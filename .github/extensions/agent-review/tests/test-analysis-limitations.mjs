import assert from "node:assert/strict";
import test from "node:test";
import { describeAnalysisWarning, summarizeAnalysisWarnings, unlinkedSentence } from "../web/analysis-limitations.mjs";
import { reviewContext } from "../web/review-presentation.mjs";
import { analyzeSnapshot } from "../node-compiler.mjs";

const model = { source_files: {
    "src/resolver.js": { current: "" },
    "src/ReviewPolicy/ReviewPolicy.csproj": { current: "" },
    "tests/Tests.csproj": { current: "" },
} };

test("library calls that cannot be linked are summarized apart from real limitations", () => {
    const warnings = [
        ...Array.from({ length: 5 }, (_, index) => `[Base/current] web/a.test.jsx:${index + 1}: unresolved call expect; target is unknown.`),
        "[Base/current] web/a.test.jsx:9: unresolved call it; target is unknown.",
        "[Current] src/app.ts:3: unresolved module react; target is unknown.",
        "[Base/current] src/app.ts:7: unresolved call (items || [])\n    .map; target is unknown.",
        "[Base/current] src/app.ts:8: unresolved call (other || [])\n    .map; target is unknown.",
        "Rust coverage ignored: add rust-coverage.json with revision, report, and source_hashes evidence.",
    ];
    const notes = summarizeAnalysisWarnings(warnings);
    assert.deepEqual([notes.calls, notes.imports, notes.unlinked, notes.other.length], [8, 1, 9, 1]);
    assert.deepEqual(notes.top.slice(0, 2), ["expect", "it"]);
    assert.ok(!notes.top.includes(""), "a call written as a parenthesized expression never shows a blank name");
    assert.equal(notes.byPath.get("src/app.ts"), 3);
    assert.equal(notes.ordered[0], warnings.at(-1), "real limitations are listed first");
    assert.match(unlinkedSentence(notes), /could not link 8 calls and 1 import to saved source \(most often expect, it/);
    assert.equal(summarizeAnalysisWarnings(warnings), notes, "summaries are cached per warning list");
    const gaps = reviewContext({ nodes: [], edges: [], warnings }, { path: "src/app.ts" }).gaps.join(" ");
    assert.match(gaps, /could not link 3 calls or imports in this file/);
    assert.match(gaps, /1 saved analyzer limitation in the change overview/);
    assert.doesNotMatch(gaps, /9 saved analyzer/);
});

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

test("adapter failures name the missing language and phase without inventing a source finding", () => {
    const note = describeAnalysisWarning(
        "C# facts unavailable: scan failed: Roslyn snapshot analysis failed (exit 42): helper failure Graph, package usage and coverage facts for this language were omitted; source diffs remain available.",
        model,
    );
    assert.equal(note.kind, "Language facts unavailable");
    assert.equal(note.adapter_unavailable, true);
    assert.equal(note.subject, "C#");
    assert.equal(note.message, "scan failed: Roslyn snapshot analysis failed (exit 42): helper failure");
    assert.equal(note.reference, null);
    assert.match(note.explanation, /omitted together.*other languages and saved source diffs/);
    assert.match(note.explanation, /not successful zero-usage or zero-coverage/);
    assert.equal(describeAnalysisWarning("Unknown compiler note", model).adapter_unavailable, undefined);
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

test("Rust limitations explain saved-syntax and source-matched coverage boundaries", () => {
    const syntax = describeAnalysisWarning(
        "Rust saved-syntax analysis does not expand macros, evaluate cfg/build scripts, or perform type-directed/dynamic trait dispatch; unresolved relationships remain unknown.",
        model,
    );
    assert.equal(syntax.kind, "Rust syntax analysis is conservative");
    assert.match(syntax.explanation, /never runs Cargo or rustc/);
    const coverage = describeAnalysisWarning(
        "Rust coverage ignored: add rust-coverage.json with revision, report, and source_hashes evidence.",
        model,
    );
    assert.equal(coverage.kind, "Rust coverage unavailable");
    assert.match(coverage.explanation, /exact reviewed revision/);
});
