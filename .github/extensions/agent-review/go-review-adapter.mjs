import { join } from "node:path";
import { formatGoTestCommand, goTestCommand, goTestPlan, resolveTestGo, runGoTests } from "./go-test-run.mjs";
import { isTestPath } from "./web/languages.mjs";

export function buildCodePathRequest(model, repoRoot) {
    const byPath = new Map();
    for (const symbol of model?.symbols || []) {
        if (symbol.language !== "go" || !["function", "method"].includes(symbol.kind)
            || !["added", "modified", "removed"].includes(symbol.classification)
            || isTestPath(symbol.path)) continue;
        const path = String(symbol.path).replaceAll("\\", "/");
        if (!byPath.has(path)) byPath.set(path, []);
        byPath.get(path).push({ id: symbol.id, qualname: symbol.qualname || symbol.name,
            name: symbol.name, receiver: symbol.receiver || null, change: symbol.classification });
    }
    if (!byPath.size) return null;
    const sources = [];
    for (const [original, saved] of Object.entries(model.source_files || {})) {
        if (!original.toLowerCase().endsWith(".go") || saved?.binary) continue;
        sources.push({ path: original.replaceAll("\\", "/"), baseline: saved.baseline ?? null,
            current: saved.current ?? null });
    }
    const saved = new Map(sources.map((item) => [item.path, item]));
    return {
        repo: model.metadata?.repo_root || repoRoot, base_sha: model.metadata?.base_sha || null,
        files: [...byPath].map(([path, callables]) => ({
            path, baseline: saved.get(path)?.baseline ?? null, current: saved.get(path)?.current ?? null,
            callables,
        })),
        sources,
        tests: sources.filter((item) => isTestPath(item.path) && typeof item.current === "string"),
    };
}

export const GO_REVIEW_ADAPTER = Object.freeze({
    id: "go",
    buildCodePathRequest,
    sourcePath: (path) => String(path || "").toLowerCase().endsWith(".go"),
    codePathProcess: (extensionRoot, input) => ({
        runtime: "node (saved Go syntax extractor)",
        candidates: [[process.execPath, []]],
        args: [join(extensionRoot, "go-codepaths.mjs"), "--input", input],
    }),
    tests: Object.freeze({
        plan: goTestPlan, resolveRuntime: resolveTestGo, command: goTestCommand,
        formatCommand: formatGoTestCommand, run: runGoTests,
    }),
});
