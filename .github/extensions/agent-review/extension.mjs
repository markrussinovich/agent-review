import { joinSession } from "@github/copilot-sdk/extension";
import { prepareRuntimes } from "./managed-runtimes.mjs";
import { canvas, initialize } from "./review-extension.mjs";

// Runtimes are ready before the canvas registers; stdout belongs to the host protocol.
let last;
await prepareRuntimes({ onProgress: ({ message }) => message !== last && console.error("[agent-review]", last = message) });
await initialize(await joinSession({ canvases: [canvas] }));
