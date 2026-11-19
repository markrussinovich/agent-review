import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { markerFile, providerMarkerDirectory, writeCanvasMarker } from "../canvas-persistence.mjs";

const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("SDK reload preserves each provider's selected target without reanalysis or repo edits", {
    skip: !process.env.AGENT_REVIEW_SDK_PATH,
    timeout: 180000,
}, async (t) => {
    const { CopilotClient } = await import(pathToFileURL(process.env.AGENT_REVIEW_SDK_PATH).href);
    const repo = await mkdtemp(join(tmpdir(), "review-reopen-sdk-"));
    const previous = process.env.AGENT_REVIEW_STATE_DIR;
    process.env.AGENT_REVIEW_STATE_DIR = join(repo, ".git", "markers");
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    let session;
    const client = new CopilotClient({
        baseDirectory: join(repo, ".git", "copilot-home"),
        workingDirectory: repo,
        connection: { kind: "stdio", ...(process.env.AGENT_REVIEW_CLI_PATH ? { path: process.env.AGENT_REVIEW_CLI_PATH } : {}) },
    });
    t.after(async () => {
        if (session) await client.deleteSession(session.sessionId);
        await client.stop();
        if (previous === undefined) delete process.env.AGENT_REVIEW_STATE_DIR;
        else process.env.AGENT_REVIEW_STATE_DIR = previous;
        await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "main.py"), "def run():\n    return 1\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(repo, "main.py"), "def run():\n    return 2\n");
    await git("commit", "-qam", "second");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    for (const name of ["agent-review", "agent-review-preview"]) {
        await cp(sourceRoot, join(repo, ".github", "extensions", name), {
            recursive: true,
            filter: (path) => !relative(sourceRoot, path).split(sep).some((part) => ["tests", "__pycache__"].includes(part)),
        });
    }
    const modified = "def run():\n    return 3\n";
    await writeFile(join(repo, "main.py"), modified);
    session = await client.createSession({
        workingDirectory: repo, requestExtensions: true, requestCanvasRenderer: true,
        enableConfigDiscovery: true,
        infiniteSessions: { enabled: true }, availableTools: [],
        onPermissionRequest: async () => ({ kind: "denied-interactively-by-user" }),
    });
    const extensions = await session.rpc.extensions.list();
    const extension = extensions.extensions.find((item) => item.name === "agent-review" && item.source === "project");
    const preview = extensions.extensions.find((item) => item.name === "agent-review-preview" && item.source === "project");
    assert.ok(extension, JSON.stringify(extensions));
    assert.ok(preview, JSON.stringify(extensions));
    for (const provider of [extension, preview]) {
        if (provider.status !== "running") await session.rpc.extensions.enable({ id: provider.id });
    }
    // The extension registers its Canvas asynchronously after it starts.
    let canvases;
    let canvas, previewCanvas;
    for (const registered = Date.now() + 20000; Date.now() < registered; await sleep(200)) {
        canvases = await session.rpc.canvas.list();
        canvas = canvases.canvases.find((item) => item.canvasId === "agent-review" && item.extensionId === extension.id);
        previewCanvas = canvases.canvases.find((item) => item.canvasId === "agent-review" && item.extensionId === preview.id);
        if (canvas && previewCanvas) break;
    }
    assert.ok(canvas, JSON.stringify(canvases));
    assert.ok(previewCanvas, JSON.stringify(canvases));
    for (const [name, input] of [["null", null], ["omitted", undefined], ["empty", {}]]) {
        const opened = await session.rpc.canvas.open({ canvasId: canvas.canvasId, extensionId: canvas.extensionId,
            instanceId: `menu-${name}`, ...(input === undefined ? {} : { input }) });
        const response = await fetch(`${opened.url}api/state`);
        assert.equal(response.status, 200);
        const state = await response.json();
        assert.equal(resolve(state.repo_root), resolve(repo));
        assert.equal(state.review_target.mode, "none", "opening must not start analysis");
        await session.rpc.canvas.close({ instanceId: opened.instanceId });
    }
    const input = { repoPath: repo, baseRef: "HEAD" };
    const request = { canvasId: canvas.canvasId, extensionId: canvas.extensionId, instanceId: "reopen-test", input };
    const first = await session.rpc.canvas.open(request);
    await session.rpc.canvas.close({ instanceId: first.instanceId });
    const second = await session.rpc.canvas.open(request);
    assert.equal(second.instanceId, first.instanceId);
    assert.ok(second.url);
    assert.equal(await readFile(join(repo, "main.py"), "utf8"), modified);
    await session.rpc.extensions.reload();
    const deadline = Date.now() + 20000;
    let recovered;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${second.url}api/state`);
            if (response.ok) {
                recovered = await response.json();
                if (recovered.error) assert.fail(recovered.error);
                if (!recovered.loading) break;
            }
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
        }
        await sleep(200);
    }
    assert.ok(recovered && !recovered.loading, "provider reload must reclaim the existing Canvas URL");
    assert.equal(resolve(recovered.repo_root), resolve(repo));
    assert.equal(recovered.review_target.mode, "none");
    assert.equal(recovered.model, null, "provider reload must not start analysis");
    const active = await session.rpc.canvas.open(request);
    const other = await session.rpc.canvas.open({ canvasId: previewCanvas.canvasId, extensionId: previewCanvas.extensionId,
        instanceId: "other-provider", input });
    for (const [url, ref] of [[active.url, head], [other.url, base]]) {
        const response = await fetch(`${url}api/review-target`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "commit", ref }),
        });
        assert.equal(response.status, 200, await response.text());
    }
    await session.rpc.extensions.reload();
    const waitForTarget = async (url, ref) => {
        let last = "unreachable";
        for (const until = Date.now() + 30000; Date.now() < until; await sleep(200)) {
            try {
                const response = await fetch(`${url}api/state`);
                if (!response.ok) { last = `HTTP ${response.status}`; continue; }
                const value = await response.json();
                if (value.error) assert.fail(value.error);
                last = JSON.stringify({ target: value.review_target, loading: value.loading, hasModel: Boolean(value.model) });
                if (!value.loading && !value.model && value.review_target.currentRef === ref) return value;
            } catch (error) {
                if (!(error instanceof TypeError)) throw error;
                last = error.message;
            }
        }
        const status = await session.rpc.extensions.list();
        const markers = await Promise.all([[extension, "reopen-test"], [preview, "other-provider"]].map(async ([provider, id]) => {
            try {
                const directory = providerMarkerDirectory(provider.id, process.env.AGENT_REVIEW_STATE_DIR);
                const value = JSON.parse(await readFile(markerFile(session.sessionId, id, directory), "utf8"));
                return { provider: provider.id, port: value.port, target: value.input.reviewTarget };
            } catch (error) { return { provider: provider.id, error: error.message }; }
        }));
        assert.fail(`Provider did not recover its pinned target ${ref}: ${last}; ${JSON.stringify(status.extensions)}; ${JSON.stringify(markers)}`);
    };
    const [mainTarget, previewTarget] = await Promise.all([
        waitForTarget(active.url, head), waitForTarget(other.url, base),
    ]);
    assert.equal(mainTarget.review_target.baseRef, base);
    assert.equal(previewTarget.review_target.baseRef, null);
    const reanalysis = await fetch(`${active.url}api/refresh`, { method: "POST" });
    assert.equal(reanalysis.status, 202);
    let analyzed;
    for (const until = Date.now() + 30000; Date.now() < until; await sleep(200)) {
        const value = await (await fetch(`${active.url}api/state`)).json();
        if (value.error) assert.fail(value.error);
        if (!value.loading && value.model) { analyzed = value; break; }
    }
    assert.ok(analyzed, "manual reanalysis must finish");
    assert.equal(analyzed.model.metadata.head_sha, head);
    assert.equal(analyzed.model.metadata.base_sha, base);
    const source = await (await fetch(`${active.url}api/source?path=main.py`)).json();
    assert.match(source.current, /return 2/);
    assert.equal(await readFile(join(repo, "main.py"), "utf8"), modified);
    assert.match((await git("status", "--short", "--", "main.py")).stdout, / M main\.py/);
    const legacyId = "legacy-review";
    const legacyInput = { repoPath: repo, baseRef: "HEAD~1",
        reviewTarget: { mode: "commit", ref: head, currentRef: head, baseRef: base, label: "Saved commit" } };
    const root = process.env.AGENT_REVIEW_STATE_DIR;
    await writeCanvasMarker({ sessionId: session.sessionId, instanceId: legacyId, port: 41234, input: legacyInput }, root);
    const legacy = await session.rpc.canvas.open({ canvasId: previewCanvas.canvasId, extensionId: previewCanvas.extensionId,
        instanceId: legacyId, input: { repoPath: repo, baseRef: "HEAD~1" } });
    const migrated = await (await fetch(`${legacy.url}api/state`)).json();
    assert.equal(migrated.review_target.currentRef, head);
    assert.equal(migrated.review_target.baseRef, base);
    assert.equal(migrated.model, null, "legacy target migration must not start analysis");
    const scoped = providerMarkerDirectory(preview.id, root);
    assert.equal(JSON.parse(await readFile(markerFile(session.sessionId, legacyId, scoped), "utf8")).instanceId, legacyId);
    await assert.rejects(readFile(markerFile(session.sessionId, legacyId, root), "utf8"), { code: "ENOENT" });
    await session.rpc.canvas.close({ instanceId: legacyId });
    await session.rpc.canvas.close({ instanceId: other.instanceId });
    await session.rpc.canvas.close({ instanceId: second.instanceId });
});
