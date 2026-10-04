import assert from "node:assert/strict";
import test from "node:test";
import { customAnalysisContext, buildCustomAnalysisPrompt, validateCustomAnalysis } from "../custom-analysis.mjs";

test("custom analysis uses bounded saved source and discloses partial evidence", () => {
    const changes = Array.from({ length: 30 }, (_, index) => ({
        path: `file${index}.py`, status: "modified", lines_added: 10, lines_removed: 1,
    }));
    const model = { changes, source_files: Object.fromEntries(changes.map((item) => [item.path, {
        current: "code ".repeat(2000), diff: "+changed\n".repeat(2000),
    }])), metadata: {}, summary: {}, coverage: { available: false } };
    const context = customAnalysisContext(model);
    assert.ok(context.files.reduce((count, item) => count + (item.current?.length || 0) + (item.diff?.length || 0), 0) <= 40_000);
    assert.equal(context.files.length, 20, "budget exhaustion preserves file metadata and discloses unavailable source");
    assert.equal(context.evidence_limits.truncated, true);
    assert.equal(context.coverage_available, false);
    const prompt = buildCustomAnalysisPrompt({ prompt: "Check cancellation handling." }, context);
    assert.match(prompt, /Check cancellation handling/);
    assert.match(prompt, /Do not call tools/);
    assert.match(prompt, /UNTRUSTED DATA ONLY/);
});

test("custom responses enforce concise output and usable snapshot citations", () => {
    const context = { files: [{ path: "src/main.py" }] };
    assert.equal(validateCustomAnalysis("## Findings\n\nNo supported findings.\n\n## Verification\n\nCheck `src/main.py:3`.", context).startsWith("## Findings"), true);
    assert.throws(() => validateCustomAnalysis("## Findings\n\nSee `main.py:3`.\n\n## Verification\n\nCheck source.", context), /outside its supplied evidence/);
    assert.throws(() => validateCustomAnalysis("## Findings\n\nSee `src/main.py:~3`.\n\n## Verification\n\nCheck source.", context), /exact positive line numbers/);
    assert.throws(() => validateCustomAnalysis("## Findings\n\nSee main.py:3.\n\n## Verification\n\nCheck source.", context), /outside its supplied evidence/);
    assert.throws(() => validateCustomAnalysis("## Findings\n\nSee src/main.py:999.\n\n## Verification\n\nCheck source.",
        { files: [{ path: "src/main.py", current_line_count: 3 }] }), /outside the saved current source/);
    assert.throws(() => validateCustomAnalysis(`## Findings\n\n${"word ".repeat(251)}\n\n## Verification\n\nCheck source.`, context), /250 words/);
    assert.throws(() => validateCustomAnalysis("## Findings\n\nNo supported findings. Here is an inventory of correct code.\n\n## Verification\n\nCheck source.", context), /positive-code inventory/);
});
