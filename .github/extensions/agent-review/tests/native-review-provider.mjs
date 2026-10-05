import { readFile } from "node:fs/promises";
import { isSea } from "node:sea";
import { ReviewState } from "../review-state.mjs";
import { ReviewLifecycle } from "../review-lifecycle.mjs";
import { writeCanvasMarker } from "../canvas-persistence.mjs";
import { startReviewServer } from "../server.mjs";

const config = JSON.parse(await readFile(process.env.AGENT_REVIEW_NATIVE_CONFIG, "utf8"));
const state = new ReviewState(config.repo, {
    workspacePath: config.workspacePath,
    baseRef: config.baseRef,
    reviewTarget: config.reviewTarget,
});
const server = await startReviewServer(state, { port: config.port || 0 });
const lifecycle = new ReviewLifecycle(
    { sessionId: "native-review-test", workspacePath: config.workspacePath },
    new Map([["canvas", { state, server }]]),
    new Map([["review", state]]),
    new Map(),
);
lifecycle.acquire("canvas", state);
await lifecycle.register("canvas");
await writeCanvasMarker({
    sessionId: "native-review-test",
    instanceId: "canvas",
    port: server.port,
    input: { repoPath: config.repo },
});
console.log(JSON.stringify({ type: "ready", url: server.url, embedded: isSea(), execPath: process.execPath }));
process.once("SIGTERM", () => void lifecycle.dispose().then(() => process.exit(0)));
process.on("message", (message) => {
    if (message.type === "shutdown") void lifecycle.dispose().then(() => process.exit(0));
});
