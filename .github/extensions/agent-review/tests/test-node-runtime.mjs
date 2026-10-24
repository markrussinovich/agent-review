import assert from "node:assert/strict";
import test from "node:test";
import { nodeExecutable } from "../node-runtime.mjs";
import { NODE_REVIEW_ADAPTER } from "../node-review-adapter.mjs";

test("embedded Copilot and Bun hosts use Node on PATH, ordinary Node uses its current executable", () => {
    assert.equal(nodeExecutable({ embedded: true, bun: false, executable: "copilot.exe", managed: "" }), "node");
    assert.equal(nodeExecutable({ embedded: false, bun: true, executable: "bun.exe", managed: "" }), "node");
    assert.equal(nodeExecutable({ embedded: false, bun: false, executable: "C:\\node\\node.exe", managed: "" }), "C:\\node\\node.exe");
    assert.deepEqual(NODE_REVIEW_ADAPTER.codePathProcess("C:\\extension", "C:\\request.json").candidates, [[nodeExecutable(), []]]);
});

test("managed Node takes precedence for embedded hosts and analyzer children without PATH changes", () => {
    assert.equal(nodeExecutable({ embedded: true, executable: "copilot.exe", managed: "C:\\private\\node.exe" }), "C:\\private\\node.exe");
    assert.equal(nodeExecutable({ embedded: false, executable: "old-node", managed: "C:\\private\\node.exe" }), "C:\\private\\node.exe");
});
