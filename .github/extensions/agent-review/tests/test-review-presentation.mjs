import assert from "node:assert/strict";
import test from "node:test";
import { annotationSections, conciseReviewText, internalReviewPresentation, overviewBlurb, reviewCommands, reviewContext, reviewItemEvidence, reviewSignal } from "../web/review-presentation.mjs";

test("incomplete findings always carry analyzed coverage and uncertainty, even with supported findings", () => {
    for (const status of ["partial", "running", "cancelled", "error"]) {
        for (const findings of [[], [{ title: "Supported concern" }]]) {
            const result = internalReviewPresentation({ status, findings,
                coverage: { completed_files: 3, total_files: 10, completed_units: 26, total_units: 255 } });
            assert.match(result.notice, /3 of 10 changed files and 26 of 255 evidence units/);
            assert.match(result.notice, /Results incomplete.*may hide additional findings.*not a clean bill/);
            assert.equal(result.empty, "No supported findings so far.");
            assert.doesNotMatch(result.empty, /completed analysis/);
            if (status === "running") assert.match(result.notice, /Review in progress/);
            if (status === "cancelled") assert.match(result.notice, /Review stopped/);
        }
    }
    assert.match(internalReviewPresentation({ status: "partial",
        coverage: { completed_files: 10, total_files: 10, completed_units: 255, total_units: 255 },
        gaps: [{ reason: "Unverified candidate" }] }).notice, /Results incomplete/);
    assert.deepEqual(internalReviewPresentation({ status: "complete" }), { notice: "", empty: "No supported findings." });
});

test("static priority signals and AI-supported concerns are not labeled confirmed defects", () => {
    assert.equal(reviewSignal({ id: "attention:size" }).label, "Review priority");
    assert.equal(reviewSignal({ verification: "supported" }).label, "AI-supported concern");
    assert.equal(reviewSignal({ id: "observation:one" }).label, "Review observation");
});
test("concise card text is explicitly truncated rather than silently rewritten", () => {
    assert.equal(conciseReviewText("Short"), "Short");
    assert.ok(conciseReviewText("word ".repeat(100)).endsWith("…"));
    assert.ok(conciseReviewText("word ".repeat(100)).length <= 241);
});
test("the overview foregrounds a bounded behavioral summary without hiding the full explanation", () => {
    assert.equal(overviewBlurb("## Summary\n- Requested: No session intent was supplied; inspect the commit.\n- Policies now use seconds.\n## Gaps\n- Tests unknown."), "Policies now use seconds.");
    assert.equal(overviewBlurb(""), "");
    assert.ok(overviewBlurb(`## Summary\n- ${"word ".repeat(200)}`).length <= 361);
    const long = `## Summary\n- ${"first ".repeat(80).trim()}.\n- Second sentence.\n- Third sentence is only in the full text.\n## Gaps\n- None.`;
    assert.match(overviewBlurb(long), /…$/, "the Overview blurb is bounded");
    assert.match(overviewBlurb(long, { full: true }), /Second sentence\. Third sentence is only in the full text\.$/, "Show more reveals every summary bullet");
});
test("progressive explanations retain preambles and do not mistake fenced code for section headings", () => {
    const parsed = annotationSections("Context.\n## What changed\n- A change.\n```md\n## Not a real heading\n```\n## Verify\n- Check it.");
    assert.equal(parsed.preamble, "Context.");
    assert.deepEqual(parsed.sections.map((section) => section.title), ["What changed", "Verify"]);
    assert.match(parsed.sections[0].text, /Not a real heading/);
});
test("the command catalog exposes source symbols and changed files without pretending to search full source", () => {
    const model = { changes: [{ path: "a.js", status: "modified" }], nodes: [
        { id: "function", name: "run", kind: "function", path: "a.js", change: "modified" },
    ], attention: [{ id: "attention:one", node_id: "function", title: "Complexity increased" }], evidence: {} };
    const catalog = reviewCommands(model);
    assert.equal(catalog.length, 3);
    assert.equal(catalog.find((item) => item.id === "attention:one").path, "a.js");
    const ranked = reviewCommands({ ...model, nodes: [...model.nodes,
        { id: "vendor", name: "–", kind: "function", path: "vendor.min.js", change: "unchanged" },
        { id: "helper", name: "helper", kind: "function", path: "b.js", change: "unchanged" }] });
    assert.equal(ranked.some((item) => item.id === "vendor"), false, "nameless minified symbols are not listed");
    assert.deepEqual(Object.fromEntries(ranked.map((item) => [item.id, item.rank])),
        { "attention:one": 0, "file:a.js": 1, function: 2, helper: 3 });
    const evidence = reviewItemEvidence(model, model.attention[0]);
    assert.deepEqual(evidence.counts, { confirmed: 0, failing: 0, inferred: 0, unknown: 0 });
});

test("context separates static relationships, aggregate coverage and repository test outcomes from per-path proof", () => {
    const model = { changes: [{ path: "a.cs", status: "modified", lines_added: 3, lines_removed: 1 }],
        nodes: [{ id: "fn", kind: "method", path: "a.cs", change: "modified" },
            { id: "caller", kind: "method", path: "consumer.cs", change: "unchanged" }],
        edges: [{ id: "call", source: "caller", target: "fn", type: "calls", evidence_ids: ["proof"] }],
        evidence: { proof: { path: "consumer.cs", line: 2 } }, warnings: [],
        coverage: { available: true, changed_lines: { "a.cs": { total: 8, covered: 4 } } } };
    const context = reviewContext(model, { path: "a.cs", selected: { id: "fn" },
        run: { status: "complete", adapter_id: "csharp", counts: { passed: 6 } } });
    assert.equal(context.impact.counts["Potential consumer"], 1);
    assert.match(context.verification.join(" "), /6 passed.*outcomes alone do not prove/i);
    assert.match(context.verification.join(" "), /4\/8.*Not named-test or per-path proof/);
    assert.doesNotMatch(context.verification.join(" "), /with named-test execution evidence/);
    assert.match(context.gaps.join(" "), /Per-path test evidence is unavailable/);
});

test("context keeps stale execution, analysis failure and bounded explanation gaps visible", () => {
    const context = reviewContext({ nodes: [], edges: [], warnings: ["unresolved import"] }, {
        path: "a.js", decisionMap: { status: "error", error: "adapter failed" },
        run: { status: "complete", stale: true, counts: { passed: 2 } },
        annotation: { source_scope: { current_complete: false } },
    });
    assert.match(context.gaps.join(" "), /predates worktree changes/);
    assert.match(context.gaps.join(" "), /analysis failed: adapter failed/);
    assert.match(context.gaps.join(" "), /1 saved analyzer limitation/);
    assert.match(context.gaps.join(" "), /bounded excerpts/);
});

test("context uses the shared named-test execution classification without promoting static matches", () => {
    const model = { nodes: [{ id: "fn", kind: "function", path: "a.js", change: "modified" }], edges: [] };
    const decisionMap = { callables: [{ id: "fn", entries: [
        { status: "added", decision: { line: 2 }, evidence: { level: "asserted", tests: [{ id: "test" }] } },
        { status: "added", decision: { line: 3 } },
    ] }] };
    let context = reviewContext(model, { path: "a.js", selected: { id: "fn" }, decisionMap });
    assert.match(context.verification.join(" "), /static test associations, not execution proof/);
    assert.match(context.gaps.join(" "), /1 code path without linked-test evidence/);
    context = reviewContext(model, { path: "a.js", selected: { id: "fn" }, decisionMap,
        run: { status: "complete", counts: { passed: 1 }, executed: { "fn:2": [{ id: "test", outcome: "passed" }] } } });
    assert.match(context.verification.join(" "), /1 code path with named-test execution evidence/);
});
