import assert from "node:assert/strict";
import test from "node:test";
import { nodeExecutable } from "../node-runtime.mjs";
import { NODE_REVIEW_ADAPTER } from "../node-review-adapter.mjs";

test("embedded Copilot and Bun hosts use Node on PATH, ordinary Node uses its current executable", () => {
    assert.equal(nodeExecutable({ embedded: true, bun: false, executable: "copilot.exe" }), "node");
    assert.equal(nodeExecutable({ embedded: false, bun: true, executable: "bun.exe" }), "node");
    assert.equal(nodeExecutable({ embedded: false, bun: false, executable: "C:\\node\\node.exe" }), "C:\\node\\node.exe");
    assert.deepEqual(NODE_REVIEW_ADAPTER.codePathProcess("C:\\extension", "C:\\request.json").candidates, [[nodeExecutable(), []]]);
});
