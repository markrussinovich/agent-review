import { ReviewState, runAnalyzerProcess } from "../review-state.mjs";
import { ReviewLifecycle } from "../review-lifecycle.mjs";
import { writeCanvasMarker } from "../canvas-persistence.mjs";

const [workspacePath, pidFile, markerDirectory] = process.argv.slice(2);
process.env.AGENT_REVIEW_STATE_DIR = markerDirectory;
const treeCode = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
`;
const state = new ReviewState(workspacePath, {
    workspacePath,
    runAnalyzer: (_repo, _base, progress, _ref, options) =>
        runAnalyzerProcess(process.execPath, ["-e", treeCode], progress, options),
});
const instances = new Map([["canvas", { state, server: { close: async () => {} } }]]);
const states = new Map([["review", state]]);
const lifecycle = new ReviewLifecycle({ sessionId: "owned", workspacePath }, instances, states, new Map());
lifecycle.acquire("canvas", state);
await lifecycle.register("canvas");
await writeCanvasMarker({ sessionId: "owned", instanceId: "canvas" });
process.on("SIGTERM", () => lifecycle.dispose({ preserveMarkers: true }).then(() => process.exit(0)));
process.on("message", (message) => {
    if (message.type === "shutdown") lifecycle.dispose({ preserveMarkers: true }).then(() => process.exit(0));
});
state.refresh().catch((error) => {
    if (error.name !== "AbortError") console.error(error);
});
