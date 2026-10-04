import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assessPackageRisk } from "./package-risk.mjs";
import { buildSessionContext } from "./session-context.mjs";

const execFileAsync = promisify(execFile);
const extensionRoot = dirname(fileURLToPath(import.meta.url));
const analyzerPath = join(extensionRoot, "analyzer", "analyze.py");

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

function runAnalyzerProcess(executable, args, onProgress) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            env: process.env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout = [];
        const diagnostics = [];
        let stderrBuffer = "";
        let outputBytes = 0;
        child.stdout.on("data", (chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > 128 * 1024 * 1024) {
                child.kill();
                reject(new Error("Analyzer output exceeded 128 MB."));
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

async function runAnalyzer(repoRoot, baseRef, onProgress) {
    const args = [analyzerPath, "--repo", repoRoot];
    if (baseRef) args.push("--base-ref", baseRef);
    const failures = [];
    for (const [executable, prefix] of pythonCandidates()) {
        try {
            return await runAnalyzerProcess(executable, [...prefix, ...args], onProgress);
        } catch (error) {
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
        this.model = null;
        this.error = null;
        this.loading = false;
        this.generatedObservations = [];
        this.selection = null;
        this.listeners = new Set();
        this.refreshPromise = null;
        this.getSessionEvents = options.getSessionEvents || null;
        this.generateAnnotation = options.generateAnnotation || null;
        this.generatePackageExplanation = options.generatePackageExplanation || null;
        this.sessionContext = null;
        this.annotations = {};
        this.annotationPromises = new Map();
        this.packageRisks = {};
        this.packageRiskPromises = new Map();
        this.progress = null;
    }

    snapshot() {
        return {
            model: this.model,
            loading: this.loading,
            error: this.error,
            generated_observations: this.generatedObservations,
            selection: this.selection,
            session_context: this.sessionContext,
            annotations: this.annotations,
            progress: this.progress,
            package_risks: this.packageRisks,
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
        this.loading = false;
        this.error = error.message;
        this.progress = { phase: "failed", message: "Repository initialization failed", percent: 100 };
        this.broadcast("refresh-failed");
    }

    async refresh() {
        if (this.refreshPromise) return this.refreshPromise;
        this.loading = true;
        this.error = null;
        this.progress = {
            phase: "starting",
            message: "Starting deterministic repository analysis",
            percent: 0,
            started_at: new Date().toISOString(),
        };
        this.broadcast("refresh-started");
        const sessionContextPromise = this.refreshSessionContext(false);
        this.refreshPromise = runAnalyzer(this.repoRoot, this.baseRef, (progress) => {
            this.progress = { ...this.progress, ...progress };
            this.broadcast("progress");
        })
            .then((model) => {
                this.model = model;
                this.generatedObservations = this.generatedObservations.filter((observation) =>
                    observation.evidence_ids.every((id) => model.evidence?.[id])
                );
                this.annotations = {};
                this.packageRisks = {};
                this.loading = false;
                this.progress = { phase: "complete", message: "Analysis complete", percent: 100 };
                return sessionContextPromise.then(() => {
                    this.broadcast("refreshed");
                    return model;
                });
            })
            .catch((error) => {
                this.loading = false;
                this.error = error.message;
                this.progress = { phase: "failed", message: "Analysis failed", percent: 100 };
                this.broadcast("refresh-failed");
                throw error;
            })
            .finally(() => {
                this.refreshPromise = null;
            });
        return this.refreshPromise;
    }

    async refreshSessionContext(broadcast = true) {
        if (!this.getSessionEvents) return null;
        try {
            this.sessionContext = buildSessionContext(await this.getSessionEvents(), this.repoRoot);
        } catch (error) {
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
        const item = node || edge || packageChange || attention || observation || evidence;
        if (!item) throw new Error(`Unknown review item: ${id}`);
        const subject = node
            || (attention?.node_id ? this.model.nodes.find((candidate) => candidate.id === attention.node_id) : null)
            || (attention?.edge_id ? this.model.edges.find((candidate) => candidate.id === attention.edge_id) : null)
            || packageChange;
        const evidenceIds = new Set(item.evidence_ids || []);
        if (this.model.evidence?.[id]) evidenceIds.add(id);
        const nodeById = new Map(this.model.nodes.map((candidate) => [candidate.id, candidate]));
        const relatedEdges = subject?.id
            ? this.model.edges.filter((candidate) => candidate.source === subject.id || candidate.target === subject.id)
            : [];
        return {
            item,
            subject,
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
            related_symbols: subject?.kind === "module"
                ? this.model.nodes
                    .filter((candidate) => candidate.module_id === subject.id && ["class", "function", "method"].includes(candidate.kind))
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
        for (const evidenceId of supplementalEvidenceIds) {
            const evidence = this.model?.evidence?.[evidenceId];
            if (!evidence) throw new Error(`Unknown evidence id: ${evidenceId}`);
            context.evidence[evidenceId] = evidence;
        }
        context.session_intent = (this.sessionContext?.intent || []).slice(-6);
        context.code_context = await this.codeContextFor(context);
        const promise = this.generateAnnotation(context)
            .then((body) => {
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
            .finally(() => this.annotationPromises.delete(id));
        this.annotationPromises.set(id, promise);
        return promise;
    }

    async codeContextFor(context) {
        const evidenceWithPath = Object.values(context.evidence || {}).find((entry) => entry.path);
        const subject = context.subject || {};
        const path = subject.path || evidenceWithPath?.path;
        if (!path) return null;
        const fullPath = safePath(this.repoRoot, path);
        let source;
        try {
            source = await readFile(fullPath, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") return { path, unavailable: "File is removed in the current snapshot." };
            throw error;
        }
        const lines = source.split(/\r?\n/);
        const evidenceLine = Number(evidenceWithPath?.line || subject.start_line || 1);
        const start = subject.kind === "module"
            ? 1
            : Math.max(1, evidenceLine - 20);
        const requestedEnd = subject.kind === "module"
            ? Math.min(lines.length, 100)
            : Math.min(lines.length, Number(subject.end_line || evidenceLine + 30));
        const end = Math.min(requestedEnd, start + 119);
        let diff = "";
        let diffError = null;
        const baseSha = this.model?.metadata?.base_sha;
        if (baseSha) {
            try {
                diff = await git(this.repoRoot, ["diff", "--no-ext-diff", "--unified=6", baseSha, "--", path]);
                if (diff.length > 24_000) diff = `${diff.slice(0, 24_000)}\n… diff truncated …`;
            } catch (error) {
                diffError = error.message;
            }
        }
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
                    candidateSource = await readFile(safePath(this.repoRoot, candidatePath), "utf8");
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

    async packageRiskFor(name, requestedVersion = null) {
        const dependency = this.model?.package_dependencies?.find((item) => item.name === name);
        if (!dependency) throw new Error(`Unknown package dependency: ${name}`);
        const declared = dependency.declared_current?.map((item) => item.specifier).filter(Boolean) || [];
        const exactDeclared = declared
            .map((value) => /^(?:===|==)\s*([^,;\s]+)$/.exec(value)?.[1])
            .find(Boolean);
        const version = requestedVersion || dependency.resolved_current || exactDeclared;
        if (!version) {
            throw new Error(`An exact or installed version is required to assess ${name}; declared ${declared.join(", ") || "without a version"}.`);
        }
        const cacheKey = `${name}@${version}`;
        if (this.packageRisks[cacheKey]) return this.packageRisks[cacheKey];
        if (this.packageRiskPromises.has(cacheKey)) return this.packageRiskPromises.get(cacheKey);
        const promise = assessPackageRisk(name, version, { includePopularity: true })
            .then(async (assessment) => {
                const explanation = this.generatePackageExplanation
                    ? await this.generatePackageExplanation({ dependency, assessment })
                    : null;
                const result = { assessment, explanation };
                this.packageRisks[cacheKey] = result;
                this.broadcast("package-risk");
                return result;
            })
            .finally(() => this.packageRiskPromises.delete(cacheKey));
        this.packageRiskPromises.set(cacheKey, promise);
        return promise;
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
        return this.sourceForPath(
            evidence.path,
            startLine,
            endLine,
        );
    }

    async sourceForPath(path, startLine = null, endLine = startLine) {
        const fullPath = safePath(this.repoRoot, path);
        let current = null;
        try {
            current = await readFile(fullPath, "utf8");
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
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
                diff = await git(this.repoRoot, ["diff", "--no-ext-diff", "--unified=4", baseSha, "--", path]);
            } catch (error) {
                diffError = `Unable to load the source diff: ${error.message}`;
            }
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
}
