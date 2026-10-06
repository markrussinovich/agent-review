import { join } from "node:path";
import { isTestPath } from "./web/languages.mjs";
import { linkedNodeTestPlan, resolveTestNode, nodeTestCommand, runLinkedNodeTests } from "./node-test-run.mjs";

export const NODE_SOURCE_EXTENSIONS = Object.freeze([".js", ".ts", ".jsx", ".tsx", ".cjs", ".mjs", ".cts", ".mts"]);
export const isNodeSourcePath = (path) => NODE_SOURCE_EXTENSIONS.some((extension) => String(path || "").toLowerCase().endsWith(extension));
const isNodeTestPath = (path) => isTestPath(String(path).replaceAll("\\", "/"))
    || /(?:^|[./\\])(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);

// Every source, including import dependencies, comes from the reviewed snapshot.
export function buildCodePathRequest(model, repoRoot) {
    const byPath = new Map();
    for (const symbol of model?.symbols || []) {
        if (!["function", "method"].includes(symbol.kind) || !["added", "modified", "removed"].includes(symbol.classification)
            || !isNodeSourcePath(symbol.path) || isNodeTestPath(symbol.path)) continue;
        const path = symbol.path.replaceAll("\\", "/");
        if (!byPath.has(path)) byPath.set(path, []);
        byPath.get(path).push({ id: symbol.id, qualname: symbol.qualname || symbol.name, change: symbol.classification });
    }
    if (!byPath.size) return null;
    const sources = [];
    const tests = [];
    const addedLines = new Map((model.changes || []).map((change) => [change.path.replaceAll("\\", "/"), change.added_lines || []]));
    for (const [originalPath, saved] of Object.entries(model.source_files || {})) {
        if (!isNodeSourcePath(originalPath) || saved?.binary) continue;
        const path = originalPath.replaceAll("\\", "/");
        sources.push({ path, baseline: saved?.baseline ?? saved?.base ?? null, current: saved?.current ?? null });
        if (isNodeTestPath(path) && typeof saved?.current === "string") {
            tests.push({ path, current: saved.current, added_lines: addedLines.get(path) || [] });
        }
    }
    const saved = new Map(sources.map((source) => [source.path, source]));
    return {
        repo: model.metadata?.repo_root || repoRoot, base_sha: model.metadata?.base_sha || null,
        files: [...byPath].map(([path, callables]) => ({
            path, baseline: saved.get(path)?.baseline ?? null, current: saved.get(path)?.current ?? null, callables,
        })),
        sources, tests,
    };
}

export const NODE_REVIEW_ADAPTER = Object.freeze({
    id: "node",
    buildCodePathRequest,
    sourcePath: isNodeSourcePath,
    codePathProcess: (extensionRoot, input) => ({
        runtime: "node",
        candidates: [[process.execPath, []]],
        args: [join(extensionRoot, "node-codepaths.mjs"), "--input", input],
    }),
    tests: Object.freeze({
        plan: linkedNodeTestPlan, resolveRuntime: resolveTestNode, command: nodeTestCommand, run: runLinkedNodeTests,
    }),
});
