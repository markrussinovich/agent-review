import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolveReference } from "../src/resolver.js";

if (process.env.AGENT_REVIEW_NODE_DEMO_MARKER) {
  writeFileSync(process.env.AGENT_REVIEW_NODE_DEMO_MARKER, "Explicit node:test execution\n");
}

test("resolves a title", () => {
  assert.equal(resolveReference({ title: " Agent Review " }), "Agent Review");
});
