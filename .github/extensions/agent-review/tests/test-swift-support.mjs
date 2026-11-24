import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeSwiftSnapshot } from "../swift-analyzer.mjs";
import { swiftHash } from "../swift-syntax.mjs";
import { baseline, current } from "./fixtures/swift-demo.mjs";
import { reviewAdapter, sourceAdapter, testAdapterForMap, mergeCodePathMaps } from "../language-adapters.mjs";
import { isReviewSymbol } from "../web/languages.mjs";
import { parseSourceReference } from "../web/source-references.mjs";
import { pathEvidence, scopeDecisionMap, callablesForSubject } from "../web/decision-map.mjs";
import { swiftTestPlan, swiftTestCommand, formatSwiftTestCommand, swiftTestOutcome, runSwiftTests } from "../swift-test-run.mjs";
import { ReviewState } from "../review-state.mjs";
import { exportSnapshot } from "../test-run.mjs";
import { packageEvidenceLinks } from "../web/package-presentation.mjs";

const execute = promisify(execFile);
const writeSources = async (root, files) => {
    for (const [path, source] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), source);
    }
};
const resultXML = (item, children = "") => `<testsuites><testsuite tests="1"><testcase classname="${[item.target, item.suite].filter(Boolean).join(".")}" name="${item.function_name}" time="0.001">${children}</testcase></testsuite></testsuites>`;

test("Swift routing, signature/body changes, unchanged consumers and inferred tests use saved syntax", async () => {
    const report = await analyzeSwiftSnapshot({ baseline, current });
    assert.equal(sourceAdapter("Sources/Policy.SWIFT"), reviewAdapter("swift"));
    assert.equal(testAdapterForMap({ adapter_id: "swift" }).id, "swift");
    assert.deepEqual(parseSourceReference("Sources/Core/Policy.swift:6").lines, [6]);
    for (const kind of ["actor", "protocol", "struct", "enum", "extension", "property", "constructor"]) {
        assert.equal(isReviewSymbol({ language: "swift", kind }), true);
    }
    const score = report.symbols.find((symbol) => symbol.name === "score" && symbol.kind === "function");
    const quote = report.symbols.find((symbol) => symbol.name === "quote");
    assert.equal(score.classification, "modified");
    assert.equal(quote.classification, "unchanged");
    assert.ok(report.edges.some((edge) => edge.kind === "calls" && edge.source === quote.id && edge.target === score.id));
    assert.ok(report.evidence.every((item) => item.path && item.line && /inferred/.test(item.resolution)));
    const map = { ...report.code_paths, status: "complete", adapter_id: "swift" };
    assert.deepEqual(map.verification.tests.map((item) => item.framework).sort(), ["swift-testing", "xctest"]);
    const decision = map.callables[0].entries.find((entry) => entry.status === "changed");
    assert.deepEqual(decision.base.when, ["value >= 0", "value > 3"]);
    assert.deepEqual(decision.decision.when, ["value >= 0", "value > 5"]);
    const run = { status: "complete", tests: map.verification.tests.map((item) => ({ id: item.id, outcome: "passed" })), executed: {}, ran: {} };
    assert.equal(pathEvidence(map.callables[0], decision, run).level, "reachable");
    assert.match(pathEvidence(map.callables[0], decision, run).text, /inferred/);
    assert.equal(swiftTestPlan(scopeDecisionMap(map, [score.path]), ".").swift_tests.length, 2);
    const mixed = { ...mergeCodePathMaps([map, { adapter_id: "cpp", callables: [], totals: {}, warnings: [] }]), status: "complete" };
    assert.equal(swiftTestPlan(scopeDecisionMap(mixed, [score.path]), ".").reason, null);
    assert.match(report.warnings.join("\n"), /macro/);
    const signature = await analyzeSwiftSnapshot({ baseline: { "A.swift": "func f(_ x: Int) -> Int { return x }\n" },
        current: { "A.swift": "public func f(_ x: Int) async throws -> String { return \"ok\" }\n" } });
    assert.equal(signature.symbols.length, 1);
    assert.equal(signature.symbols[0].classification, "modified");
    assert.notEqual(signature.symbols[0].signature_base, signature.symbols[0].signature_current);
});

test("SwiftPM literal declarations, product imports and v1/v2/v3 lock evidence remain distinct", async () => {
    for (const version of [1, 2, 3]) {
        const pin = version === 1 ? { package: "Lib", repositoryURL: "https://example.com/lib.git", state: { version: "1.2.0", revision: "abc" } }
            : { identity: "lib", location: "https://example.com/lib.git", state: { version: "1.2.0", revision: "abc" } };
        const files = {
            "Package.swift": baseline["Package.swift"].replace("dependencies: []", 'dependencies: [.package(url: "https://example.com/lib.git", from: "1.0.0")]')
                .replace('.target(name: "Core")', '.target(name: "Core", dependencies: [.product(name: "LibAPI", package: "lib")])'),
            "Package.resolved": JSON.stringify(version === 1 ? { version, object: { pins: [pin] } } : { version, pins: [pin] }),
            "Sources/Core/Core.swift": "import LibAPI\nfunc f() {}\n",
        };
        const report = await analyzeSwiftSnapshot({ current: files });
        const declared = report.dependencies.current.find((item) => item.evidence_kind === "declaration");
        const locked = report.dependencies.current.find((item) => item.evidence_kind === "lock");
        assert.equal(declared.resolved_version, null);
        assert.equal(locked.resolved_version, "1.2.0");
        assert.deepEqual(declared.used_by, ["Sources/Core/Core.swift:1"]);
        assert.ok(report.edges.some((edge) => edge.kind === "uses_package" && edge.target === declared.id));
        assert.equal(report.dependencies.changes.length, 1);
        const changed = await analyzeSwiftSnapshot({ baseline: files, current: { ...files,
            "Package.resolved": files["Package.resolved"].replace("1.2.0", "1.3.0") } });
        assert.equal(changed.dependencies.changes[0].kind, "version_changed");
    }
});

test("dynamic manifests, interpolation, ambiguous targets and unknown lock schemas do not become resolved facts", async () => {
    const files = {
        "Package.swift": 'import PackageDescription\nlet package = Package(name:"Demo", dependencies: dependencies(), targets: targets())\n',
        "Package.resolved": '{"version":99,"pins":[]}',
        "Sources/Core/A.swift": "func score() -> Int { return 1 }",
        "Tests/CoreTests/A.swift": "import XCTest\nimport Core\nclass Checks: XCTestCase { func testScore(){ XCTAssertEqual(score(), 1) } }",
    };
    const report = await analyzeSwiftSnapshot({ current: files });
    assert.equal(report.dependencies.current.length, 0);
    assert.equal(report.code_paths.verification.tests.length, 0);
    assert.ok(!report.edges.some((edge) => edge.kind === "calls"));
    assert.match(report.warnings.join("\n"), /dynamic SwiftPM dependencies/);
    assert.match(report.warnings.join("\n"), /unsupported Package.resolved/);
    const interpolation = await analyzeSwiftSnapshot({ current: {
        "Package.swift": 'let package = Package(name:"Demo", dependencies:[.package(url:"https://example.com/\\(name).git",from:"1.0.0")],targets:[])',
    } });
    assert.equal(interpolation.dependencies.current.length, 0);
    assert.match(interpolation.warnings.join("\n"), /nonliteral/);
    const mutation = await analyzeSwiftSnapshot({ current: {
        "Package.swift": `${baseline["Package.swift"]}\npackage.dependencies = dynamicDependencies()\n`,
    } });
    assert.match(mutation.warnings.join("\n"), /no single unconditional literal/);
    const unknownCurrent = await analyzeSwiftSnapshot({
        baseline: { "Package.swift": baseline["Package.swift"].replace("dependencies: []",
            'dependencies: [.package(url:"https://example.com/lib.git",from:"1.0.0")]') },
        current: { "Package.swift": files["Package.swift"] },
    });
    assert.deepEqual(unknownCurrent.dependencies.changes, []);
    assert.match(unknownCurrent.warnings.join("\n"), /unknown declarations are not reported as removals/);
    const malformed = await analyzeSwiftSnapshot({ current: {
        "Package.swift": 'let package = Package(name:"Demo", dependencies:[], dependencies:[.package(url:"https://example.com/lib",from:"1.0.0")], targets:[])',
        "Package.resolved": '{"version":3,"pins":[{"identity":"lib","location":"https://example.com/lib","state":{"version":{},"revision":"abc"}}]}',
    } });
    assert.deepEqual(malformed.dependencies.current, []);
    assert.match(malformed.warnings.join("\n"), /malformed pin/);
});

test("nested Swift declarations, accessors and else-if conditions keep their lexical ownership", async () => {
    const report = await analyzeSwiftSnapshot({ current: { "Flow.swift": `func flow(_ x: Int) -> Int {
    if x > 2 { return 3 } else if x > 1 { return 2 } else { return 0 }
}
func outer() {
    func inner() { func nested() { return }; return }
    let closure = { return 42 }
}
struct Value { var data: Int { get { return 7 } set { log() } } }
` } });
    const flow = report.code_paths.callables.find((item) => item.qualname === "flow");
    assert.deepEqual(flow.entries.find((entry) => entry.decision.value === "2").decision.when, ["!(x > 2)", "x > 1"]);
    assert.deepEqual(flow.entries.find((entry) => entry.decision.value === "0").decision.when, ["!(x > 2)", "!(x > 1)"]);
    assert.equal(report.symbols.filter((symbol) => symbol.name === "nested").length, 1);
    assert.ok(report.symbols.some((symbol) => symbol.qualname === "outer.inner.nested"));
    assert.ok(report.symbols.some((symbol) => symbol.kind === "closure"));
    const getter = report.code_paths.callables.find((item) => item.qualname === "Value.data.get");
    assert.equal(getter.entries[0].decision.value, "7");
    const closure = report.symbols.find((symbol) => symbol.kind === "closure");
    assert.deepEqual(callablesForSubject(report.code_paths, report, closure).map((item) => item.id), [closure.id]);
    for (const [kind, source] of [
        ["actor", "actor Store { func read() -> Int { return 1 } }"],
        ["protocol", "protocol Store { func read() -> Int }"],
        ["extension", "extension Store { func read() -> Int { return 1 } }"],
    ]) {
        const scoped = await analyzeSwiftSnapshot({ current: { "Scope.swift": source } });
        const owner = scoped.symbols.find((symbol) => symbol.kind === kind);
        const member = scoped.symbols.find((symbol) => symbol.name === "read");
        assert.ok(owner && member);
        assert.ok(callablesForSubject(scoped.code_paths, scoped, owner).some((item) => item.id === member.id), kind);
    }
});

test("overloads, local shadowing, instance dispatch, closures and conditional compilation stay conservative", async () => {
    const report = await analyzeSwiftSnapshot({ current: { "A.swift": `func score(_ x: Int) -> Int { return x }
func score(_ x: String) -> Int { return 0 }
func caller() -> Int { return score(1) }
func unique() -> Int { return 2 }
func shadow(_ unique: () -> Int) -> Int { return unique() }
func local() -> Int { let unique = callback; return unique() }
struct Item { func method() -> Int { return 3 } }
func dynamic(_ item: Item) -> Int { return item.method() }
func closure() { let f = { return 8 }; f() }
#if DEBUG
func configured() {}
#else
func configured() {}
#endif
` } });
    assert.equal(new Set(report.symbols.map((symbol) => symbol.id)).size, report.symbols.length);
    assert.equal(report.edges.filter((edge) => edge.kind === "calls").length, 0);
    const closure = report.code_paths.callables.find((item) => item.qualname === "closure");
    assert.ok(!closure.entries.some((entry) => entry.decision.value === "8"));
    assert.match(report.warnings.join("\n"), /conditional compilation/);
    const simple = await analyzeSwiftSnapshot({ current: { "A.swift": "func unique() -> Int { return 1 }\nfunc f(_ unique: () -> Int) -> Int { return unique() }\n" } });
    assert.equal(simple.edges.filter((edge) => edge.kind === "calls").length, 0);
});

test("Swift Unicode, BOM/CRLF, comments, malformed input and removed declarations keep source evidence honest", async () => {
    const source = '// \u03bb\nfunc f() -> String { /* return "no"; */ return "yes" }\n';
    const report = await analyzeSwiftSnapshot({ baseline: { "A.swift": source }, current: { "A.swift": `\uFEFF${source.replaceAll("\n", "\r\n")}` } });
    assert.equal(report.symbols[0].classification, "unchanged");
    assert.equal(report.symbols[0].range.start_line, 2);
    const removed = await analyzeSwiftSnapshot({ baseline: { "A.swift": source } });
    assert.equal(removed.code_paths.callables[0].entries[0].status, "removed");
    assert.equal(removed.code_paths.callables[0].entries[0].decision.value, '"yes"');
    const broken = await analyzeSwiftSnapshot({ current: { "Broken.swift": "func good() { return }\nfunc bad( {", "Huge.swift": " ".repeat(5_000_001) } });
    assert.equal(broken.code_paths.limited, true);
    assert.match(broken.warnings.join("\n"), /incomplete/);
    assert.match(broken.warnings.join("\n"), /5 MB/);
});

test("Swift commands are explicit, locked and exact, while unresolved selectors cannot run", async () => {
    const report = await analyzeSwiftSnapshot({ baseline, current });
    const plan = swiftTestPlan({ ...report.code_paths, status: "complete" }, ".");
    assert.equal(plan.reason, null);
    const commands = plan.swift_tests.map((item) => swiftTestCommand({ executable: "swift" }, plan, item));
    assert.ok(commands.every((command) => command.includes("--force-resolved-versions") && command.includes("--xunit-output")));
    assert.ok(commands.some((command) => command.includes("^CoreTests\\.PolicyTests/testScore$")));
    assert.ok(commands.some((command) => command.includes("^CoreTests\\.PolicyChecks/scoreLarge\\(\\)(?:/.*)?$")));
    assert.match(formatSwiftTestCommand({ executable: "swift" }, plan), /disable-xctest/);
    assert.match(plan.prerequisites, /not a sandbox/);
    assert.match(swiftTestPlan({ ...report.code_paths, status: "complete", source_hashes: {} }, ".").reason, /hashes/);
    const invalid = structuredClone(report.code_paths);
    invalid.verification.tests[0].selector_error = "Dynamic target";
    assert.match(swiftTestPlan({ ...invalid, status: "complete" }, ".").reason, /Dynamic target/);
    assert.throws(() => swiftTestCommand({ executable: "swift" }, { ...plan, manifest: "../Package.swift" }), /selector/);
    const item = plan.swift_tests[0];
    assert.equal(swiftTestOutcome(resultXML(item), item), "passed");
    assert.equal(swiftTestOutcome(resultXML(item, "<failure/>"), item), "failed");
    assert.equal(swiftTestOutcome(resultXML(item, "<skipped/>"), item), "skipped");
    assert.throws(() => swiftTestOutcome("<testsuites></testsuites>", item), /exactly one/);
    assert.throws(() => swiftTestOutcome(resultXML(item).replace(item.function_name, "different"), item), /different test/);
    assert.throws(() => swiftTestOutcome(resultXML(item).replace('time="0.001"', ""), item), /completed-test/);
    assert.throws(() => swiftTestOutcome(resultXML(item).slice(0, -4), item), /incomplete/);
});

test("owned Swift runner rejects stale inputs, records only named outcomes and supports cancellation", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "swift-runner-fixture-"));
    try {
        await writeSources(root, current);
        const map = (await analyzeSwiftSnapshot({ baseline, current })).code_paths;
        const plan = swiftTestPlan({ ...map, status: "complete" }, root);
        const item = plan.swift_tests[0];
        plan.swift_tests = [item]; plan.tests = [item.id];
        // Node's first positional "test" argument loads this local stand-in executable.
        await writeFile(join(root, "test"), `const fs = require("node:fs"); fs.writeFileSync(process.argv[process.argv.indexOf("--xunit-output")+1], ${JSON.stringify(resultXML(item))});`);
        const run = () => runSwiftTests({ repoRoot: root, python: { executable: process.execPath }, plan });
        const result = await run();
        assert.equal(result.trace.per_test_path_evidence, false);
        assert.deepEqual(result.trace.tests[item.id], { outcome: "passed", executed_lines: {} });
        await writeFile(join(root, "Sources", "Core", "New.swift"), "func newFunction() {}\n");
        await assert.rejects(run(), /inventory changed/);
        await rm(join(root, "Sources", "Core", "New.swift"));
        await writeFile(join(root, "Package.swift"), `${current["Package.swift"]}\n// changed`);
        await assert.rejects(run(), /source changed/);
        await writeFile(join(root, "Package.swift"), current["Package.swift"]);
        await writeFile(join(root, "test"), 'const fs=require("node:fs"); fs.appendFileSync("Sources/Core/Policy.swift", "\\n// changed");');
        await assert.rejects(run(), /source changed/);
        await writeFile(join(root, "Sources", "Core", "Policy.swift"), current["Sources/Core/Policy.swift"]);
        await writeFile(join(root, "test"), "setInterval(() => {}, 1000);");
        const controller = new AbortController();
        const pending = runSwiftTests({ repoRoot: root, python: { executable: process.execPath }, plan, signal: controller.signal });
        const timer = setTimeout(() => controller.abort(new Error("Cancelled Swift fixture")), 300);
        try { await assert.rejects(pending, /Cancelled Swift fixture/); } finally { clearTimeout(timer); }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test("production review model and historical exports retain Swift source, inferred paths and dependency boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "swift-review-fixture-"));
    let exported, state;
    try {
        const git = (...args) => execute("git", ["-C", root, "-c", "commit.gpgsign=false", ...args]);
        await writeSources(root, baseline);
        await git("init", "-q", "--template=");
        await git("config", "user.name", "Swift fixture");
        await git("config", "user.email", "swift@example.invalid");
        await git("add", ".");
        await git("commit", "-qm", "Baseline");
        await writeSources(root, current);
        state = new ReviewState(root, { baseRef: "HEAD", getSessionEvents: async () => [] });
        await state.refresh();
        assert.equal(state.error, null);
        const map = await state.decisionMapFor(60_000);
        assert.equal(map.adapter_id, "swift");
        assert.ok(state.model.metadata.swift_loc > 0);
        assert.ok(state.model.nodes.some((node) => node.language === "swift" && node.kind === "actor"));
        assert.ok(state.model.source_files["Sources/Core/Policy.swift"].baseline.includes("value > 3"));
        assert.ok((await state.testRunPlan()).available);
        const assessment = await state.packageAssessmentFor("swiftpm:test", "test", null, "swiftpm");
        assert.equal(assessment.risk.level, "unknown");
        assert.deepEqual(packageEvidenceLinks("test", "1.0.0", null, "swiftpm"), {
            registry: null, release: null, maintenance: null, vulnerabilities: null, downloads: null, scorecard: null,
        });
        await git("add", ".");
        await git("commit", "-qm", "Threshold change");
        const head = (await git("rev-parse", "HEAD")).stdout.trim();
        exported = await exportSnapshot(root, head);
        assert.equal(swiftHash(await readFile(join(exported, "Sources", "Core", "Policy.swift"), "utf8")), swiftHash(current["Sources/Core/Policy.swift"]));
        const plan = swiftTestPlan(map, exported), item = plan.swift_tests[0];
        plan.swift_tests = [item]; plan.tests = [item.id];
        await writeFile(join(exported, "test"), `const fs = require("node:fs"); fs.writeFileSync(process.argv.at(-1), ${JSON.stringify(resultXML(item))});`);
        const result = await runSwiftTests({ repoRoot: exported, python: { executable: process.execPath }, plan });
        assert.equal(result.trace.tests[item.id].outcome, "passed");
    } finally {
        await state?.dispose();
        if (exported) await rm(exported, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});

test("native SwiftPM XCTest and Swift Testing execution, when Swift is installed", { timeout: 180_000 }, async (context) => {
    try { await execute("swift", ["--version"]); }
    catch (error) {
        if (error.code === "ENOENT") { context.skip("Swift is not installed; native execution is unverified on this host."); return; }
        throw error;
    }
    const root = await mkdtemp(join(tmpdir(), "swift-native-fixture-"));
    try {
        await writeSources(root, current);
        const map = (await analyzeSwiftSnapshot({ baseline, current })).code_paths;
        const plan = swiftTestPlan({ ...map, status: "complete" }, root);
        const result = await runSwiftTests({ repoRoot: root, python: { executable: "swift" }, plan, timeoutMs: 150_000 });
        assert.deepEqual(Object.values(result.trace.tests).map((record) => record.outcome), ["passed", "passed"]);
        assert.equal(result.trace.per_test_path_evidence, false);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
