import { isSea } from "node:sea";

// Copilot's embedded executable is not a general-purpose Node interpreter.
export function nodeExecutable({ embedded = isSea(), bun = Boolean(process.versions.bun),
    executable = process.execPath } = {}) {
    return embedded || bun ? "node" : executable;
}
