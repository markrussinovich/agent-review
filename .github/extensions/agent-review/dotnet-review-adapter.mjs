import { join } from "node:path";
import { pythonCandidates } from "./python-runtime.mjs";
import { dotnetTestCommand, dotnetTestPlan, formatDotnetTestCommand, resolveDotnetRuntime, runDotnetTests } from "./dotnet-test-run.mjs";

function buildCodePathRequest(model) {
    if (!(model?.symbols || []).some((symbol) => symbol.language === "csharp"
        && ["method", "property"].includes(symbol.kind)
        && ["added", "modified", "removed"].includes(symbol.classification))) return null;
    const baseline = {};
    const current = {};
    for (const [path, saved] of Object.entries(model.source_files || {})) {
        if (saved.binary || !Object.hasOwn(saved, "baseline")) continue;
        if (typeof saved.baseline === "string") baseline[path] = saved.baseline;
        if (typeof saved.current === "string") current[path] = saved.current;
    }
    return { baseline, current };
}

export const DOTNET_REVIEW_ADAPTER = Object.freeze({
    id: "csharp",
    buildCodePathRequest,
    sourcePath: (path) => String(path || "").toLowerCase().endsWith(".cs"),
    codePathProcess: (extensionRoot, input) => ({
        runtime: "C# / .NET (prepared Roslyn helper and Python coordinator)",
        candidates: pythonCandidates(),
        args: [join(extensionRoot, "analyzer", "dotnet_decisions.py"), "--input", input],
    }),
    tests: Object.freeze({
        plan: dotnetTestPlan,
        resolveRuntime: resolveDotnetRuntime,
        command: dotnetTestCommand,
        formatCommand: formatDotnetTestCommand,
        run: runDotnetTests,
    }),
});
