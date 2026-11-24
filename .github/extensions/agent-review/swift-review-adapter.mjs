import { join } from "node:path";
import { isSwiftPath } from "./swift-syntax.mjs";
import { swiftTestPlan, swiftTestCommand, formatSwiftTestCommand, resolveSwiftRuntime, runSwiftTests } from "./swift-test-run.mjs";

export const SWIFT_REVIEW_ADAPTER = Object.freeze({
    id: "swift",
    sourcePath: isSwiftPath,
    buildCodePathRequest: (model) => model.code_paths?.swift ? { precomputed: model.code_paths.swift } : null,
    codePathProcess: (root, input) => ({ runtime: "Swift Tree-sitter WASM", candidates: [[process.execPath, []]],
        args: [join(root, "swift-analyzer.mjs"), "--input", input] }),
    tests: Object.freeze({ plan: swiftTestPlan, resolveRuntime: resolveSwiftRuntime,
        command: swiftTestCommand, formatCommand: formatSwiftTestCommand, run: runSwiftTests }),
});
