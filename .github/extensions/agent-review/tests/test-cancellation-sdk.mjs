import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ReviewState, runAnalyzerProcess } from "../review-state.mjs";
import { ReviewLifecycle } from "../review-lifecycle.mjs";
import { markerFile, writeCanvasMarker } from "../canvas-persistence.mjs";

test("SDK disposable session.delete removes workspace and triggers analyzer ownership cleanup", {
    skip: !process.env.AGENT_REVIEW_SDK_PATH,
    timeout: 45000,
}, async (t) => {
    const { CopilotClient } = await import(pathToFileURL(process.env.AGENT_REVIEW_SDK_PATH).href);
    const root = join(dirname(fileURLToPath(import.meta.url)), `.cancellation-sdk-${randomUUID()}`);
    await mkdir(root);
    const previous = process.env.AGENT_REVIEW_STATE_DIR;
    process.env.AGENT_REVIEW_STATE_DIR = join(root, "markers");
    const client = new CopilotClient({
        baseDirectory: join(root, "copilot-home"),
        workingDirectory: root,
        connection: { kind: "stdio", ...(process.env.AGENT_REVIEW_CLI_PATH ? { path: process.env.AGENT_REVIEW_CLI_PATH } : {}) },
    });
    let session;
    let deleted = false;
    let lifecycle;
    t.after(async () => {
        if (lifecycle) await lifecycle.dispose();
        if (session && !deleted) await client.deleteSession(session.sessionId);
        await client.stop();
        if (previous === undefined) delete process.env.AGENT_REVIEW_STATE_DIR;
        else process.env.AGENT_REVIEW_STATE_DIR = previous;
        await rm(root, { recursive: true, force: true });
    });
    session = await client.createSession({
        workingDirectory: root,
        infiniteSessions: { enabled: true },
        availableTools: [],
        onPermissionRequest: async () => ({ kind: "denied-interactively-by-user" }),
    });
    assert.ok(session.workspacePath, "SDK must expose an owning session workspace");
    await access(session.workspacePath);
    let analyzerPid;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const state = new ReviewState(root, {
        workspacePath: session.workspacePath,
        runAnalyzer: (_repo, _base, progress, _ref, options) => runAnalyzerProcess(
            process.execPath, ["-e", "setInterval(() => {}, 1000)"], progress,
            { ...options, onSpawn: (pid) => { analyzerPid = pid; started(); } }),
    });
    const instances = new Map([["disposable", { state, server: { close: async () => {} } }]]);
    lifecycle = new ReviewLifecycle(session, instances, new Map([["repo", state]]), new Map());
    lifecycle.acquire("disposable", state);
    await lifecycle.register("disposable");
    await writeCanvasMarker({ sessionId: session.sessionId, instanceId: "disposable" });
    const pending = state.refresh().catch((error) => error);
    await ready;
    await client.deleteSession(session.sessionId);
    deleted = true;
    await assert.rejects(access(session.workspacePath), { code: "ENOENT" });
    const deadline = Date.now() + 8000;
    while (!state.disposed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(state.disposed, true);
    await lifecycle.dispose();
    await pending;
    assert.throws(() => process.kill(analyzerPid, 0), { code: "ESRCH" });
    assert.equal(state.model, null);
    await assert.rejects(access(markerFile(session.sessionId, "disposable")), { code: "ENOENT" });
});
