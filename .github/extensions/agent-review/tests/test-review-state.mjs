import assert from "node:assert/strict";
import test from "node:test";

import { ReviewState } from "../review-state.mjs";

test("historical session search times out instead of remaining in loading state", async () => {
    const state = new ReviewState("C:\\repo", {
        currentSessionId: "current-session",
        getSessionEvents: async () => [],
        getHistoricalSessionContexts: () => new Promise(() => {}),
        historicalSessionTimeoutMs: 20,
    });

    await state.refreshSessionContext(false);
    assert.equal(state.attributionStatusForPath("src/feature.py").status, "loading");

    await new Promise((resolve) => setTimeout(resolve, 40));

    const status = state.attributionStatusForPath("src/feature.py");
    assert.equal(status.status, "error");
    assert.match(status.message, /exceeded 20 milliseconds/);
    assert.equal(state.sessionContext.historical_search_complete, true);
});

test("overview context summarizes churn split, ranked findings, and prompts deterministically", async () => {
    let received;
    const state = new ReviewState("C:\\repo", {
        generateAnnotation: async (context) => {
            received = context;
            return "## Summary\n\n- ok\n\n## Review order\n\n- a\n\n## Gaps\n\n- b";
        },
    });
    state.model = {
        summary: { files_added: 2 },
        changes: [
            { path: "src/app.py", status: "added", lines_added: 100, lines_removed: 0 },
            { path: "tests/test_app.py", status: "added", lines_added: 10, lines_removed: 0 },
            { path: "README.md", status: "unchanged", lines_added: 0, lines_removed: 0 },
        ],
        nodes: [{ id: "n1", name: "App", kind: "class", path: "src/app.py" }],
        attention: [
            { id: "a1", node_id: "n1", title: "Large implementation change", impact_score: 40, reason: "x" },
            { id: "a2", node_id: "n1", title: "Change has broad caller impact", impact_score: 70, reason: "y" },
        ],
        package_changes: [{ name: "packaging", change: "added", resolved_current: "25.0" }],
        coverage: { available: false },
        warnings: [],
    };
    const first = await state.overviewFor();
    assert.equal(received.kind, "overview");
    assert.deepEqual(received.totals, { source: { added: 100, removed: 0 }, tests: { added: 10, removed: 0 } });
    assert.equal(received.files.length, 2);
    assert.equal(received.findings.length, 1, "findings are deduplicated by subject");
    assert.equal(received.findings[0].impact_score, 70);
    assert.equal(received.analysis_quality.coverage_available, false);
    assert.equal(await state.overviewFor(), first, "overview is cached until refresh");
});

test("base ref is re-resolved on every refresh", async () => {
    let calls = 0;
    const state = new ReviewState("C:\\definitely-not-a-repo", {
        resolveBaseRef: async () => `ref-${++calls}`,
    });
    await state.refresh().catch(() => {});
    assert.equal(state.baseRef, "ref-1");
    await state.refresh().catch(() => {});
    assert.equal(state.baseRef, "ref-2");
});

test("package assessment is available before the Copilot explanation and both are cached", async () => {
  let explanations = 0;
  const state = new ReviewState("C:\\repo", {
    generatePackageExplanation: async () => {
      explanations += 1;
      return "## Why it was added\n\n- ok";
    },
  });
  state.model = { package_dependencies: [{ name: "demo", resolved_current: "1.0", declared_current: [] }] };
  state.packageAssessments.set("demo@1.0", { version: "1.0", risk: { level: "low" } });

  const fast = await state.packageRiskFor("demo", null, { explain: false });
  assert.equal(fast.assessment.risk.level, "low");
  assert.equal(fast.explanation, null);
  assert.equal(explanations, 0, "indicators do not wait for the model");

  const full = await state.packageRiskFor("demo");
  assert.match(full.explanation, /Why it was added/);
  await state.packageRiskFor("demo");
  assert.equal(explanations, 1, "explanation is generated once");
  assert.match((await state.packageRiskFor("demo", null, { explain: false })).explanation, /Why it was added/);
});
