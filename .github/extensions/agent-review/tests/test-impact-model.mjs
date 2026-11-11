import assert from "node:assert/strict";
import test from "node:test";
import { impactSlice } from "../web/impact-model.mjs";
import { planReview } from "../review-pipeline.mjs";

const model = () => ({
    nodes: [
        { id: "changed", name: "changed", kind: "function", path: "core.js", change: "modified", start_line: 1, end_line: 1 },
        { id: "caller", name: "caller", kind: "function", path: "caller.js", change: "unchanged", start_line: 1, end_line: 1 },
        { id: "entry", name: "entry", kind: "function", path: "entry.js", change: "unchanged" },
        { id: "dependency", name: "helper", kind: "function", path: "helper.js", change: "unchanged" },
        { id: "test", name: "test", kind: "function", path: "tests/core.test.js", change: "unchanged" },
    ],
    edges: [
        { id: "a", source: "caller", target: "changed", type: "calls", confidence: "high", evidence_ids: ["ea"] },
        { id: "b", source: "entry", target: "caller", type: "calls", confidence: "high", evidence_ids: ["eb"] },
        { id: "c", source: "changed", target: "dependency", type: "calls", evidence_ids: ["ec"] },
        { id: "d", source: "test", target: "changed", type: "calls", evidence_ids: ["ed"] },
    ],
    evidence: { ea: { path: "caller.js", line: 1 }, eb: {}, ec: {}, ed: {} },
    attention: [{ id: "finding", node_id: "changed" }],
    changes: [{ path: "core.js", status: "modified", lines_added: 1, lines_removed: 1 }],
    source_files: { "core.js": { current: "new", diff: "@@ -1 +1 @@\n-old\n+new\n" }, "caller.js": { current: "unchangedCaller();" } },
});
test("members tagged modified without their own line changes are shown unchanged, and edges carry short sentences", () => {
    const value = model();
    value.nodes.push(
        { id: "sibling", name: "Sibling", kind: "method", path: "core.js", change: "modified", metrics: { lines_added: 0, lines_removed: 0 } },
        { id: "elsewhere", name: "Receipt", kind: "method", path: "receipt.js", change: "modified", metrics: { lines_added: 0, lines_removed: 0 } },
        { id: "type", name: "Policy", kind: "class", path: "core.js", change: "modified", metrics: { lines_added: 0, lines_removed: 0 } },
    );
    value.edges.push({ id: "s", source: "sibling", target: "changed", type: "calls", evidence_ids: ["ea"] },
        { id: "r", source: "changed", target: "elsewhere", type: "calls", evidence_ids: ["ea"] },
        { id: "t", source: "changed", target: "type", type: "calls", evidence_ids: ["ea"] });
    const slice = impactSlice(value, "changed");
    assert.equal(slice.nodes.find((node) => node.id === "type").change, "modified", "classes and packages keep the analyzer's change flag");
    assert.equal(slice.nodes.find((node) => node.id === "sibling").change, "unchanged", "an untouched member of a modified file");
    assert.equal(slice.nodes.find((node) => node.id === "elsewhere").change, "unchanged", "a member whose file is not in the diff");
    assert.equal(slice.nodes.find((node) => node.id === "changed").change, "modified", "a member without line metrics keeps the analyzer flag");
    assert.equal(slice.edges.find((edge) => edge.id === "a").label, "calls · caller.js:1");
    assert.equal(slice.edges.find((edge) => edge.id === "c").label, "calls", "no evidence location, no invented one");
});
test("impact keeps unchanged consumers, separates dependencies and tests, and preserves edge direction", () => {
    const slice = impactSlice(model(), "finding");
    assert.equal(slice.nodes.find((node) => node.id === "caller").impact_role, "Potential consumer");
    assert.equal(slice.nodes.find((node) => node.id === "dependency").impact_role, "Dependency");
    assert.equal(slice.nodes.find((node) => node.id === "test").impact_role, "Related test");
    assert.equal(slice.edges.find((edge) => edge.id === "a").source, "caller");
    assert.deepEqual(slice.paths.caller, ["a"]);
    assert.equal(slice.boundary, 1);
});
test("expansion, cycles, evidence gaps and limits are explicit", () => {
    const value = model();
    value.edges.push({ id: "cycle", source: "changed", target: "entry", type: "calls", evidence_ids: ["ea"] });
    value.edges.push({ id: "unknown", source: "missing", target: "changed", type: "calls", evidence_ids: ["ea"] });
    const expanded = impactSlice(value, "changed", { depth: 4 });
    assert.equal(new Set(expanded.nodes.map((node) => node.id)).size, expanded.nodes.length);
    assert.ok(expanded.gaps.some((gap) => /lack resolved/.test(gap)));
    const limited = impactSlice(value, "changed", { maxNodes: 2 });
    assert.ok(limited.omitted > 0);
    assert.ok(limited.gaps.some((gap) => /omitted/.test(gap)));
    assert.ok(impactSlice(value, "missing").gaps.length);
});
test("review scheduling includes exact saved evidence for unchanged consumers", () => {
    const plan = planReview(model());
    const consumer = plan.units.find((unit) => unit.kind === "unchanged consumer");
    assert.equal(consumer.path, "caller.js");
    assert.equal(consumer.evidence[0].lines[0].text, "unchangedCaller();");
});
test("evidence and package findings retain an explicit focus instead of becoming selectionless", () => {
    const value = model();
    value.nodes.find((node) => node.id === "caller").end_line = 1;
    value.package_changes = [{ id: "package:npm:example", name: "example", change: "added" }];
    value.attention.push({ id: "package-finding", package_id: "package:npm:example" });
    assert.ok(impactSlice(value, "ea").seed_ids.includes("caller"));
    const slice = impactSlice(value, "package-finding");
    assert.equal(slice.nodes[0].name, "example");
    assert.ok(slice.gaps.some((gap) => /package example/.test(gap)));
    assert.ok(!slice.gaps.some((gap) => /Select a changed/.test(gap)));
});
test("an unchanged selected consumer is not mislabeled as changed", () => {
    const slice = impactSlice(model(), "caller");
    assert.equal(slice.nodes.find((node) => node.id === "caller").impact_role, "Selected focus");
    assert.equal(slice.counts["Selected focus"], 1);
});

test("limited C# caller counts are resolved lower bounds in every impact selection", () => {
    const value = model();
    value.nodes[0].relationships_incomplete = true;
    for (const subject of ["changed", "finding", "file:core.js"]) {
        const slice = impactSlice(value, subject);
        assert.equal(slice.counts["Potential consumer"], 1);
        assert.equal(slice.counts["Related test"], 1);
        assert.match(slice.gaps.join(" "), /counts include only resolved saved-source relationships/);
    }
});
