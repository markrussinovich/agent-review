import { createHash } from "node:crypto";
import { join } from "node:path";
import { pythonCandidates } from "./python-runtime.mjs";
import { cargoTestCommand, cargoTestPlan, formatCargoTestCommand, resolveCargoRuntime, runCargoTests } from "./rust-test-run.mjs";
import { isTestPath } from "./web/languages.mjs";

function buildCodePathRequest(model) {
    const callables = (model?.symbols || []).filter((symbol) => symbol.language === "rust"
        && ["function", "method"].includes(symbol.kind)
        && ["added", "modified", "removed"].includes(symbol.classification)
        && !symbol.test && !isTestPath(symbol.path))
        .map((symbol) => ({ id: symbol.id, qualname: symbol.qualname, change: symbol.classification }));
    if (!callables.length) return null;
    const baseline = {};
    const current = {};
    const source_hashes = {};
    for (const [path, saved] of Object.entries(model.source_files || {})) {
        const rust = path.toLowerCase().endsWith(".rs");
        const cargoManifest = path.split(/[\\/]/).at(-1) === "Cargo.toml";
        if ((!rust && !cargoManifest) || saved?.binary) continue;
        if (typeof saved.baseline === "string") baseline[path] = saved.baseline;
        if (typeof saved.current === "string") {
            current[path] = saved.current;
            if (rust) source_hashes[path] = createHash("sha256").update(saved.current).digest("hex");
        }
    }
    return { baseline, current, callables, source_hashes };
}

export const RUST_REVIEW_ADAPTER = Object.freeze({
    id: "rust",
    buildCodePathRequest,
    sourcePath: (path) => String(path || "").toLowerCase().endsWith(".rs"),
    codePathProcess: (extensionRoot, input) => ({
        runtime: "Rust saved-snapshot syntax analyzer",
        candidates: pythonCandidates(),
        args: [join(extensionRoot, "analyzer", "rust_decisions.py"), "--input", input],
    }),
    tests: Object.freeze({
        plan: cargoTestPlan, resolveRuntime: resolveCargoRuntime, command: cargoTestCommand,
        formatCommand: formatCargoTestCommand, run: runCargoTests,
    }),
});
