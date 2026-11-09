import { join } from "node:path";
import { isCppSourcePath } from "./web/languages.mjs";
import { cppTestCommand, cppTestPlan, formatCppTestCommand, resolveCppTestRuntime, runCppTests } from "./cpp-test-run.mjs";

export const CPP_REVIEW_ADAPTER = Object.freeze({
    id: "cpp",
    sourcePath: isCppSourcePath,
    buildCodePathRequest: (model) => model.code_paths?.cpp ? { precomputed: model.code_paths.cpp } : null,
    codePathProcess: (root, input) => ({
        runtime: "C/C++ Tree-sitter WASM", candidates: [[process.execPath, []]],
        args: [join(root, "cpp-analyzer.mjs"), "--input", input],
    }),
    tests: Object.freeze({ plan: cppTestPlan, resolveRuntime: resolveCppTestRuntime,
        command: cppTestCommand, formatCommand: formatCppTestCommand, run: runCppTests }),
});
