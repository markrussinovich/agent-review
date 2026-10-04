import assert from "node:assert/strict";
import test from "node:test";
import { findingsForNode, findingKey, isFindingClosed, orderFindings } from "../web/findings.mjs";

test("module finding counts and drilldown list include module-level and descendant findings", () => {
    const component = { id: "component", kind: "component" };
    const module = { id: "module", kind: "module", component_id: component.id };
    const klass = { id: "class", kind: "class", module_id: module.id, component_id: component.id };
    const other = { id: "other", kind: "module" };
    const model = { nodes: [component, module, klass, other] };
    const findings = [
        { id: "module-finding", node_id: module.id },
        { id: "class-finding", node_id: klass.id },
        { id: "other-finding", node_id: other.id },
        { id: "unknown-finding", node_id: "missing" },
    ];
    assert.deepEqual(findingsForNode(model, module, findings).map((item) => item.id), ["module-finding", "class-finding"]);
    assert.deepEqual(findingsForNode(model, klass, findings).map((item) => item.id), ["class-finding"]);
    assert.equal(findingsForNode(model, component, findings).length, 2);
});

test("closed findings sort last and aggregate closure covers all members", () => {
    const high = { id: "high", impact_score: 90, evidence_ids: ["e2", "e1"] };
    const low = { id: "low", impact_score: 10, evidence_ids: ["e3"] };
    const closed = new Set([findingKey(high)]);
    assert.equal(findingKey(high), findingKey({ ...high, evidence_ids: ["e1", "e2"] }));
    assert.deepEqual(orderFindings([high, low], closed).map((item) => item.id), ["low", "high"]);
    assert.equal(isFindingClosed({ members: [high, low] }, closed), false);
    closed.add(findingKey(low));
    assert.equal(isFindingClosed({ members: [high, low] }, closed), true);
    assert.equal(isFindingClosed({ ...high, evidence_ids: ["new-evidence"] }, closed), false);
});
