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

test("overview includes bounded saved implementation and test evidence, never live files", () => {
    const state = new ReviewState("C:\\repo");
    state.readCurrentSource = () => { throw new Error("must use frozen review evidence"); };
    state.model = {
        summary: {}, metadata: {}, nodes: [], attention: [], coverage: {}, warnings: [],
        changes: [
            { path: "src/checker.py", status: "modified", lines_added: 2, lines_removed: 1 },
            { path: "tests/test_checker.py", status: "added", lines_added: 50, lines_removed: 0 },
        ],
        source_files: {
            "src/checker.py": { current: "def accept(number):\n    return number.isdigit()\n",
                diff: "@@ -1 +1,2 @@\n-def accept(): pass\n+def accept(number):\n+    return number.isdigit()\n" },
            "tests/test_checker.py": { current: "def test_rejects_letters():\n    assert not accept('bad')\n",
                diff: "+def test_rejects_letters():\n+    assert not accept('bad')\n" + "x".repeat(45000) },
        },
    };
    const context = state.overviewContext();
    assert.match(context.code_context.find((file) => file.path === "src/checker.py").current, /2:.*isdigit/);
    assert.match(context.code_context.find((file) => file.path === "tests/test_checker.py").current, /rejects_letters/);
    assert.equal(context.evidence_limits.truncated, true);
    assert.ok(context.code_context.reduce((count, file) => count + file.diff.length + file.current.length, 0) <= 40000);
});

test("empty worktree, commit and PR reviews skip automatic custom checks and summaries", async () => {
    let summaries = 0, customRuns = 0;
    const state = new ReviewState("C:\\repo", {
        generateAnnotation: async () => { summaries += 1; return "## Summary\n\n- Empty commit."; },
    });
    state.model = { summary: {}, changes: [], nodes: [], attention: [], coverage: {}, warnings: [] };
    state.runCustomAnalyses = async () => { customRuns += 1; return []; };
    for (const mode of ["worktree", "commit", "pr"]) {
        state.reviewTarget = { mode };
        state.startCustomAnalyses();
        await assert.rejects(state.overviewFor(), /no changes to summarize/);
    }
    assert.equal(summaries, 0);
    assert.equal(customRuns, 0);
});

test("automatic summary captures originating history only after the bounded search finishes", async () => {
    let finishHistory, received;
    const history = new Promise((resolve) => { finishHistory = resolve; });
    const state = new ReviewState("C:\\repo", {
        getHistoricalSessionContexts: () => history,
        generateAnnotation: async (context) => { received = context; return "## Summary\n\n- Feature.\n\n## Review order\n\n- Source.\n\n## Gaps\n\n- Coverage."; },
    });
    state.model = { summary: {}, changes: [{ path: "main.py", status: "added", lines_added: 1, lines_removed: 0 }], nodes: [], attention: [], coverage: {}, warnings: [] };
    const request = state.overviewFor();
    assert.equal(received, undefined);
    finishHistory({ contexts: [{ session_id: "authoring", turns: [],
        intent: [{ timestamp: "2026-10-03T10:00:00Z", summary: "Implement YAML configuration importing." }],
        recent_activity: [], referenced_files: [], event_count: 1 }], failures: [] });
    await request;
    assert.deepEqual(received.session_intent, ["Implement YAML configuration importing."]);
    assert.equal(state.sessionContext.historical_search_complete, true);
});

test("commit summary intent cannot borrow goals from a newer same-repository feature", () => {
    const state = new ReviewState("C:\\repo", { reviewTarget: { mode: "commit" } });
    state.model = { summary: {}, metadata: { generated_at: "2026-10-03T10:00:00Z" },
        changes: [{ path: "src/app.py", status: "modified", lines_added: 1, lines_removed: 1 }],
        nodes: [], attention: [], coverage: {}, warnings: [] };
    const turn = (id, timestamp, prompt) => ({ id, session_id: id, started_at: timestamp, prompt,
        prompt_event_id: id, referenced_files: ["src/app.py"],
        agent_activity: [{ timestamp, operation: "write", referenced_files: ["src/app.py"], summary: prompt }] });
    state.sessionContext = {
        turns: [turn("old", "2026-10-03T09:00:00Z", "Create cron planning."),
            turn("new", "2026-10-03T11:00:00Z", "Create YAML importing.")],
        intent: [{ timestamp: "2026-10-03T09:00:00Z", summary: "Create cron planning." },
            { timestamp: "2026-10-03T11:00:00Z", summary: "Create YAML importing." }],
    };
    assert.deepEqual(state.overviewContext().session_intent, ["Create cron planning."]);
    assert.equal(state.overviewContext().session_attribution[0].prompt, "Create cron planning.");
    state.reviewTarget = { mode: "worktree" };
    assert.equal(state.overviewContext().session_attribution[0].prompt, "Create YAML importing.");
    state.lastAnalyzedAt = "2026-10-03T10:00:00Z";
    assert.equal(state.overviewContext().session_attribution[0].prompt, "Create cron planning.", "a saved worktree also excludes edits after its analysis");
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

test("analysis progress never moves backward when adapters report overlapping ranges", async () => {
    const percentages = [];
    const state = new ReviewState("C:\\repo", {
        resolveBaseRef: async () => null,
        getSessionEvents: async () => [],
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        runAnalyzer: async (_repo, _base, onProgress) => {
            for (const percent of [42, 58, 67, 42, 55, 68]) {
                onProgress({ phase: "graph", message: `Graph ${percent}`, percent });
            }
            return {
                metadata: {}, summary: {}, changes: [], source_files: {}, symbols: [],
                nodes: [], edges: [], attention: [], coverage: {}, warnings: [],
            };
        },
    });
    state.subscribe((event) => {
        if (event.type === "progress") percentages.push(event.progress.percent);
    });

    await state.refresh();

    assert.deepEqual(percentages, [42, 58, 67, 67, 67, 68]);
});

test("summary from an older analysis cannot overwrite the current review", async () => {
    let finish;
    const state = new ReviewState("C:\\repo", { generateAnnotation: () => new Promise((resolve) => { finish = resolve; }) });
    state.model = { nodes: [], changes: [{ path: "main.py", status: "added", lines_added: 1, lines_removed: 0 }], attention: [], warnings: [], coverage: {}, metadata: {}, summary: {} };
    const pending = state.overviewFor();
    state.reviewGeneration += 1;
    finish("## Summary\n\n- Old review.");
    await assert.rejects(pending, /review changed/i);
    assert.equal(state.annotations.overview, undefined);
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

test("package risk uses the project pin and rejects a different requested version", async () => {
    const state = new ReviewState("C:\\repo");
    state.model = { package_dependencies: [{
        name: "demo", resolved_current: "9.9", declared_current: [{ specifier: "==1.0" }],
    }] };
    const calls = [];
    state.packageAssessmentFor = async (key, name, version) => {
        calls.push({ key, name, version });
        return { version };
    };
    assert.equal((await state.packageRiskFor("demo", null, { explain: false })).assessment.version, "1.0");
    await assert.rejects(state.packageRiskFor("demo", "9.9", { explain: false }), /does not match the reviewed project version/);
    assert.deepEqual(calls, [{ key: "demo@1.0", name: "demo", version: "1.0" }]);
});

test("unresolved ranges and conflicting pins cannot produce a clean vulnerability result", async () => {
    for (const declarations of [[">=1,<3"], ["==1.*"], ["==1.0", "==2.0"]]) {
        const state = new ReviewState("C:\\repo");
        state.model = { package_dependencies: [{
            name: "demo", resolved_current: null,
            declared_current: declarations.map((specifier) => ({ specifier })),
        }] };
        state.packageAssessmentFor = async () => { throw new Error("Unexpected vulnerability query"); };
        await assert.rejects(state.packageRiskFor("demo", "2.0", { explain: false }), /exact project version|Conflicting project version pins/);
    }
});

test("unresolved reportlab range permits metadata and Copilot explanation without inventing a version", async () => {
    let received, explanations = 0;
    const state = new ReviewState("C:\\repo", {
        generatePackageExplanation: async (context) => {
            received = context;
            explanations++;
            return "## Why it was added\n\n- PDF report generation.";
        },
    });
    state.model = { package_dependencies: [{
        name: "reportlab", resolved_current: null, declared_current: [{ specifier: ">=4.0" }], usage_locations: [],
    }] };
    const calls = [];
    state.packageAssessmentFor = async (key, name, version) => {
        calls.push({ key, name, version });
        return { version, risk: { level: "unknown", score: null }, indicators: { vulnerability_count: null } };
    };
    const fast = await state.packageRiskFor("reportlab", null, { explain: false });
    assert.equal(explanations, 0);
    assert.equal(fast.assessment.version, null);
    const full = await state.packageRiskFor("reportlab");
    assert.match(full.explanation, /PDF report/);
    assert.equal(received.dependency.declared_current[0].specifier, ">=4.0");
    assert.equal(received.assessment.version, null);
    assert.equal(received.assessment.risk.level, "unknown");
    assert.ok(calls.every((call) => call.key === "reportlab@<unresolved>" && call.version === null));
    await state.packageRiskFor("reportlab");
    assert.equal(explanations, 1);
    await assert.rejects(state.packageRiskFor("reportlab", "4.0"), /exact project version/);
});

test("removed symbols and their findings focus baseline source in a surviving file", async () => {
    const state = new ReviewState("C:\\repo");
    const source = { base: "def removed():\n    pass\n", current: "def replacement():\n    pass\n" };
    state.sourceForPath = async () => source;
    for (const context of [
        { item: { path: "main.py", change: "removed", start_line: 1 }, subject: null },
        { item: { type: "signature" }, subject: { change: "removed" },
            evidence: { e: { kind: "signature", path: "main.py", line: 1 } } },
    ]) {
        state.contextFor = () => context;
        assert.equal((await state.sourceFor("removed")).focus_side, "base");
    }
});
