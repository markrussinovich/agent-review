import test from "node:test";
import assert from "node:assert/strict";
import { resolveReference } from "../src/resolver.js";

test("resolves a title", () => {
  assert.equal(resolveReference({ title: " Agent Review " }), "Agent Review");
});
