import assert from "node:assert/strict";
import test from "node:test";
import { describeAnalysisWarning } from "../web/analysis-limitations.mjs";
import { analyzeSnapshot } from "../node-compiler.mjs";

const model = { source_files: {
    "src/resolver.js": { current: "" },
    "src/ReviewPolicy/ReviewPolicy.csproj": { current: "" },
    "tests/Tests.csproj": { current: "" },
} };

test("unresolved call notes explain uncertainty and retain baseline source locations", () => {
    const note = describeAnalysisWarning("[Base] src/resolver.js:2: unresolved call reference.title.trim; target is unknown.", model);
    assert.equal(note.kind, "Unresolved call");
    assert.equal(note.subject, "reference.title.trim");
    assert.match(note.explanation, /Built-in APIs, external libraries, or dynamic receiver types/);
    assert.deepEqual(note.reference, { path: "src/resolver.js", lines: [2], side: "base" });
    assert.equal(note.snapshot, "Base");
});

test("C# project/framework notes link whole saved project files, not invented line numbers", () => {
    const note = describeAnalysisWarning("baseline: src/ReviewPolicy/ReviewPolicy.csproj@net10.0: configuration incomplete; only supported literal XML and supplied sources were analyzed.", model);
    assert.equal(note.framework, "net10.0");
    assert.equal(note.kind, "Project configuration partially analyzed");
    assert.deepEqual(note.reference, { path: "src/ReviewPolicy/ReviewPolicy.csproj", lines: [], side: "base" });
    const packageNote = describeAnalysisWarning("current: tests/Tests.csproj@net10.0: PackageReference 'xunit' unavailable; no restore or assembly loading from reviewed paths.", model);
    assert.equal(packageNote.subject, "xunit");
    assert.equal(packageNote.kind, "Package assembly not loaded");
    assert.equal(packageNote.reference.side, "current");
    assert.match(packageNote.explanation, /does not mean your installed package is missing/);
});

test("unavailable source links never invent a path and unrecognized diagnostics remain visible", () => {
    const note = describeAnalysisWarning("Other.csproj@net10.0: custom configuration is unsupported", model);
    assert.equal(note.reference, null);
    assert.equal(note.message, "custom configuration is unsupported");
    assert.equal(note.kind, "Analyzer note");
    const builtin = describeAnalysisWarning("[Base/current] src/resolver.js:1: unresolved module node:test; target is unknown.", model);
    assert.match(builtin.explanation, /Node built-in/);
    assert.equal(builtin.reference.side, "current");
});

test("Node warning locations retain their actual snapshot without duplicating identical notes", () => {
    const baseline = { "main.js": "export function trim(value) { return value.title.trim(); }\n" };
    const current = { "main.js": "export function trim(value) {\n  return value.title.trim();\n}\n" };
    const report = analyzeSnapshot({ baseline, current, use_cache: false });
    assert.ok(report.warnings.some((warning) => warning.startsWith("[Base] main.js:1: unresolved call")));
    assert.ok(report.warnings.some((warning) => warning.startsWith("[Current] main.js:2: unresolved call")));
    const same = analyzeSnapshot({ baseline, current: baseline, use_cache: false });
    assert.ok(same.warnings.some((warning) => warning.startsWith("[Base/current] main.js:1: unresolved call")));
    assert.equal(same.warnings.length, new Set(same.warnings).size);
});
