import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, readdir, stat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { linkedNodeTestPlan, nodeTestCommand, resolveTestNode, runLinkedNodeTests } from "../node-test-run.mjs";
import { preciseRangeLines } from "../node-test-range-lines.mjs";

const here = dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
    const root = await mkdtemp(join(here, ".node-runner-fixture-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "subject.mjs"), [
        "export function branch(value) {",
        "  if (value) {",
        '    return "yes";',
        "  }",
        '  return "no";',
        "}",
        "export function setup() {",
        '  return "setup-only";',
        "}",
    ].join("\n"));
    return root;
}
const runtime = { executable: process.execPath };
const plan = (root, name = "positive", path = "branch.test.mjs") => ({
    tests: [`${path}::${name}`], node_tests: [{ id: `${path}::${name}`, name, path }],
    files: [join(root, "subject.mjs")],
});

test("node test planning rejects aggregate runners and multi-test files", () => {
    const map = { status: "complete", callables: [], verification: { tests: [
        { id: "a.mjs::one", runner: "node:test", link: "call", test_file_count: 2 },
        { id: "a.mjs::two", runner: "node:test", link: "call", test_file_count: 2 },
        { id: "b.mjs::vitest", runner: "vitest", link: "call", test_file_count: 1 },
        { id: "c.mjs::unique", runner: "node:test", link: "call", test_file_count: 1, source_hash: "1".repeat(64) },
        { id: "d.mjs::linked", runner: "node:test", link: "call", test_file_count: 2 },
        { id: "e.mjs::unknown-count", runner: "node:test", link: "call" },
    ] } };
    assert.deepEqual(linkedNodeTestPlan(map, here).tests, ["c.mjs::unique"]);
    assert.equal(linkedNodeTestPlan(map, here).unsupported, 5);
    assert.equal(linkedNodeTestPlan(map, here).source_hashes["c.mjs"], "1".repeat(64));
    const command = nodeTestCommand(runtime, { node_tests: [{ path: "test.mjs", name: "literal (a)+?" }] });
    assert(command.includes("--test-name-pattern=^literal \\(a\\)\\+\\?$"));
    assert(nodeTestCommand(runtime, { tests: [], files: [] }).includes("--test"));
    assert.equal(resolveTestNode(here, { test_node: process.execPath }).executable, process.execPath);
});

test("separate node:test processes capture callback-only branches, not setup or other tests", async (t) => {
    const root = await fixture(t);
    for (const [path, name, value] of [["branch.test.mjs", "positive", true], ["negative.test.mjs", "negative", false]]) {
        await writeFile(join(root, path), `import test from "node:test";\nimport {branch, setup} from "./subject.mjs";\nsetup();\ntest("${name}", () => { branch(${value}); });\n`);
    }
    const selection = plan(root);
    selection.tests.push("negative.test.mjs::negative");
    selection.node_tests.push({ id: "negative.test.mjs::negative", path: "negative.test.mjs", name: "negative" });
    const result = await runLinkedNodeTests({ repoRoot: root, python: runtime, plan: selection });
    assert.equal(result.exit_code, 0);
    const positive = result.trace.tests["branch.test.mjs::positive"];
    const negative = result.trace.tests["negative.test.mjs::negative"];
    assert.equal(positive.outcome, "passed");
    assert(positive.lines[join(root, "subject.mjs")].includes(3));
    assert(!positive.lines[join(root, "subject.mjs")].includes(5));
    assert(!positive.lines[join(root, "subject.mjs")].includes(8));
    assert(negative.lines[join(root, "subject.mjs")].includes(5));
    assert(!negative.lines[join(root, "subject.mjs")].includes(3));
    assert.equal((await readdir(root)).some((entry) => entry.startsWith(".agent-review-node-tests-")), false);
});

test("failed and skipped tests cannot masquerade as passed coverage", async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "branch.test.mjs"), 'import test from "node:test"; import {branch} from "./subject.mjs"; test("positive", () => {branch(true); throw new Error("expected failure");});');
    const failed = await runLinkedNodeTests({ repoRoot: root, python: runtime, plan: plan(root) });
    assert.equal(failed.exit_code, 1);
    assert.equal(failed.trace.tests["branch.test.mjs::positive"].outcome, "failed");
    await writeFile(join(root, "branch.test.mjs"), 'import test from "node:test"; test("positive", {skip:true}, () => {});');
    const skipped = await runLinkedNodeTests({ repoRoot: root, python: runtime, plan: plan(root) });
    assert.equal(skipped.trace.tests["branch.test.mjs::positive"].outcome, "skipped");
    assert.deepEqual(skipped.trace.tests["branch.test.mjs::positive"].lines, {});
});

test("native TypeScript stripping retains source coordinates for per-test return evidence", async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "subject.ts"), 'export function typed(value: boolean): string {\n  if (value) {\n    return "yes";\n  }\n  return "no";\n}\n');
    await writeFile(join(root, "typed.test.ts"), 'import test from "node:test"; import {typed} from "./subject.ts"; test("typed", () => {typed(true);});');
    const selection = plan(root, "typed", "typed.test.ts");
    selection.files = [join(root, "subject.ts")];
    const result = await runLinkedNodeTests({ repoRoot: root, python: runtime, plan: selection });
    assert(result.trace.tests["typed.test.ts::typed"].lines[join(root, "subject.ts")].includes(3));
    assert(!result.trace.tests["typed.test.ts::typed"].lines[join(root, "subject.ts")].includes(5));
});

test("throw gates do not confirm the unexecuted trailing return", async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "subject.mjs"), 'export function branch(value) {\n  if (value) {\n    throw new Error("stop");\n  }\n  return "no";\n}\n');
    await writeFile(join(root, "branch.test.mjs"), 'import test from "node:test"; import {branch} from "./subject.mjs"; test("positive", () => {try {branch(true);} catch {}});');
    const result = await runLinkedNodeTests({ repoRoot: root, python: runtime, plan: plan(root) });
    const lines = result.trace.tests["branch.test.mjs::positive"].lines[join(root, "subject.mjs")];
    assert(lines.includes(3));
    assert(!lines.includes(5));
});

test("unexpected tests, subtests and missing tooling produce explicit errors", async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "branch.test.mjs"), 'import test from "node:test"; test("positive", async (t) => {await t.test("child", () => {});});');
    await assert.rejects(runLinkedNodeTests({ repoRoot: root, python: runtime, plan: plan(root) }), /no valid callback coverage|one top-level/);
    await assert.rejects(runLinkedNodeTests({ repoRoot: root, python: { executable: "agent-review-node-does-not-exist" }, plan: plan(root) }), /Unable to launch/);
});

test("cancellation and timeout stop owned test processes and remove captures", async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "branch.test.mjs"), 'import test from "node:test"; import {writeFileSync} from "node:fs"; test("positive", async () => {writeFileSync("started", "yes"); await new Promise(resolve => setTimeout(resolve, 30000));});');
    const controller = new AbortController();
    const running = runLinkedNodeTests({ repoRoot: root, python: runtime, plan: plan(root), signal: controller.signal });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        try { await stat(join(root, "started")); break; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await stat(join(root, "started"));
    controller.abort(new Error("cancel isolated run"));
    await assert.rejects(running, /cancel isolated run/);
    await assert.rejects(runLinkedNodeTests({ repoRoot: root, python: runtime, plan: plan(root), timeoutMs: 3000 }), /timeout/);
    assert.equal((await readdir(root)).some((entry) => entry.startsWith(".agent-review-node-tests-")), false);
});

test("setup async overlap is rejected instead of attributed to the test", async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "branch.test.mjs"), 'import test from "node:test"; import {branch} from "./subject.mjs"; setTimeout(() => branch(false), 30); test("positive", async () => {branch(true); await new Promise(resolve => setTimeout(resolve, 80));});');
    await assert.rejects(runLinkedNodeTests({ repoRoot: root, python: runtime, plan: plan(root) }), /setup async work overlapped/);
});

test("reviewed source hashes reject stale snapshots before execution and test-time mutation", async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "branch.test.mjs"), 'import test from "node:test"; import {branch} from "./subject.mjs"; import {writeFileSync} from "node:fs"; test("positive", () => {branch(true); writeFileSync("subject.mjs", "changed during test");});');
    const selection = plan(root);
    const current = await readFile(join(root, "subject.mjs"), "utf8");
    selection.source_hashes = { "subject.mjs": "0".repeat(64), "branch.test.mjs":
        createHash("sha256").update(await readFile(join(root, "branch.test.mjs"), "utf8")).digest("hex") };
    await assert.rejects(runLinkedNodeTests({ repoRoot: root, python: runtime, plan: selection }), /Reviewed source changed/);
    assert.equal(await readFile(join(root, "subject.mjs"), "utf8"), current);
    selection.source_hashes["subject.mjs"] = createHash("sha256").update(current).digest("hex");
    const testHash = selection.source_hashes["branch.test.mjs"];
    delete selection.source_hashes["branch.test.mjs"];
    await assert.rejects(runLinkedNodeTests({ repoRoot: root, python: runtime, plan: selection }), /Reviewed source hash missing/);
    selection.source_hashes["branch.test.mjs"] = testHash;
    await assert.rejects(runLinkedNodeTests({ repoRoot: root, python: runtime, plan: selection }), /Reviewed source changed/);
    assert.equal((await readdir(root)).some((entry) => entry.startsWith(".agent-review-node-tests-")), false);
});

test("precise range mapping excludes inline branch proof and unexecuted smaller ranges", () => {
    const source = "function f(x) {\n if(x) return 1;\n return 2;\n}\n";
    const ranges = [{ ranges: [{ startOffset: 0, endOffset: source.length, count: 1 },
        { startOffset: source.indexOf("return 2"), endOffset: source.indexOf("return 2") + 9, count: 0 }] }];
    assert.deepEqual(preciseRangeLines(source, ranges).covered, []);
});
