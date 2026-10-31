import assert from "node:assert/strict";
import test from "node:test";
import { resolveSymbolReference } from "../web/symbol-links.mjs";
import { packageEvidenceLinks } from "../web/package-presentation.mjs";

test("class fields resolve locally rather than matching unrelated same-named properties", () => {
    const health = { id: "health", kind: "class", name: "HealthCheck", qualified_name: "health.HealthCheck",
        path: "health.py", start_line: 1, fields: [
            { name: "name", line: 2 }, { name: "severity", line: 3 }, { name: "passed", line: 4 }, { name: "message", line: 5 },
        ] };
    const property = { id: "rules-passed", kind: "method", name: "passed", display_name: "RuleResult.passed",
        qualified_name: "rules.RuleResult.passed", parent_id: "rule-result", path: "rules.py", start_line: 43 };
    const model = { nodes: [health, property] };
    for (const field of health.fields) {
        const link = resolveSymbolReference(model, field.name, health);
        assert.equal(link.path, "health.py");
        assert.equal(link.start_line, field.line);
    }
    assert.equal(resolveSymbolReference(model, "passed"), null);
    assert.equal(resolveSymbolReference(model, "self.passed", health).start_line, 4);
    assert.equal(resolveSymbolReference(model, "HealthCheck.passed").path, "health.py");
    assert.equal(resolveSymbolReference(model, "RuleResult.passed").path, "rules.py");
    assert.equal(resolveSymbolReference(model, "HealthCheck").id, "health");
});

test("package evidence links point to public sources and reject unsafe repository URLs", () => {
    const links = packageEvidenceLinks("packaging", "25.0", "https://github.com/pypa/packaging");
    assert.equal(links.release, "https://pypi.org/project/packaging/25.0/");
    assert.equal(links.maintenance, "https://pypi.org/project/packaging/#history");
    assert.match(links.scorecard, /^https:\/\/securityscorecards\.dev\/viewer\/\?uri=/);
    assert.equal(new URL(links.scorecard).searchParams.get("uri"), "github.com/pypa/packaging");
    assert.equal(packageEvidenceLinks("x", "1", "https://github.com.evil.invalid/owner/repo").scorecard, null);
    assert.equal(packageEvidenceLinks("x", "1", "https://user@github.com/owner/repo").scorecard, null);
});
import { parseSourceReference, resolveSourceReference, sourceReferencesInText } from "../web/source-references.mjs";

test("Markdown citations retain snapshot sides and resolve only the selected document's exact basename alias", () => {
    const path = "skills/references/runtime-contract.md";
    const model = { source_files: { [path]: {}, "other/runtime-contract.md": {}, "SKILL.md": {} } };
    assert.deepEqual(parseSourceReference(`base:${path}:134`), { path, lines: [134], side: "base" });
    assert.deepEqual(resolveSourceReference(`current:${path}:136`, model), { path, lines: [136], side: "current" });
    assert.deepEqual(resolveSourceReference("base Runtime Contract:134", model, path), { path, lines: [134], side: "base" });
    assert.equal(resolveSourceReference("base Runtime Contract:134", model), null);
    assert.equal(resolveSourceReference("base Another Contract:134", model, path), null);
    assert.equal(resolveSourceReference(`base:current:${path}:134`, model), null);
    const text = `Compare base Runtime Contract:134 → current Runtime Contract:136 and current:SKILL.md:83.`;
    const links = sourceReferencesInText(text, model, path);
    assert.deepEqual(links.map((link) => link.reference), [
        { path, lines: [134], side: "base" }, { path, lines: [136], side: "current" },
        { path: "SKILL.md", lines: [83], side: "current" },
    ]);
    assert.deepEqual(links.map(({ start, end }) => text.slice(start, end)),
        ["base Runtime Contract:134", "current Runtime Contract:136", "current:SKILL.md:83"]);
    assert.deepEqual(sourceReferencesInText("base Runtime Contract:134", model), []);
});

test("source references accept root files and exact ranges without unbounded expansion", () => {
    for (const extension of ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]) {
        assert.deepEqual(parseSourceReference(`src/main.${extension}:4`), { path: `src/main.${extension}`, lines: [4] });
    }
    assert.deepEqual(parseSourceReference("main.py:2-4,8"), { path: "main.py", lines: [2, 3, 4, 8] });
    assert.deepEqual(parseSourceReference("src\\main.py:3"), { path: "src/main.py", lines: [3] });
    assert.equal(parseSourceReference("main.py:4-2"), null);
    assert.equal(parseSourceReference("main.py:0"), null);
    assert.equal(parseSourceReference("main.py:1-99999999"), null);
    assert.equal(parseSourceReference("main.py:~4"), null);
});

test("source links resolve unique basenames and same-repository absolute paths only", () => {
    const model = { metadata: { repo_root: "C:\\repo" }, source_files: { "src/config.py": {}, "README.md": {} } };
    assert.deepEqual(resolveSourceReference("config.py:3", model), { path: "src/config.py", lines: [3] });
    assert.deepEqual(resolveSourceReference("C:\\repo\\src\\config.py:3", model), { path: "src/config.py", lines: [3] });
    assert.equal(resolveSourceReference("C:\\elsewhere\\src\\config.py:3", model), null);
    assert.equal(resolveSourceReference("missing.py:3", model), null);
    model.source_files["tests/config.py"] = {};
    assert.equal(resolveSourceReference("config.py:3", model), null);
});
