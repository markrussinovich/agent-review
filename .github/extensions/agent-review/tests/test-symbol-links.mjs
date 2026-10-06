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
import { parseSourceReference, resolveSourceReference } from "../web/source-references.mjs";

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
