import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { ensureRuntimes } from "../.github/extensions/agent-review/managed-runtimes.mjs";
import { watchSessionOwnership } from "../.github/extensions/agent-review/ownership-guard.mjs";

// Downloads every pinned runtime for this platform with PATH discovery disabled, as on a machine without them.
const execute = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), "agent-review-runtimes-"));
const options = {
    cacheRoot: process.argv[2] || join(scratch, "tools"), embedded: true,
    env: { ...process.env, AGENT_REVIEW_NODE: "", AGENT_REVIEW_PYTHON: "", AGENT_REVIEW_DOTNET: "" },
    run: (command, args, settings) => isAbsolute(command) ? execute(command, args, settings)
        : Promise.reject(Object.assign(new Error(`${command} is hidden`), { code: "ENOENT" })),
};
let guard, last;
try {
    const runtimes = await ensureRuntimes({ ...options, onProgress: ({ message }) => message !== last && console.log(last = message) });
    assert.deepEqual(await ensureRuntimes({ ...options,
        fetchArchive: () => assert.fail("Prepared runtimes must work offline.") }), runtimes);
    process.env.AGENT_REVIEW_NODE = runtimes.AGENT_REVIEW_NODE;
    guard = watchSessionOwnership(scratch, () => assert.fail("The workspace still exists."));
    await writeFile(join(scratch, "canvas.json"), "{}");
    await guard.registerMarker(join(scratch, "canvas.json"));
    console.log("Pinned runtimes installed, reused offline, and started the ownership guard.");
} finally {
    await guard?.close();
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
