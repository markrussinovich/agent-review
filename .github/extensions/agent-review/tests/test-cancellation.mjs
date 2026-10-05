import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ReviewState, runAnalyzer, runAnalyzerProcess } from "../review-state.mjs";
import { startReviewServer } from "../server.mjs";
import { ReviewLifecycle } from "../review-lifecycle.mjs";
import { markerFile, writeCanvasMarker } from "../canvas-persistence.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
const execute = (command, args) => new Promise((resolve, reject) =>
    execFile(command, args, { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
async function until(check, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await sleep(30);
    }
    assert.fail("Condition did not become true within the bounded timeout.");
}
async function area(t) {
    const path = join(root, `.cancellation-${randomUUID()}`);
    await mkdir(path);
    t.after(() => rm(path, { recursive: true, force: true }));
    return path;
}
function treeCode(pidFile) {
    return `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
        setInterval(() => {}, 1000);
    `;
}
async function pidsAt(path) {
    let pids;
    await until(async () => {
        try { pids = JSON.parse(await readFile(path, "utf8")); return pids.length === 2; }
        catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return false; throw error; }
    });
    return pids;
}
async function killProvider(provider) {
    if (provider.exitCode !== null || provider.signalCode !== null || !alive(provider.pid)) return;
    if (process.platform === "win32") {
        await new Promise((resolve, reject) => execFile("taskkill", ["/PID", String(provider.pid), "/F"],
            { windowsHide: true }, (error) => error && error.code !== 128 ? reject(error) : resolve()));
    } else provider.kill("SIGKILL");
}

test("cancel API waits for real analyzer descendants to exit; GET and SSE never restart; Reanalyze works", async (t) => {
    const path = await area(t);
    const pidFile = join(path, "pids.json");
    let runs = 0;
    const state = new ReviewState(path, {
        runAnalyzer: (_repo, _base, progress, _ref, options) => {
            runs += 1;
            const code = runs === 1 ? treeCode(pidFile) : 'console.log(JSON.stringify({ summary: {}, changes: [], evidence: {} }))';
            return runAnalyzerProcess(process.execPath, ["-e", code], progress, options);
        },
    });
    const server = await startReviewServer(state);
    t.after(async () => { await state.dispose(); await server.close(); });
    await fetch(`${server.url}api/state`);
    const pids = await pidsAt(pidFile);
    const started = Date.now();
    const result = await (await fetch(`${server.url}api/cancel`, { method: "POST" })).json();
    assert.equal(result.cancelled, true);
    assert.equal(result.loading, false);
    assert.ok(Date.now() - started < 6000);
    assert.ok(pids.every((pid) => !alive(pid)), "response arrives only after analyzer tree exits");
    for (let index = 0; index < 2; index++) await fetch(`${server.url}api/state`);
    const events = await fetch(`${server.url}events`);
    const reader = events.body.getReader();
    await reader.read();
    await reader.cancel();
    await sleep(100);
    assert.equal(runs, 1);
    const restarted = await fetch(`${server.url}api/refresh`, { method: "POST" });
    assert.equal(restarted.status, 200);
    assert.equal(runs, 2);
    assert.equal(state.cancelled, false);
    assert.ok(state.model);
});

test("cancels while base resolution or session context is pending and late work cannot clobber restart", async () => {
    for (const pendingPhase of ["base", "context"]) {
        let release;
        let runs = 0;
        const pending = new Promise((resolve) => { release = resolve; });
        const state = new ReviewState(root, {
            resolveBaseRef: pendingPhase === "base" ? () => pending : null,
            getSessionEvents: pendingPhase === "context" ? () => pending : null,
            runAnalyzer: async () => { runs++; return { summary: {}, changes: [], evidence: {} }; },
        });
        const old = state.refresh();
        const rejected = assert.rejects(old, { name: "AbortError" });
        await sleep(10);
        await state.cancel();
        await rejected;
        assert.equal(state.loading, false);
        state.resolveBaseRef = null;
        state.getSessionEvents = null;
        await state.refresh();
        const generation = state.reviewGeneration;
        release(pendingPhase === "base" ? "late-base" : []);
        await sleep(20);
        assert.equal(state.reviewGeneration, generation);
        assert.equal(state.refreshPromise, null);
        assert.equal(state.cancelled, false);
        assert.equal(state.baseRef, null);
        assert.equal(state.sessionContext, null);
        assert.equal(runs, pendingPhase === "base" ? 1 : 2);
        await state.dispose();
    }
});

test("last Canvas owner disposes cached state and only its exact marker", async (t) => {
    const path = await area(t);
    const previous = process.env.AGENT_REVIEW_STATE_DIR;
    process.env.AGENT_REVIEW_STATE_DIR = path;
    t.after(() => { if (previous === undefined) delete process.env.AGENT_REVIEW_STATE_DIR; else process.env.AGENT_REVIEW_STATE_DIR = previous; });
    const state = new ReviewState(root);
    state.model = { summary: {}, changes: [] };
    state.saveCurrentReview();
    state.annotations = { example: "saved" };
    const instances = new Map(["one", "two"].map((id) => [id, { state, server: { close: async () => {} } }]));
    const states = new Map([["repo", state]]);
    const lifecycle = new ReviewLifecycle({ sessionId: "owner" }, instances, states, new Map());
    t.after(() => lifecycle.dispose());
    for (const id of instances.keys()) {
        lifecycle.acquire(id, state);
        await lifecycle.register(id);
        await writeCanvasMarker({ sessionId: "owner", instanceId: id });
    }
    const unrelated = join(path, "user-file.json");
    await writeFile(unrelated, "user data");
    await lifecycle.closeInstance("one");
    assert.equal(state.disposed, false);
    assert.ok(state.model);
    await lifecycle.closeInstance("two");
    assert.equal(state.disposed, true);
    assert.equal(state.model, null);
    assert.equal(state.reviewCache.size, 0);
    assert.deepEqual(state.annotations, {});
    assert.equal(states.size, 0);
    assert.equal(await readFile(unrelated, "utf8"), "user data");
    await assert.rejects(access(markerFile("owner", "two")), { code: "ENOENT" });
    await assert.rejects(state.refresh(), /closed/);
});

test("dispose invalidates an in-flight AI result without resurrecting manually supplied review state", async () => {
    let finish;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const state = new ReviewState(root, {
        generateAnnotation: () => {
            started();
            return new Promise((resolve) => { finish = resolve; });
        },
    });
    state.model = {
        summary: {}, changes: [{ path: "main.py", status: "added" }],
        nodes: [], attention: [], coverage: {}, warnings: [],
    };
    const request = state.overviewFor();
    const rejected = assert.rejects(request, /review changed/);
    await ready;
    await state.dispose();
    finish("## Summary\n\n- Stale.\n\n## Review order\n\n- Stale.\n\n## Gaps\n\n- Stale.");
    await rejected;
    assert.equal(state.model, null);
    assert.deepEqual(state.annotations, {});
});

test("deleting a simulated owning session during Python graph stops actual analyze.py and clears its state", async (t) => {
    const path = await area(t);
    const workspacePath = join(path, "owning-session");
    const repo = join(path, "repo");
    const markers = join(path, "markers");
    for (const directory of [workspacePath, repo, markers]) await mkdir(directory);
    await execute("git", ["-C", repo, "init", "--quiet"]);
    await execute("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "commit", "--quiet", "--allow-empty", "-m", "Baseline"]);
    await writeFile(join(repo, "large.py"), Array.from({ length: 12000 },
        (_, index) => `def function_${index}(value):\n    return value + ${index}\n`).join("\n"));
    const previous = process.env.AGENT_REVIEW_STATE_DIR;
    process.env.AGENT_REVIEW_STATE_DIR = markers;
    t.after(() => { if (previous === undefined) delete process.env.AGENT_REVIEW_STATE_DIR; else process.env.AGENT_REVIEW_STATE_DIR = previous; });
    let analyzerPid;
    let deletePromise;
    const state = new ReviewState(repo, {
        workspacePath,
        runAnalyzer: (_repo, _base, progress, _ref, options) => runAnalyzer(
            repo, null,
            (event) => {
                progress(event);
                if (event.phase === "python_graph" && !deletePromise) deletePromise = rm(workspacePath, { recursive: true });
            },
            null, { ...options, onSpawn: (pid) => { analyzerPid = pid; } }),
    });
    const instances = new Map([["python", { state, server: { close: async () => {} } }]]);
    const states = new Map([["repo", state]]);
    const lifecycle = new ReviewLifecycle({ sessionId: "python-owner", workspacePath }, instances, states, new Map());
    t.after(() => lifecycle.dispose());
    lifecycle.acquire("python", state);
    await lifecycle.register("python");
    await writeCanvasMarker({ sessionId: "python-owner", instanceId: "python" });
    const pending = state.refresh().catch((error) => error);
    try { await until(() => state.disposed); }
    catch (error) {
        throw new Error(`${error.message} Analyzer state: ${JSON.stringify(state.snapshot())}; result: ${String(await pending)}`);
    }
    await lifecycle.dispose();
    await pending;
    assert.ok(analyzerPid);
    assert.equal(alive(analyzerPid), false);
    assert.equal(state.model, null);
    assert.equal(state.reviewCache.size, 0);
    await assert.rejects(access(markerFile("python-owner", "python")), { code: "ENOENT" });
    assert.equal(await readFile(join(repo, "large.py"), "utf8").then((text) => text.startsWith("def function_0")), true);
});

for (const scenario of ["session-directory-deletion", "provider-hard-kill", "provider-SIGTERM", "provider-graceful-shutdown"]) {
    test(`${scenario} stops analyzer tree, preserves live-session markers, and cleans on deletion`, async (t) => {
        const path = await area(t);
        const workspace = join(path, "owner-session");
        const markers = join(path, "markers");
        const pidFile = join(path, "pids.json");
        await mkdir(workspace);
        await mkdir(markers);
        const unrelated = join(markers, "another-session.json");
        await writeFile(unrelated, "preserve");
        const provider = spawn(process.execPath, [join(root, "cancellation-provider.mjs"), workspace, pidFile, markers],
            { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
        let diagnostics = "";
        provider.stderr.on("data", (chunk) => { diagnostics += chunk; });
        t.after(async () => {
            await killProvider(provider);
            await sleep(300);
        });
        const pids = await pidsAt(pidFile);
        assert.ok(pids.every(alive));
        if (scenario === "session-directory-deletion") await rm(workspace, { recursive: true });
        else if (scenario === "provider-hard-kill") await killProvider(provider);
        else if (scenario === "provider-graceful-shutdown") provider.send({ type: "shutdown" });
        else provider.kill("SIGTERM");
        await until(() => pids.every((pid) => !alive(pid)));
        if (scenario !== "session-directory-deletion") {
            await sleep(300);
            await access(markerFile("owned", "canvas", markers));
            await rm(workspace, { recursive: true });
        }
        await until(async () => {
            try { await access(markerFile("owned", "canvas", markers)); return false; }
            catch (error) { if (error.code === "ENOENT") return true; throw error; }
        });
        assert.equal(await readFile(unrelated, "utf8"), "preserve");
        assert.equal(diagnostics, "");
    });
}
