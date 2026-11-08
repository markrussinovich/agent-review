import assert from "node:assert/strict";
import test from "node:test";
import { annotationCodeContext } from "../annotation-context.mjs";

const text = (count, label = "line") => Array.from({ length: count }, (_, i) => `${label} ${i + 1}`).join("\n");
const selected = { id: "function", name: "merge", kind: "function", path: "a.js",
    start_line: 1, end_line: 250, change: "modified" };
const context = (subject = selected) => ({ subject, evidence: {}, related_edges: [] });
const file = { id: "file:main.cpp", name: "main.cpp", path: "main.cpp", kind: "file", change: "modified",
    start_line: null, end_line: null };
const excerptText = (side) => side.ranges.map((range) => range.excerpt).join("\n");
const modifiedSnapshot = (count, edits) => {
    const base = text(count).split("\n"), current = [...base];
    for (const [line, value] of edits) current[line - 1] = value;
    return { base: base.join("\n"), current: current.join("\n"),
        diff: edits.map(([line, value]) => `@@ -${line} +${line} @@\n-${base[line - 1]}\n+${value}\n`).join("") };
};

test("unsupported file explanations include late edits instead of identical opening excerpts", async () => {
    const snapshot = modifiedSnapshot(300, [[250, "int limit() { return 20; }"]]);
    for (const path of ["main.cpp", "notes.txt"]) {
        const result = await annotationCodeContext({ nodes: [] }, context({ ...file, path }), async () => snapshot);
        assert.match(excerptText(result.current), /250: int limit\(\) \{ return 20; \}/);
        assert.match(excerptText(result.base), /250: line 250/);
        assert.notEqual(excerptText(result.base), excerptText(result.current));
        assert.deepEqual(result.current.requested_ranges, [[245, 255]]);
        assert.match(result.diff, /\+int limit/);
        assert.equal(result.evidence_limits.unrelated_diff_hunks, 0);
        assert.equal(result.evidence_limits.omitted_diff_hunks, 0);
        assert.deepEqual(result.current.changed_lines, { total: 1, included: 1 });
    }
});

test("file and module explanations include every distant edit, not just the first changed symbols", async () => {
    const edits = Array.from({ length: 8 }, (_, index) => [50 + index * 100, `changed ${index}`]);
    const snapshot = modifiedSnapshot(900, edits);
    const nodes = edits.map(([line], index) => ({ id: `symbol:${index}`, path: file.path, kind: "function",
        start_line: line, end_line: line + 2, change: "modified" }));
    for (const subject of [file, { ...file, kind: "module", start_line: 1, end_line: 900 }]) {
        const result = await annotationCodeContext({ nodes }, context(subject), async () => snapshot);
        for (const [line, value] of edits) {
            assert.match(excerptText(result.current), new RegExp(`${line}: ${value}`));
            assert.match(result.diff, new RegExp(`\\+${value}`));
        }
        assert.equal(result.current.requested_ranges.length, 8);
        assert.equal(result.evidence_limits.unrelated_diff_hunks, 0);
        assert.deepEqual(result.base.changed_lines, { total: 8, included: 8 });
    }
});

test("neighboring hunk context merges without duplicating source ranges", async () => {
    const snapshot = modifiedSnapshot(300, [[250, "changed first"], [255, "changed second"]]);
    const result = await annotationCodeContext({ nodes: [] }, context(file), async () => snapshot);
    assert.deepEqual(result.current.requested_ranges, [[245, 260]]);
    assert.deepEqual(result.base.requested_ranges, [[245, 260]]);
    assert.equal(result.current.ranges.length, 1);
    assert.deepEqual(result.current.changed_lines, { total: 2, included: 2 });
});

test("deletion-only edits use each side's hunk coordinates, including deletion at EOF", async () => {
    for (const line of [1, 250, 300]) {
        const base = text(300).split("\n"), current = [...base];
        current.splice(line - 1, 1);
        const result = await annotationCodeContext({ nodes: [] }, context(file), async () => ({
            base: base.join("\n"), current: current.join("\n"),
            diff: `@@ -${line} +${line - 1},0 @@\n-${base[line - 1]}\n`,
        }));
        assert.match(excerptText(result.base), new RegExp(`${line}: line ${line}(?:\\n|$)`));
        assert.match(result.diff, new RegExp(`-line ${line}`));
        assert.deepEqual(result.base.changed_lines, { total: 1, included: 1 });
        assert.deepEqual(result.current.changed_lines, { total: 0, included: 0 });
        assert.ok(result.current.requested_ranges.every(([start, end]) => start >= 1 && end <= current.length));
        assert.equal(result.evidence_limits.unrelated_diff_hunks, 0);
    }
});

test("insertion-only edits preserve the before context at the beginning and end of a file", async () => {
    for (const line of [1, 301]) {
        const base = text(300).split("\n"), current = [...base];
        current.splice(line - 1, 0, "inserted");
        const result = await annotationCodeContext({ nodes: [] }, context(file), async () => ({
            base: base.join("\n"), current: current.join("\n"),
            diff: `@@ -${line - 1},0 +${line} @@\n+inserted\n`,
        }));
        assert.match(excerptText(result.current), new RegExp(`${line}: inserted`));
        assert.ok(result.base.ranges.length);
        assert.deepEqual(result.current.changed_lines, { total: 1, included: 1 });
        assert.deepEqual(result.base.changed_lines, { total: 0, included: 0 });
    }
});

test("added, deleted, and emptied files retain their available changed sides", async () => {
    const source = text(300);
    const addedDiff = `@@ -0,0 +1,300 @@\n${source.split("\n").map((line) => `+${line}`).join("\n")}\n`;
    const removedDiff = `@@ -1,300 +0,0 @@\n${source.split("\n").map((line) => `-${line}`).join("\n")}\n`;
    const added = await annotationCodeContext({ nodes: [] }, context({ ...file, change: "added" }),
        async () => ({ base: null, current: source, diff: addedDiff }));
    assert.equal(added.base.available, false);
    assert.deepEqual(added.current.changed_lines, { total: 300, included: 300 });
    for (const current of [null, ""]) {
        const removed = await annotationCodeContext({ nodes: [] },
            context({ ...file, change: current === null ? "deleted" : "modified" }),
            async () => ({ base: source, current, diff: removedDiff }));
        assert.deepEqual(removed.base.changed_lines, { total: 300, included: 300 });
        assert.deepEqual(removed.current.ranges, []);
        assert.equal(removed.current.available, current !== null);
        assert.equal(removed.evidence_limits.unrelated_diff_hunks, 0);
    }
});

test("changed lines outrank unchanged boundaries in budget-limited symbol excerpts on both sides", async () => {
    const base = text(3000, "padding ".repeat(12)).split("\n"), current = [...base];
    base[1499] = "return oldWinner;";
    current[1499] = "return newWinner;";
    const result = await annotationCodeContext({ nodes: [] }, context({ ...selected, end_line: 3000 }),
        async () => ({ base: base.join("\n"), current: current.join("\n"),
            diff: "@@ -1500 +1500 @@\n-return oldWinner;\n+return newWinner;\n" }));
    assert.match(excerptText(result.current), /1500: return newWinner/);
    assert.match(excerptText(result.base), /1500: return oldWinner/);
    assert.equal(result.current.complete, false);
    assert.equal(result.base.complete, false);
    assert.deepEqual(result.current.changed_lines, { total: 1, included: 1 });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 48_000);
});

test("large changed hunks report omitted edits and remain within the explanation budget", async () => {
    const base = text(500, "old ".repeat(30)), current = text(500, "new ".repeat(30));
    const result = await annotationCodeContext({ nodes: [] }, context(file), async () => ({
        base, current, diff: `@@ -1,500 +1,500 @@\n${base.split("\n").map((line) => `-${line}`).join("\n")}\n`
            + `${current.split("\n").map((line) => `+${line}`).join("\n")}\n`,
    }));
    for (const side of [result.base, result.current]) {
        assert.equal(side.complete, false);
        assert.equal(side.changed_lines.total, 500);
        assert.ok(side.changed_lines.included > 0 && side.changed_lines.included < 500);
        assert.ok(side.omitted_ranges.length);
    }
    assert.equal(result.evidence_limits.omitted_diff_hunks, 1);
    assert.equal(result.evidence_limits.unrelated_diff_hunks, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 48_000);
});

test("oversized changed lines are omitted explicitly rather than mistaken for unchanged files", async () => {
    const snapshot = modifiedSnapshot(300, [[250, "x".repeat(30_000)]]);
    const result = await annotationCodeContext({ nodes: [] }, context(file), async () => snapshot);
    assert.equal(result.current.complete, false);
    assert.deepEqual(result.current.changed_lines, { total: 1, included: 0 });
    assert.ok(result.current.omitted_ranges.some((range) => range.start_line <= 250 && range.end_line >= 250));
    assert.equal(result.evidence_limits.omitted_diff_hunks, 1);
    assert.match(result.evidence_limits.note, /Identical bounded excerpts do not establish/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 48_000);
});

test("diff content resembling file headers is retained as changed source", async () => {
    const result = await annotationCodeContext({ nodes: [] }, context(file), async () => ({
        base: "-- old source", current: "++ new source",
        diff: "--- a/main.cpp\n+++ b/main.cpp\n@@ -1 +1 @@\n--- old source\n+++ new source\n",
    }));
    assert.match(result.diff, /--- old source\n\+\+\+ new source/);
    assert.deepEqual(result.base.changed_lines, { total: 1, included: 1 });
    assert.deepEqual(result.current.changed_lines, { total: 1, included: 1 });
});

test("selected bodies include behavior beyond the former 120-line cutoff on both sides", async () => {
    const source = text(250) + "\nreturn finalPrecedenceWinner;";
    const result = await annotationCodeContext({ nodes: [] }, context({ ...selected, end_line: 251 }),
        async () => ({ current: source, base: source, diff: "" }));
    assert.equal(result.current.complete, true);
    assert.equal(result.base.complete, true);
    assert.match(result.current.ranges[0].excerpt, /251: return finalPrecedenceWinner/);
    assert.match(result.base.ranges[0].excerpt, /251: return finalPrecedenceWinner/);
});

test("before ranges follow saved diff coordinates after earlier insertions and whole-block replacement", async () => {
    const result = await annotationCodeContext({ nodes: [] }, context({ ...selected, start_line: 5, end_line: 7 }),
        async () => ({ current: "intro\nadded\nadded\nspacer\nfunction merge() {\nreturn newWinner;\n}",
            base: "intro\nspacer\nfunction merge() {\nreturn oldWinner;\n}",
            diff: "@@ -1,2 +1,4 @@\n intro\n+added\n+added\n spacer\n@@ -3,3 +5,3 @@\n function merge() {\n-return oldWinner;\n+return newWinner;\n }\n" }));
    assert.deepEqual(result.base.requested_ranges, [[3, 5]]);
    assert.match(result.base.ranges[0].excerpt, /4: return oldWinner/);
    assert.match(result.current.ranges[0].excerpt, /6: return newWinner/);
    assert.doesNotMatch(result.diff, /\+added/);
    const replacement = await annotationCodeContext({ nodes: [] }, context({ ...selected, end_line: 2 }),
        async () => ({ current: "new start\nnew end", base: "old start\nold middle\nold end",
            diff: "@@ -1,3 +1,2 @@\n-old start\n-old middle\n-old end\n+new start\n+new end\n" }));
    assert.deepEqual(replacement.base.requested_ranges, [[1, 3]]);
    assert.match(replacement.base.ranges[0].excerpt, /old end/);
});

test("late-file selections receive their own source and diff rather than the first file hunk", async () => {
    const source = text(1500);
    const result = await annotationCodeContext({ nodes: [] }, context({ ...selected, start_line: 1400, end_line: 1420 }),
        async () => ({ current: source, base: source,
            diff: "@@ -1 +1 @@\n-old unrelated\n+new unrelated\n@@ -1400 +1400 @@\n-old decision\n+new decision\n" }));
    assert.equal(result.current.ranges[0].start_line, 1400);
    assert.match(result.diff, /new decision/);
    assert.doesNotMatch(result.diff, /unrelated/);
});

test("removed functions retain their baseline implementation and explicitly unavailable current text", async () => {
    const result = await annotationCodeContext({ nodes: [] }, context({ ...selected, change: "removed", end_line: 2 }),
        async () => ({ current: null, base: "function merge() {\nreturn oldWinner;",
            diff: "@@ -1,2 +0,0 @@\n-function merge() {\n-return oldWinner;\n" }));
    assert.equal(result.subject_side, "base");
    assert.equal(result.current.available, false);
    assert.match(result.base.ranges[0].excerpt, /oldWinner/);
});

test("huge code is bounded, retains its tail, and names exact omitted ranges without truncating source lines", async () => {
    const source = `${text(2000, "long ".repeat(20))}\nreturn tailWinner;`;
    const result = await annotationCodeContext({ nodes: [] }, context({ ...selected, end_line: 2001 }),
        async () => ({ current: source, base: source, diff: "" }));
    assert.equal(result.current.complete, false);
    assert.ok(result.current.omitted_ranges.length);
    assert.match(result.current.ranges.map((range) => range.excerpt).join("\n"), /return tailWinner/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 48_000);
});

test("consumer, dependency and test implementations accompany static relationships", async () => {
    const nodes = [
        { id: "caller", name: "exportCitation", path: "caller.js", start_line: 1, end_line: 3 },
        { id: "helper", name: "normalize", path: "helper.js", start_line: 1, end_line: 2 },
        { id: "test", name: "testFallback", path: "tests/merge.test.js", start_line: 1, end_line: 3 },
    ];
    const data = context({ ...selected, end_line: 3 });
    data.related_edges = [
        { source: "caller", target: "function", type: "calls" },
        { source: "function", target: "helper", type: "calls" },
        { source: "test", target: "function", type: "calls" },
    ];
    const result = await annotationCodeContext({ nodes }, data,
        async (path) => ({ current: path.startsWith("tests/") ? "testFallback\nassert.equal(merge(), expected);\nend" : text(3),
            base: text(3), diff: "" }));
    assert.deepEqual(result.usages.map((item) => item.role), ["consumer", "dependency"]);
    assert.match(result.tests[0].ranges[0].excerpt, /assert\.equal/);
    assert.match(result.evidence_limits.note, /not executed tests/);
});

test("unresolved test references supply assertions without being promoted to proven linkage or execution", async () => {
    const model = { nodes: [], source_files: {
        "tests/merge.test.js": { current: "const actual = merge({ value: 1 });\nassert.equal(actual.value, 1);\n" },
    } };
    const result = await annotationCodeContext(model, context({ ...selected, end_line: 3 }),
        async () => ({ current: text(3), base: text(3), diff: "" }));
    assert.equal(result.tests[0].path, "tests/merge.test.js");
    assert.match(result.tests[0].relationship, /linkage and execution are not established/);
    assert.match(result.tests[0].ranges[0].excerpt, /assert\.equal/);
});

test("same-file callsites do not replace callee bodies, and imported constants and lexical flags are supplied", async () => {
    const subject = { ...selected, module_id: "module", start_line: 10, end_line: 12 };
    const model = { evidence: { call: { path: "a.js", line: 11 } }, nodes: [
        { id: "helper", name: "parseDetails", path: "a.js", start_line: 2, end_line: 5 },
        { id: "defaults", kind: "module", name: "defaults", path: "defaults.js" },
    ], edges: [{ source: "module", target: "defaults", type: "imports" }] };
    const data = context(subject);
    data.related_edges = [{ source: subject.id, target: "helper", type: "calls", evidence_ids: ["call"] }];
    const source = ["const AS_CITED = Symbol();", "function parseDetails(text) {", "if (!text.includes('cited:')) return null;",
        "return parsed;", "}", "", "", "", "", "function merge(ref) {", "parseDetails(ref.text);", "return ref[AS_CITED];"].join("\n");
    const result = await annotationCodeContext(model, data, async (path) =>
        ({ current: path === "defaults.js" ? "export const DEFAULT_RETRIES = 3;\n" : source, base: source, diff: "" }));
    const helper = result.usages.find((item) => item.name === "parseDetails");
    assert.equal(helper.complete, true);
    assert.match(helper.ranges[0].excerpt, /cited:/);
    assert.match(result.usages.find((item) => item.path === "defaults.js").ranges[0].excerpt, /DEFAULT_RETRIES = 3/);
    assert.match(result.declarations[0].ranges[0].excerpt, /AS_CITED = Symbol/);
});
