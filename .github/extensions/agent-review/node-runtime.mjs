import { isSea } from "node:sea";

// Copilot's embedded executable is not a general-purpose Node interpreter.
export function nodeExecutable({ embedded = isSea(), bun = Boolean(process.versions.bun),
    executable = process.execPath, managed = process.env.AGENT_REVIEW_NODE } = {}) {
    return managed || (embedded || bun ? "node" : executable);
}
