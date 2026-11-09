import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCppSnapshot } from "../cpp-analyzer.mjs";
import { cppSourceHash } from "../cpp-syntax.mjs";
import { reviewAdapter, sourceAdapter, testAdapterForMap } from "../language-adapters.mjs";
import { isCppSourcePath, isReviewSymbol, languageForPath } from "../web/languages.mjs";
import { callablesForSubject } from "../web/decision-map.mjs";
import { parseSourceReference } from "../web/source-references.mjs";
import { cppTestCommand, cppTestPlan, resolveCppTestRuntime, runCppTests } from "../cpp-test-run.mjs";
import { annotationCodeContext } from "../annotation-context.mjs";
import { exportSnapshot } from "../test-run.mjs";
import { prepareSample } from "../../../../test-repos/prepare.mjs";

const baseline = {
    "include/policy.hpp": "namespace policy {\ninline int limit(int x) {\n if (x > 3) return 0;\n return x;\n}\n}\n",
    "app.cpp": '#include "include/policy.hpp"\nint run() { return policy::limit(4); }\n',
    "tests/policy.cpp": '#include "../include/policy.hpp"\nTEST(Policy, limit) { EXPECT_EQ(policy::limit(4), 0); }\n',
};
const current = { ...baseline, "include/policy.hpp": baseline["include/policy.hpp"].replace("> 3", "> 5") };

test("C/C++ source paths, symbols, decisions and adapter routing are registered", async () => {
    for (const path of ["x.c", "x.C", "x.cc", "x.cpp", "x.cxx", "x.h", "x.hpp", "x.tpp", "x.inl"]) {
        assert.equal(isCppSourcePath(path), true);
        assert.equal(languageForPath(path).id, "cpp");
        assert.equal(sourceAdapter(path), reviewAdapter("cpp"));
        assert.deepEqual(parseSourceReference(`${path}:7`).lines, [7]);
    }
    assert.equal(isCppSourcePath("x.cs"), false);
    for (const kind of ["struct", "namespace", "constructor", "destructor", "operator", "lambda"]) {
        assert.equal(isReviewSymbol({ language: "cpp", kind }), true);
    }
    assert.equal(testAdapterForMap({ adapter_id: "cpp" }).id, "cpp");
    const report = await analyzeCppSnapshot({ baseline, current });
    assert.deepEqual(reviewAdapter("cpp").buildCodePathRequest({ code_paths: { cpp: report.code_paths } }), { precomputed: report.code_paths });
});

test("header edits reach unchanged consumers and exact statically linked tests", async () => {
    const result = await analyzeCppSnapshot({ baseline, current });
    const limit = result.symbols.find((symbol) => symbol.qualname === "policy::limit");
    const caller = result.symbols.find((symbol) => symbol.name === "run");
    assert.equal(limit.classification, "modified");
    assert.equal(caller.classification, "unchanged");
    assert.ok(result.edges.some((edge) => edge.kind === "calls" && edge.source === caller.id && edge.target === limit.id));
    assert.equal(result.edges.filter((edge) => edge.kind === "imports").length, 2);
    const map = result.code_paths;
    assert.deepEqual(map.verification.tests.map((test) => test.name), ["Policy.limit"]);
    const entry = map.callables[0].entries.find((entry) => entry.status === "changed");
    assert.deepEqual(entry.base.when, ["x > 3"]);
    assert.deepEqual(entry.decision.when, ["x > 5"]);
    assert.deepEqual(entry.decision.thresholds, ["5"]);
    assert.equal(entry.evidence.level, "reachable");
    assert.ok(result.evidence.every((item) => item.path && item.line > 0));
    assert.equal(result.aggregates.modules.length, 3);
    assert.ok(result.aggregates.edges.length);
});

test("an added early guard does not steal the old threshold or unchanged fallback", async () => {
    const report = await analyzeCppSnapshot({ baseline: { "policy.hpp": baseline["include/policy.hpp"] },
        current: { "policy.hpp": current["include/policy.hpp"].replace(" if (x > 5)", " if (x < 0) return 0;\n if (x > 5)") } });
    const entries = report.code_paths.callables[0].entries;
    const guard = entries.find((entry) => entry.decision.when.includes("x < 0"));
    const threshold = entries.find((entry) => entry.decision.when.includes("x > 5"));
    const fallback = entries.find((entry) => entry.decision.value === "x");
    assert.equal(guard.status, "added");
    assert.equal(threshold.status, "changed");
    assert.deepEqual(threshold.base.when, ["x > 3"]);
    assert.equal(fallback.base.value, "x");
    assert.ok(["unchanged", "moved"].includes(fallback.status));
});

test("dialects, templates, overloads, declarations, members and callable kinds retain source identities", async () => {
    const files = {
        "c.c": "struct Plain { int value; };\nint run(int x) { return x; }\n",
        "upper.C": "template<class T> T identity(T value) { return value; }\n",
        "objects.hpp": `namespace app {
struct Base {};
class Item : public Base {
 int value;
public:
 Item() {}
 ~Item() {}
 int operator()(int x) { return x; }
 int get(int x);
};
int overloaded(int n) { return n; }
int overloaded(double n) { return 0; }
}
`,
        "objects.cpp": '#include "objects.hpp"\nint app::Item::get(int x) { return x; }\nint run() { return app::overloaded(1); }\n',
    };
    const report = await analyzeCppSnapshot({ current: files });
    assert.equal(report.aggregates.modules.find((module) => module.path === "c.c").dialect, "c");
    assert.equal(report.aggregates.modules.find((module) => module.path === "upper.C").dialect, "cpp");
    const kinds = new Set(report.symbols.map((symbol) => symbol.kind));
    for (const kind of ["class", "struct", "constructor", "destructor", "operator", "method"]) assert.ok(kinds.has(kind), kind);
    const overloaded = report.symbols.filter((symbol) => symbol.name === "overloaded");
    assert.equal(overloaded.length, 2);
    assert.notEqual(overloaded[0].id, overloaded[1].id);
    assert.equal(new Set(report.symbols.map((symbol) => symbol.id)).size, report.symbols.length);
    const item = report.symbols.find((symbol) => symbol.name === "Item" && symbol.kind === "class");
    assert.ok(item.fields.some((field) => field.name === "value"));
    const get = report.symbols.find((symbol) => symbol.path === "objects.cpp" && symbol.name.endsWith("get"));
    assert.equal(get.parent_id, item.id);
    assert.ok(report.edges.some((edge) => edge.kind === "inherits"));
    assert.ok(report.warnings.some((warning) => warning.includes("unresolved C/C++ call app::overloaded")));
    assert.ok(!report.edges.some((edge) => overloaded.some((symbol) => symbol.id === edge.target)));
    const owned = callablesForSubject(report.code_paths, report, { ...item, kind: "class", language: "cpp" });
    assert.ok(owned.some((callable) => callable.id === get.id));
});

test("nested branches, exceptions and lambdas do not leak decisions to the wrong callable", async () => {
    const report = await analyzeCppSnapshot({ current: { "flow.cpp": `int flow(int x) {
 if (x > 1) { if (x < 5) return 1; else return 2; }
 auto local = [](int y) { return y; };
 try { throw x; } catch (int e) { return 3; }
 return 0;
}` } });
    const flow = report.code_paths.callables.find((callable) => callable.qualname === "flow");
    assert.ok(!flow.entries.some((entry) => entry.decision.value === "y"));
    assert.deepEqual(flow.entries.find((entry) => entry.decision.value === "2").decision.when, ["x > 1", "!(x < 5)"]);
    assert.deepEqual(flow.entries.find((entry) => entry.decision.value === "3").decision.context, ["catch (int e)"]);
    const lambda = report.code_paths.callables.find((callable) => callable.qualname.includes("(lambda"));
    assert.deepEqual(lambda.entries.map((entry) => entry.decision.value), ["y"]);
});

test("C and C++ callable parameters shadow global functions but not explicitly qualified calls", async () => {
    for (const path of ["bindings.c", "bindings.cpp"]) {
        const report = await analyzeCppSnapshot({ current: { [path]: `int Target() { return 1; }
int Pointer(int (*Target)()) { return Target(); }
int Function(int Target()) { return Target(); }
${path.endsWith(".cpp") ? "int Qualified(int (*Target)()) { return ::Target(); }" : ""}
` } });
        const target = report.symbols.find((symbol) => symbol.name === "Target");
        for (const name of ["Pointer", "Function"]) {
            const caller = report.symbols.find((symbol) => symbol.name === name);
            assert.ok(!report.edges.some((edge) => edge.kind === "calls" && edge.source === caller.id));
        }
        assert.match(report.warnings.join("\n"), /unresolved C\/C\+\+ call Target/);
        if (path.endsWith(".cpp")) {
            const qualified = report.symbols.find((symbol) => symbol.name === "Qualified");
            assert.ok(report.edges.some((edge) => edge.kind === "calls"
                && edge.source === qualified.id && edge.target === target.id));
        }
    }
});

test("local bindings and lambda parameters respect lexical scope during call resolution", async () => {
    const report = await analyzeCppSnapshot({ current: { "locals.cpp": `int Target() { return 1; }
int Other() { return 2; }
int Before() { Target(); auto Target = [] { return 0; }; return Target(); }
int Outside() { { auto Target = callback; Target(); } return Target(); }
int Range() { for (auto Target : callbacks) Target(); return Target(); }
int Conditional() { if (auto Target = callback; ready) Target(); return Target(); }
int ConditionValue() { if (auto Target = callback) Target(); return Target(); }
int Captures(int (*Target)()) {
 auto local = [Target = callback](int (*Other)()) { return Target() + Other(); };
 return local();
}
` } });
    const target = report.symbols.find((symbol) => symbol.name === "Target");
    for (const name of ["Before", "Outside", "Range", "Conditional", "ConditionValue"]) {
        const caller = report.symbols.find((symbol) => symbol.name === name);
        assert.ok(report.edges.some((edge) => edge.kind === "calls"
            && edge.source === caller.id && edge.target === target.id), name);
        assert.ok(report.warnings.some((warning) => warning.includes(`locals.cpp:${caller.range.start_line}:`)
            && warning.includes("unresolved C/C++ call Target")), name);
    }
    const captures = report.symbols.find((symbol) => symbol.name === "Captures");
    const lambda = report.symbols.find((symbol) => symbol.kind === "lambda" && symbol.parent_id === captures.id);
    assert.ok(!report.edges.some((edge) => edge.kind === "calls" && edge.source === lambda.id));
});

test("do/while decisions do not require the condition before the first iteration", async () => {
    const report = await analyzeCppSnapshot({
        baseline: { "loops.cpp": "int Loop(bool keep) { while (keep) { return 7; } return 0; }\n" },
        current: { "loops.cpp": `int Do(bool keep, bool ready) {
 if (ready) do { if (keep) return 1; else return 2; } while (keep);
 return 0;
}
int While(bool keep) { while (keep) return 3; return 0; }
int For(bool keep) { for (; keep;) return 4; return 0; }
int Loop(bool keep) { do { return 7; } while (keep); }
` } });
    const decisions = (name) => report.code_paths.callables.find((callable) => callable.qualname === name)
        .entries.map((entry) => entry.decision);
    assert.deepEqual(decisions("Do").find((decision) => decision.value === "1").when, ["ready", "keep"]);
    assert.deepEqual(decisions("Do").find((decision) => decision.value === "2").when, ["ready", "!(keep)"]);
    assert.deepEqual(decisions("While").find((decision) => decision.value === "3").when, ["keep"]);
    assert.deepEqual(decisions("For").find((decision) => decision.value === "4").when, ["keep"]);
    assert.deepEqual(decisions("Loop").find((decision) => decision.value === "7").when, []);
    const loop = report.code_paths.callables.find((callable) => callable.qualname === "Loop");
    const seven = loop.entries.find((entry) => entry.status === "changed");
    assert.equal(seven.base.value, "7");
    assert.deepEqual(seven.base.when, ["keep"]);
    assert.equal(loop.entries.find((entry) => entry.status === "removed").decision.value, "0");
});

test("return/default/noexcept changes preserve callable identity and declaration names do not affect linkage", async () => {
    const report = await analyzeCppSnapshot({
        baseline: { "app.cpp": "auto value(int n=1) noexcept -> int { return n; }\n" },
        current: { "app.cpp": "auto value(int renamed=2) -> long { return renamed; }\n" },
    });
    assert.equal(report.symbols.length, 1);
    assert.equal(report.symbols[0].classification, "modified");
    const linked = await analyzeCppSnapshot({ current: {
        "value.h": "int value(int* pointer);\n",
        "value.cpp": '#include "value.h"\nint value(int *renamed) { return *renamed; }\n',
        "app.cpp": '#include "value.h"\nint run() { return value(nullptr); }\n',
    } });
    const caller = linked.symbols.find((symbol) => symbol.name === "run");
    const definition = linked.symbols.find((symbol) => symbol.path === "value.cpp");
    assert.ok(linked.edges.some((edge) => edge.kind === "calls" && edge.source === caller.id && edge.target === definition.id));
});

test("UTF-8 source locations, comments, raw strings and CRLF remain accurate", async () => {
    const report = await analyzeCppSnapshot({ current: {
        "unicode.cpp": '\uFEFF// \u03bb\r\nconst char* text=R"(return bad; })";\r\nint real() { /* return bad; */ return 7; }\r\n',
    } });
    const symbol = report.symbols.find((symbol) => symbol.name === "real");
    assert.deepEqual(symbol.range, { start_line: 3, end_line: 3 });
    assert.deepEqual(report.code_paths.callables[0].entries.map((entry) => entry.decision.value), ["7"]);
    assert.equal(cppSourceHash("\uFEFFa\r\n"), cppSourceHash("a\n"));
    const sameLine = await analyzeCppSnapshot({ current: { "same-line.cpp": 'const char* marker="\u03bb"; int named(){return 4;}' } });
    assert.equal(sameLine.symbols.find((symbol) => symbol.name === "named").signature, "int named()");
    const normalized = await analyzeCppSnapshot({ baseline: { "same.cpp": "int same(){return 1;}\n" },
        current: { "same.cpp": "\uFEFFint same(){return 1;}\r\n" } });
    assert.ok(normalized.symbols.every((symbol) => symbol.classification === "unchanged"));
    assert.equal(normalized.aggregates.modules[0].change, "unchanged");
});

test("conditional definitions retain separate identities and unresolved configuration", async () => {
    const report = await analyzeCppSnapshot({ current: { "config.cpp": "#if WIN32\nint run(){return 1;}\n#else\nint run(){return 2;}\n#endif\n" } });
    const runs = report.symbols.filter((symbol) => symbol.name === "run");
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0].id, runs[1].id);
    assert.ok(runs.every((symbol) => symbol.conditions.length));
    assert.match(report.warnings.join("\n"), /preprocessor conditions are not evaluated/);
});

test("removed sources and malformed syntax remain explicit without hiding valid surrounding code", async () => {
    const removed = await analyzeCppSnapshot({ baseline: { "gone.c": "int gone() { return 1; }\n" } });
    assert.equal(removed.symbols[0].classification, "removed");
    assert.equal(removed.code_paths.callables[0].entries[0].status, "removed");
    const malformed = await analyzeCppSnapshot({ current: { "broken.cpp": "int before(){return 1;}\nint broken( {\n" } });
    assert.ok(malformed.symbols.some((symbol) => symbol.name === "before"));
    assert.ok(malformed.warnings.some((warning) => warning.includes("affected syntax")));
    const huge = await analyzeCppSnapshot({ current: { "huge.cpp": " ".repeat(5_000_001) } });
    assert.match(huge.warnings.join("\n"), /5 MB/);
});

test("Windows compiler annotations parse without macro expansion; unknown annotations remain explicit", async () => {
    const report = await analyzeCppSnapshot({ current: {
        "windows.cpp": "__declspec(dllexport) int __stdcall call(int value) { return value; }\n",
        "unknown.cpp": "RESULT UNKNOWN_CALLING_CONVENTION call(ARG value) { return value; }\n",
    } });
    assert.ok(report.symbols.some((symbol) => symbol.path === "windows.cpp" && symbol.name === "call"));
    assert.ok(!report.symbols.some((symbol) => symbol.name.includes("UNKNOWN_CALLING_CONVENTION")));
    assert.ok(report.warnings.some((warning) => warning.includes("unknown.cpp") && warning.includes("affected syntax")));
});

test("Catch2 cases are source-linked without executing test registration macros", async () => {
    const report = await analyzeCppSnapshot({ current: {
        "limit.hpp": "inline int limit(int x) { return x; }\n",
        "tests/test.cpp": '#include "../limit.hpp"\nTEST_CASE("accepts value", "[limit]") { REQUIRE(limit(2) == 2); }\n',
    } });
    assert.deepEqual(report.code_paths.verification.tests.map((test) => [test.name, test.framework]), [["accepts value", "catch2"]]);
});

test("file explanations select late native edits instead of unchanged opening lines", async () => {
    const base = Array.from({ length: 300 }, (_, index) => `// line ${index + 1}`);
    const current = [...base]; current[249] = "int changed() { return 2; }";
    const result = await annotationCodeContext({ nodes: [] },
        { subject: { kind: "file", path: "late.cpp", change: "modified" }, evidence: {} }, async () => ({
            base: base.join("\n"), current: current.join("\n"),
            diff: "@@ -250 +250 @@\n-// line 250\n+int changed() { return 2; }\n",
        }));
    assert.match(result.current.ranges[0].excerpt, /return 2/);
    assert.match(result.base.ranges[0].excerpt, /line 250/);
    assert.deepEqual(result.current.changed_lines, { total: 1, included: 1 });
    assert.equal(result.evidence_limits.unrelated_diff_hunks, 0);
});

test("test planning requires an explicit build and exact framework filter", async () => {
    const report = await analyzeCppSnapshot({ baseline, current });
    const plan = cppTestPlan({ ...report.code_paths, status: "complete" }, "C:\\repo");
    assert.equal(plan.reason, null);
    assert.equal(resolveCppTestRuntime("", {}).error.includes("Configure test_cpp"), true);
    const runtime = resolveCppTestRuntime("", { test_cpp: "test.exe", test_cpp_build: ["compiler", "tests.cpp"] });
    assert.equal(runtime.error, null);
    assert.deepEqual(cppTestCommand(runtime, plan), ["test.exe", "--gtest_filter=Policy.limit", "--gtest_color=no"]);
});

test("configured native test runner builds, verifies hashes and rejects zero-test successes", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agent-review-cpp-run-"));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.cpp"), "int run(){return 1;}\n");
    const executable = join(root, process.platform === "win32" ? "runner.exe" : "runner");
    // A real executable with a tiny script is enough to test the runner protocol without a compiler.
    const { copyFile } = await import("node:fs/promises");
    await copyFile(process.execPath, executable);
    const runtime = { executable: process.platform === "win32" ? "runner.exe" : "runner",
        build: [process.execPath, "-e", "console.log('build complete')"], error: null };
    const plan = { cpp_tests: [{ id: "test::run", name: "Suite.run", framework: "gtest" }],
        source_hashes: { "src/app.cpp": cppSourceHash("int run(){return 1;}\n") } };
    // Node rejects GoogleTest switches. A nonzero process cannot become passing evidence.
    await assert.rejects(runCppTests({ repoRoot: root, python: runtime, plan }), /did not report an outcome/);
    await writeFile(join(root, "src", "app.cpp"), "int run(){return 2;}\n");
    await assert.rejects(runCppTests({ repoRoot: root, python: runtime, plan }), /source changed/);
    await assert.rejects(runCppTests({ repoRoot: root, python: { ...runtime, executable: "../outside" }, plan }), /inside the reviewed snapshot/);
});

test("native sample tests build and run from both the worktree and an exact historical export", async (t) => {
    const execute = promisify(execFile);
    try { await execute(process.platform === "win32" ? "cl" : "c++", [process.platform === "win32" ? "/?" : "--version"]); }
    catch (error) {
        if (error.code === "ENOENT") { t.skip("No C++ compiler installed; static review requires none."); return; }
        if (!Number.isInteger(error.code)) throw error;
    }
    const root = await mkdtemp(join(tmpdir(), "agent-review-cpp-native-"));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const repo = join(root, "repo");
    await prepareSample("cpp-demo", repo);
    const runtime = resolveCppTestRuntime(repo, { test_cpp: "native-tests.exe", test_cpp_build: [process.execPath, "build-tests.mjs"] });
    const run = async (directory) => {
        const files = Object.fromEntries(await Promise.all(
            ["app.cpp", "legacy.c", "include/policy.hpp", "tests/policy_tests.cpp"].map(async (path) =>
                [path, await readFile(join(directory, path), "utf8")])));
        const report = await analyzeCppSnapshot({ current: files });
        const plan = cppTestPlan({ ...report.code_paths, status: "complete" }, directory);
        const result = await runCppTests({ repoRoot: directory, python: runtime, plan });
        assert.equal(result.exit_code, 0);
        assert.equal(Object.values(result.trace.tests).filter((test) => test.outcome === "passed").length, 2);
        assert.equal(result.trace.per_test_path_evidence, false);
    };
    await run(repo);
    const exported = await exportSnapshot(repo, "HEAD");
    try { await run(exported); }
    finally { await rm(exported, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    const status = (await execute("git", ["-C", repo, "status", "--short"])).stdout;
    assert.ok(!status.includes("native-tests"), "build artifacts remain ignored");
});

test("cancelling native builds stops the owned process without test outcomes", { timeout: 15_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agent-review-cpp-cancel-"));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    await writeFile(join(root, "app.cpp"), "int run(){return 1;}");
    const plan = { cpp_tests: [{ id: "app::run", name: "Suite.run", framework: "gtest" }],
        source_hashes: { "app.cpp": cppSourceHash("int run(){return 1;}") } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Native build cancelled")), 250);
    try {
        await assert.rejects(runCppTests({ repoRoot: root, plan, signal: controller.signal,
            python: { executable: "unused.exe", build: [process.execPath, "-e", "setInterval(()=>{},1000)"], error: null } }),
        /Native build cancelled/);
    } finally { clearTimeout(timer); }
});
