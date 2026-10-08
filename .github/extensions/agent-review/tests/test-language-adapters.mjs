import assert from "node:assert/strict";
import test from "node:test";
import { buildCodePathRequests, mergeCodePathMaps, reviewAdapter, sourceAdapter, testAdapterForMap } from "../language-adapters.mjs";
import { buildDecisionRequest } from "../review-state.mjs";
import { isTestPath, languageForPath } from "../web/languages.mjs";
import { pythonCandidates } from "../python-runtime.mjs";

test("language support is shared and advertises implemented adapters only", () => {
    assert.equal(languageForPath("src/main.py").id, "python");
    assert.equal(languageForPath("App.cs").id, "csharp");
    assert.equal(languageForPath("cmd/main.go").id, "go");
    assert.equal(sourceAdapter("App.cs"), reviewAdapter("csharp"));
    assert.equal(sourceAdapter("cmd/main.go"), reviewAdapter("go"));
    for (const path of ["README.md", undefined]) {
        assert.equal(languageForPath(path), null);
        assert.equal(sourceAdapter(path), null);
    }
    assert.equal(sourceAdapter("src/main.py"), reviewAdapter("python"));
    for (const path of ["src/main.ts", "src/main.js", "ui/view.tsx", "ui/view.jsx", "lib/main.cjs", "lib/main.mjs"]) {
        assert.equal(languageForPath(path).id, "node");
        assert.equal(sourceAdapter(path), reviewAdapter("node"));
    }
    assert.equal(isTestPath("src/widget.test.ts"), true);
    assert.equal(isTestPath("tests/test_main.py"), true);
    assert.equal(isTestPath("pkg/widget_test.py"), true);
    assert.equal(isTestPath("pkg/widget.py"), false);
    assert.equal(isTestPath("pkg/widget_test.go"), true);
    assert.throws(() => reviewAdapter("typescript"), /No review adapter is installed/);
    assert.throws(() => testAdapterForMap({ adapter_ids: ["python", "csharp"] }), /combined execution is not implemented/);
});

test("Python code path requests and runtime routing retain existing behavior", () => {
    const model = {
        symbols: [{ id: "run", kind: "function", path: "main.py", classification: "added", qualname: "run" }],
        source_files: { "main.py": { current: "def run(): return 1" } }, changes: [], nodes: [],
    };
    const legacy = buildDecisionRequest(model, "C:\\repo");
    assert.deepEqual(buildCodePathRequests(model, "C:\\repo"), [{ ...legacy, adapter_id: "python" }]);
    assert.deepEqual(buildCodePathRequests({ symbols: [], source_files: {} }, "C:\\repo"), []);
    const parser = reviewAdapter().codePathProcess("C:\\extension", "C:\\request.json");
    assert.deepEqual(parser.args, ["C:\\extension\\analyzer\\decisions.py", "--input", "C:\\request.json"]);
    assert.deepEqual(parser.candidates, pythonCandidates());
    assert.equal(testAdapterForMap({ adapter_id: "python" }).tests.command({ executable: "py" }, { tests: [] })[2], "pytest");
});

test("adapter orchestration skips absent languages and rejects duplicate registrations", () => {
    const seen = [];
    const adapters = ["first", "absent", "second"].map((id) => ({
        id,
        buildCodePathRequest: (_model, repo) => {
            seen.push([id, repo]);
            return id === "absent" ? null : { files: [id] };
        },
    }));
    assert.deepEqual(buildCodePathRequests({}, "repo", adapters),
        [{ files: ["first"], adapter_id: "first" }, { files: ["second"], adapter_id: "second" }]);
    assert.deepEqual(seen, [["first", "repo"], ["absent", "repo"], ["second", "repo"]]);
    assert.throws(() => buildCodePathRequests({}, "repo", [adapters[0], adapters[0]]), /Duplicate review adapter/);
});

test("code path maps merge without losing per-language identities or evidence limits", () => {
    const python = { adapter_id: "python", callables: [{ id: "python:run" }], totals: { added: 2 }, warnings: [],
        elapsed_ms: 1, verification: { tests: [{ id: "test_run" }], omitted_tests: 1, test_files_examined: 1 } };
    const csharp = { adapter_id: "csharp", callables: [{ id: "csharp:run" }], totals: { added: 3, removed: 1 },
        limited: true, warnings: ["References missing"], elapsed_ms: 2,
        verification: { tests: [{ id: "RunTest" }], omitted_tests: 0, test_files_examined: 2, limited: true } };
    assert.equal(mergeCodePathMaps([python]), python, "single-language DTO passes through unchanged");
    const result = mergeCodePathMaps([python, csharp]);
    assert.deepEqual(result.totals, { added: 5, removed: 1 });
    assert.deepEqual(result.callables.map((item) => item.adapter_id), ["python", "csharp"]);
    assert.deepEqual(result.verification.tests.map((item) => item.adapter_id), ["python", "csharp"]);
    assert.equal(result.verification.test_files_examined, 3);
    assert.equal(result.verification.limited, true);
    assert.equal(result.limited, true);
    assert.equal(result.elapsed_ms, 3);
    assert.deepEqual(result.warnings, ["References missing"]);
    assert.throws(() => mergeCodePathMaps([python, { ...csharp, callables: [{ id: "python:run" }] }]), /duplicate callable ID/);
});
