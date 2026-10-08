import assert from "node:assert/strict";
import test from "node:test";
import {
    nextReviewItem, parseReviewLedger, reviewProgress, reviewSnapshotKey, serializeReviewLedger,
} from "../web/review-ledger.mjs";

const model = (current) => ({
    metadata: { repo_root: "C:\\repo", base_sha: "base", head_sha: "head" },
    changes: [{ path: "src/app.js", status: "modified" }],
    source_files: { "src/app.js": { base: "return 1;\n", current } },
});
const target = { mode: "worktree" };
const plan = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("snapshot keys preserve unchanged reviews and invalidate changed source", () => {
    assert.equal(reviewSnapshotKey(model("return 2;\n"), target), reviewSnapshotKey(model("return 2;\n"), target));
    assert.notEqual(reviewSnapshotKey(model("return 2;\n"), target), reviewSnapshotKey(model("return 3;\n"), target));
});

test("ledger round trips dispositions, notes, and source locations", () => {
    const entries = new Map([["a", {
        disposition: "follow-up",
        note: "Exercise the error branch.",
        path: "src/app.js",
        line: 4,
        updated_at: "2026-10-08T00:00:00.000Z",
    }]]);
    assert.deepEqual(parseReviewLedger(serializeReviewLedger(entries)), entries);
    assert.throws(() => parseReviewLedger('{"a":{"disposition":"unknown"}}'), /Invalid review ledger entry/);
});

test("progress distinguishes completed work from unresolved follow-up", () => {
    const entries = new Map([
        ["a", { disposition: "reviewed" }],
        ["b", { disposition: "follow-up" }],
        ["c", { disposition: "accepted" }],
    ]);
    assert.deepEqual(reviewProgress(plan, entries), { completed: 2, followUp: 1, total: 3 });
    assert.equal(nextReviewItem(plan, entries).id, "b");
    entries.set("b", { disposition: "false-positive" });
    assert.equal(nextReviewItem(plan, entries), null);
});
