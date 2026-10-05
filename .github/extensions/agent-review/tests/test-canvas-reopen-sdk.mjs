import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("SDK closes and reopens the same Canvas, reloads its provider, and preserves repo edits", {
    skip: !process.env.AGENT_REVIEW_SDK_PATH,
    timeout: 90000,
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
    await cp(sourceRoot, join(repo, ".github", "extensions", "agent-review"), {
        recursive: true,
        filter: (path) => !relative(sourceRoot, path).split(sep).some((part) => ["tests", "__pycache__"].includes(part)),
    });
    const modified = "def run():\n    return 2\n";
    await writeFile(join(repo, "main.py"), modified);
    session = await client.createSession({
        workingDirectory: repo, requestExtensions: true, requestCanvasRenderer: true,
        enableConfigDiscovery: true,
        infiniteSessions: { enabled: true }, availableTools: [],
        onPermissionRequest: async () => ({ kind: "denied-interactively-by-user" }),
    });
    const extensions = await session.rpc.extensions.list();
    const extension = extensions.extensions.find((item) => item.name === "agent-review" && item.source === "project");
    assert.ok(extension, JSON.stringify(extensions));
    if (extension.status !== "running") await session.rpc.extensions.enable({ id: extension.id });
    const canvases = await session.rpc.canvas.list();
    const canvas = canvases.canvases.find((item) => item.canvasId === "agent-review" && item.extensionId === extension.id);
    assert.ok(canvas, JSON.stringify(canvases));
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
                if (recovered.model && !recovered.loading) break;
                if (recovered.error) assert.fail(recovered.error);
            }
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
        }
        await sleep(200);
    }
    assert.ok(recovered?.model && !recovered.loading, "provider reload must reclaim the existing Canvas URL");
    assert.equal(recovered.model.summary.files_changed, 1);
    assert.match(recovered.model.source_files["main.py"].current, /return 2/);
    assert.equal(await readFile(join(repo, "main.py"), "utf8"), modified);
    assert.match((await git("status", "--short", "--", "main.py")).stdout, / M main\.py/);
    await session.rpc.canvas.close({ instanceId: second.instanceId });
});
