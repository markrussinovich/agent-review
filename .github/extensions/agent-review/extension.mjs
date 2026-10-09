import { joinSession } from "@github/copilot-sdk/extension";
import { canvas, initialize } from "./review-extension.mjs";

await initialize(await joinSession({ canvases: [canvas] }));
