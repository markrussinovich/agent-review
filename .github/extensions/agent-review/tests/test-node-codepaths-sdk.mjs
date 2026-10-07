import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("real SDK Canvas extracts Node code paths under the embedded Copilot host", {
    skip: !process.env.AGENT_REVIEW_SDK_PATH, timeout: 120000,
}, async (t) => {
    const { CopilotClient } = await import(pathToFileURL(process.env.AGENT_REVIEW_SDK_PATH).href);
    const repo = await mkdtemp(join(tmpdir(), "review-node-sdk-"));
    const previous = process.env.AGENT_REVIEW_STATE_DIR;
    process.env.AGENT_REVIEW_STATE_DIR = join(repo, ".git", "markers");
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    let session;
    const client = new CopilotClient({
        baseDirectory: join(repo, ".git", "copilot-home"), workingDirectory: repo,
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
    await writeFile(join(repo, "package.json"), '{"type":"module"}');
    await writeFile(join(repo, "main.js"), "export function resolve(ref) { return ref; }\n");
    await git("add", ".");
    await git("commit", "-qm", "baseline");
    await writeFile(join(repo, "main.js"), "export function resolve(ref) {\n  if (!ref) return null;\n  return ref;\n}\n");
    await cp(sourceRoot, join(repo, ".github", "extensions", "agent-review"), {
        recursive: true,
        filter: (path) => !relative(sourceRoot, path).split(sep).some((part) =>
            ["tests", "__pycache__", "bin", "obj", ".node-browser-work"].includes(part)),
    });
    session = await client.createSession({
        workingDirectory: repo, requestExtensions: true, requestCanvasRenderer: true,
        enableConfigDiscovery: true, infiniteSessions: { enabled: true }, availableTools: [],
        onPermissionRequest: async () => ({ kind: "denied-interactively-by-user" }),
    });
    const extensions = await session.rpc.extensions.list();
    const extension = extensions.extensions.find((item) => item.name === "agent-review" && item.source === "project");
    assert.ok(extension, JSON.stringify(extensions));
    if (extension.status !== "running") await session.rpc.extensions.enable({ id: extension.id });
    let canvas;
    for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
        const catalog = await session.rpc.canvas.list();
        canvas = catalog.canvases.find((item) => item.canvasId === "agent-review" && item.extensionId === extension.id);
        if (canvas) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(canvas, "project extension registers its Canvas");
    const opened = await session.rpc.canvas.open({
        canvasId: canvas.canvasId, extensionId: canvas.extensionId, instanceId: "node-runtime-test",
        input: { repoPath: repo, baseRef: "HEAD" },
    });
    let snapshot;
    for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
        snapshot = await (await fetch(`${opened.url}api/state`)).json();
        assert.equal(snapshot.error, null);
        if (snapshot.decision_map && snapshot.decision_map.status !== "loading") break;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(snapshot.decision_map?.status, "complete", snapshot.decision_map?.error || "code paths never completed");
    assert.equal(snapshot.decision_map.adapter_id, "node");
    const callable = snapshot.decision_map.callables.find((item) => item.qualname === "resolve");
    assert.ok(callable?.entries.some((entry) => entry.status === "added"), "new guard produces an added code path");
    assert.match(await readFile(join(repo, "main.js"), "utf8"), /if \(!ref\) return null/);
});
