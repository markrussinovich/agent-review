import assert from "node:assert/strict";
import test from "node:test";
import { buildPackageUsageContext } from "../package-context.mjs";
import { buildPackagePrompt } from "../ai-prompts.mjs";

test("package explanation receives saved implementations, including calls far beyond the import", () => {
    const current = ["from croniter import croniter", ...Array(1500).fill("# filler"),
        "def next_run(expression, start):", "    iterator = croniter(expression, start)",
        "    return iterator.get_next(datetime)"].join("\n");
    const context = buildPackageUsageContext({ source_files: { "src/scheduling.py": { current, diff: "+added code" } } },
        { usage_locations: ["src/scheduling.py:1"] });
    assert.match(context.files[0].excerpts.map((item) => item.text).join("\n"), /iterator\.get_next\(datetime\)/);
    assert.match(buildPackagePrompt({ name: "croniter" }, {}, context), /specific package APIs they call/);
    assert.match(buildPackagePrompt({ name: "croniter" }, {}, context), /iterator\.get_next/);
});

test("package code evidence is bounded and missing sources never imply usage", () => {
    const source_files = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`file${i}.py`,
        { current: "long source\n".repeat(10_000), diff: "+diff\n".repeat(1000) }]));
    const context = buildPackageUsageContext({ source_files },
        { usage_locations: Object.keys(source_files).map((path) => `${path}:1`) });
    const size = context.files.reduce((sum, item) => sum + item.diff.length
        + item.excerpts.reduce((count, excerpt) => count + excerpt.text.length, 0), 0);
    assert.ok(size <= 64_000);
    assert.equal(context.omitted_importing_files, 3);
    assert.equal(context.files[0].truncated, true);
    assert.match(buildPackageUsageContext({}, { usage_locations: [] }).note, /Do not invent runtime usage/);
});

test("NuGet briefings receive saved implementations from declaring projects even without assembly usage edges", () => {
    const receipt = "using Newtonsoft.Json;\nclass ReviewPolicy {\n  public string CreateReceipt() {\n    return JsonConvert.SerializeObject(new { Decision = \"accept\" });\n  }\n}\n";
    const model = {
        source_files: {
            "src/ReviewPolicy/ReviewPolicy.csproj": { current: "<Project />" },
            "src/ReviewPolicy/Receipt.cs": { current: receipt, diff: "" },
            "other/Other.csproj": { current: "<Project />" },
            "other/Unrelated.cs": { current: "using Newtonsoft.Json;\nclass Unrelated {}" },
        },
        symbols: [
            { kind: "method", qualname: "ReviewPolicy.CreateReceipt()", path: "src/ReviewPolicy/Receipt.cs",
                compiler_scope: "src/ReviewPolicy/ReviewPolicy.csproj@net10.0", range: { start_line: 3, end_line: 5 } },
            { kind: "class", name: "Unrelated", path: "other/Unrelated.cs", compiler_scope: "other/Other.csproj@net10.0" },
        ],
    };
    const dependency = { name: "Newtonsoft.Json", ecosystem: "nuget", usage_locations: [],
        declared_current: [{ project: "src/ReviewPolicy/ReviewPolicy.csproj", source: "src/ReviewPolicy/ReviewPolicy.csproj" }] };
    const context = buildPackageUsageContext(model, dependency);
    assert.deepEqual(context.files.map((file) => file.path), ["src/ReviewPolicy/Receipt.cs"]);
    assert.deepEqual(context.files[0].using_lines, [1]);
    assert.deepEqual(context.files[0].import_lines, [], "no resolved usage edge is invented");
    assert.equal(context.files[0].association, "inferred candidate: declaring project and matching namespace import");
    assert.equal(context.files[0].methods[0].name, "ReviewPolicy.CreateReceipt()");
    assert.match(context.files[0].excerpts[0].text, /4:.*JsonConvert.SerializeObject/);
    assert.match(context.note, /Namespace spelling alone does not prove/);
    assert.match(buildPackagePrompt(dependency, {}, context), /never say no source was supplied/);
    assert.match(buildPackagePrompt(dependency, {}, context), /Registry metadata or Scorecard failures do not invalidate that OSV result/);
});

test("NuGet directory candidates respect nested project boundaries and nearest directory, not filename length", () => {
    const model = { source_files: {
        "ExtremelyLongRootProjectName.csproj": { current: "<Project />" },
        "src/Short.csproj": { current: "<Project />" },
        "src/Serializer.cs": { current: "using Package.Name;\nclass Serializer {}" },
        "src/nested/Other.csproj": { current: "<Project />" },
        "src/nested/NotIncluded.cs": { current: "using Package.Name;\nclass Other {}" },
    } };
    const context = buildPackageUsageContext(model, { name: "Package.Name", ecosystem: "nuget", usage_locations: [],
        declared_current: [{ source: "src/Short.csproj" }] });
    assert.deepEqual(context.files.map((file) => file.path), ["src/Serializer.cs"]);
});

test("NuGet namespace spelling does not leak unrelated repository code into the context", () => {
    const context = buildPackageUsageContext({ source_files: {
        "other/Receipt.cs": { current: "using Newtonsoft.Json;\nclass Receipt {}" },
    } }, { name: "Newtonsoft.Json", ecosystem: "nuget", usage_locations: [], declared_current: [] });
    assert.deepEqual(context.files, []);
    assert.match(context.note, /Do not invent runtime usage/);
});
