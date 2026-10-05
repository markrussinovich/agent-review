import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assessPackageRisk } from "./package-risk.mjs";
import { buildPackageUsageContext } from "./package-context.mjs";
import { CustomPromptStore } from "./custom-prompts.mjs";
import { customAnalysisContext, validateCustomAnalysis } from "./custom-analysis.mjs";
import { resolveReviewTarget } from "./review-target.mjs";
import { buildSessionContext, findSessionAttribution, mergeSessionContexts } from "./session-context.mjs";
import { spawnOwnedAnalyzer } from "./ownership-guard.mjs";

const execFileAsync = promisify(execFile);
const extensionRoot = dirname(fileURLToPath(import.meta.url));
const analyzerPath = join(extensionRoot, "analyzer", "analyze.py");

export function isTestPath(path) {
    return /(^|\/)(tests?|__tests__)\//i.test(path) || /(^|\/)test_[^/]+\.py$|_test\.py$/i.test(path);
}

function withTimeout(promise, timeoutMs, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function abortable(value, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(value).then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
    });
}

function normalizeRepoPath(value) {
    return resolve(value || process.env.COPILOT_WORKSPACE_PATH || process.env.COPILOT_ROOT_PATH || process.cwd());
}

async function git(repoRoot, args, options = {}) {
    const result = await execFileAsync("git", ["-C", repoRoot, ...args], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        ...options,
    });
    return result.stdout.trimEnd();
}

export async function resolveRepoRoot(requestedPath) {
    const candidate = normalizeRepoPath(requestedPath);
    const root = await git(candidate, ["rev-parse", "--show-toplevel"]);
    return resolve(root);
}

export async function loadReviewConfig(repoRoot) {
    const path = join(repoRoot, ".agent-review.json");
    try {
        const config = JSON.parse(await readFile(path, "utf8"));
        if (config.base_ref !== undefined && typeof config.base_ref !== "string") {
            throw new Error("base_ref must be a string.");
        }
        return config;
    } catch (error) {
        if (error.code === "ENOENT") return {};
        throw new Error(`Unable to load ${path}: ${error.message}`);
    }
}

function pythonCandidates() {
    if (process.env.AGENT_REVIEW_PYTHON) return [[process.env.AGENT_REVIEW_PYTHON, []]];
    return process.platform === "win32"
        ? [["py", ["-3.11"]], ["python", []], ["python3", []]]
        : [["python3", []], ["python", []]];
}

export function runAnalyzerProcess(executable, args, onProgress = () => {}, options = {}) {
    return new Promise((resolve, reject) => {
        options.signal?.throwIfAborted();
        const child = spawnOwnedAnalyzer(executable, args, options);
        const abort = () => child.stop();
        options.signal?.addEventListener("abort", abort, { once: true });
        const stdout = [];
        const diagnostics = [];
        let stderrBuffer = "";
        let outputBytes = 0;
        let failure;
        child.on("message", (message) => {
            if (message.type === "spawn-error") failure = Object.assign(new Error(message.message), { code: message.code });
            if (message.type === "analyzer-started") options.onSpawn?.(message.pid);
        });
        child.stdout.on("data", (chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > 128 * 1024 * 1024) {
                failure = new Error("Analyzer output exceeded 128 MB.");
                child.stop();
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderrBuffer += chunk.toString("utf8");
            const lines = stderrBuffer.split(/\r?\n/);
            stderrBuffer = lines.pop() || "";
            for (const line of lines) {
                if (line.startsWith("AGENT_REVIEW_PROGRESS ")) {
                    try {
                        onProgress(JSON.parse(line.slice("AGENT_REVIEW_PROGRESS ".length)));
                    } catch (error) {
                        diagnostics.push(`Invalid progress event: ${error.message}`);
                    }
                } else if (line.trim()) {
                    diagnostics.push(line);
                }
            }
        });
        child.once("error", reject);
        child.once("close", (code) => {
            options.signal?.removeEventListener("abort", abort);
            if (options.signal?.aborted) { reject(options.signal.reason); return; }
            if (failure) { reject(failure); return; }
            if (stderrBuffer.trim() && !stderrBuffer.startsWith("AGENT_REVIEW_PROGRESS ")) diagnostics.push(stderrBuffer);
            if (code !== 0) {
                reject(new Error(diagnostics.join("\n") || `${executable} exited with code ${code}`));
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
            } catch (error) {
                reject(new Error(`Analyzer returned invalid JSON: ${error.message}`));
            }
        });
    });
}

export async function runAnalyzer(repoRoot, baseRef, onProgress, currentRef = null, options = {}) {
    const args = [analyzerPath, "--repo", repoRoot];
    if (baseRef) args.push("--base-ref", baseRef);
    if (currentRef) args.push("--current-ref", currentRef);
    const failures = [];
    for (const [executable, prefix] of pythonCandidates()) {
        try {
            return await runAnalyzerProcess(executable, [...prefix, ...args], onProgress, options);
        } catch (error) {
            options.signal?.throwIfAborted();
            if (error.code !== "ENOENT") throw error;
            failures.push(`${executable}: ${error.message}`);
        }
    }
    throw new Error(`Unable to run the Python 3.11+ analyzer:\n${failures.join("\n")}`);
}

function safePath(repoRoot, path) {
    if (!path || isAbsolute(path)) throw new Error("A repository-relative path is required.");
    const fullPath = resolve(repoRoot, normalize(path));
    const rel = relative(repoRoot, fullPath);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path is outside the repository.");
    return fullPath;
}

export class ReviewState {
    constructor(repoRoot, options = {}) {
        this.repoRoot = repoRoot;
        this.baseRef = options.baseRef || null;
        this.worktreeBaseRef = this.baseRef;
        this.reviewTarget = options.reviewTarget || { mode: "worktree", label: "Worktree", currentRef: null };
        this.resolveBaseRef = options.resolveBaseRef || null;
        this.model = null;
        this.error = null;
        this.loading = false;
        this.cancelled = false;
        this.disposed = false;
        this.activeRun = null;
        this.cancelPromise = null;
        this.runAnalyzer = options.runAnalyzer || runAnalyzer;
        this.workspacePath = options.workspacePath;
        this.generatedObservations = [];
        this.selection = null;
        this.listeners = new Set();
        this.refreshPromise = null;
        this.reviewGeneration = 0;
        this.reviewInstanceId = randomUUID();
        this.reviewCache = new Map();
        this.lastAnalyzedAt = null;
        this.restoredFromCache = false;
        this.getSessionEvents = options.getSessionEvents || null;
        this.getHistoricalSessionContexts = options.getHistoricalSessionContexts || null;
        this.historicalSessionTimeoutMs = options.historicalSessionTimeoutMs || 40_000;
        this.currentSessionId = options.currentSessionId || null;
        this.generateAnnotation = options.generateAnnotation || null;
        this.generatePackageExplanation = options.generatePackageExplanation || null;
        this.generateCustomAnalysis = options.generateCustomAnalysis || null;
        this.customAnalysisTimeoutMs = options.customAnalysisTimeoutMs || 120_000;
        this.customPromptOptions = options.customPromptOptions || {};
        this.customAnalyses = {};
        this.customAnalysisPromises = new WeakMap();
        this.customPromptError = null;
        this.sessionContext = null;
        this.annotations = {};
        this.annotationPromises = new Map();
        this.packageRisks = {};
        this.packageRiskPromises = new Map();
        this.packageAssessments = new Map();
        this.packageAssessmentPromises = new Map();
        this.progress = null;
        this.sessionHistories = new Map();
        this.historicalContextPromise = null;
    }

    snapshot() {
        return {
            model: this.model,
            loading: this.loading,
            cancelled: this.cancelled,
            disposed: this.disposed,
            error: this.error,
            generated_observations: this.generatedObservations,
            selection: this.selection,
            session_context: this.sessionContext,
            annotations: this.annotations,
            progress: this.progress,
            package_risks: this.packageRisks,
            review_target: this.reviewTarget,
            review_generation: `${this.reviewInstanceId}:${this.reviewGeneration}`,
            analyzed_at: this.lastAnalyzedAt,
            restored_from_cache: this.restoredFromCache,
            saved_review_targets: [...this.reviewCache.values()].map((entry) => entry.target),
            custom_analyses: this.customAnalyses,
            custom_prompt_error: this.customPromptError,
        };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    broadcast(type = "state") {
        const event = { type, ...this.snapshot() };
        for (const listener of this.listeners) listener(event);
    }

    failInitialization(error) {
        if (this.disposed || this.cancelled) return;
        this.loading = false;
        this.error = error.message;
        this.progress = { phase: "failed", message: "Repository initialization failed", percent: 100 };
        this.broadcast("refresh-failed");
    }


    async refresh() {
        if (this.disposed) throw new Error("This review has been closed.");
        if (this.cancelPromise) await this.cancelPromise;
        if (this.refreshPromise) return this.refreshPromise;
        const run = { controller: new AbortController() };
        this.activeRun = run;
        const signal = run.controller.signal;
        const wait = (promise) => abortable(promise, signal);
        this.reviewGeneration += 1;
        this.annotationPromises = new Map();
        this.loading = true;
        this.cancelled = false;
        this.error = null;
        this.progress = {
            phase: "starting",
            message: "Starting deterministic repository analysis",
            percent: 0,
            started_at: new Date().toISOString(),
        };
        this.broadcast("refresh-started");
        const sessionContextPromise = wait(this.refreshSessionContext(false));
        sessionContextPromise.catch(() => {});
        this.refreshPromise = Promise.resolve()
            .then(() => {
                signal.throwIfAborted();
                return wait(this.reviewTarget.mode !== "worktree" ? this.reviewTarget.baseRef
                    : this.resolveBaseRef ? this.resolveBaseRef() : this.worktreeBaseRef);
            })
            .then((baseRef) => {
                signal.throwIfAborted();
                this.baseRef = baseRef ?? null;
                return this.runAnalyzer(this.repoRoot, this.baseRef, (progress) => {
                    if (signal.aborted || this.activeRun !== run) return;
                    this.progress = { ...this.progress, ...progress, updated_at: new Date().toISOString() };
                    this.broadcast("progress");
                }, this.reviewTarget.currentRef, { signal, workspacePath: this.workspacePath });
            })
            .then(async (model) => {
                await sessionContextPromise;
                signal.throwIfAborted();
                if (this.activeRun !== run) throw new Error("The review changed during analysis.");
                this.model = model;
                this.generatedObservations = this.generatedObservations.filter((observation) =>
                    observation.evidence_ids.every((id) => model.evidence?.[id])
                );
                this.annotations = {};
                this.selection = null;
                this.packageRisks = {};
                this.packageAssessments = new Map();
                this.customAnalyses = {};
                this.customPromptError = null;
                this.loading = false;
                this.lastAnalyzedAt = new Date().toISOString();
                this.restoredFromCache = false;
                this.progress = { phase: "complete", message: "Analysis complete", percent: 100 };
                this.saveCurrentReview();
                this.broadcast("refreshed");
                this.startCustomAnalyses();
                return model;
            })
            .catch((error) => {
                if (signal.aborted || this.activeRun !== run || this.disposed) throw error;
                this.loading = false;
                this.error = error.message;
                this.progress = { phase: "failed", message: "Analysis failed", percent: 100 };
                this.broadcast("refresh-failed");
                throw error;
            })
            .finally(() => {
                if (this.activeRun === run) {
                    this.refreshPromise = null;
                    this.activeRun = null;
                }
            });
        return this.refreshPromise;
    }

    // Keep the run promise until its ownership guard has confirmed process-tree exit.
    async cancel() {
        if (this.cancelPromise) return this.cancelPromise;
        this.cancelled = true;
        this.reviewGeneration += 1;
        const pending = this.refreshPromise;
        this.activeRun?.controller.abort(new DOMException("Analysis cancelled.", "AbortError"));
        const cancellation = (async () => {
            try { await pending; }
            catch (error) { if (error.name !== "AbortError") console.error("[agent-review cancellation]", error); }
            this.loading = false;
            this.error = null;
            this.progress = { phase: "cancelled", message: "Analysis cancelled. Choose Reanalyze to try again.", percent: 0 };
            this.broadcast("cancelled");
        })();
        this.cancelPromise = cancellation;
        try { await cancellation; }
        finally { if (this.cancelPromise === cancellation) this.cancelPromise = null; }
        return this.snapshot();
    }

    async dispose() {
        if (this.disposalPromise) return this.disposalPromise;
        this.disposed = true;
        this.disposalPromise = this.clearDisposedReview();
        return this.disposalPromise;
    }

    async clearDisposedReview() {
        await this.cancel();
        this.model = null;
        this.generatedObservations = [];
        this.annotations = {};
        this.selection = null;
        this.sessionContext = null;
        this.customAnalyses = {};
        this.customPromptError = null;
        this.packageRisks = {};
        this.reviewCache.clear();
        this.annotationPromises.clear();
        this.packageRiskPromises.clear();
        this.packageAssessments.clear();
        this.packageAssessmentPromises.clear();
        this.customAnalysisPromises = new WeakMap();
        this.sessionHistories.clear();
        this.historicalContextPromise = null;
        this.restoredFromCache = false;
        this.lastAnalyzedAt = null;
        this.progress = null;
        this.listeners.clear();
    }

    async setReviewTarget(input) {
        if (this.refreshPromise || this.switchingTarget) throw new Error("Wait for the current analysis or review switch to finish.");
        if (this.packageRiskPromises.size || this.packageAssessmentPromises.size) {
            throw new Error("Wait for the current package assessment to finish before switching reviews.");
        }
        this.switchingTarget = true;
        try {
            const resolved = await resolveReviewTarget(this.repoRoot, input);
            this.saveCurrentReview();
            this.reviewTarget = resolved;
            this.selection = null;
            const cached = this.reviewCache.get(this.reviewCacheKey(resolved));
            if (cached) {
                this.reviewGeneration += 1;
                this.annotationPromises = new Map();
                this.model = cached.model;
                this.annotations = cached.annotations;
                this.packageRisks = cached.packageRisks;
                this.packageAssessments = cached.packageAssessments;
                this.generatedObservations = cached.generatedObservations;
                this.customAnalyses = cached.customAnalyses;
                this.customPromptError = null;
                this.lastAnalyzedAt = cached.analyzedAt;
                this.restoredFromCache = true;
                this.loading = false;
                this.error = null;
                this.progress = { phase: "complete", message: "Saved review restored", percent: 100 };
                this.broadcast("refreshed");
                this.startCustomAnalyses();
                return this.model;
            }
            this.model = null;
            this.annotations = {};
            this.generatedObservations = [];
            return await this.refresh();
        } finally {
            this.switchingTarget = false;
        }
    }

    reviewCacheKey(target = this.reviewTarget) {
        return JSON.stringify([target.mode, target.currentRef || null,
            target.mode === "worktree" ? this.worktreeBaseRef : target.baseRef]);
    }

    saveCurrentReview() {
        if (!this.model || this.loading || this.error) return;
        this.reviewCache.set(this.reviewCacheKey(), {
            target: { ...this.reviewTarget },
            model: this.model,
            annotations: this.annotations,
            packageRisks: this.packageRisks,
            packageAssessments: this.packageAssessments,
            generatedObservations: this.generatedObservations,
            analyzedAt: this.lastAnalyzedAt,
            customAnalyses: this.customAnalyses,
        });
    }

    promptStore() {
        if (!this.customPromptStore || this.customPromptStore.repoRoot !== resolve(this.repoRoot)) {
            this.customPromptStore = new CustomPromptStore(this.repoRoot, this.customPromptOptions);
        }
        return this.customPromptStore;
    }

    startCustomAnalyses() {
        const model = this.model;
        if (model
            && !(model.changes || []).some((change) => change.status !== "unchanged")) return;
        this.runCustomAnalyses().catch((error) => {
            if (this.model !== model) return;
            this.customPromptError = error.message;
            this.broadcast("custom-analysis-error");
        });
    }

    async runCustomAnalyses(input = {}) {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Custom analysis options must be an object.");
        if (input.force !== undefined && typeof input.force !== "boolean") throw new Error("force must be a boolean.");
        if (input.id !== undefined && (typeof input.id !== "string" || !input.id || !["global", "repository"].includes(input.scope))) {
            throw new Error("A prompt id and valid scope are required.");
        }
        if (!this.model || this.loading) throw new Error("Wait for the review analysis to finish.");
        const model = this.model;
        const results = this.customAnalyses;
        const prompts = (await this.promptStore().list()).filter((prompt) => prompt.enabled && prompt.trusted);
        const selected = input.id ? prompts.filter((prompt) => prompt.id === input.id && prompt.scope === input.scope) : prompts;
        if (input.id && !selected.length) throw new Error("The requested prompt is missing, disabled, or requires approval.");
        if (selected.length && !this.generateCustomAnalysis) throw new Error("Custom AI analysis is unavailable in this provider.");
        if (this.model !== model || this.customAnalyses !== results) throw new Error("The review changed before custom analysis could start.");
        let pending = this.customAnalysisPromises.get(results);
        if (!pending) {
            pending = new Map();
            this.customAnalysisPromises.set(results, pending);
        }
        const context = customAnalysisContext(model);
        let chain = Promise.resolve();
        const tasks = [];
        for (const prompt of selected) {
            const key = `${prompt.scope}:${prompt.id}:${prompt.revision}`;
            if (pending.has(key)) {
                tasks.push(pending.get(key));
                continue;
            }
            if (results[key] && !input.force) continue;
            const result = { id: prompt.id, scope: prompt.scope, revision: prompt.revision, title: prompt.title, status: "queued" };
            results[key] = result;
            const task = chain.then(async () => {
                if (this.disposed || this.customAnalyses !== results || this.model !== model) return;
                result.status = "running";
                if (this.customAnalyses === results) this.broadcast("custom-analysis");
                try {
                    result.content = validateCustomAnalysis(await withTimeout(this.generateCustomAnalysis({ prompt, context }),
                        this.customAnalysisTimeoutMs, "Custom analysis timed out. Retry this check."), context);
                    result.status = "complete";
                    result.completed_at = new Date().toISOString();
                } catch (error) {
                    result.status = "error";
                    result.error = error.message;
                } finally {
                    pending.delete(key);
                    if (this.customAnalyses === results) this.broadcast("custom-analysis");
                }
                return result;
            });
            pending.set(key, task);
            chain = task;
            tasks.push(task);
        }
        this.customPromptError = null;
        if (this.customAnalyses === results) this.broadcast("custom-analysis");
        await Promise.all(tasks);
        return Object.values(results);
    }

    async refreshSessionContext(broadcast = true) {
        if (!this.getSessionEvents || this.disposed) return null;
        const generation = this.reviewGeneration;
        try {
            const current = buildSessionContext(await this.getSessionEvents(), this.repoRoot);
            if (this.disposed || generation !== this.reviewGeneration) return null;
            current.session_id = this.currentSessionId;
            current.session_summary = "Current Agent Review session";
            for (const turn of current.turns) {
                turn.session_id = this.currentSessionId;
                turn.session_summary = current.session_summary;
            }
            this.sessionHistories.set(this.currentSessionId, current);
            this.sessionContext = mergeSessionContexts([...this.sessionHistories.values()]);
            if (this.sessionHistories.size > 1) {
                this.sessionContext.historical_search_complete = true;
                this.sessionContext.historical_session_count = this.sessionHistories.size - 1;
            }
            this.refreshHistoricalSessionContexts();
        } catch (error) {
            if (this.disposed || generation !== this.reviewGeneration) return null;
            this.sessionContext = {
                provenance: "copilot_session_history",
                factual_status: "context_only",
                intent: [],
                recent_activity: [],
                referenced_files: [],
                event_count: 0,
                generated_at: new Date().toISOString(),
                error: `Unable to read Copilot session history: ${error.message}`,
            };
        }
        if (broadcast) this.broadcast("session-context");
        return this.sessionContext;
    }

    refreshHistoricalSessionContexts() {
        if (!this.getHistoricalSessionContexts || this.disposed) return null;
        if (this.historicalContextPromise) return this.historicalContextPromise;
        if (this.sessionContext?.historical_search_complete) return null;
        if (!this.sessionContext) this.sessionContext = mergeSessionContexts([...this.sessionHistories.values()]);
        const generation = this.reviewGeneration;
        const pending = withTimeout(
            Promise.resolve().then(() => this.getHistoricalSessionContexts()),
            this.historicalSessionTimeoutMs,
            `Historical Copilot session search exceeded ${this.historicalSessionTimeoutMs >= 1000 ? `${Math.round(this.historicalSessionTimeoutMs / 1000)} seconds` : `${this.historicalSessionTimeoutMs} milliseconds`}.`,
        )
            .then(({ contexts, failures }) => {
                if (this.disposed || generation !== this.reviewGeneration) return;
                for (const context of contexts) {
                    this.sessionHistories.set(context.session_id, context);
                }
                this.sessionContext = mergeSessionContexts([...this.sessionHistories.values()]);
                this.sessionContext.history_failures = failures;
                this.sessionContext.historical_search_complete = true;
                this.sessionContext.historical_session_count = contexts.length;
                this.broadcast("session-history");
            })
            .catch((error) => {
                if (this.disposed || generation !== this.reviewGeneration) return;
                this.sessionContext.history_error = `Unable to read historical sessions: ${error.message}`;
                this.sessionContext.historical_search_complete = true;
                this.broadcast("session-history-failed");
            })
            .finally(() => {
                if (this.historicalContextPromise === pending) this.historicalContextPromise = null;
            });
        this.historicalContextPromise = pending;
        return this.historicalContextPromise;
    }

    sessionHistoryFor(sessionId) {
        const context = this.sessionHistories.get(sessionId);
        if (!context) throw new Error(`Session history is not loaded: ${sessionId}`);
        return {
            session_id: context.session_id,
            summary: context.session_summary,
            working_directory: context.working_directory || null,
            timeline: context.timeline || [],
            turns: context.turns || [],
        };
    }

    select(selection) {
        if (selection !== null && (!selection || typeof selection.id !== "string")) {
            throw new Error("Selection must contain an id.");
        }
        this.selection = selection;
        this.broadcast("selection");
        return this.contextFor(selection?.id);
    }

    contextFor(id = this.selection?.id) {
        if (!this.model) return null;
        if (!id) return { metadata: this.model.metadata, summary: this.model.summary, session_context: this.sessionContext };
        const node = this.model.nodes?.find((item) => item.id === id);
        const edge = this.model.edges?.find((item) => item.id === id);
        const packageChange = this.model.package_changes?.find((item) => item.id === id || `package:${item.name}` === id);
        const attention = this.model.attention?.find((item) => item.id === id);
        const observation = this.generatedObservations.find((item) => item.id === id);
        const evidence = this.model.evidence?.[id];
        const filePath = id?.startsWith("file:") ? id.slice("file:".length) : null;
        const fileChange = filePath ? this.model.changes?.find((candidate) => candidate.path === filePath) : null;
        const file = fileChange ? {
            id,
            kind: "file",
            type: "file",
            name: filePath,
            path: filePath,
            change: fileChange.status,
            start_line: null,
            end_line: null,
            metrics: {
                lines_added: fileChange.lines_added,
                lines_removed: fileChange.lines_removed,
                lines_changed: fileChange.lines_added + fileChange.lines_removed,
            },
            evidence_ids: [],
        } : null;
        const item = node || edge || packageChange || attention || observation || evidence || file;
        if (!item) throw new Error(`Unknown review item: ${id}`);
        const subject = node
            || (attention?.node_id ? this.model.nodes.find((candidate) => candidate.id === attention.node_id) : null)
            || (attention?.edge_id ? this.model.edges.find((candidate) => candidate.id === attention.edge_id) : null)
            || packageChange
            || file;
        const evidenceIds = new Set(item.evidence_ids || []);
        if (this.model.evidence?.[id]) evidenceIds.add(id);
        const nodeById = new Map(this.model.nodes.map((candidate) => [candidate.id, candidate]));
        const relatedEdges = subject?.id
            ? this.model.edges.filter((candidate) => candidate.source === subject.id || candidate.target === subject.id)
            : [];
        return {
            item,
            subject,
            analysis_quality: {
                coverage_available: Boolean(this.model.coverage?.available),
                warnings: this.model.warnings || [],
            },
            evidence: Object.fromEntries([...evidenceIds].filter((key) => this.model.evidence?.[key]).map((key) => [key, this.model.evidence[key]])),
            related_edges: relatedEdges.map((candidate) => ({
                ...candidate,
                source_summary: nodeById.has(candidate.source)
                    ? {
                        name: nodeById.get(candidate.source).name,
                        kind: nodeById.get(candidate.source).kind,
                        path: nodeById.get(candidate.source).path,
                    }
                    : null,
                target_summary: nodeById.has(candidate.target)
                    ? {
                        name: nodeById.get(candidate.target).name,
                        kind: nodeById.get(candidate.target).kind,
                        path: nodeById.get(candidate.target).path,
                    }
                    : null,
            })),
            related_symbols: subject?.kind === "module" || subject?.kind === "file"
                ? this.model.nodes
                    .filter((candidate) =>
                        ["class", "function", "method"].includes(candidate.kind)
                        && (subject.kind === "module" ? candidate.module_id === subject.id : candidate.path === subject.path)
                    )
                    .map((candidate) => ({
                        id: candidate.id,
                        kind: candidate.kind,
                        name: candidate.name,
                        change: candidate.change,
                        signatures: candidate.signatures,
                        metrics: candidate.metrics,
                    }))
                    .slice(0, 60)
                : [],
        };
    }

    addObservation(input) {
        const title = String(input.title || "").trim();
        const body = String(input.body || input.detail || "").trim();
        const evidenceIds = [...new Set((input.evidence_ids || []).map(String))];
        if (!title || !body) throw new Error("Observation title and body are required.");
        if (!evidenceIds.length) throw new Error("Every observation must cite at least one evidence id.");
        const unknown = evidenceIds.filter((id) => !this.model?.evidence?.[id]);
        if (unknown.length) throw new Error(`Unknown evidence ids: ${unknown.join(", ")}`);
        const observation = {
            id: `observation:${Date.now()}:${this.generatedObservations.length}`,
            title,
            body,
            severity: ["info", "low", "medium", "high"].includes(input.severity) ? input.severity : "info",
            evidence_ids: evidenceIds,
        };
        this.generatedObservations.push(observation);
        this.broadcast("observation");
        return observation;
    }

    async annotationFor(id, supplementalEvidenceIds = []) {
        if (this.annotations[id]) return this.annotations[id];
        if (!this.generateAnnotation) throw new Error("Copilot annotation is unavailable.");
        if (this.annotationPromises.has(id)) return this.annotationPromises.get(id);
        const context = this.contextFor(id);
        const generation = this.reviewGeneration;
        for (const evidenceId of supplementalEvidenceIds) {
            const evidence = this.model?.evidence?.[evidenceId];
            if (!evidence) throw new Error(`Unknown evidence id: ${evidenceId}`);
            context.evidence[evidenceId] = evidence;
        }
        const attributionPath = context.subject?.path
            || Object.values(context.evidence || {}).find((entry) => entry.path)?.path;
        const promise = (async () => {
            const history = this.refreshHistoricalSessionContexts();
            if (history) await history;
            if (generation !== this.reviewGeneration) throw new Error("The review changed while loading annotation context.");
            context.session_attribution = this.attributionForPath(attributionPath);
            context.session_intent = this.intentForReview(context.session_attribution).slice(-6);
            context.code_context = await this.codeContextFor(context);
            if (generation !== this.reviewGeneration) throw new Error("The review changed while loading annotation context.");
            return this.generateAnnotation(context);
        })()
            .then((body) => {
                if (generation !== this.reviewGeneration) throw new Error("The review changed while generating this annotation.");
                const annotation = {
                    id: `annotation:${id}`,
                    item_id: id,
                    body: String(body || "").trim(),
                    evidence_ids: Object.keys(context.evidence || {}),
                    generated_at: new Date().toISOString(),
                };
                if (!annotation.body) throw new Error("Copilot returned an empty annotation.");
                this.annotations[id] = annotation;
                this.broadcast("annotation");
                return annotation;
            })
            .finally(() => {
                if (this.annotationPromises.get(id) === promise) this.annotationPromises.delete(id);
            });
        this.annotationPromises.set(id, promise);
        return promise;
    }

    async overviewFor() {
        if (this.loading) throw new Error("Wait for analysis to complete before generating the summary.");
        if (this.model
            && !(this.model.changes || []).some((change) => change.status !== "unchanged")) {
            throw new Error("This review has no changes to summarize.");
        }
        if (this.annotations.overview) return this.annotations.overview;
        if (!this.generateAnnotation) throw new Error("Copilot annotation is unavailable.");
        if (!this.model) throw new Error("Analysis is not complete.");
        if (this.annotationPromises.has("overview")) return this.annotationPromises.get("overview");
        const generation = this.reviewGeneration;
        const promise = (async () => {
            const history = this.refreshHistoricalSessionContexts();
            if (history) await history;
            if (generation !== this.reviewGeneration) throw new Error("The review changed while loading summary context.");
            return this.generateAnnotation(this.overviewContext());
        })()
            .then((body) => {
                if (generation !== this.reviewGeneration) throw new Error("The review changed while generating this summary.");
                const annotation = {
                    id: "annotation:overview",
                    item_id: "overview",
                    body: String(body || "").trim(),
                    evidence_ids: [],
                    generated_at: new Date().toISOString(),
                };
                if (!annotation.body) throw new Error("Copilot returned an empty change summary.");
                this.annotations.overview = annotation;
                this.broadcast("annotation");
                return annotation;
            })
            .finally(() => {
                if (this.annotationPromises.get("overview") === promise) this.annotationPromises.delete("overview");
            });
        this.annotationPromises.set("overview", promise);
        return promise;
    }

    overviewContext() {
        const model = this.model;
        const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
        const files = model.changes
            .filter((change) => change.status !== "unchanged")
            .map((change) => ({
                path: change.path,
                status: change.status,
                added: change.lines_added,
                removed: change.lines_removed,
                is_test: isTestPath(change.path),
            }))
            .sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
        const totals = { source: { added: 0, removed: 0 }, tests: { added: 0, removed: 0 } };
        for (const file of files) {
            const bucket = file.is_test ? totals.tests : totals.source;
            bucket.added += file.added;
            bucket.removed += file.removed;
        }
        const seen = new Set();
        const findings = [];
        for (const finding of [...(model.attention || [])].sort((a, b) => (b.impact_score || 0) - (a.impact_score || 0))) {
            const key = finding.node_id || finding.edge_id || finding.id;
            if (seen.has(key)) continue;
            seen.add(key);
            const node = nodeById.get(finding.node_id);
            findings.push({
                title: finding.title,
                subject: node ? { name: node.name, kind: node.kind, path: node.path } : null,
                impact_score: finding.impact_score,
                reason: finding.reason,
                factors: finding.impact_factors,
            });
            if (findings.length >= 12) break;
        }
        const attribution = files
            .filter((file) => !file.is_test)
            .slice(0, 3)
            .map((file) => ({ file, match: this.attributionForPath(file.path)[0] }))
            .filter((entry) => entry.match)
            .map(({ file, match }) => ({
                path: file.path,
                prompt: String(match.original_prompt || match.prompt || "").slice(0, 500),
                latest_file_request: match.original_prompt !== match.prompt ? String(match.prompt || "").slice(0, 500) : null,
                confidence: match.confidence,
            }));
        return {
            kind: "overview",
            summary: model.summary,
            totals,
            files: files.slice(0, 30),
            omitted_files: Math.max(0, files.length - 30),
            findings,
            packages: (model.package_changes || []).map((item) => ({
                name: item.name,
                change: item.change,
                version: item.resolved_current || null,
            })),
            session_intent: this.intentForReview(attribution).slice(-4).map((item) => String(item.summary || "").slice(0, 500)),
            session_attribution: attribution,
            analysis_quality: {
                coverage_available: Boolean(model.coverage?.available),
                warnings: model.warnings || [],
                session_history_error: this.sessionContext?.history_error || this.sessionContext?.error || null,
            },
        };
    }

    async codeContextFor(context) {
        const evidenceWithPath = Object.values(context.evidence || {}).find((entry) => entry.path);
        const subject = context.subject || {};
        const path = subject.path || evidenceWithPath?.path;
        if (!path) return null;
        const snapshot = await this.sourceForPath(path);
        const source = snapshot.current;
        if (source === null) return { path, unavailable: "File is removed in the current snapshot." };

        const lines = source.split(/\r?\n/);
        const evidenceLine = Number(evidenceWithPath?.line || subject.start_line || 1);
        const start = subject.kind === "module"
            ? 1
            : Math.max(1, evidenceLine - 20);
        const requestedEnd = subject.kind === "module"
            ? Math.min(lines.length, 100)
            : Math.min(lines.length, Number(subject.end_line || evidenceLine + 30));
        const end = Math.min(requestedEnd, start + 119);
        const diff = snapshot.diff.length > 24_000
            ? `${snapshot.diff.slice(0, 24_000)}\n… diff truncated …` : snapshot.diff;
        const diffError = snapshot.diff_error;
        const usages = [];
        const subjectName = String(subject.name || "");
        if (/^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(subjectName)) {
            const matcher = new RegExp(`\\b${subjectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
            const pythonPaths = [...new Set(
                this.model.nodes
                    .filter((candidate) => candidate.kind === "module" && candidate.path?.endsWith(".py"))
                    .map((candidate) => candidate.path)
            )];
            for (const candidatePath of pythonPaths) {
                let candidateSource;
                try {
                    candidateSource = await this.readCurrentSource(candidatePath);
                    if (candidateSource === null) continue;
                } catch (error) {
                    if (error.code === "ENOENT") continue;
                    throw error;
                }
                const candidateLines = candidateSource.split(/\r?\n/);
                for (let index = 0; index < candidateLines.length && usages.length < 30; index += 1) {
                    if (matcher.test(candidateLines[index])) {
                        usages.push({
                            path: candidatePath,
                            line: index + 1,
                            text: candidateLines[index].trim().slice(0, 300),
                        });
                    }
                }
                if (usages.length >= 30) break;
            }
        }
        return {
            path,
            start_line: start,
            end_line: end,
            excerpt: lines
                .slice(start - 1, end)
                .map((line, index) => `${start + index}: ${line}`)
                .join("\n"),
            truncated: end < lines.length,
            diff,
            diff_error: diffError,
            usages,
        };
    }

    attributionForPath(path) {
        return findSessionAttribution(this.sessionContext, path, { before: this.reviewHistoryCutoff() });
    }

    reviewHistoryCutoff() {
        return this.reviewTarget.mode === "worktree" ? this.lastAnalyzedAt : this.model?.metadata?.generated_at || null;
    }

    intentForReview(attribution = []) {
        if (attribution.length) {
            return [...new Set(attribution.map((item) => item.original_prompt || item.prompt).filter(Boolean))]
                .map((summary) => ({ summary }));
        }
        const before = this.reviewHistoryCutoff();
        const cutoff = before === null ? null : Date.parse(before);
        if (cutoff !== null && !Number.isFinite(cutoff)) throw new Error("Review history cutoff must be a valid timestamp.");
        return (this.sessionContext?.intent || []).filter((item) => cutoff === null || Date.parse(item.timestamp) <= cutoff);
    }

    attributionStatusForPath(path) {
        const attribution = this.attributionForPath(path);
        if (attribution.length) return { status: "matched", attribution };
        if (this.sessionContext?.history_error) {
            return { status: "error", attribution, message: this.sessionContext.history_error };
        }
        if (!this.sessionContext?.historical_search_complete) {
            return { status: "loading", attribution, message: "Searching Copilot sessions for this repository…" };
        }
        return {
            status: "no_match",
            attribution,
            message: this.reviewTarget.mode === "worktree"
                ? "No originating prompt was found in Copilot sessions for this repository."
                : "No originating prompt was found in repository sessions at or before this commit.",
        };
    }

    async packageRiskFor(name, requestedVersion = null, { explain = true } = {}) {
        if (this.disposed) throw new Error("This review has been closed.");
        const generation = this.reviewGeneration;
        const dependency = this.model?.package_dependencies?.find((item) => item.name === name);
        if (!dependency) throw new Error(`Unknown package dependency: ${name}`);
        const declared = dependency.declared_current?.map((item) => item.specifier).filter(Boolean) || [];
        const resolutionError = dependency.declared_current?.find((item) => item.resolution_error)?.resolution_error;
        if (resolutionError) throw new Error(resolutionError);
        const exactPins = [...new Set(declared
            .map((value) => /^(?:===|==)\s*([^*,;<>=\s]+)$/.exec(value)?.[1])
            .filter(Boolean))];
        if (exactPins.length > 1) throw new Error(`Conflicting project version pins for ${name}: ${exactPins.join(", ")}.`);
        const version = exactPins[0] || dependency.resolved_current || null;
        if ((version && /[*,;<>=~^\s]/.test(version)) || (!version && requestedVersion)) {
            throw new Error(`An exact project version is required to assess ${name}; declared ${declared.join(", ") || "without a version"}. Pin or resolve the dependency, then reanalyze.`);
        }
        if (requestedVersion && requestedVersion !== version) throw new Error(`Requested version ${requestedVersion} does not match the reviewed project version ${name}@${version}.`);
        const cacheKey = `${name}@${version ?? "<unresolved>"}`;
        const assessment = await this.packageAssessmentFor(cacheKey, name, version);
        if (this.disposed || generation !== this.reviewGeneration) throw new Error("The review changed while assessing this package.");
        if (!explain) return { assessment, explanation: this.packageRisks[cacheKey]?.explanation ?? null };
        if (this.packageRisks[cacheKey]) return this.packageRisks[cacheKey];
        if (this.packageRiskPromises.has(cacheKey)) return this.packageRiskPromises.get(cacheKey);
        const usageContext = buildPackageUsageContext(this.model, dependency, isTestPath);
        const promise = Promise.resolve()
            .then(() => this.generatePackageExplanation
                ? this.generatePackageExplanation({ dependency, assessment, usageContext })
                : null)
            .then((explanation) => {
                if (generation !== this.reviewGeneration) throw new Error("The review changed while explaining this package.");
                const result = { assessment, explanation };
                this.packageRisks[cacheKey] = result;
                this.broadcast("package-risk");
                return result;
            })
            .finally(() => this.packageRiskPromises.delete(cacheKey));
        this.packageRiskPromises.set(cacheKey, promise);
        return promise;
    }

    // Public-registry indicators are fast and independent of the slower Copilot explanation.
    packageAssessmentFor(cacheKey, name, version) {
        if (this.disposed) return Promise.reject(new Error("This review has been closed."));
        if (this.packageAssessments.has(cacheKey)) return Promise.resolve(this.packageAssessments.get(cacheKey));
        if (!this.packageAssessmentPromises.has(cacheKey)) {
            const generation = this.reviewGeneration;
            const promise = assessPackageRisk(name, version, { includePopularity: true, metadataOnly: version === null })
                .then((assessment) => {
                    if (this.disposed || generation !== this.reviewGeneration) throw new Error("The review changed while assessing this package.");
                    this.packageAssessments.set(cacheKey, assessment);
                    return assessment;
                })
                .finally(() => this.packageAssessmentPromises.delete(cacheKey));
            this.packageAssessmentPromises.set(cacheKey, promise);
        }
        return this.packageAssessmentPromises.get(cacheKey);
    }
    async sourceFor(id) {
        const context = this.contextFor(id);
        const item = context?.item;
        const evidence = item?.path ? item : Object.values(context?.evidence || {}).find((entry) => entry.path);
        if (!evidence?.path) throw new Error("The selected item has no source location.");
        const preciseEvidence = evidence.kind !== "line_delta" && item?.type !== "size";
        const startLine = item?.path
            ? item.start_line || null
            : preciseEvidence ? evidence.line || null : null;
        const endLine = item?.path
            ? item.end_line || startLine
            : startLine;
        const source = await this.sourceForPath(
            evidence.path,
            startLine,
            endLine,
        );
        return { ...source, focus_side: item?.change === "removed" || context.subject?.change === "removed"
            || source.current === null ? "base" : "current" };
    }

    async sourceForPackageDeclaration(path, name) {
        const dependency = this.model?.package_changes?.find((item) => item.name === name)
            || this.model?.package_dependencies?.find((item) => item.name === name);
        if (!dependency) throw new Error(`Unknown package dependency: ${name}`);
        const current = dependency.declared_current?.find((item) => item.source === path);
        const declaration = current || dependency.declared_base?.find((item) => item.source === path);
        if (!declaration || !Number.isInteger(declaration.line)) {
            throw new Error(`No saved declaration location for ${name} in ${path}. Reanalyze this review.`);
        }
        const source = await this.sourceForPath(path, declaration.line, declaration.end_line || declaration.line);
        return { ...source, declaration_highlight: {
            line: declaration.line, end_line: declaration.end_line || declaration.line,
            start_column: declaration.start_column, end_column: declaration.end_column,
            side: current ? "current" : "base",
        } };
    }

    async sourceForPath(path, startLine = null, endLine = startLine) {
        const current = await this.readCurrentSource(path);
        let base = null;
        let baseError = null;
        const baseSha = this.model?.metadata?.base_sha;
        if (baseSha) {
            try {
                base = await git(this.repoRoot, ["show", `${baseSha}:${path.replaceAll("\\", "/")}`]);
            } catch (error) {
                baseError = `File is not present in the base snapshot: ${error.message}`;
            }
        }
        let diff = "";
        let diffError = null;
        if (baseSha) {
            try {
                const saved = this.model?.source_files?.[path.replaceAll("\\", "/")];
                diff = saved ? saved.diff || "" : await git(this.repoRoot, ["diff", "--no-ext-diff", "--unified=4", baseSha,
                    ...(this.reviewTarget.currentRef ? [this.reviewTarget.currentRef] : []), "--", path]);
            } catch (error) {
                diffError = `Unable to load the source diff: ${error.message}`;
            }

        }
        if (!diff && base === null && current !== null) {
            const lines = current.split(/\r?\n/);
            if (lines.at(-1) === "") lines.pop();
            diff = `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
        }
        return {
            path,
            start_line: startLine,
            end_line: endLine,
            current,
            base,
            base_error: baseError,
            diff,
            diff_error: diffError,
        };
    }

    async readCurrentSource(path) {
        const fullPath = safePath(this.repoRoot, path);
        const saved = this.model?.source_files?.[path.replaceAll("\\", "/")];
        if (saved) {
            if (saved.binary) throw new Error(`Cannot display ${path}: the analyzed file is not UTF-8 text.`);
            return saved.current;
        }
        if (this.model?.source_files) return null;
        if (this.reviewTarget.currentRef) {
            const name = path.replaceAll("\\", "/");
            const exists = await git(this.repoRoot, ["ls-tree", "--name-only", this.reviewTarget.currentRef, "--", name]);
            return exists ? git(this.repoRoot, ["show", `${this.reviewTarget.currentRef}:${name}`]) : null;
        }
        try {
            return await readFile(fullPath, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    }
}
