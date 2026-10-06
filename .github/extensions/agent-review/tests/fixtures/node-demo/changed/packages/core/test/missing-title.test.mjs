import test from "node:test";
import assert from "node:assert/strict";
import { resolveReference } from "../src/resolver.js";

test("missing title returns null", () => {
  assert.equal(resolveReference({ title: "" }), null);
});
