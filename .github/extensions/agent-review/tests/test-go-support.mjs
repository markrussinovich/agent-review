import assert from "node:assert/strict";
import test from "node:test";
import { GO_REVIEW_ADAPTER, buildCodePathRequest } from "../go-review-adapter.mjs";
import { buildGoCodePathMap } from "../go-codepaths.mjs";
import { assessGoModuleRisk } from "../go-package-risk.mjs";
import { goTestCommand, goTestPlan } from "../go-test-run.mjs";
import { reviewAdapter, sourceAdapter } from "../language-adapters.mjs";
import { isReviewSymbol, isTestPath, languageForPath } from "../web/languages.mjs";
import { packageEvidenceLinks } from "../web/package-presentation.mjs";

const baseline = `package score
func Classify(value int) string {
 if value > 10 { return "high" }
 return "normal"
}`;
const current = `package score
func Classify(value int) string {
 if value < 0 { return "invalid" }
 if value >= 10 { return "high" }
 return "normal"
}`;
const testSource = `package score
import "testing"
func TestClassify(t *testing.T) {
 if got := Classify(10); got != "high" { t.Fatalf("bad") }
}`;

test("Go language registration, source labels, symbols, and tests are shared", () => {
    assert.equal(languageForPath("pkg/value.GO").id, "go");
    assert.equal(sourceAdapter("pkg/value.go"), reviewAdapter("go"));
    assert.equal(reviewAdapter("go"), GO_REVIEW_ADAPTER);
    assert.equal(isTestPath("pkg/value_test.go"), true);
    assert.equal(isReviewSymbol({ language: "go", kind: "struct" }), true);
});

test("Go code paths use saved sources and link Test functions without execution", () => {
    const model = { metadata: { repo_root: "C:\\repo" }, changes: [], symbols: [
        { id: "go:classify", language: "go", kind: "function", path: "score.go",
            classification: "modified", qualname: "Classify", name: "Classify" },
    ], source_files: {
        "score.go": { baseline, current },
        "score_test.go": { baseline: null, current: testSource },
    } };
    const request = buildCodePathRequest(model, "missing");
    assert.equal(request.files.length, 1);
    assert.equal(request.tests.length, 1);
    const map = buildGoCodePathMap(request);
    assert.equal(map.adapter_id, "go");
    assert.equal(map.callables.length, 1);
    assert.ok(map.callables[0].counts.added + map.callables[0].counts.changed > 0);
    assert.deepEqual(map.verification.tests.map((item) => item.id), ["score_test.go::TestClassify"]);
    assert.equal(map.callables[0].entries.some((entry) => entry.evidence?.level === "asserted"), true);
});

test("Go plans are exact, snapshot bounded, and explicitly warn about execution", () => {
    const map = { status: "complete", callables: [{ id: "go:f", path: "score.go", source_hash: "abc" }],
        verification: { tests: [{ id: "score_test.go::TestClassify", path: "score_test.go",
            package: ".", source_hash: "def", link: "direct" }] } };
    const plan = goTestPlan(map, "C:\\repo");
    assert.equal(plan.reason, null);
    assert.match(plan.prerequisites, /executes repository/);
    assert.deepEqual(goTestCommand({ executable: "go" }, plan),
        ["go", "test", ".", "-count=1", "-run", "^(?:TestClassify)$", "-json"]);
    assert.match(goTestPlan({ ...map, verification: { tests: [{ ...map.verification.tests[0],
        id: "..\\outside_test.go::TestClassify", package: ".." }] } }, "C:\\repo").reason, /outside/);
});

test("Go module assessment sends only exact coordinates to proxy and Go OSV", async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
        return { ok: true, json: async () => url.includes("proxy.golang.org")
            ? { Version: "v1.2.3", Time: "2025-01-01T00:00:00Z" } : { vulns: [] } };
    };
    const result = await assessGoModuleRisk("example.com/mod", "v1.2.3", { fetchImpl });
    assert.equal(result.ecosystem, "gomod");
    assert.equal(calls[1].body.package.ecosystem, "Go");
    assert.equal(calls[1].body.version, "v1.2.3");
    assert.match(packageEvidenceLinks("example.com/mod", "v1.2.3", null, "gomod").registry, /pkg\.go\.dev/);
});
