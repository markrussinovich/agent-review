import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { loadNodeCoverage, snapshotChangedLines } from "../node-coverage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
const lcov = "SF:src/subject.js\nDA:1,2\nDA:2,0\nend_of_record\n";
const source = "return 1;\nreturn 2;\n";
const unavailable = { available: false, files: [], changed_lines: {} };
async function fixture(t) {
    const root = await mkdtemp(join(here, ".coverage-import-fixture-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

test("LCOV import requires exact saved source association and remains aggregate-only", async (t) => {
    const repo = await fixture(t);
    const current = { "src/subject.js": source, "coverage/lcov.info": lcov,
        "coverage/sources.json": JSON.stringify({ "src/subject.js": source }) };
    const result = await loadNodeCoverage({ repo, current, baseline: { "src/subject.js": "return 0;\nreturn 2;\n" }, historical: true });
    assert.equal(result.available, true);
    assert.deepEqual(result.files[0].covered_lines, [1]);
    assert.deepEqual(result.files[0].missing_lines, [2]);
    assert.deepEqual(result.changed_lines["src/subject.js"].covered_lines, [1]);
    assert.deepEqual(result.changed_lines["src/subject.js"].uncovered_lines, []);
    assert.equal("tests" in result, false);
    current["coverage/sources.json"] = JSON.stringify({ "src/subject.js": "stale" });
    const stale = await loadNodeCoverage({ repo, current, historical: true });
    assert.equal(stale.available, false);
    assert.match(stale.warnings[0], /does not match snapshot/);
});

test("historical imports never read live reports or live manifests", async (t) => {
    const repo = await fixture(t);
    await mkdir(join(repo, "coverage"));
    await writeFile(join(repo, "coverage", "lcov.info"), lcov);
    await writeFile(join(repo, "coverage", "sources.json"), JSON.stringify({ "src/subject.js": source }));
    const current = { "src/subject.js": source };
    assert.deepEqual(await loadNodeCoverage({ repo, current, historical: true }), unavailable);
    assert.equal((await loadNodeCoverage({ repo, current })).available, true);
    current["coverage/lcov.info"] = lcov;
    assert.equal((await loadNodeCoverage({ repo, current, historical: true })).available, false);
});

test("Istanbul statement counters and hashes validate against saved source, not worktree", async (t) => {
    const repo = await fixture(t);
    const record = {
        path: "src/subject.js", sourceHash: createHash("sha256").update(source).digest("hex"),
        statementMap: { a: { start: { line: 1, column: 0 }, end: { line: 1, column: 9 } },
            b: { start: { line: 2, column: 0 }, end: { line: 2, column: 9 } } },
        s: { a: 1, b: 0 },
    };
    const current = { "src/subject.js": source, "coverage/coverage-final.json": JSON.stringify({ "src/subject.js": record }) };
    const result = await loadNodeCoverage({ repo, current, historical: true });
    assert.deepEqual(result.files[0].executable_lines, [1, 2]);
    assert.deepEqual(result.files[0].missing_lines, [2]);
    assert.deepEqual(result.changed_lines["src/subject.js"].uncovered_lines, [2]);
    record.sourceHash = "wrong";
    current["coverage/coverage-final.json"] = JSON.stringify({ "src/subject.js": record });
    assert.equal((await loadNodeCoverage({ repo, current, historical: true })).available, false);
});

test("Istanbul source maps cover only matching original snapshot lines", async (t) => {
    const repo = await fixture(t);
    const original = "return value;\nreturn null;\n";
    const record = { path: "dist/out.js", statementMap: {
        a: { start: { line: 1 }, end: { line: 1 } }, b: { start: { line: 2 }, end: { line: 2 } },
    }, s: { a: 1, b: 0 }, inputSourceMap: {
        version: 3, sources: ["../src/original.ts"], sourcesContent: [original], mappings: "AAAA;AACA",
    } };
    const current = { "src/original.ts": original, "coverage/coverage-final.json": JSON.stringify({ "dist/out.js": record }) };
    const result = await loadNodeCoverage({ repo, current, historical: true });
    assert.equal(result.files[0].path, "src/original.ts");
    assert.deepEqual(result.files[0].covered_lines, [1]);
    assert.deepEqual(result.files[0].missing_lines, [2]);
    current["src/original.ts"] = "changed source";
    assert.equal((await loadNodeCoverage({ repo, current, historical: true })).available, false);
});

test("LCOV external source maps from the saved snapshot map generated to original sources", async (t) => {
    const repo = await fixture(t);
    const current = {
        "dist/out.js": "return 1;\n//# sourceMappingURL=out.js.map",
        "dist/out.js.map": JSON.stringify({ version: 3, sources: ["../src/original.ts"], sourcesContent: [source], mappings: "AAAA" }),
        "src/original.ts": source,
        "coverage/lcov.info": "SF:dist/out.js\nDA:1,1\nend_of_record\n",
    };
    const result = await loadNodeCoverage({ repo, current, historical: true });
    assert.equal(result.files[0].path, "src/original.ts");
    assert.deepEqual(result.files[0].covered_lines, [1]);
});

test("malformed reports fail explicitly and CLI emits the coverage contract", async (t) => {
    const repo = await fixture(t);
    await assert.rejects(loadNodeCoverage({ repo, current: { "coverage/lcov.info": "SF:src/a.js\nDA:bad,1" }, historical: true }), /Invalid coverage report/);
    await assert.rejects(loadNodeCoverage({ repo, current: { "coverage/coverage-final.json": "{" }, historical: true }), /Invalid coverage report/);
    const input = join(repo, "snapshot.json");
    await writeFile(input, JSON.stringify({ repo, current: {}, historical: true }));
    const result = await execute(process.execPath, [join(here, "..", "node-coverage.mjs"), "--input", input]);
    assert.deepEqual(JSON.parse(result.stdout), unavailable);
    const literal = await execute(process.execPath, [join(here, "..", "node-coverage.mjs"), "--input",
        JSON.stringify({ repo, current: {}, historical: true })]);
    assert.deepEqual(JSON.parse(literal.stdout), unavailable);
    for (const args of [[], ["--input", "-"]]) {
        const stdin = await new Promise((resolve, reject) => {
            const child = execFile(process.execPath, [join(here, "..", "node-coverage.mjs"), ...args],
                (error, stdout) => error ? reject(error) : resolve(stdout));
            child.stdin.end(JSON.stringify({ repo, current: {}, historical: true }));
        });
        assert.deepEqual(JSON.parse(stdin), unavailable);
    }
});

test("snapshot changed lines track additions and modifications without live Git", () => {
    assert.deepEqual([...snapshotChangedLines("a\nb\n", "a\nnew\nb\n")], [2]);
    assert.deepEqual([...snapshotChangedLines("a\nb\n", "a\nc\n")], [2]);
    assert.deepEqual([...snapshotChangedLines("a\nb\n", "a\n")], []);
    assert.deepEqual([...snapshotChangedLines(null, "a\nb\n")], [1, 2]);
});
