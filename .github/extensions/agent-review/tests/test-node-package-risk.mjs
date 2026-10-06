import assert from "node:assert/strict";
import test from "node:test";
import { assessNpmPackageRisk } from "../node-package-risk.mjs";
import { packageEvidenceLinks } from "../web/package-presentation.mjs";
import { ReviewState } from "../review-state.mjs";

test("npm assessment sends npm coordinates only and retains unknown broader risk", async () => {
    const requests = [];
    const assessment = await assessNpmPackageRisk("@scope/demo", "1.2.3", {
        fetchImpl: async (url, init) => {
            requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
            return { ok: true, json: async () => url.includes("osv.dev") ? {} : {
                "dist-tags": { latest: "4.0.0" }, versions: { "1.2.3": { license: "MIT" } },
            } };
        },
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.package.ecosystem, "npm");
    assert.equal(requests[1].body.version, "1.2.3");
    assert.ok(requests.every(({ url }) => !url.includes("pypi")));
    assert.equal(assessment.version, "1.2.3");
    assert.equal(assessment.indicators.vulnerability_count, 0);
    assert.equal(assessment.risk.level, "unknown");
    assert.match(packageEvidenceLinks("@scope/demo", "1.2.3", null, "npm").registry, /npmjs/);
});

test("unresolved npm ranges never become latest-version vulnerability assessments", async () => {
    const requests = [];
    const assessment = await assessNpmPackageRisk("demo", null, {
        fetchImpl: async (url) => {
            requests.push(url);
            return { ok: true, json: async () => ({ "dist-tags": { latest: "4.0.0" } }) };
        },
    });
    assert.equal(requests.length, 1);
    assert.equal(assessment.version, null);
    assert.equal(assessment.sources.osv.status, "skipped");
    assert.equal(assessment.indicators.vulnerability_count, null);
    await assert.rejects(assessNpmPackageRisk("demo", "^1.0.0"), /exact version/);
});

test("npm registry and advisory errors are surfaced independently", async () => {
    const assessment = await assessNpmPackageRisk("demo", "1.0.0", {
        fetchImpl: async () => { throw new Error("offline"); },
    });

    assert.equal(assessment.sources.npm.status, "error");
    assert.equal(assessment.sources.osv.error, "offline");
    assert.equal(assessment.risk.level, "unknown");
});

test("provider assessment uses ecosystem-qualified identity and reviewed versions", async () => {
    const state = new ReviewState(process.cwd());
    try {
        state.model = { package_dependencies: [
            { name: "demo", id: "package:demo", resolved_current: "1.0.0", declared_current: [{ specifier: "==1.0.0" }] },
            { name: "demo", id: "package:npm:demo", ecosystem: "npm", resolved_current: "2.1.0", declared_current: [{ specifier: "^2.0.0" }] },
        ] };
        const calls = [];
        state.packageAssessmentFor = async (...args) => { calls.push(args); return { version: args[2] }; };
        await assert.rejects(state.packageRiskFor("demo", null, { explain: false }), /ambiguous/);
        await state.packageRiskFor("demo", null, { explain: false, ecosystem: "npm" });
        await state.packageRiskFor("demo", null, { explain: false, ecosystem: "pypi" });
        assert.deepEqual(calls, [
            ["npm:demo@2.1.0", "demo", "2.1.0", "npm"],
            ["demo@1.0.0", "demo", "1.0.0", "pypi"],
        ]);
        await assert.rejects(state.packageRiskFor("demo", "3.0.0", { explain: false, ecosystem: "npm" }), /does not match/);
        state.model.package_dependencies.push({ name: "local", ecosystem: "npm",
            declared_current: [{ specifier: "workspace:*" }] });
        await assert.rejects(state.packageRiskFor("local", null, { ecosystem: "npm" }), /not applicable/);
        assert.equal(calls.length, 2, "local package names must not be sent to public registries");
    } finally {
        await state.dispose();
    }
});
