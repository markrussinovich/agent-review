import { join } from "node:path";
import { pythonCandidates } from "./python-runtime.mjs";
import { dotnetTestCommand, dotnetTestPlan, formatDotnetTestCommand, resolveDotnetRuntime, runDotnetTests } from "./dotnet-test-run.mjs";

function buildCodePathRequest(model) {
    if (!(model?.symbols || []).some((symbol) => symbol.language === "csharp"
        && ["method", "property", "constructor", "function", "accessor"].includes(symbol.kind)
        && ["added", "modified", "removed"].includes(symbol.classification))) return null;
    if (model.code_paths?.csharp) {
        const paths = model.code_paths.csharp;
        const verification = paths.verification;
        return { precomputed: verification && Object.hasOwn(verification, "omitted_tests") &&
            !Object.hasOwn(verification, "omitted_test_candidates")
            ? { ...paths, verification: { ...verification,
                omitted_test_candidates: verification.omitted_tests, omitted_tests: 0 } } : paths };
    }
    const baseline = {};
    const current = {};
    for (const [path, saved] of Object.entries(model.source_files || {})) {
        if (saved.binary || !Object.hasOwn(saved, "baseline")) continue;
        if (!/\.(?:cs|csproj|slnx?|props|targets)$|(?:^|[\\/])(?:global\.json|nuget\.config|\.editorconfig)$/i.test(path)) continue;
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
