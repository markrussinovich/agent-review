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
import { packageEvidenceLinks } from "../../web/package-presentation.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const fixture = await mkdtemp(join(tmpdir(), "review-diff-context-"));
const git = (repo, ...args) => execute("git", ["-C", repo, ...args]);
const explanation = "## Why it was added\n\n- PDF reports.\n\n## What uses it\n\n- No static import is mapped.\n\n## Risks and alternatives\n\n- Version-specific vulnerability checks are unavailable.\n\n## Review checklist\n\n- **Verify:** the resolved runtime version.";
let browser;
const servers = [];
try {
    await git(fixture, "init", "-q");
    await git(fixture, "config", "user.name", "Test");
    await git(fixture, "config", "user.email", "test@example.invalid");
    const implementation = ["def report(value):", ...Array.from({ length: 80 }, (_, i) => `    # context ${i}`), "    return value", ""].join("\n");
    await writeFile(join(fixture, "checker.py"), `${implementation}\ndef removed():\n    return 0\n`);
    await writeFile(join(fixture, "callers.py"), [
        "from checker import report", ...Array.from({ length: 8 }, (_, i) => `def caller_${i}(value):\n    return report(value)\n`),
    ].join("\n"));
    await git(fixture, "add", ".");
    await git(fixture, "commit", "-qm", "base");
    await writeFile(join(fixture, "checker.py"), implementation.replace("return value", "return value + 1"));
    await writeFile(join(fixture, "requirements.txt"), "reportlab>=4.0\n");
    const state = new ReviewState(fixture, {
        baseRef: "HEAD",
        generateAnnotation: async () => "## Summary\n\n- Review report.\n\n## Review order\n\n- `checker.py`.\n\n## Gaps\n\n- Coverage unknown.",
        generatePackageExplanation: async () => explanation,
    });
    await state.refresh();
    const report = state.model.nodes.find((node) => node.kind === "function" && node.name === "report");
    const removed = state.model.nodes.find((node) => node.name === "removed" && node.change === "removed");
    assert.ok(report && removed);
    assert.doesNotMatch(state.model.source_files["checker.py"].diff, /def report/);
    const finding = state.model.attention.find((item) => item.node_id === report.id && item.type === "broad_impact");
    assert.ok(finding, "real caller-impact finding reproduces the omitted definition");
    state.packageAssessments.set("reportlab@<unresolved>", {
        version: null, sources: { osv: { status: "skipped", error: "Exact project version unknown." } },
        risk: { level: "unknown", score: null, reasons: ["Version-specific vulnerability checks are unavailable."] },
        indicators: { vulnerability_count: null, vulnerability_history_count: 0, latest_version: "4.4.0" },
    });
    const server = await startReviewServer(state);
    servers.push(server);
    const executablePath = process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.locator("#attention .review-card").filter({ hasText: "Change has broad caller impact" }).click();
        await page.locator("#source .focus-start").waitFor();
        assert.match(await page.locator("#source").textContent(), /Referenced line 1 · unchanged context/);
        const definition = page.locator('#source .code-row[data-new-line="1"]');
        assert.match(await definition.textContent(), /def report\(value\)/);
        assert.equal(await definition.getAttribute("data-old-line"), "1");
        assert.match(await definition.getAttribute("class"), /context.*focus-line/);
        assert.equal(await page.locator('#source .code-row[data-new-line="1"]').count(), 1);
        assert.equal(await page.locator("#source-context-notice").isVisible(), false);
        const bothGutters = await definition.evaluate((row) =>
            row.querySelector("code").getBoundingClientRect().left - row.getBoundingClientRect().left);
        assert.ok(bothGutters <= 100, `two-sided gutter stays compact: ${bothGutters}px`);
        for (const tab of ["base", "current", "diff"]) {
            await page.locator(`.tab[data-tab="${tab}"]`).click();
            assert.match(await page.locator("#source .focus-start").textContent(), /def report\(value\)/);
        }
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) await page.screenshot({
            path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `source-context-${theme}.png`), fullPage: true,
        });
        await page.click("#source-close");
        const component = state.model.nodes.find((node) => node.id === removed.component_id);
        const module = state.model.nodes.find((node) => node.id === removed.module_id);
        await page.locator(`.node[aria-label^="${component.name},"]`).click();
        await page.locator(`.node[aria-label^="${module.name},"]`).click();
        await page.locator('.node[aria-label^="removed,"]').click();
        await page.locator("#source .focus-start").waitFor();
        assert.match(await page.locator("#source .focus-start").textContent(), /def removed/);
        await page.locator('.tab[data-tab="base"]').click();
        assert.match(await page.locator("#source .focus-start").textContent(), /def removed/);
        const baseMarks = await page.locator("#source .code-row").evaluateAll((rows) => rows
            .filter((row) => /diff-(delete|modified)/.test(row.className))
            .map((row) => [row.dataset.oldLine, row.querySelector(".diff-prefix").textContent, row.querySelector("code").textContent]));
        assert.ok(baseMarks.some(([, prefix, code]) => prefix === "−" && /def removed/.test(code)), "Base marks removed lines");
        assert.ok(baseMarks.some(([line, prefix, code]) => line === "82" && prefix === "−" && /return value$/.test(code)), "Base marks the changed line");
        assert.equal(await page.locator('#source .code-row[data-old-line="1"]').getAttribute("class"), "code-row diff-context", "unchanged lines stay plain");
        await page.locator('.tab[data-tab="current"]').click();
        assert.equal(await page.locator("#source .focus-line").count(), 0, "removed definitions never highlight unrelated current lines");
        const changed = page.locator('#source .code-row[data-new-line="82"]');
        assert.match(await changed.getAttribute("class"), /diff-(add|modified)/, "Current marks the changed line");
        assert.equal(await changed.locator(".diff-prefix").textContent(), "+");
        await page.click("#source-close");
        await page.locator("#packages .review-card").filter({ hasText: "reportlab" }).click();
        await page.waitForFunction(() => document.querySelector("#package-detail")?.textContent.includes("PDF reports."));
        const panel = await page.locator("#package-detail").textContent();
        assert.match(panel, /Version >=4\.0/);
        assert.match(panel, /Dependency risk: unknown/);
        assert.match(panel, /Not assessed: the exact project version is unknown/);
        assert.doesNotMatch(panel, /Pin or resolve|Affects reviewed version null/);
        assert.equal(await page.locator("#package-detail .annotation-error").count(), 0);
        assert.equal(await page.locator('#package-detail a[href*="/null/"]').count(), 0);
        await page.locator("#package-detail .package-declaration-note .source-reference").click();
        await page.locator('.tab[data-tab="diff"]').click();
        const gutter = await page.locator('#source .code-row[data-new-line="1"]').evaluate((row) => ({
            width: row.querySelector("code").getBoundingClientRect().left - row.getBoundingClientRect().left,
            unused: row.querySelector(".line-number").getBoundingClientRect().width,
        }));
        assert.equal(gutter.unused, 0, "new files have no empty baseline gutter");
        assert.ok(gutter.width <= 60, `added-file code starts within 60px: ${gutter.width}px`);
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) await page.screenshot({
            path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `compact-gutter-${theme}.png`), fullPage: true,
        });
        await page.click("#source-close");
        await page.setViewportSize({ width: 560, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        assert.deepEqual(errors, []);
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) await page.screenshot({
            path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `reportlab-range-${theme}.png`), fullPage: true,
        });
        await page.close();
        console.log(`PASS ${theme}: omitted definition, Base/Current/Diff focus, removed symbol, range assessment, narrow layout`);
    }
    assert.equal(packageEvidenceLinks("reportlab", null).release, "https://pypi.org/project/reportlab/");
    if (process.env.AGENT_REVIEW_RANGE_REPO) {
        const repo = process.env.AGENT_REVIEW_RANGE_REPO;
        const ref = (await git(repo, "log", "-n", "1", "-S", "reportlab", "--format=%H", "--", "requirements.txt")).stdout.trim();
        assert.ok(ref);
        const baseRef = (await git(repo, "rev-parse", `${ref}^`)).stdout.trim();
        let context;
        const actual = new ReviewState(repo, {
            reviewTarget: { mode: "commit", ref, currentRef: ref, baseRef, label: `Commit ${ref.slice(0, 7)}` },
            generateAnnotation: async () => "## Summary\n\n- Dependency change.\n\n## Review order\n\n- Requirements.\n\n## Gaps\n\n- Exact versions unknown.",
            generatePackageExplanation: async (received) => { context = received; return explanation; },
        });
        await actual.refresh();
        const reportlab = actual.model.package_changes.find((item) => item.name === "reportlab");
        assert.ok(reportlab?.declared_current.some((item) => item.specifier === ">=4.0"));
        const actualServer = await startReviewServer(actual);
        servers.push(actualServer);
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(actualServer.url);
        await page.locator("#packages .review-card").filter({ hasText: "reportlab" }).click();
        await page.waitForFunction(() => document.querySelector("#package-detail")?.textContent.includes("PDF reports."), null, { timeout: 60000 });
        assert.equal(context.assessment.version, null);
        assert.equal(context.assessment.sources.osv.status, "skipped");
        assert.equal(context.assessment.risk.level, "unknown");
        assert.equal(await page.locator("#package-detail .annotation-error").count(), 0);
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) await page.screenshot({
            path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, "refchecker-reportlab-range.png"), fullPage: true,
        });
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS actual RefChecker ${ref.slice(0, 7)}: reportlab>=4.0, live registry metadata, no guessed-version audit, explanation rendered`);
    }
} finally {
    await browser?.close();
    for (const server of servers) await server.close();
    await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
