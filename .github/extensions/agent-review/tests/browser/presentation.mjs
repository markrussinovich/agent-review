import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), "review-presentation-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
let server, browser;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "health.py"), "class HealthCheck:\n    name: str\n    severity: str\n    passed: bool\n");
    await writeFile(join(repo, "rules.py"), "class RuleResult:\n    @property\n    def passed(self):\n        return True\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(repo, "health.py"), "class HealthCheck:\n    name: str\n    severity: str\n    passed: bool\n    message: str\n    details: dict\n");
    await writeFile(join(repo, "pyproject.toml"), '[project]\nname="fixture"\nversion="1.0"\ndependencies=["packaging==25.0"]\n');
    let summaries = 0, explanations = 0;
    const state = new ReviewState(repo, {
        baseRef: base,
        generateAnnotation: async (context) => context.kind === "overview"
            ? `## Summary\n\n- Saved summary ${++summaries}.\n\n## Review order\n\n- Review the declaration.\n\n## Gaps\n\n- No coverage.`
            : "## What changed\n\n`HealthCheck` requires `name`, `severity`, `passed`, `message`, and `details`.",
        generatePackageExplanation: async () => {
            explanations += 1;
            return "## Why it was added\n\n- Manifest declaration.\n\n## What uses it\n\n- No Python imports found.\n\n## Risks and alternatives\n\n- Verify necessity.\n\n## Review checklist\n\n- Check the manifest.";
        },
    });
    await state.refresh();
    state.packageAssessments.set("packaging@25.0", {
        name: "packaging", version: "25.0", risk: { level: "low", score: 0, reasons: ["No known vulnerabilities."] },
        sources: { pypi: { status: "ok" }, osv: { status: "ok" }, scorecard: { status: "ok" },
            pypistats: { status: "error", error: "HTTP 429" } },
        indicators: { repository_url: "https://github.com/pypa/packaging", vulnerability_count: 0,
            vulnerability_history_count: 0, scorecard_score: 8.8, scorecard_checks: [{ name: "Code-Review", score: 3 }],
            latest_version: "26.3", recent_downloads: null, release_age_days: 533, maintenance: { status: "active", releases_last_12_months: 7 } },
    });
    server = await startReviewServer(state);
    const executablePath = process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.locator("#change-brief .brief-ai").waitFor();
        assert.match(await page.locator("#repository-identity").textContent(), /review-presentation-.*Base [a-f0-9]{8}/);
        const generated = summaries;
        for (const width of [1440, 1280, 1024, 820, 600, 420]) {
            await page.setViewportSize({ width, height: 1000 });
            const measurements = await page.locator("#change-brief .detail-row strong").evaluateAll((values) => values.map((value) => ({
                height: value.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(value).lineHeight),
                right: value.getBoundingClientRect().right, rowRight: value.parentElement.getBoundingClientRect().right,
            })));
            assert.ok(measurements.every((value) => value.height <= value.lineHeight + 1), `brief values stay on one line at ${width}px`);
            assert.ok(measurements.every((value) => value.right <= value.rowRight + 1), `brief values fit their metric at ${width}px`);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        const header = await page.locator(".topbar").boundingBox();
        const openPosition = await page.locator("#review-apply").boundingBox();
        const panels = await page.locator(".brief-ai-section").evaluateAll((sections) =>
            sections.map((section) => ({ border: getComputedStyle(section).borderTopColor,
                background: getComputedStyle(section).backgroundColor, heading: getComputedStyle(section.querySelector("h2")).color })));
        assert.equal(new Set(panels.map((panel) => panel.border)).size, 1, "summary panels use neutral Primer borders");
        assert.equal(new Set(panels.map((panel) => panel.background)).size, 1, "summary panels have neutral surfaces, not decorative tints");
        assert.equal(new Set(panels.map((panel) => panel.heading)).size, 3, "semantic color is limited to the section headings");
        await page.locator("#summary .metric").filter({ hasText: "Packages" }).click();
        await page.locator(".stat-grid").waitFor();
        assert.match(await page.locator("#packages").textContent(), /Version 25\.0/);
        assert.match(await page.locator("#attention .impact-score").first().textContent(), /Priority \d+\/100/);
        const panel = await page.locator("#package-detail").textContent();
        assert.match(panel, /Manifest changes are reviewed even when no Python import is found/);
        assert.match(panel, /Python import locations \(0\)/);
        assert.match(panel, /not an observed import/);
        assert.match(panel, /Reviewed version/);
        await page.locator("#package-detail .package-declaration-note .source-reference").click();
        await page.locator("#source .package-reference-highlight").waitFor();
        assert.equal(await page.locator("#source .package-reference-highlight").textContent(), "packaging");
        assert.equal(await page.locator("#source-title").textContent(), "pyproject.toml:4");
        await page.click("#source-close");
        const scorecard = page.getByRole("link", { name: "OpenSSF Scorecard", exact: true });
        assert.match(await scorecard.getAttribute("href"), /^https:\/\/securityscorecards\.dev\/viewer/);
        assert.equal(await page.getByRole("link", { name: "8.8/10", exact: true }).count(), 1);
        assert.equal(await page.getByRole("link", { name: "Code-Review", exact: true }).count(), 1);
        assert.match(await page.locator(".evidence-sources").textContent(), /HTTP 429/);
        await page.locator("#breadcrumbs button").first().click();
        const health = state.model.nodes.find((node) => node.kind === "class" && node.name === "HealthCheck");
        const module = state.model.nodes.find((node) => node.id === health.module_id);
        const component = state.model.nodes.find((node) => node.id === health.component_id);
        await page.locator(`.node[aria-label^="${component.name},"]`).click();
        await page.locator(`.node[aria-label^="${module.name},"]`).click();
        await page.locator(`.node[aria-label^="HealthCheck,"]`).click();
        await page.locator("#source-annotation .annotation-body").waitFor();
        for (const name of ["name", "severity", "passed", "message", "details"]) {
            const link = page.locator("#source-annotation .source-reference").filter({ hasText: new RegExp(`^${name}$`) });
            assert.equal(await link.count(), 1);
            assert.match(await link.getAttribute("title"), /health\.py/);
        }
        await page.locator("#source-annotation .source-reference").filter({ hasText: /^passed$/ }).click();
        await page.waitForFunction(() => document.querySelector("#source-title").textContent === "health.py:4");
        await page.selectOption("#review-mode", "pr");
        await page.waitForFunction(() => document.querySelector("#review-options-status").textContent.includes("No usable GitHub remote"));
        assert.equal(await page.locator(".workspace").isVisible(), false);
        assert.equal(await page.locator("#change-brief").isVisible(), false);
        assert.equal(await page.locator("#source-panel").isVisible(), false);
        assert.equal(await page.locator("#review-picker-notice").isVisible(), true);
        const after = await page.locator(".topbar").boundingBox();
        const openAfter = await page.locator("#review-apply").boundingBox();
        assert.equal(after.height, header.height, "header height is stable on PR failure");
        assert.equal(openAfter.x, openPosition.x, "Open review does not move");
        await page.selectOption("#review-mode", "worktree");
        await page.click("#review-apply");
        await page.waitForFunction(() => document.querySelector("#status").textContent === "Saved review");
        await page.locator("#change-brief .brief-ai").waitFor();
        assert.equal(summaries, generated, "switching reuses the previous AI summary");
        assert.equal(await page.locator("#graph-title").textContent(), "Structural change map");
        assert.equal(await page.locator(".workspace").evaluate((node) => node.classList.contains("package-mode")), false);
        assert.equal(await page.locator(".detail").isVisible(), false);
        assert.equal(await page.locator("#attention").isVisible(), true);
        await page.locator("#summary .metric").filter({ hasText: "Packages" }).click();
        await page.locator(".stat-grid").waitFor();
        assert.equal(explanations, 1, "saved package explanation is reused");
        await page.setViewportSize({ width: 760, height: 1000 });
        await page.waitForTimeout(300);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}: colored brief, explicit version/priority, linked evidence, no-import rationale, correct field links, stable toolbar, empty PR state, saved results and overview reset`);
    }
} finally {
    await browser?.close();
    await server?.close();
    await rm(repo, { recursive: true, force: true });
}
