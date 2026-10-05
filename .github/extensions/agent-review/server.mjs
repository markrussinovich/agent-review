import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listReviewTargets } from "./review-target.mjs";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "web");
const staticFiles = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/app.js", "app.js"],
    ["/graph.js", "graph.js"],
    ["/findings.mjs", "findings.mjs"],
    ["/symbol-links.mjs", "symbol-links.mjs"],
    ["/package-presentation.mjs", "package-presentation.mjs"],
    ["/source-references.mjs", "source-references.mjs"],
    ["/diff-context.mjs", "diff-context.mjs"],
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
        let update = event;
        if (["progress", "refresh-started", "worktree-changed"].includes(event.type)) {
            update = Object.fromEntries(["type", "loading", "cancelled", "disposed", "error", "progress",
                "review_target", "review_generation", "analyzed_at", "restored_from_cache",
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
                    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self' 'sha256-HNjOU2rt1GsFc5zDEQXklLEbjDyKexAo5wKONo5tkTc='; img-src 'self' data:",
                    "X-Content-Type-Options": "nosniff",
                });
                res.end(body);
                return;
            }
            if (req.method === "GET" && pathname === "/api/state") {
                if (!state.model && !state.loading && !state.cancelled && !state.disposed) {
                    state.refresh().catch((error) => {
                        if (error.name !== "AbortError") console.error("[agent-review refresh]", error);
                    });
                }
                sendJson(res, state.snapshot());
                return;
            }
            if (req.method === "GET" && pathname === "/api/source") {
                const path = requestUrl.searchParams.get("path");
                const line = Number(requestUrl.searchParams.get("line"));
                const packageName = requestUrl.searchParams.get("package");
                sendJson(res, path
                    ? packageName ? await state.sourceForPackageDeclaration(path, packageName)
                        : await state.sourceForPath(path, Number.isInteger(line) && line > 0 ? line : null)
                    : await state.sourceFor(requestUrl.searchParams.get("id")));
                return;
            }
            if (req.method === "GET" && pathname === "/api/review-targets") {
                sendJson(res, await listReviewTargets(state.repoRoot, {
                    mode: requestUrl.searchParams.get("mode"),
                    page: Number(requestUrl.searchParams.get("page") || 0),
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
                if (!state.model && !state.loading && !state.cancelled && !state.disposed) {
                    state.refresh().catch((error) => {
                        if (error.name !== "AbortError") console.error("[agent-review refresh]", error);
                    });
                }
                res.write(`event: state\ndata: ${JSON.stringify({ type: "connected", ...state.snapshot() })}\n\n`);
                clients.add(res);
                const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
                req.on("close", () => {
                    clearInterval(ping);
                    clients.delete(res);
                });
                return;
            }
            if (req.method === "POST" && pathname === "/api/cancel") {
                sendJson(res, { ok: true, ...await state.cancel() });
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
            if (req.method === "POST" && pathname === "/api/overview") {
                sendJson(res, { ok: true, annotation: await state.overviewFor() });
                return;
            }
            if (req.method === "POST" && pathname === "/api/package-risk") {
                const input = await readJson(req);
                if (!input.name || typeof input.name !== "string") throw new Error("A package name is required.");
                sendJson(res, await state.packageRiskFor(input.name, input.version || null, { explain: input.explain !== false }));
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
