import assert from "node:assert/strict";
import test from "node:test";
import { DOTNET_REVIEW_ADAPTER } from "../dotnet-review-adapter.mjs";
import { dotnetTestCommand, dotnetTestPlan, formatDotnetTestCommand } from "../dotnet-test-run.mjs";
import { assessPackageRisk } from "../package-risk.mjs";
import { packageEvidenceLinks } from "../web/package-presentation.mjs";
import { callableName, callablesForSubject, pathEvidence } from "../web/decision-map.mjs";
import { parseSourceReference } from "../web/source-references.mjs";
import { resolveSymbolReference } from "../web/symbol-links.mjs";
import { ReviewState, runDecisionExtractor } from "../review-state.mjs";
import { isReviewSymbol } from "../web/languages.mjs";
import { mergeCodePathMaps } from "../language-adapters.mjs";

test("C# requests contain saved baseline and current configuration, never live files", () => {
    const model = { symbols: [{ language: "csharp", kind: "method", classification: "modified" }],
        source_files: { "App.cs": { baseline: "old", current: "new" },
            "App.csproj": { baseline: "<Project/>", current: "<Project/>" },
            "main.py": { current: "ignored" } } };
    assert.deepEqual(DOTNET_REVIEW_ADAPTER.buildCodePathRequest(model), {
        baseline: { "App.cs": "old", "App.csproj": "<Project/>" },
        current: { "App.cs": "new", "App.csproj": "<Project/>" },
    });
    assert.equal(DOTNET_REVIEW_ADAPTER.buildCodePathRequest({ symbols: [] }), null);
});

test("C# requests retain compiler inputs but exclude unrelated mixed-repository source and assets", () => {
    const inputs = ["src/App.CS", "src/App.CSPROJ", "App.sln", "App.slnx", "Directory.Build.props",
        "Directory.Packages.props", "src/Custom.targets", "global.json", "src/NuGet.Config", "src/.editorconfig"];
    const excluded = ["main.py", "ui/app.ts", "data/large.json", "assets/strings.resx",
        "assets/logo.svg", "nested/not-global.json", "nuget.config.txt", "global.json/notes.txt"];
    const source_files = Object.fromEntries([...inputs, ...excluded]
        .map((path) => [path, { baseline: "saved base", current: "saved current" }]));
    const request = DOTNET_REVIEW_ADAPTER.buildCodePathRequest({
        symbols: [{ language: "csharp", kind: "method", classification: "modified" }], source_files,
    });
    assert.deepEqual(Object.keys(request.baseline), inputs);
    assert.deepEqual(Object.keys(request.current), inputs);
});

test("C# paths reuse the scan's immutable compiler result without another helper process", async () => {
    const paths = { callables: [], totals: {}, limited: true, warnings: ["Saved compiler limit"] };
    const request = DOTNET_REVIEW_ADAPTER.buildCodePathRequest({
        symbols: [{ language: "csharp", kind: "method", classification: "modified" }],
        source_files: {}, code_paths: { csharp: paths },
    });

    assert.deepEqual(request, { precomputed: paths });
    assert.deepEqual(await runDecisionExtractor({ ...request, adapter_id: "csharp" }),
        { ...paths, adapter_id: "csharp" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runDecisionExtractor(request, { signal: controller.signal }), { name: "AbortError" });
});

test("constructor/local-function reviews and cached C# test candidate limits remain explicit", () => {
    const paths = { callables: [], totals: {}, limited: true, warnings: [],
        verification: { tests: [], omitted_tests: 7, limited: true } };
    for (const kind of ["constructor", "function", "accessor"]) {
        const request = DOTNET_REVIEW_ADAPTER.buildCodePathRequest({
            symbols: [{ language: "csharp", kind, classification: "modified" }], code_paths: { csharp: paths },
        });
        assert.equal(request.precomputed.verification.omitted_tests, 0);
        assert.equal(request.precomputed.verification.omitted_test_candidates, 7);
    }
    assert.equal(paths.verification.omitted_tests, 7, "older saved reports are not mutated");
    const combined = mergeCodePathMaps([
        { adapter_id: "csharp", callables: [], warnings: [], verification: {
            tests: [], omitted_tests: 0, omitted_test_candidates: 7, limited: true } },
        { adapter_id: "python", callables: [], warnings: [], verification: { tests: [], omitted_tests: 2 } },
    ]);
    assert.equal(combined.verification.omitted_tests, 2);
    assert.equal(combined.verification.omitted_test_candidates, 7);
});

test("xUnit plans use exact filters, surface build/restore, and reject outside project paths", () => {
    const map = { status: "complete", verification: { tests: [
        { id: "Tests.WidgetTests.Run", link: "direct", project: "tests\\Tests.csproj" },
    ] } };
    const plan = dotnetTestPlan(map, "C:\\repo");
    assert.equal(plan.reason, null);
    assert.match(plan.prerequisites, /builds\/restores/);
    assert.deepEqual(dotnetTestCommand({ executable: "dotnet" }, plan),
        ["dotnet", "test", ".\\tests\\Tests.csproj", "--filter", "FullyQualifiedName=Tests.WidgetTests.Run", "--logger", "trx", "--nologo",
            "-p:UseSharedCompilation=false", "-nodeReuse:false"]);
    assert.match(dotnetTestPlan({ ...map, verification: { tests: [{ ...map.verification.tests[0], project: "..\\outside.csproj" }] } }, "C:\\repo").reason, /outside/);
    assert.match(formatDotnetTestCommand({ executable: "C:\\Program Files\\dotnet\\dotnet.exe" },
        { ...plan, tests: ["Tests.One", "Tests.Two"] }), /^& 'C:\\Program Files\\dotnet\\dotnet.exe'/);
    assert.match(formatDotnetTestCommand({ executable: "dotnet" }, { ...plan, tests: ["Tests.One", "Tests.Two"] }),
        /'FullyQualifiedName=Tests.One\|FullyQualifiedName=Tests.Two'/);
});

test("bounded C# analysis cannot present absent links as no callers or tests", () => {
    for (const map of [{ limited: true }, { verification: { limited: true } }]) {
        const plan = dotnetTestPlan({ status: "complete", ...map }, "C:\\repo");
        assert.match(plan.reason, /incomplete analysis/);
        assert.doesNotMatch(plan.reason, /No statically resolved xUnit tests reach/);
    }
    const result = pathEvidence({ id: "bounded" }, {
        status: "added", decision: { line: 1 }, evidence: { level: "none", tests: [], limited: true },
    });
    assert.equal(result.level, "none");
    assert.equal(result.text, "No test evidence in incomplete analysis");
});

test("NuGet assessment queries only NuGet and NuGet OSV for the exact saved version", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
        return { ok: true, json: async () => url.includes("nuget") ? { versions: ["1.0.0", "2.0.0"] } : { vulns: [] } };
    };
    const result = await assessPackageRisk("Demo", "1.0.0", { ecosystem: "nuget", fetchImpl });
    assert.equal(result.version, "1.0.0");
    assert.equal(result.risk.level, "unknown");
    assert.equal(calls[1].body.package.ecosystem, "NuGet");
    assert.equal(calls[1].body.version, "1.0.0");
    assert.ok(calls.every((item) => !item.url.includes("pypi")));
    const links = packageEvidenceLinks("Demo", "1.0.0", null, "nuget");
    assert.match(links.registry, /nuget.org/);
    assert.match(links.vulnerabilities, /ecosystem=NuGet/);
    await assert.rejects(() => assessPackageRisk("Demo", "[1,2)", { ecosystem: "nuget", fetchImpl }), /exact version/);
});

test("a passing TRX test with no line trace never confirms a path or reports it unexecuted", () => {
    const entry = { status: "added", decision: { line: 4 },
        evidence: { level: "exercised", tests: [{ id: "Tests.Run" }] } };
    const result = pathEvidence({ id: "method" }, entry, {
        status: "complete", tests: [{ id: "Tests.Run", outcome: "passed" }], executed: {}, ran: {}, planned: 1,
    });

    assert.equal(result.level, "exercised");
    assert.doesNotMatch(result.text, /Confirmed|Not executed/);
});

test("C# source, project and property references resolve without selecting ambiguous overloads", () => {
    assert.deepEqual(parseSourceReference("src\\Widget.cs:4-5"), { path: "src/Widget.cs", lines: [4, 5] });
    assert.deepEqual(parseSourceReference("Tests.csproj:9"), { path: "Tests.csproj", lines: [9] });
    const owner = { id: "class", kind: "class", name: "Widget", path: "Widget.cs", start_line: 1 };
    const property = { id: "prop", kind: "property", name: "Value", parent_id: "class", path: "Widget.cs", start_line: 4 };
    assert.equal(resolveSymbolReference({ nodes: [owner, property] }, "this.Value", owner), property);
    const overloads = ["int", "string"].map((type) => ({ id: type, kind: "method", name: "Run", language: "csharp",
        display_name: `Widget.Run(${type})`, parent_id: "class", path: "Widget.cs", start_line: 5 }));
    assert.equal(resolveSymbolReference({ nodes: [owner, ...overloads] }, "Widget.Run(string)", owner), overloads[1]);
});

test("partial C# class paths use compiler ownership across files and expose framework scope", () => {
    const type = { id: "type", kind: "class", language: "csharp", path: "One.cs" };
    const map = { callables: [{ id: "method", path: "Two.cs", qualname: "Widget.Run()", language: "csharp", target_framework: "net10.0" }] };
    assert.deepEqual(callablesForSubject(map, { symbols: [{ id: "method", parent_id: "type" }] }, type), map.callables);
    assert.equal(callableName(map.callables[0]), "Widget.Run() [net10.0]");
    assert.deepEqual(callablesForSubject(map, {}, { id: "method", kind: "property" }), map.callables);
    for (const kind of ["namespace", "interface", "property", "struct", "record"]) {
        assert.equal(isReviewSymbol({ kind, language: "csharp" }), true);
    }
    assert.equal(isReviewSymbol({ kind: "module", language: "csharp" }), false);
});

test("same-named NuGet and PyPI packages never share selection or assessment cache keys", async () => {
    const state = new ReviewState("C:\\repo");
    try {
        state.model = { nodes: [], edges: [], changes: [], evidence: {}, source_files: {},
            package_changes: [{ id: "package:nuget:foo", name: "foo", ecosystem: "nuget" },
                { id: "package:foo", name: "foo" }],
            package_dependencies: [
                { id: "package:nuget:foo", name: "foo", ecosystem: "nuget", resolved_current: "1.0",
                    declared_current: [{ specifier: "1.0", source: "App.csproj" }] },
                { id: "package:foo", name: "foo", declared_current: [{ specifier: "==1.0", source: "requirements.txt" }] },
            ] };
        assert.equal(state.contextFor("package:foo").item.id, "package:foo");
        assert.equal(state.contextFor("package:nuget:foo").item.id, "package:nuget:foo");
        const calls = [];
        state.packageAssessmentFor = async (key, name, version, ecosystem) => {
            calls.push({ key, ecosystem });
            return { name, version };
        };
        await state.packageRiskFor("foo", null, { explain: false, ecosystem: "pypi" });
        await state.packageRiskFor("foo", null, { explain: false, ecosystem: "nuget" });
        assert.deepEqual(calls.map((call) => call.key), ["foo@1.0", "nuget:foo@1.0"]);
        await assert.rejects(state.packageRiskFor("foo"), /multiple ecosystems/);
    } finally { await state.dispose(); }
});
