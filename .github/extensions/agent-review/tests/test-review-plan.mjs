import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPlan } from "../web/review-plan.mjs";

const node = {
    id: "resolver",
    kind: "function",
    name: "resolveReference",
    path: "src/resolver.js",
    start_line: 1,
    metrics: { lines_changed: 6, direct_callers: 2, transitive_callers: 1 },
};
const callable = {
    id: node.id,
    qualname: node.name,
    path: node.path,
    line: 1,
    entries: [
        { status: "added", decision: { line: 3 }, evidence: { level: "asserted", tests: [{ id: "test::empty" }] } },
        { status: "added", decision: { line: 6 }, evidence: { level: "exercised", tests: [{ id: "test::legacy" }] } },
    ],
};
const model = {
    nodes: [node],
    package_changes: [{
        id: "package:npm:colors",
        name: "colors",
        change: "added",
        usage_locations: ["src/view.js:2"],
        declared_current: [{ source: "package.json" }],
    }],
};
const findings = [
    { id: "complexity", node_id: node.id, title: "Complexity increased", impact_score: 58 },
    { id: "dependency", package_id: "package:npm:colors", title: "Dependency added", impact_score: 62 },
];
const decisionMap = { status: "complete", callables: [callable] };

test("review plan combines static impact, reach, churn, and inferred evidence gaps", () => {
    const plan = buildReviewPlan(model, decisionMap, null, findings);
    assert.deepEqual(plan.map((item) => item.title), ["resolveReference", "colors"]);
    assert.ok(plan[0].score > 62);
    assert.deepEqual(plan[0].evidence, {
        confirmed: 0,
        inferred: 2,
        untested: 0,
        entries: plan[0].evidence.entries,
    });
    assert.match(plan[0].reasons.join(" · "), /2 inferred paths.*3 callers.*6 changed lines/);
});

test("review plan reranks from actual linked-test evidence", () => {
    const run = {
        status: "complete",
        stale: false,
        ran: { resolver: 1 },
        executed: {
            "resolver:3": [{ id: "test::empty", outcome: "passed" }],
            "resolver:6": [],
        },
    };
    const [resolver] = buildReviewPlan(model, decisionMap, run, findings);
    assert.equal(resolver.evidence.confirmed, 1);
    assert.equal(resolver.evidence.untested, 1);
    assert.equal(resolver.preferred.entry.decision.line, 6);
    assert.match(resolver.reasons[0], /1 untested path/);
});
