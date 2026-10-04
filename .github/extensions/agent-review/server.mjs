import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "web");
const staticFiles = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/app.js", "app.js"],
    ["/graph.js", "graph.js"],
    ["/styles.css", "styles.css"],
]);
const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
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

export function startReviewServer(state) {
    const clients = new Set();
    const unsubscribe = state.subscribe((event) => {
        const payload = `event: state\ndata: ${JSON.stringify(event)}\n\n`;
        for (const client of clients) client.write(payload);
    });

    const server = createServer(async (req, res) => {
        const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
        const pathname = requestUrl.pathname;
        try {
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
                if (!state.model && !state.loading) state.refresh().catch(() => {});
                sendJson(res, state.snapshot());
                return;
            }
            if (req.method === "GET" && pathname === "/api/source") {
                const path = requestUrl.searchParams.get("path");
                sendJson(res, path
                    ? await state.sourceForPath(path)
                    : await state.sourceFor(requestUrl.searchParams.get("id")));
                return;
            }
            if (req.method === "GET" && pathname === "/api/attribution") {
                sendJson(res, { attribution: state.attributionForPath(requestUrl.searchParams.get("path")) });
                return;
            }
            if (req.method === "GET" && pathname === "/events") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache, no-transform",
                    Connection: "keep-alive",
                });
                res.write(": connected\n\n");
                clients.add(res);
                const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
                req.on("close", () => {
                    clearInterval(ping);
                    clients.delete(res);
                });
                return;
            }
            if (req.method === "POST" && pathname === "/api/refresh") {
                const model = await state.refresh();
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
            if (req.method === "POST" && pathname === "/api/package-risk") {
                const input = await readJson(req);
                if (!input.name || typeof input.name !== "string") throw new Error("A package name is required.");
                sendJson(res, await state.packageRiskFor(input.name, input.version || null));
                return;
            }
            sendJson(res, { error: "not_found" }, 404);
        } catch (error) {
            sendJson(res, { error: error.message }, 400);
        }
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            resolve({
                url: `http://127.0.0.1:${port}/`,
                close: async () => {
                    unsubscribe();
                    for (const client of clients) client.end();
                    await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
                },
            });
        });
    });
}
