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
