import assert from "node:assert/strict";
import test from "node:test";
import { ReviewState } from "../review-state.mjs";
import { validateCustomAnalysis } from "../custom-analysis.mjs";
import { packageEvidenceLinks } from "../web/package-presentation.mjs";
import { parseSourceReference } from "../web/source-references.mjs";
import { isReviewSymbol } from "../web/languages.mjs";

test("C# constructors and operators stay visible as reviewable constructs", () => {
    for (const kind of ["constructor", "operator", "property", "accessor"]) {
        assert.equal(isReviewSymbol({ kind, language: "csharp" }), true);
    }
});

test("all implemented source languages validate citations without matching partial extensions", () => {
    for (const file of ["core.ts", "view.tsx", "badge.jsx", "resolver.mjs", "legacy.cjs", "types.mts", "node.cts",
        "Widget.cs", "App.csproj", "Solution.sln", "Directory.Packages.props", "rules.targets",
        "worker.go", "worker_test.go", "go.mod", "go.sum", "lib.rs", "Cargo.toml", "Cargo.lock", "styles.css"]) {
        const context = { files: [{ path: `src/${file}`, current_line_count: 4 }] };
        const content = `## Findings\n\nNo supported findings.\n\n## Verification\n\n- Check \`src/${file}:3\`.`;
        assert.equal(validateCustomAnalysis(content, context), content);
        assert.deepEqual(parseSourceReference(`src/${file}:3`), { path: `src/${file}`, lines: [3] });
        assert.throws(() => validateCustomAnalysis(content.replace(":3", ":20"), context),
            /outside the saved current source/, `${file} rejects out-of-range lines`);
        assert.throws(() => validateCustomAnalysis(content.replace(`src/${file}`, `other/${file}`), context),
            /outside its supplied evidence/, `${file} rejects paths outside supplied evidence`);
    }
});

test("same-named dependency ecosystems route distinct assessments and registry links", async () => {
    const state = new ReviewState("C:\\repo");
    state.model = { nodes: [], edges: [], changes: [], evidence: {}, source_files: {}, package_dependencies: [
        { name: "shared", declared_current: [{ specifier: "==1.0" }] },
        { name: "shared", ecosystem: "npm", resolved_current: "2.0", declared_current: [{ specifier: "^2.0" }] },
        { name: "shared", ecosystem: "nuget", resolved_current: "3.0", declared_current: [{ specifier: "3.0" }] },
        { name: "shared", ecosystem: "gomod", resolved_current: "v4.0.0", declared_current: [{ specifier: "v4.0.0" }] },
        { name: "shared", ecosystem: "cargo", resolved_current: "4.0.0", declared_current: [{ specifier: "4" }] },
    ] };
    const calls = [];
    state.packageAssessmentFor = async (key, name, version, ecosystem) => {
        calls.push({ key, ecosystem, version });
        return { name, version };
    };
    for (const ecosystem of ["pypi", "npm", "nuget", "gomod", "cargo"]) {
        await state.packageRiskFor("shared", null, { explain: false, ecosystem });
    }
    assert.deepEqual(calls, [
        { key: "shared@1.0", ecosystem: "pypi", version: "1.0" },
        { key: "npm:shared@2.0", ecosystem: "npm", version: "2.0" },
        { key: "nuget:shared@3.0", ecosystem: "nuget", version: "3.0" },
        { key: "gomod:shared@v4.0.0", ecosystem: "gomod", version: "v4.0.0" },
        { key: "cargo:shared@4.0.0", ecosystem: "cargo", version: "4.0.0" },
    ]);
    assert.notEqual(packageEvidenceLinks("shared", "2.0", null, "npm").registry,
        packageEvidenceLinks("shared", "3.0", null, "nuget").registry);
    assert.match(packageEvidenceLinks("shared", "2.0", null, "npm").registry, /npmjs/);
    assert.match(packageEvidenceLinks("shared", "3.0", null, "nuget").registry, /nuget/);
    assert.match(packageEvidenceLinks("shared", "v4.0.0", null, "gomod").registry, /pkg\.go\.dev/);
    await assert.rejects(state.packageRiskFor("shared"), /multiple ecosystems/);
    await state.dispose();
});
