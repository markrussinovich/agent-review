import assert from "node:assert/strict";
import test from "node:test";
import { unchangedDiffContext, diffSegments } from "../web/diff-context.mjs";

test("full-file segments mark changed lines per side and anchor removals and insertions", () => {
    const diff = [
        "--- a/x.py", "+++ b/x.py",
        "@@ -1,5 +1,5 @@", " keep", "-old", "+new", " keep", "-gone", " keep",
        "@@ -9,0 +10,2 @@", "+added 1", "+added 2",
        "@@ -20,2 +21,0 @@", "-tail 1", "-tail 2",
        "\\ No newline at end of file",
    ].join("\n");
    const segments = diffSegments(diff);
    assert.deepEqual([...segments.current], [[2, "modified"], [10, "add"], [11, "add"]]);
    assert.deepEqual([...segments.base], [[2, "modified"], [4, "delete"], [20, "delete"], [21, "delete"]]);
    assert.deepEqual([...segments.removedBefore], [[4, 1], [22, 2]], "removals anchor before the next current line");
    assert.deepEqual([...segments.addedBefore], [[10, 2]], "insertions anchor before the next base line");
    const added = diffSegments("@@ -0,0 +1,2 @@\n+a\n+b\n");
    assert.deepEqual([...added.current], [[1, "add"], [2, "add"]]);
    assert.deepEqual([...diffSegments("--- a/x\n+++ b/x\n").current], [], "headers are not changes");
});

const source = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
const text = (lines) => lines.join("\n");

test("referenced unchanged lines before and after a hunk retain both snapshot coordinates", () => {
    const current = [...source.slice(0, 10), "added", ...source.slice(10)];
    const diff = "@@ -10,2 +10,3 @@\n line 10\n+added\n line 11\n";
    const before = unchangedDiffContext({ diff, base: text(source), current: text(current), line: 2 });
    assert.deepEqual(before.find((row) => row.newLine === 2), { oldLine: 2, newLine: 2, content: "line 2" });
    const after = unchangedDiffContext({ diff, base: text(source), current: text(current), line: 20 });
    assert.deepEqual(after.find((row) => row.newLine === 20), { oldLine: 19, newLine: 20, content: "line 19" });
    assert.equal(unchangedDiffContext({ diff, base: text(source), current: text(current), line: 11 }), null);
});

test("context is bounded by adjacent hunks and supports baseline-focused references", () => {
    const current = [...source.slice(0, 10), "added", ...source.slice(10)];
    const diff = "@@ -10,2 +10,3 @@\n line 10\n+added\n line 11\n";
    const context = unchangedDiffContext({ diff, base: text(source), current: text(current), line: 9 });
    assert.equal(context.at(-1).newLine, 9, "does not duplicate existing hunk rows");
    const baseline = unchangedDiffContext({ diff, base: text(source), current: text(current), line: 20, side: "base" });
    assert.deepEqual(baseline.find((row) => row.oldLine === 20), { oldLine: 20, newLine: 21, content: "line 20" });
});

test("zero-length insert/delete ranges and multiple hunks map correctly", () => {
    const inserted = [...source.slice(0, 3), "new 1", "new 2", ...source.slice(3)];
    const insertDiff = "@@ -3,0 +4,2 @@\n+new 1\n+new 2\n";
    const insertedContext = unchangedDiffContext({ diff: insertDiff, base: text(source), current: text(inserted), line: 8 });
    assert.deepEqual(insertedContext.find((row) => row.newLine === 8), { oldLine: 6, newLine: 8, content: "line 6" });
    const deleted = [...source.slice(0, 9), ...source.slice(10)];
    const deleteDiff = "@@ -10 +9,0 @@\n-line 10\n";
    const deletedContext = unchangedDiffContext({ diff: deleteDiff, base: text(source), current: text(deleted), line: 12 });
    assert.deepEqual(deletedContext.find((row) => row.newLine === 12), { oldLine: 13, newLine: 12, content: "line 13" });
    const changed = [...source.slice(0, 3), "new 1", "new 2", ...source.slice(3, 19), ...source.slice(20)];
    const diff = `${insertDiff}@@ -20 +21,0 @@\n-line 20\n`;
    const context = unchangedDiffContext({ diff, base: text(source), current: text(changed), line: 26 });
    assert.deepEqual(context.find((row) => row.newLine === 26), { oldLine: 25, newLine: 26, content: "line 25" });
});

test("context is never fabricated for mismatched, unavailable, or invalid snapshots", () => {
    assert.equal(unchangedDiffContext({ diff: "", base: "before", current: "after", line: 1 }), null);
    assert.equal(unchangedDiffContext({ diff: "", base: null, current: "after", line: 1 }), null);
    assert.equal(unchangedDiffContext({ diff: "", base: "same", current: "same", line: 0 }), null);
    assert.equal(unchangedDiffContext({ diff: "", base: "same", current: "same", line: 3 }), null);
    const context = unchangedDiffContext({ diff: "", base: "one\r\ntwo\rthree", current: "one\ntwo\nthree", line: 2 });
    assert.equal(context[1].content, "two");
});
