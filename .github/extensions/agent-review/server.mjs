import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewSnapshotKey } from "./web/review-ledger.mjs";

const browserModels = new WeakMap();

export function browserSnapshot(snapshot) {
    if (!snapshot.model) return snapshot;
    const model = snapshot.model;
    const target = JSON.stringify(snapshot.review_target);
    let cached = browserModels.get(model);
    if (!cached || cached.target !== target) {
        const { code_paths, ...browserModel } = model;
        const sources = Object.fromEntries(Object.entries(model.source_files || {}).map(([path, source]) =>
            [path, { binary: Boolean(source.binary) }]));
        cached = { target, value: { ...browserModel, source_files: sources,
            review_snapshot_key: reviewSnapshotKey(model, snapshot.review_target) } };
        browserModels.set(model, cached);
    }
    return { ...snapshot, model: cached.value };
}

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "web");
const staticFiles = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/theme.js", "theme.js"],
    ["/app.js", "app.js"],
    ["/graph.js", "graph.js"],
    ["/findings.mjs", "findings.mjs"],
    ["/symbol-links.mjs", "symbol-links.mjs"],
    ["/package-presentation.mjs", "package-presentation.mjs"],
    ["/source-references.mjs", "source-references.mjs"],
    ["/diff-context.mjs", "diff-context.mjs"],
    ["/impact-model.mjs", "impact-model.mjs"],
    ["/item-discussion-ui.mjs", "item-discussion-ui.mjs"],
    ["/ai-activity.mjs", "ai-activity.mjs"],
    ["/review-location.mjs", "review-location.mjs"],
    ["/review-presentation.mjs", "review-presentation.mjs"],
    ["/review-workspace.mjs", "review-workspace.mjs"],
    ["/decision-map.mjs", "decision-map.mjs"],
    ["/count-format.mjs", "count-format.mjs"],
    ["/review-plan.mjs", "review-plan.mjs"],
    ["/review-ledger.mjs", "review-ledger.mjs"],
    ["/languages.mjs", "languages.mjs"],
    ["/connection-feedback.mjs", "connection-feedback.mjs"],
    ["/analysis-limitations.mjs", "analysis-limitations.mjs"],
    ["/styles.css", "styles.css"],
]);
const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
};

function sendJson(res, value, status = 200) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
}

async function readJson(req) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error("Request body is too large.");
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
}

export function startReviewServer(state, options = {}) {
    const clients = new Set();
    const unsubscribe = state.subscribe((event) => {
        if (!clients.size) return;
        let update = browserSnapshot(event);
        if (["selection", "annotation"].includes(event.type)) {
            update = { type: event.type, partial: true, review_generation: event.review_generation,
                ...(event.type === "selection" ? { selection: event.selection } : { annotations: event.annotations }) };
        }
        if (event.type === "discussion") update = {
            type: event.type, partial: true, review_generation: event.review_generation, discussion_update: event.discussion_update,
        };
        if (["rule-check-progress", "custom-analysis-progress"].includes(event.type)) {
            update = { type: event.type, partial: true,
                ...(event.type === "rule-check-progress" ? { rule_check: event.rule_check } : { custom_analyses: event.custom_analyses }) };
        }
        if (["progress", "refresh-started", "worktree-changed"].includes(event.type)) {
            update = Object.fromEntries(["type", "loading", "cancelled", "disposed", "error", "progress",
                "review_target", "review_generation", "repo_root", "analyzed_at", "restored_from_cache",
                "worktree_changed", "worktree_check_error"].map((key) => [key, event[key]]));
            update.partial = true;
            if (event.model === null) update.model = null;
        }
        const payload = `event: state\ndata: ${JSON.stringify(update)}\n\n`;
        for (const client of clients) client.write(payload);
    });

    const server = createServer(async (req, res) => {
        const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
        const pathname = requestUrl.pathname;
        try {
            if (["POST", "DELETE"].includes(req.method) && req.headers.origin) {
                const port = server.address().port;
                if (![ `http://127.0.0.1:${port}`, `http://localhost:${port}` ].includes(req.headers.origin)) {
                    sendJson(res, { error: "Cross-origin mutations are not allowed." }, 403);
                    return;
                }
            }
            if (req.method === "GET" && staticFiles.has(pathname)) {
                const filename = staticFiles.get(pathname);
                const body = await readFile(join(webRoot, filename));
                res.writeHead(200, {
                    "Content-Type": contentTypes[extname(filename)],
                    "Cache-Control": "no-store",
                    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:",
                    "X-Content-Type-Options": "nosniff",
                });
                res.end(body);
                return;
            }
            if (req.method === "GET" && pathname === "/api/state") {
                sendJson(res, browserSnapshot(state.snapshot()));
                return;
            }
            if (req.method === "GET" && pathname === "/api/review-progress") {
                sendJson(res, await state.progressForReview());
                return;
            }
            if (req.method === "POST" && pathname === "/api/review-handoff/preview") {
                sendJson(res, await state.prepareHandoff());
                return;
            }
            if (req.method === "POST" && pathname === "/api/review-handoff/import") {
                sendJson(res, await state.importHandoff(await readJson(req)));
                return;
            }
            if (req.method === "POST" && pathname === "/api/review-handoff/submit") {
                sendJson(res, await state.submitHandoff(await readJson(req)));
                return;
            }
            if (req.method === "GET" && pathname === "/api/pr-review") {
                sendJson(res, await state.prReview());
                return;
            }
            if (req.method === "POST" && pathname === "/api/pr-review/drafts") {
                try { sendJson(res, await state.updateReviewDraft(await readJson(req))); }
                catch (error) {
                    if (error.code !== "review_draft_conflict") throw error;
                    sendJson(res, { error: error.message, code: error.code }, 409);
                }
                return;
            }
            if (req.method === "POST" && pathname === "/api/review-progress") {
                try { sendJson(res, await state.saveReviewProgress(await readJson(req))); }
                catch (error) {
                    if (error.code !== "review_progress_conflict") throw error;
                    sendJson(res, { error: error.message, code: error.code }, 409);
                }
                return;
            }
            if (req.method === "GET" && pathname === "/api/discussion") {
                sendJson(res, { thread: await state.discussionFor(requestUrl.searchParams.get("id")),
                    available: Boolean(state.generateDiscussion) });
                return;
            }
            if (req.method === "GET" && pathname === "/api/review-sections") {
                sendJson(res, state.reviewSectionsFor());
                return;
            }
            if (req.method === "POST" && pathname === "/api/discussion") {
                sendJson(res, { thread: await state.askDiscussion(await readJson(req)) }, 202);
                return;
            }
            if (req.method === "GET" && pathname === "/api/source") {
                const path = requestUrl.searchParams.get("path");
                const line = Number(requestUrl.searchParams.get("line"));
                const end = Number(requestUrl.searchParams.get("end"));
                const side = requestUrl.searchParams.get("side");
                const packageName = requestUrl.searchParams.get("package");
                const start = Number.isInteger(line) && line > 0 ? line : null;
                if (path && !packageName) {
                    const source = await state.sourceForPath(path, start, start && Number.isInteger(end) && end >= start ? end : start);
                    sendJson(res, ["base", "current"].includes(side) ? { ...source, focus_side: side } : source);
                    return;
                }
                sendJson(res, path
                    ? await state.sourceForPackageDeclaration(path, packageName, requestUrl.searchParams.get("ecosystem"))
                    : await state.sourceFor(requestUrl.searchParams.get("id")));
                return;
            }
            if (req.method === "POST" && pathname === "/api/repository") {
                const input = await readJson(req);
                const snapshot = options.changeRepository
                    ? await options.changeRepository(input) : await state.setRepository(input);
                sendJson(res, { ok: true, ...browserSnapshot(snapshot) });
                return;
            }
            if (req.method === "POST" && pathname === "/api/rule-check") {
                const input = await readJson(req);
                if (input.force !== undefined && typeof input.force !== "boolean") throw new Error("force must be a boolean.");
                sendJson(res, { check: await state.runRuleCheck({ force: input.force ?? true }) });
                return;
            }
            if (req.method === "POST" && pathname === "/api/internal-reviews/cancel") {
                const input = await readJson(req);
                if (typeof input.scope !== "string" || !input.scope) throw new Error("A review scope is required.");
                state.stopInternalReviews(input.scope);
                sendJson(res, { ok: true });
                return;
            }
            if (req.method === "GET" && pathname === "/api/test-run/plan") {
                sendJson(res, await state.testRunPlan());
                return;
            }
            if (req.method === "POST" && pathname === "/api/test-run/plan") {
                const input = await readJson(req);
                sendJson(res, await state.testRunPlan({ layer: input?.layer || null }));
                return;
            }
            if (req.method === "POST" && pathname === "/api/test-run") {
                const input = await readJson(req);
                sendJson(res, { run: await state.runLinkedTests({ layer: input?.layer || null }) }, 202);
                return;
            }
            if (req.method === "POST" && pathname === "/api/test-run/cancel") {
                sendJson(res, { run: state.cancelTestRun() });
                return;
            }
            if (req.method === "GET" && pathname === "/api/review-targets") {
                sendJson(res, await state.listReviewTargets({
                    mode: requestUrl.searchParams.get("mode"),
                    page: Number(requestUrl.searchParams.get("page") || 0),
                }));
                return;
            }
            if (req.method === "POST" && pathname === "/api/review-targets/refresh") {
                const input = await readJson(req);
                sendJson(res, await state.listReviewTargets({
                    mode: input.mode,
                    page: 0,
                    refresh: input.mode === "commit",
                }));
                return;
            }
            if (req.method === "GET" && pathname === "/api/custom-prompts") {
                sendJson(res, { prompts: await state.promptStore().list() });
                return;
            }
            if (req.method === "POST" && pathname === "/api/custom-prompts") {
                sendJson(res, { prompt: await state.promptStore().save(await readJson(req)) });
                return;
            }
            if (req.method === "DELETE" && pathname === "/api/custom-prompts") {
                const input = await readJson(req);
                sendJson(res, { removed: await state.promptStore().remove(input.scope, input.id) });
                return;
            }
            if (req.method === "POST" && pathname === "/api/custom-analyses") {
                sendJson(res, { results: await state.runCustomAnalyses(await readJson(req)) });
                return;
            }
            if (req.method === "GET" && pathname === "/api/attribution") {
                sendJson(res, state.attributionStatusForPath(requestUrl.searchParams.get("path")));
                return;
            }
            if (req.method === "GET" && pathname === "/api/session-history") {
                const sessionId = requestUrl.searchParams.get("session_id");
                if (!sessionId) throw new Error("A session_id is required.");
                sendJson(res, state.sessionHistoryFor(sessionId));
                return;
            }
            if (req.method === "GET" && pathname === "/events") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache, no-transform",
                    Connection: "keep-alive",
                });
                res.write(": connected\n\n");
                res.write(`event: state\ndata: ${JSON.stringify({ type: "connected", ...browserSnapshot(state.snapshot()) })}\n\n`);
                clients.add(res);
                const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
                req.on("close", () => {
                    clearInterval(ping);
                    clients.delete(res);
                });
                return;
            }
            if (req.method === "POST" && pathname === "/api/cancel") {
                sendJson(res, { ok: true, ...browserSnapshot(await state.cancel()) });
                return;
            }
            if (req.method === "POST" && pathname === "/api/refresh") {
                state.refresh().catch((error) => {
                    if (error.name !== "AbortError") console.error("[agent-review refresh]", error);
                });
                sendJson(res, { ok: true }, 202);
                return;
            }
            if (req.method === "POST" && pathname === "/api/review-target") {
                const model = await state.setReviewTarget(await readJson(req));
                sendJson(res, { ok: true, summary: model.summary });
                return;
            }
            if (req.method === "POST" && pathname === "/api/selection") {
                sendJson(res, { ok: true, context: state.select(await readJson(req)) });
                return;
            }
            if (req.method === "POST" && pathname === "/api/annotation") {
                const input = await readJson(req);
                if (!input.id || typeof input.id !== "string") throw new Error("An item id is required.");
                sendJson(res, {
                    ok: true,
                    annotation: await state.annotationFor(input.id, Array.isArray(input.evidence_ids) ? input.evidence_ids : []),
                });
                return;
            }
            if (req.method === "GET" && pathname === "/api/document-roles") {
                sendJson(res, { ok: true, roles: await state.rolesForReview() });
                return;
            }
            if (req.method === "POST" && pathname === "/api/document-roles") {
                sendJson(res, { ok: true, roles: await state.correctDocumentRole(await readJson(req)) });
                return;
            }
            if (req.method === "POST" && pathname === "/api/overview") {
                sendJson(res, { ok: true, annotation: await state.overviewFor() });
                return;
            }
            if (req.method === "POST" && pathname === "/api/layer-summaries") {
                sendJson(res, { ok: true, annotation: await state.layerSummariesFor() });
                return;
            }
            if (req.method === "POST" && pathname === "/api/package-risk") {
                const input = await readJson(req);
                if (!input.name || typeof input.name !== "string") throw new Error("A package name is required.");
                sendJson(res, await state.packageRiskFor(input.name, input.version || null, { explain: input.explain !== false, ecosystem: input.ecosystem || null }));
                return;
            }
            sendJson(res, { error: "not_found" }, 404);
        } catch (error) {
            sendJson(res, { error: error.message, cancelled: error.name === "AbortError" },
                error.name === "AbortError" ? 409 : error.statusCode || 400);
        }
    });

    const listen = (port) => new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off("listening", onListening);
            reject(error);
        };
        const onListening = () => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
    });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    return (async () => {
        const preferred = Number.isInteger(options.port) ? options.port : 0;
        const deadline = Date.now() + (options.exactPort ? options.waitMs ?? 20_000 : 0);
        for (;;) {
            try {
                await listen(preferred);
                break;
            } catch (error) {
                if (error.code !== "EADDRINUSE" || !preferred) throw error;
                if (options.exactPort) {
                    if (Date.now() >= deadline) throw error;
                    await sleep(300);
                    continue;
                }
                await listen(0);
                break;
            }
        }
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const stopWorktreeMonitoring = state.startWorktreeMonitoring(options.worktreeCheckIntervalMs);
        return {
            port,
            url: `http://127.0.0.1:${port}/`,
            close: async () => {
                stopWorktreeMonitoring();
                unsubscribe();
                for (const client of clients) client.end();
                await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
            },
        };
    })();
}
