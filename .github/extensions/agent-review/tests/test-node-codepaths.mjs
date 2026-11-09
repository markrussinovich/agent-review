import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { buildNodeCodePathMap, collectNodeDecisions, diffNodeDecisions, NODE_CODEPATH_LIMITS } from "../node-codepaths.mjs";
import { NODE_REVIEW_ADAPTER, buildCodePathRequest } from "../node-review-adapter.mjs";
import { linkedNodeTestPlan, resolveTestNode, nodeTestCommand, runLinkedNodeTests } from "../node-test-run.mjs";
import { analyzeSnapshot } from "../node-compiler.mjs";
import { decisionSentence, pathEvidence, decisionPromptContext } from "../web/decision-map.mjs";

function collect(body) {
    const source = ts.createSourceFile("source.ts", `function f(x, obj, items) {\n${body}\n}`, ts.ScriptTarget.Latest, true);
    assert.equal(source.parseDiagnostics.length, 0);
    return collectNodeDecisions(source.statements[0]).decisions;
}
function request(current, { baseline = null, tests = [], sources = [], path = "src/main.ts", qualname = "f", change = baseline === null ? "added" : "modified" } = {}) {
    return { repo: "not-a-real-repository", base_sha: "not-a-real-git-object",
        files: [{ path, baseline, current, callables: [{ id: "node:f", qualname, change }] }], tests, sources };
}
function map(current, options) { return buildNodeCodePathMap(request(current, options)); }
const production = "export function f(x: boolean) {\n if (x) return 1;\n return 2;\n}";
const testFile = (current, path = "tests/main.test.ts") => ({ path, current, added_lines: [3] });
const nodeTest = (body, imports = "import { f } from '../src/main.js';") => testFile(`
import test from 'node:test'; import assert from 'node:assert/strict';
${imports}
test('result', () => { ${body} });
`);

test("Node review adapter routes all eight extensions and preserves only saved snapshots", () => {
    for (const extension of [".js", ".ts", ".jsx", ".tsx", ".cjs", ".mjs", ".cts", ".mts"])
        assert.equal(NODE_REVIEW_ADAPTER.sourcePath(`src/a${extension}`), true);
    assert.equal(NODE_REVIEW_ADAPTER.sourcePath("file.py"), false);
    const model = {
        symbols: [{ id: "f", path: "src/main.ts", kind: "function", classification: "modified", qualname: "f" },
            { id: "test", path: "src/main.spec.ts", kind: "function", classification: "added", qualname: "test" }],
        source_files: {
            "src/main.ts": { baseline: "export function f() {return 1}", current: "export function f() {return 2}" },
            "src/main.spec.ts": { baseline: "", current: "import test from 'node:test'" },
            "src/dependency.ts": { baseline: "", current: "export const dep = 1" },
            "binary.ts": { binary: true }, "other.py": { current: "" },
        }, metadata: { base_sha: "invalid" }, changes: [],
    };
    const value = buildCodePathRequest(model, "missing");
    assert.equal(value.files.length, 1);
    assert.equal(value.files[0].baseline, model.source_files["src/main.ts"].baseline);
    assert.equal(value.tests.length, 1);
    assert.equal(value.sources.length, 3);
    assert.equal(buildCodePathRequest({ symbols: [] }, "missing"), null);
    assert.deepEqual(NODE_REVIEW_ADAPTER.codePathProcess("C:\\extension", "C:\\request.json"),
        { runtime: "node", candidates: [[process.execPath, []]],
            args: ["C:\\extension\\node-codepaths.mjs", "--input", "C:\\request.json"] });
    assert.equal(NODE_REVIEW_ADAPTER.tests.plan, linkedNodeTestPlan);
    assert.equal(NODE_REVIEW_ADAPTER.tests.resolveRuntime, resolveTestNode);
    assert.equal(NODE_REVIEW_ADAPTER.tests.command, nodeTestCommand);
    assert.equal(NODE_REVIEW_ADAPTER.tests.run, runLinkedNodeTests);
});

test("returns, throws, nested scopes, guards and optional presence gates remain explicit", () => {
    const decisions = collect(`
if (!x) {
 return;
}
if (obj?.value && obj.value > 10 && x > -2) {
 return true;
}
if (x === 3) {
 throw new Error('bad');
}
return false;`);
    assert.equal(decisions[0].outcome, "empty");
    assert.equal(decisions[1].outcome, "true");
    assert.deepEqual(decisions[1].only_if, ["obj?.value"]);
    assert.deepEqual(decisions[1].when, ["obj.value > 10", "x > -2"]);
    assert.equal(decisions[1].when_mode, "all");
    assert.deepEqual(decisions[1].thresholds, ["10", "-2"]);
    assert.ok(decisions[1].context.includes("x"));
    assert.equal(decisions[2].outcome, "raise");
    assert.match(decisions[2].value, /new Error/);
    assert.equal(decisions.at(-1).outcome, "false");
    assert.ok(decisions.at(-1).context.includes("x"));
    assert.ok(decisions.at(-1).when.includes("x !== 3"));
    assert.deepEqual(collect("if (x || obj) {\n return 1;\n}")[0].when, ["x", "obj"]);
    assert.equal(collect("if (x || obj) {\n return 1;\n}")[0].when_mode, "any");
    assert.equal(collect("if (x < 2) {\n return 1;\n} else {\n return 0;\n}")[1].when[0], "!(x < 2)");
});

test("the reported fail guard has the same raise and continuation predicates as inline throw", () => {
    const reported = 'function fail(m) { throw new Error(m); }\nfunction f(x) { if (!x) fail("bad"); return x; }';
    const inline = 'function f(x) { if (!x) throw new Error("bad"); return x; }';
    const result = map(reported).callables[0];
    const equivalent = map(inline).callables[0];
    const predicates = (item) => item.entries.map(({ decision }) => ({
        outcome: decision.outcome, when: decision.when, only_if: decision.only_if, context: decision.context,
        implicit: decision.implicit, trace: decision.trace !== null,
    }));
    assert.deepEqual(predicates(result), predicates(equivalent));
    assert.equal(result.decisions_current, 2);
    assert.equal(result.entries[0].decision.value, 'fail("bad")');
    assert.deepEqual(result.entries[1].decision.when, ["x"]);
    assert.equal(result.incomplete, false);
});

test("transitive declarations, immutable closures and distinct function scopes resolve by binding", () => {
    for (const helpers of [
        "function fail(m) { throw new Error(m); } function check(m) { fail(m); }",
        "const fail = (m) => { throw new Error(m); }; const check = (m) => fail(m);",
        "const fail = function hidden(m) { throw new Error(m); }; function check(m) { return fail(m); }",
        "function check(m) { function fail() { throw m; } fail(); }",
        "function check(m) { if (m) { throw m; } else { throw null; } }",
        "function check(m) { try { throw m; } catch (err) { throw err; } }",
        "function check(m) { try { return m; } finally { throw m; } }",
    ]) {
        const result = map(`${helpers}\nexport function f(x) {\n if (!x) {\n  check("bad");\n }\n return x;\n}`);
        assert.deepEqual(result.callables[0].entries.map((entry) => entry.decision.outcome), ["raise", "value"], helpers);
        assert.deepEqual(result.callables[0].entries[0].decision.trace, [4, 4], helpers);
        assert.deepEqual(result.callables[0].entries[1].decision.when, ["x"], helpers);
        assert.equal(result.incomplete, false, helpers);
    }
    const nested = map("function fail() {return 1;} function f(x) { const fail = () => {throw x;}; if (!x) fail(); return x; }");
    assert.equal(nested.callables[0].entries[0].decision.outcome, "raise");
    const siblings = map("function one() { function fail() {throw 1;} } function two() { function fail() {return 1;} } function f(x) { if (!x) fail(); return x; }");
    assert.ok(siblings.callables[0].entries.every((entry) => entry.decision.outcome !== "raise"));
    assert.equal(siblings.incomplete, true);
});

test("conditional, recursive, async, generator, optional and shadowed helpers do not invent raises", () => {
    const negatives = [
        ["name only", "", 'if (!x) fail("bad");'],
        ["conditional return", "function fail(m) { if (m) throw m; }", "if (!x) fail(x);"],
        ["explicit return", "function fail(m) { if (m) return m; throw m; }", "if (!x) fail(x);"],
        ["return before throw", "function fail() { return; throw 1; }", "if (!x) fail();"],
        ["swallowed throw", "function fail() { try { throw 1; } catch {} }", "if (!x) fail();"],
        ["finally return", "function fail() { try { throw 1; } finally { return; } }", "if (!x) fail();"],
        ["self recursion", "function fail() { fail(); }", "if (!x) fail();"],
        ["recursion before throw", "function fail() { fail(); throw 1; }", "if (!x) fail();"],
        ["recursion in throw", "function fail() { throw fail(); }", "if (!x) fail();"],
        ["recursive default", "function fail(m = fail()) { throw 1; }", "if (!x) fail();"],
        ["recursive constructor", "function fail() { throw new fail(); }", "if (!x) fail();"],
        ["recursive finally", "function fail() { try { fail(); } finally { throw 1; } }", "if (!x) fail();"],
        ["mutual recursion", "function fail() { other(); } function other() { fail(); }", "if (!x) fail();"],
        ["async declaration", "async function fail() { throw 1; }", "if (!x) fail();"],
        ["async arrow", "const fail = async () => {throw 1;};", "if (!x) fail();"],
        ["generator", "function* fail() { throw 1; }", "if (!x) fail();"],
        ["async generator", "async function* fail() { throw 1; }", "if (!x) fail();"],
        ["awaited async", "async function fail() { throw 1; }", "if (!x) await fail();"],
        ["optional call", "function fail() {throw 1;}", "if (!x) fail?.();"],
        ["parameter shadow", "function fail() {throw 1;}", "if (!x) fail();", "x, fail"],
        ["block shadow", "function fail() {throw 1;}", "{ const fail = () => 1; if (!x) fail(); }"],
        ["catch shadow", "function fail() {throw 1;}", "try {} catch (fail) { if (!x) fail(); }"],
        ["hoisted var shadow", "function fail() {throw 1;}", "if (!x) fail(); var fail = () => 1;"],
        ["nested-only throw", "function fail() { function nested() {throw 1;} }", "if (!x) fail();"],
        ["method", "const helpers = {fail() {throw 1;}};", "if (!x) helpers.fail();"],
        ["import", "import {fail} from './other.js';", "if (!x) fail();"],
        ["unsupported loop", "function fail() { while (x) {} throw 1; }", "if (!x) fail();"],
        ["unsupported switch", "function fail() { switch(x) {default: throw 1;} }", "if (!x) fail();"],
        ["spread arguments", "function fail() {throw 1;}", "if (!x) fail(...items);"],
        ["unmodelled arguments", "function fail() {throw 1;}", "if (!x) fail(other());"],
        ["const before initialization", "", "if (!x) fail(); const fail = () => {throw 1;};"],
        ["mutable initializer", "let fail = () => {throw 1;};", "if (!x) fail();"],
    ];
    for (const [label, helpers, guard, parameters = "x"] of negatives) {
        const result = map(`${helpers}\nexport async function f(${parameters}) {\n ${guard}\n return x;\n}`);
        assert.ok(result.callables[0].entries.every((entry) => entry.decision.outcome !== "raise"), label);
        assert.equal(result.incomplete, true, label);
        assert.ok(result.warnings.some((warning) => /counts are partial/.test(warning)), label);
    }
});

test("writes anywhere in the saved scope invalidate a throwing binding, including destructuring and closures", () => {
    for (const mutation of [
        "fail = replacement;", "fail ||= replacement;", "fail++;", "++fail;",
        "[fail] = items;", "({fail} = obj);", "({nested: fail} = obj);",
        "({fail = replacement} = obj);", "[...fail] = items;", "({...fail} = obj);",
        "for (fail of items) {}", "for (fail in obj) {}", "function replace() { fail = replacement; }",
    ]) {
        const result = map(`function fail() {throw 1;} ${mutation}\nfunction f(x) { if (!x) fail(); return x; }`);
        assert.ok(result.callables[0].entries.every((entry) => entry.decision.outcome !== "raise"), mutation);
        assert.equal(result.incomplete, true, mutation);
    }
    const shadowWrite = map("function fail() {throw 1;} function other(fail) {fail = () => 1;} function f(x) {if (!x) fail(); return x;}");
    assert.equal(shadowWrite.callables[0].entries[0].decision.outcome, "raise", "writes to a shadow are not writes to the helper");
    const evalWrite = map('function fail() {throw 1;} eval("fail = () => 1"); function f(x) {if (!x) fail(); return x;}');
    assert.equal(evalWrite.incomplete, true);
    assert.ok(evalWrite.callables[0].entries.every((entry) => entry.decision.outcome !== "raise"));
    const annexB = map("function fail() {throw 1;} if (x) {function fail() {return 1;}} function f(x) {if (!x) fail(); return x;}", { path: "src/main.js" });
    assert.equal(annexB.incomplete, true, "sloppy block declarations can replace an outer binding at runtime");
    assert.ok(annexB.callables[0].entries.every((entry) => entry.decision.outcome !== "raise"));
});

test("production helper proof checks executable nested binding defaults and computed keys", () => {
    for (const helper of [
        "function fail({ x = fail() } = {}) { throw 1; }",
        "function fail([x = fail()] = []) { throw 1; }",
        "function fail({outer: {x = fail()} = {}} = {}) { throw 1; }",
        "function fail([{x = fail()} = {}] = [{}]) { throw 1; }",
        "function fail({[fail()]: x} = {}) { throw 1; }",
        "function fail({outer: {[fail()]: x} = {}} = {}) { throw 1; }",
        "function fail(x = {[fail()]() {}}) { throw 1; }",
        "function fail(x = class {[fail()]() {}}) { throw 1; }",
        "const fail = ({x = fail()} = {}) => {throw 1;};",
        "const fail = function ({x = fail()} = {}) {throw 1;};",
        "function unsafe({x = unsafe()} = {}) {throw 1;} function fail() {unsafe();}",
        "function fail() {const {x = fail()} = {}; throw 1;}",
        "function fail() {const {[fail()]: x} = {}; throw 1;}",
        "function fail() {const [x = fail()] = []; throw 1;}",
    ]) {
        const result = map(`${helper} export function f(x) { if (!x) fail(); return x; }`);
        assert.ok(result.callables[0].entries.every((entry) => entry.decision.outcome !== "raise"), helper);
        assert.equal(result.incomplete, true, helper);
        assert.ok(result.warnings.some((warning) => /counts are partial/.test(warning)), helper);
    }
    for (const parameters of ["{x = 1} = {}", "[[x = 1] = []] = []", '{["x"]: x = 1} = {}', "callback = () => fail()"]) {
        const result = map(`function fail(${parameters}) {throw 1;} export function f(x) {if (!x) fail(); return x;}`);
        assert.equal(result.callables[0].entries[0].decision.outcome, "raise", parameters);
        assert.equal(result.incomplete, false, parameters);
    }
});

test("helper raises participate in block termination, switch fallthrough, catches and finally overrides", () => {
    const prefix = "function fail(m) {throw m;}\n";
    const value = (body) => map(`${prefix}function f(x) {\n${body}\n}`).callables[0].entries.map((entry) => entry.decision);
    assert.deepEqual(value("fail(x);\nreturn 1;").map((decision) => decision.outcome), ["raise"]);
    assert.deepEqual(value("return fail(x);").map((decision) => decision.outcome), ["raise"]);
    assert.deepEqual(value("if (x) fail(x); else fail(null);").map((decision) => decision.outcome), ["raise", "raise"]);
    assert.deepEqual(value("try {return 1;} finally {fail(x);}").map((decision) => decision.outcome), ["raise"]);
    const caught = value("try {fail(x);} catch (err) {return 2;}");
    assert.ok(caught[0].context.some((context) => context.includes("throws may be caught")));
    assert.deepEqual(caught.map((decision) => decision.outcome), ["raise", "value"]);
    assert.ok(value("try {} catch (err) {fail(err);}").every((decision) => decision.outcome !== "handled"));
    const switched = value("switch(x) {case 1: fail(x); case 2: return 2;}");
    assert.equal(switched[1].context.includes("case x === 2 (or fallthrough)"), false);
});

test("unmodelled calls preserve known evidence but mark unchanged and empty decision maps incomplete", () => {
    for (const source of ["export function f(x) { check(x); }", "export function f(x) { if (!x) check(x); return x; }"]) {
        const result = map(source, { baseline: source, tests: [nodeTest("f(true);")] });
        assert.equal(result.callables[0].entries.length, 0);
        assert.equal(result.callables[0].incomplete, true);
        assert.equal(result.incomplete, true);
        const prompt = decisionPromptContext({ ...result, status: "complete" });
        assert.equal(prompt.limited, true);
        assert.deepEqual(prompt.callables[0].changes, ["partial code path model; no modelled changes"]);
    }
    const known = map("export function f(x) { check(x); return 1; }", { tests: [nodeTest("assert.equal(f(true), 1);")] });
    assert.equal(known.callables[0].entries[0].evidence.level, "asserted");
    const chain = Array.from({ length: 65 }, (_, i) => `function fail${i}() {${i === 64 ? "throw 1;" : `fail${i + 1}();`}}`).join("\n");
    assert.equal(map(`${chain}\nfunction f(x) {fail0();}`).incomplete, true, "bounded proof must remain unknown, not a zero claim");
    for (const source of [
        "export function f(x = check()) {}",
        "export function f({x = check()}) {}",
        "export function f() {new Helper();}",
        "export function f() {check`value`;}",
    ]) assert.equal(map(source).incomplete, true, source);
    assert.equal(map("export function f() {throw new Error('bad');}").incomplete, false, "an explicit throw already models the raise");
    const unchanged = map(production, { baseline: production });
    for (const flagged of [
        { ...unchanged, limited: true },
        { ...unchanged, incomplete: true },
        { ...unchanged, callables: unchanged.callables.map((item) => ({ ...item, truncated: true })) },
    ]) {
        const prompt = decisionPromptContext({ ...flagged, status: "complete" });
        assert.equal(prompt.limited, true);
        assert.equal(prompt.callables[0].incomplete, true);
        assert.deepEqual(prompt.callables[0].changes, ["partial code path model; no modelled changes"]);
    }
});

test("production compiler, request adapter and parser CLI expose ten newly added helper guards", async () => {
    const baseline = 'function fail(m) { throw new Error(m); }\nexport function f(x) {\n return x;\n}\n';
    const current = baseline.replace(" return x;", Array.from({ length: 10 }, (_, i) => ` if (x === ${i}) fail("bad ${i}");`).join("\n") + "\n return x;");
    const path = "src/main.mjs";
    const savedTest = nodeTest("assert.throws(() => f(0));");
    const snapshots = { [path]: { baseline, current }, [savedTest.path]: savedTest };
    const report = analyzeSnapshot({ baseline: { [path]: baseline }, current: { [path]: current, [savedTest.path]: savedTest.current } });
    const inputRequest = buildCodePathRequest({ ...report, source_files: snapshots }, "missing");
    const directory = join(dirname(fileURLToPath(import.meta.url)), `.node-codepaths-${randomUUID()}`);
    await mkdir(directory);
    try {
        const input = join(directory, "request.json");
        await writeFile(input, JSON.stringify(inputRequest));
        const processSpec = NODE_REVIEW_ADAPTER.codePathProcess(dirname(dirname(fileURLToPath(import.meta.url))), input);
        const result = JSON.parse(execFileSync(process.execPath, processSpec.args, { encoding: "utf8" }));
        const callable = result.callables.find((item) => item.qualname === "f");
        assert.equal(callable.decisions_base, 1);
        assert.equal(callable.decisions_current, 11);
        assert.equal(callable.counts.added, 10);
        const raises = callable.entries.filter((entry) => entry.decision.outcome === "raise");
        assert.equal(raises.length, 10);
        assert.ok(raises.every((entry) => entry.evidence.level === "asserted"));
        assert.equal(result.incomplete, false);
        assert.deepEqual(result.warnings, []);
        assert.equal(result.verification.tests.length, 1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("inline conditions, ternaries, short-circuit exits and implicit fallthrough cannot claim line proof", () => {
    assert.equal(collect("if (x) return 1;")[0].trace, null);
    const ternary = collect("return x ? true : false;");
    assert.deepEqual(ternary.map((decision) => decision.outcome), ["true", "false"]);
    assert.ok(ternary.every((decision) => decision.trace === null));
    for (const operator of ["&&", "||", "??"]) {
        const decisions = collect(`return x ${operator} 2;`);
        assert.equal(decisions.length, 2);
        assert.ok(decisions.every((decision) => decision.trace === null));
    }
    const explicit = collect("if (x) {\n return 1;\n}");
    assert.deepEqual(explicit[0].trace, [3, 3]);
    assert.equal(explicit[1].implicit, true);
    assert.equal(explicit[1].trace, null);
});

test("loops emit iteration control and catch/finally never invent a typed exception", () => {
    const decisions = collect(`
for (const item of items) {
 if (!item) {
  continue;
 }
 if (item > 10) {
  break;
 }
}
try {
 throw new TypeError('x');
} catch (err) {
 obj.log(err);
} finally {
 if (x) {
  return [];
 }
}
return {};`);
    assert.equal(decisions[0].outcome, "skip");
    assert.equal(decisions[1].outcome, "stop");
    assert.equal(decisions[0].loop, "for const item of items");
    assert.equal(decisions[2].outcome, "raise");
    assert.ok(decisions[2].context.some((value) => value.includes("throws may be caught")));
    const handled = decisions.find((decision) => decision.outcome === "handled");
    assert.equal(handled.on_error, "any exception as err");
    assert.equal(handled.trace, null);
    const final = decisions.find((decision) => decision.value === "[]");
    assert.ok(final.context.includes("finally (also runs on pending exit)"));
    assert.equal(final.outcome, "empty");
    const override = collect("try {\n return 1;\n} finally {\n return 2;\n}");
    assert.deepEqual(override.map((decision) => decision.value), ["2"]);
    assert.deepEqual(collect("let callback = () => { return 99; }; return 1;").map((decision) => decision.value), ["1"]);
});

test("switch fallthrough is explicit and switch break is not a loop-stop decision", () => {
    const decisions = collect("switch(x) {\ncase 1:\n obj.log();\ncase 2:\n return 2;\ndefault:\n break;\n}\nreturn 0;");
    assert.ok(decisions[0].context.includes("case x === 2 (or fallthrough)"));
    assert.ok(decisions.every((decision) => decision.outcome !== "stop"));
});

test("finally overrides effective outcomes and pending try/catch exits explicitly distinguish execution from result", () => {
    const overridden = collect("try {\n return 1;\n} finally {\n return 2;\n}");
    assert.deepEqual(overridden.map((decision) => decision.value), ["2"]);
    assert.ok(overridden.every((decision) => !decision.implicit));
    const pending = collect("try {\n return 1;\n} finally {\n if (x) {\n return 2;\n }\n}");
    assert.deepEqual(pending.map((decision) => decision.value), ["1", "2"]);
    assert.ok(pending[0].context.includes("try (pending exit may be replaced by finally)"));
    assert.deepEqual(pending[0].trace, [3, 3]);
    assert.match(decisionSentence(pending[0]), /pending exit may be replaced by finally/);
    const caught = map(`export function f(x) {
 try { throw new Error('bad'); }
 catch (err) {
  return 1;
 } finally {
  if (x) {
   return 2;
  }
 }
}`, { tests: [nodeTest("assert.equal(f(false), 1);")] });
    const caughtReturn = caught.callables[0].entries.find((entry) => entry.decision.value === "1");
    assert.ok(caughtReturn.decision.context.includes("pending exit may be replaced by finally"));
    assert.equal(caughtReturn.evidence.level, "exercised", "executing the pending return is not proof of the effective result");
    const nested = collect("try { return 1; } finally { try { return 2; } finally { return 3; } }");
    assert.deepEqual(nested.map((decision) => decision.value), ["3"]);
});

test("saved baseline comparisons distinguish added, removed, changed and moved decisions with neighbor spans", () => {
    const baseline = "export function f(x) {\n if(x === 1) {return 1;}\n if(x === 2) {return 2;}\n return 0;\n}";
    const current = "export function f(x) {\n if(x === 2) {return 2;}\n if(x === 1) {return 1;}\n if(x === 3) {return 3;}\n return 0;\n}";
    const result = map(current, { baseline });
    assert.equal(result.warnings.length, 0);
    assert.ok(result.totals.added >= 1);
    // Guards make later exits' governing predicates change, so assert movement on
    // the pure diff independently of the guard-propagating collector.
    const a = collect("if (x) { return 1; }"), b = collect("if (obj) { return 2; }");
    const moved = diffNodeDecisions([...a, ...b], [...b, ...a]);
    assert.ok(moved.some((entry) => entry.status === "moved"));
    const insertion = diffNodeDecisions(a, [a[0], { ...a[0], value: "3" }, ...a.slice(1)]);
    assert.ok(insertion.find((entry) => entry.status === "added").after.end_line);
    assert.equal(map(null, { baseline, change: "removed" }).callables[0].counts.removed, 3);
    const changed = map("export function f() {\n return 2;\n}", { baseline: "export function f() {\n return 1;\n}" });
    assert.equal(changed.callables[0].entries[0].status, "changed");
    assert.deepEqual(changed.callables[0].entries[0].changed_fields, ["value"]);
    assert.equal(map(production, { baseline: production }).callables[0].entries.length, 0);
    const missing = map(production, { change: "modified" });
    assert.equal(missing.callables.length, 0);
    assert.match(missing.warnings[0], /both saved implementations/);
});

test("JS, TS, JSX, TSX, CJS, MJS, CTS and MTS parse saved implementations and class/arrow callables", () => {
    for (const extension of [".js", ".ts", ".jsx", ".tsx", ".cjs", ".mjs", ".cts", ".mts"]) {
        const source = extension.endsWith("x") ? "export const f = () => <div/>;"
            : extension.includes("t") ? "export function f(x: number): number { return x; }"
                : "export function f(x) { return x; }";
        const result = map(source, { path: `src/main${extension}` });
        assert.equal(result.callables.length, 1, extension);
        assert.equal(result.callables[0].entries[0].decision.outcome, "value");
    }
    const result = map("class Service { f() { return 1; } }", { qualname: "Service.f" });
    assert.equal(result.callables[0].qualname, "Service.f");
    assert.equal(map("export const publicName = function hidden() { return 1; }", { qualname: "publicName" }).callables.length, 1);
    assert.equal(map("exports.f = () => 1;", { qualname: "f", path: "src/main.cjs" }).callables.length, 1);
    assert.equal(map("export default () => 1;", { qualname: "default" }).callables.length, 1);
    assert.equal(map("export const object = { f() { return 1; } };", { qualname: "object.f" }).callables.length, 1);
    assert.equal(map("class Service { f = () => 1; }", { qualname: "Service.f" }).callables.length, 1);
    assert.equal(map("module.exports = function inner() { return 1; };", { qualname: "default", path: "src/main.cjs" }).callables.length, 1);
    assert.equal(map("const publicName = function hidden() { function nested() { return 1; } return nested(); };",
        { qualname: "publicName.nested" }).callables.length, 1);
    assert.equal(map("const Pub = class { f() { return 1; } };", { qualname: "Pub.f" }).callables.length, 1);
    assert.equal(map("const Pub = class Inside { f() { return 1; } };", { qualname: "Inside.f" }).callables.length, 1);
    assert.equal(map("namespace Outer { export function f() { return 1; } }", { qualname: "Outer.f" }).callables.length, 1);
    assert.equal(map("class Service { get value() { return 1; } }", { qualname: "Service.value" }).callables.length, 1);
    const invalid = map("export function f( {");
    assert.equal(invalid.callables.length, 0);
    assert.match(invalid.warnings[0], /cannot parse snapshot/);
});

test("compiler symbols link aliases, namespace imports, reexports and immutable results to exact assertions", () => {
    const aliases = map(production, { tests: [nodeTest("const result = renamed(true); assert.strictEqual(result, 1);", "import { f as renamed } from '../src/main.js';")] });
    assert.equal(aliases.verification.tests.length, 1);
    assert.equal(aliases.verification.tests[0].runner, "node:test");
    assert.equal(aliases.verification.tests[0].adapter, "node");
    const one = aliases.callables[0].entries.find((entry) => entry.decision.value === "1");
    const two = aliases.callables[0].entries.find((entry) => entry.decision.value === "2");
    assert.equal(one.evidence.level, "asserted");
    assert.equal(two.evidence.level, "exercised");
    assert.match(pathEvidence(aliases.callables[0], one, null).text, /Asserted/);
    assert.ok(decisionSentence(one.decision).startsWith("Returns"));
    const namespaced = map(production, { tests: [nodeTest("assert.equal(main.f(false), 2);", "import * as main from '../src/main.js';")] });
    assert.equal(namespaced.verification.tests.length, 1);
    const reexported = map(production, {
        sources: [{ path: "src/index.ts", current: "export {f as run} from './main.js';" }],
        tests: [nodeTest("assert.equal(run(false), 2);", "import {run} from '../src/index.js';")],
    });
    assert.equal(reexported.verification.tests.length, 1);
});

test("same spelling, dynamic imports and unrelated assertions never masquerade as semantic evidence", () => {
    const local = map(production, { tests: [nodeTest("function f() {return 1}; assert.equal(f(), 1);", "")] });
    assert.equal(local.verification.tests.length, 0);
    const unrelated = map(production, { tests: [nodeTest("f(true); assert.equal(123, 1);")] });
    assert.ok(unrelated.callables[0].entries.every((entry) => entry.evidence.level === "exercised"));
    const mutable = map(production, { tests: [nodeTest("let result = f(true); result = 1; assert.equal(result, 1);")] });
    assert.ok(mutable.callables[0].entries.every((entry) => entry.evidence.level === "exercised"));
    const fakeAssertion = map(production, { tests: [nodeTest("const fake = {equal(){}}; fake.equal(f(true), 1);")] });
    assert.ok(fakeAssertion.callables[0].entries.every((entry) => entry.evidence.level === "exercised"));
    const transformed = map(production, { tests: [nodeTest("assert.equal(f(true) + 1, 2);")] });
    assert.ok(transformed.callables[0].entries.every((entry) => entry.evidence.level === "exercised"));
    const dynamic = map(production, { tests: [testFile("import test from 'node:test'; import {f} from '../src/main.js'; test(makeName(), () => f(true));")] });
    assert.equal(dynamic.verification.tests.length, 0);
    assert.ok(dynamic.warnings.some((warning) => warning.includes("Dynamic test")));
    const dynamicImport = map(production, { tests: [nodeTest("import('../src/main.js').then(m => m.f(true));", "")] });
    assert.equal(dynamicImport.verification.tests.length, 0);
    assert.ok(dynamicImport.warnings.some((warning) => warning.includes("dynamic imports")));
    const globals = map(production, { tests: [testFile("import {f} from '../src/main.js'; test('implicit', () => f(true));")] });
    assert.equal(globals.verification.tests.length, 0);
    assert.ok(globals.warnings.some((warning) => warning.includes("unimported test")));
});

test("iteration guards govern following exits and nested methods resolve through compiler symbols", () => {
    const guarded = collect("for (const item of items) {\n if (!item) {\n continue;\n }\n return item;\n}");
    assert.equal(guarded[1].when[0], "item");
    const method = map("export class Service { f() {\n return true;\n} }", {
        qualname: "Service.f", tests: [nodeTest("const instance = new Service(); assert.equal(instance.f(), true);",
            "import {Service} from '../src/main.js';")],
    });
    assert.equal(method.verification.tests.length, 1);
    assert.equal(method.callables[0].entries[0].evidence.level, "asserted");
    const arrowField = map("export class Service { f = () => true; }", {
        qualname: "Service.f", tests: [nodeTest("const instance = new Service(); assert.equal(instance.f(), true);",
            "import {Service} from '../src/main.js';")],
    });
    assert.equal(arrowField.verification.tests.length, 1);
    assert.equal(arrowField.callables[0].entries[0].evidence.level, "asserted");
    const constructor = map("export class Service { constructor() {\n throw new Error('bad');\n} }", {
        qualname: "Service.constructor", tests: [nodeTest("assert.throws(() => new Service());",
            "import {Service} from '../src/main.js';")],
    });
    assert.equal(constructor.verification.tests.length, 1);
    assert.equal(constructor.callables[0].entries[0].evidence.level, "asserted");
});

test("assert throws invokes only its imported assertion callback; wrappers are reachable not asserted", () => {
    const throwing = map("export function f() {\n throw new Error('bad');\n}", { tests: [nodeTest("assert.throws(() => f());")] });
    assert.equal(throwing.callables[0].entries[0].evidence.level, "asserted");
    const caught = map("export function f() {\n try { throw new Error('bad'); } catch (err) { console.log(err); }\n}",
        { tests: [nodeTest("assert.throws(() => f());")] });
    assert.ok(caught.callables[0].entries.every((entry) => entry.evidence.level === "exercised"));
    const deferred = map(production, { tests: [nodeTest("const deferred = () => f(true); assert.equal(1, 1);")] });
    assert.equal(deferred.verification.tests.length, 0);
    const wrapper = map(production, {
        sources: [{ path: "src/wrapper.ts", current: "import {f} from './main.js'; export function wrapper(x) {return f(x)}" }],
        tests: [nodeTest("assert.equal(wrapper(true), 1);", "import {wrapper} from '../src/wrapper.js';")],
    });
    assert.equal(wrapper.verification.tests[0].link, "via");
    assert.ok(wrapper.callables[0].entries.every((entry) => entry.evidence.level === "reachable"));
});

test("CommonJS literal require and imported Vitest expect are statically linked", () => {
    const cjs = map("exports.f = function f(x) {\n return 1;\n}", { path: "src/main.cjs", tests: [testFile(`
const test = require('node:test');
const assert = require('node:assert/strict');
const {f} = require('../src/main.cjs');
test('cjs', () => assert.equal(f(), 1));
`, "tests/main.test.cjs")] });
    assert.equal(cjs.verification.tests.length, 1);
    assert.equal(cjs.callables[0].entries[0].evidence.level, "asserted");
    const vitest = map(production, { tests: [testFile(`
import {test, expect} from 'vitest'; import {f} from '../src/main.js';
test('vitest', () => expect(f(true)).toBe(1));`)] });
    assert.equal(vitest.verification.tests[0].runner, "vitest");
    assert.equal(vitest.callables[0].entries[0].evidence.level, "asserted");
});

test("file test counts include unlinked tests so isolated runtime plans cannot misidentify evidence", () => {
    const result = map(production, { tests: [testFile(`
import test from 'node:test'; import assert from 'node:assert/strict'; import {f} from '../src/main.js';
test('linked', () => assert.equal(f(true),1));
test('unlinked', () => assert.equal(1,1));`)] });
    assert.equal(result.verification.tests[0].test_file_count, 2);
});

test("runtime source hashes originate exclusively from saved current sources, tests and dependencies", () => {
    const dependency = { path: "src/dependency.ts", current: "export const dependency = 1;\r\n" };
    const savedTest = nodeTest("assert.equal(f(true), 1);");
    const result = map(production, { baseline: production.replace("return 1", "return 3"), sources: [dependency], tests: [savedTest] });
    const hash = (source) => createHash("sha256").update(source, "utf8").digest("hex");
    assert.deepEqual(result.source_hashes, {
        "src/main.ts": hash(production),
        [dependency.path]: hash(dependency.current),
        [savedTest.path]: hash(savedTest.current),
    });
    assert.equal(result.callables[0].source_hash, hash(production));
    assert.equal(result.verification.tests[0].source_hash, hash(savedTest.current));
    const plan = linkedNodeTestPlan({ ...result, status: "complete" }, "not-a-real-repository");
    assert.deepEqual(plan.source_hashes, result.source_hashes);
    assert.deepEqual(plan.tests, [`${savedTest.path}::result`]);
});

test("explicit byte, callable, decision, entry and test bounds warn rather than silently claim completeness", () => {
    const limits = { ...NODE_CODEPATH_LIMITS, sourceBytes: 10 };
    const result = buildNodeCodePathMap(request(production), limits);
    assert.equal(result.limited, true);
    assert.equal(result.callables.length, 0);
    assert.ok(result.warnings.length);
    const entries = buildNodeCodePathMap(request(production), { ...NODE_CODEPATH_LIMITS, entries: 1 });
    assert.equal(entries.callables[0].entries.length, 1);
    assert.equal(entries.callables[0].omitted_entries, 1);
    assert.equal(entries.limited, true);
    const decisions = buildNodeCodePathMap(request(production), { ...NODE_CODEPATH_LIMITS, decisions: 1 });
    assert.equal(decisions.callables[0].truncated, true);
    assert.equal(decisions.limited, true);
    assert.equal(buildNodeCodePathMap(request(production), { ...NODE_CODEPATH_LIMITS, callables: 0 }).limited, true);
    assert.equal(buildNodeCodePathMap(request(production, { tests: [nodeTest("f(true);")] }),
        { ...NODE_CODEPATH_LIMITS, testFiles: 0 }).verification.limited, true);
});

test("parser CLI uses --input and emits a Python-compatible JSON decisions DTO", async () => {
    const directory = join(dirname(fileURLToPath(import.meta.url)), `.node-codepaths-${randomUUID()}`);
    await mkdir(directory);
    try {
        const input = join(directory, "request.json");
        await writeFile(input, JSON.stringify(request(production)));
        const parser = join(dirname(fileURLToPath(import.meta.url)), "..", "node-codepaths.mjs");
        const result = JSON.parse(execFileSync(process.execPath, [parser, "--input", input], { encoding: "utf8" }));
        assert.equal(result.adapter_id, "node");
        assert.equal(result.callables[0].counts.added, 2);
        assert.ok(result.callables[0].entries.every((entry) => entry.evidence.level === "none"));
        assert.throws(() => execFileSync(process.execPath, [parser, input], { stdio: "pipe" }), { status: 2 });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
