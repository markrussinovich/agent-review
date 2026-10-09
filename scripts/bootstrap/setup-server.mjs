import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preparing Agent Review</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/setup.css">
<script type="module" src="/setup.js"></script></head>
<body><main class="setup"><h1>Preparing Agent Review</h1>
<p id="repository"></p><p>First use downloads the prepared extension from a pinned GitHub release.
Its checksum is verified before extraction. No reviewed project is built or restored.</p>
<p id="status" role="status" aria-live="polite">Preparing...</p>
<progress aria-label="Bundle download"></progress><pre id="error" role="alert" hidden></pre>
<button id="retry" hidden>Retry preparation</button>
<p class="muted">Requires Python 3.11+, Node.js 20+, and the .NET 10 runtime for C# reviews.</p>
<p class="muted" id="release"></p></main></body></html>`;
const css = `body { overflow: auto; height: auto; min-height: 100vh; display: block; }
.setup { width: auto; max-width: 640px; margin: 48px auto; padding: 24px; border: 1px solid var(--cp-border);
border-radius: 6px; background: var(--cp-surface); }
.setup h1 { font-size: 20px; margin-top: 0; } .setup p { margin: 12px 0; overflow-wrap: anywhere; }
.setup .muted { color: var(--cp-text-muted); font-size: 12px; }
.setup progress { width: 100%; accent-color: var(--cp-link); }
.setup pre { color: var(--cp-danger); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.setup button { padding: 6px 12px; border: 1px solid var(--cp-border); border-radius: 6px;
background: var(--cp-primary); color: white; cursor: pointer; }
@media(max-width: 680px) { .setup { margin: 16px; padding: 16px; } }
`;
const script = `
const status = document.querySelector("#status"), error = document.querySelector("#error");
const retry = document.querySelector("#retry"), progress = document.querySelector("progress");
const theme = () => { document.documentElement.dataset.theme =
    (document.documentElement.dataset.colorMode || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")); };
theme();
new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode"] });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", theme);
let stopped = false;
async function update() {
    try {
        const response = await fetch("/state", { cache: "no-store" });
        if (!response.ok) throw new Error("Preparation status unavailable. Reopen the canvas.");
        const state = await response.json();
        status.textContent = state.message;
        document.querySelector("#repository").textContent = "Repository: " + state.repository;
        document.querySelector("#release").textContent = "Pinned source: " + state.source;
        error.hidden = !state.error; error.textContent = state.error || "";
        retry.hidden = !state.error; progress.hidden = !!state.error;
        if (state.phase === "download" && state.total) { progress.max = state.total; progress.value = state.received; }
        else progress.removeAttribute("value");
        if (state.url) { stopped = true; location.replace(state.url); }
    } catch (failure) {
        error.hidden = false; error.textContent = failure.message; progress.hidden = true;
    }
    if (!stopped) setTimeout(update, 500);
}
retry.addEventListener("click", async () => {
    retry.disabled = true;
    try {
        const response = await fetch("/retry", { method: "POST" });
        if (!response.ok) throw new Error("Unable to retry preparation. Reopen the canvas.");
    } catch (failure) { error.hidden = false; error.textContent = failure.message; }
    finally { retry.disabled = false; }
});
update();
`;

export async function startSetupServer(getState, retry, { stylesPath = join(root, "styles.css") } = {}) {
    const server = createServer(async (req, res) => {
        try {
            const headers = {
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
            };
            if (req.method === "GET" && req.url === "/state") {
                res.writeHead(200, { ...headers, "Content-Type": "application/json" });
                res.end(JSON.stringify(getState()));
                return;
            }
            if (req.method === "POST" && req.url === "/retry") {
                const origin = `http://127.0.0.1:${server.address().port}`;
                if (req.headers.origin !== origin) {
                    res.writeHead(403, headers); res.end("Cross-origin retry denied."); return;
                }
                retry();
                res.writeHead(202, headers); res.end(); return;
            }
            const assets = {
                "/": ["text/html; charset=utf-8", html],
                "/setup.css": ["text/css; charset=utf-8", css],
                "/setup.js": ["text/javascript; charset=utf-8", script],
            };
            if (req.method === "GET" && req.url === "/styles.css") {
                assets["/styles.css"] = ["text/css; charset=utf-8", await readFile(stylesPath)];
            }
            if (req.method === "GET" && assets[req.url]) {
                res.writeHead(200, { ...headers, "Content-Type": assets[req.url][0] });
                res.end(assets[req.url][1]); return;
            }
            res.writeHead(404, headers); res.end("Not found.");
        } catch (error) {
            console.error("[agent-review preparation]", error);
            if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Preparation UI failed. Check the extension log.");
        }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    let closing;
    return {
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => closing ||= new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}
