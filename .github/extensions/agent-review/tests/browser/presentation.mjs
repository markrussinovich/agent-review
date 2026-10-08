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
    await writeFile(join(repo, "health.py"), `class HealthCheck:\n    name: str\n    severity: str\n    passed: bool\n    message: str\n    details: dict\n# ${"long-source-line-".repeat(60)}\n`);
    await writeFile(join(repo, "pyproject.toml"), '[project]\nname="fixture"\nversion="1.0"\ndependencies=["packaging==25.0"]\n');
    let summaries = 0, explanations = 0;
    const state = new ReviewState(repo, {
        baseRef: base,
        getHistoricalSessionContexts: async () => ({
            contexts: [{
                session_id: "prompt-fixture", intent: [], recent_activity: [], referenced_files: ["health.py"], event_count: 1,
                turns: [{
                    id: "long-prompt", session_id: "prompt-fixture", started_at: "2026-10-03T10:00:00Z",
                    prompt: `Implement health fields using C:\\Users\\${"long-directory-name".repeat(40)}\\python3.11.exe and verify the result.`,
                    referenced_files: ["health.py"],
                    agent_activity: [{ operation: "write", timestamp: "2026-10-03T10:00:01Z", referenced_files: ["health.py"] }],
                }],
            }],
            failures: [],
        }),
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
        await page.route("**/api/state", async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await route.continue();
        });
        await page.route("**/events", async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await route.continue();
        });
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.locator("#change-brief .brief-ai").waitFor();
        assert.equal(await page.locator("#change-brief .review-heading").textContent(), "Uncommitted changes");
        for (const [selector, property, token] of [
            ["#graph .node-metric .delta-add", "fill", "--cp-success"],
            ["#graph .node-metric .delta-remove", "fill", "--cp-danger"],
            ["#graph .node-metric .delta-modified", "fill", "--cp-warning"],
            ["#change-brief .brief-file-counts .change-added", "color", "--cp-success"],
            ["#change-brief .brief-file-counts .change-modified", "color", "--cp-warning"],
            ["#change-brief .brief-file-counts .change-removed", "color", "--cp-danger"],
        ]) {
            const spans = page.locator(selector);
            assert.ok(await spans.count(), `${selector} has separate semantic text spans`);
            const colors = await spans.evaluateAll((items, { variable, property }) => {
                const probe = document.createElement("span");
                probe.style.color = `var(${variable})`;
                document.body.append(probe);
                const expected = getComputedStyle(probe).color;
                probe.remove();
                return items.map((item) => ({ actual: getComputedStyle(item).getPropertyValue(property), expected }));
            }, { variable: token, property });
            assert.ok(colors.every((color) => color.actual === color.expected), `${theme}: ${selector} uses its semantic color`);
        }
        assert.match(await page.locator(".quality-warning").textContent(), /Coverage unavailable.*Generate coverage\.json or coverage\.xml/);
        const tiles = await page.locator("#summary .metric").evaluateAll((cards) => {
            const probe = document.createElement("span");
            probe.style.color = "var(--cp-text-muted)";
            document.body.append(probe);
            const muted = getComputedStyle(probe).color;
            probe.remove();
            return cards.map((card) => ({
                label: card.querySelector(":scope > span").textContent,
                zero: [...card.querySelector("strong").textContent.matchAll(/\d+/g)].every((match) => Number(match[0]) === 0),
                empty: card.classList.contains("metric-empty"),
                mutedCounts: [...card.querySelectorAll("strong span")].every((span) => getComputedStyle(span).color === muted),
            }));
        });
        assert.ok(tiles.some((tile) => tile.zero) && tiles.some((tile) => !tile.zero), "fixture has tiles with and without changes");
        for (const tile of tiles) {
            assert.equal(tile.empty, tile.zero, `${theme}: ${tile.label} is greyed exactly when it has no changes`);
            if (tile.empty) assert.ok(tile.mutedCounts, `${theme}: ${tile.label} counts are muted`);
        }
        assert.match(await page.locator("#summary .metric").filter({ hasText: "Architecture edges" }).textContent(),
            /\+0\/−0Architecture edgesNo module relationship changes/, "edge detail follows the module-level count");
        assert.match(await page.locator("#repository-identity").textContent(), /review-presentation-.*Base [a-f0-9]{8}/);
        const generated = summaries;
        for (const width of [1440, 1280, 1024, 820, 600, 420]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const measurements = await page.locator("#change-brief .detail-row strong").evaluateAll((values) => values.map((value) => ({
                text: value.textContent,
                height: value.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(value).lineHeight),
                right: value.getBoundingClientRect().right, rowRight: value.parentElement.getBoundingClientRect().right,
                gap: value.getBoundingClientRect().left - value.previousElementSibling.getBoundingClientRect().right,
                top: value.getBoundingClientRect().top, labelTop: value.previousElementSibling.getBoundingClientRect().top,
            })));
            assert.ok(measurements.every((value) => value.height <= value.lineHeight + 1), `brief values stay on one line at ${width}px: ${JSON.stringify(measurements)}`);
            assert.ok(measurements.every((value) => value.right <= value.rowRight + 1), `brief values fit their metric at ${width}px`);
            assert.ok(measurements.every((value) => Math.abs(value.top - value.labelTop) > 1 || value.gap <= 11),
                `brief values sit beside their labels at ${width}px: ${JSON.stringify(measurements)}`);
            const queueGeometry = await page.locator("#attention .queue-item").evaluateAll((items) => items.map((item) => {
                const bounds = item.getBoundingClientRect();
                const nodes = [...item.querySelectorAll(".queue-heading, .queue-title, .queue-priority, .queue-copy")];
                return {
                    fits: nodes.every((node) => {
                        const child = node.getBoundingClientRect();
                        return child.left >= bounds.left - 1 && child.right <= bounds.right + 1;
                    }),
                    scrollWidth: item.scrollWidth,
                    clientWidth: item.clientWidth,
                };
            }));
            assert.ok(queueGeometry.length > 0, "fixture has review queue cards");
            assert.ok(queueGeometry.every((item) => item.fits && item.scrollWidth <= item.clientWidth + 1),
                `${theme}: queue text and priorities fit at ${width}px: ${JSON.stringify(queueGeometry)}`);
            const metrics = await page.locator("#summary .metric").evaluateAll((cards) => {
                cards[2].querySelector("small").textContent = "Largest: src.workflow_service.scheduling → croniter";
                return cards.map((card) => ({
                    row: card.getBoundingClientRect().top,
                    count: card.querySelector("strong").getBoundingClientRect().top,
                    heading: card.querySelector(":scope > span").getBoundingClientRect().top,
                    detail: card.querySelector("small").getBoundingClientRect().top,
                }));
            });
            for (const metric of metrics) {
                for (const other of metrics.filter((item) => Math.abs(item.row - metric.row) < 1)) {
                    for (const part of ["count", "heading", "detail"]) {
                        assert.ok(Math.abs(other[part] - metric[part]) < 1, `${part} is top-aligned at ${width}px despite wrapping`);
                    }
                }
            }
            assert.equal(await page.locator("#summary .metric").filter({ hasText: "Files" }).locator(".delta-modified").textContent(), "~1");
            assert.equal(await page.locator("#summary .metric").filter({ hasText: "Packages" }).locator(".delta-modified").textContent(), "~0");
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        const header = await page.locator(".topbar").boundingBox();
        assert.equal(await page.locator("#review-apply").count(), 0);
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
        assert.match(panel, /Manifest changes are reviewed even when no static usage is resolved/);
        assert.match(panel, /Static usage locations \(0\)/);
        assert.match(panel, /not an observed import/);
        assert.match(panel, /Reviewed version/);
        assert.match(panel, /Affects reviewed version 25\.0/);
        assert.match(panel, /Advisory history/);
        assert.match(panel, /Across all versions; not necessarily this release/);
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
        await page.getByRole("button", { name: "Architecture", exact: true }).click();
        const health = state.model.nodes.find((node) => node.kind === "class" && node.name === "HealthCheck");
        const module = state.model.nodes.find((node) => node.id === health.module_id);
        const component = state.model.nodes.find((node) => node.id === health.component_id);
        await page.locator(`.node[aria-label^="${component.name},"]`).click();
        await page.locator(`.node[aria-label^="${module.name},"]`).click();
        await page.locator(`.node[aria-label^="HealthCheck,"]`).click();
        await page.locator("#source-annotation .annotation-body").waitFor();
        await page.locator("#source").evaluate((source) => { source.scrollLeft = source.scrollWidth; });
        const diffGeometry = await page.locator("#source").evaluate((source) => {
            const lines = source.querySelector(".code-lines").getBoundingClientRect();
            return {
                viewportWidth: source.clientWidth, contentWidth: source.scrollWidth,
                rows: [...source.querySelectorAll(".code-row")].map((row) => ({
                    width: row.getBoundingClientRect().width,
                    right: row.getBoundingClientRect().right,
                    contentRight: lines.right,
                })),
            };
        });
        assert.ok(diffGeometry.contentWidth > diffGeometry.viewportWidth, "fixture exercises horizontal source overflow");
        assert.ok(diffGeometry.rows.every((row) => Math.abs(row.right - row.contentRight) < 1
            && row.width >= diffGeometry.viewportWidth), `${theme}: every diff row fills the full shared source width after scrolling`);
        await page.locator("#source").evaluate((source) => { source.scrollLeft = 0; });
        const expandPrompt = page.locator("#source-provenance").getByRole("button", { name: "Show full prompt", exact: true }).first();
        await expandPrompt.click();
        for (const width of [1440, 760, 420]) {
            await page.setViewportSize({ width, height: 1000 });
            const wraps = await page.locator("#source-provenance .provenance-prompt").first().evaluate((prompt) => {
                const range = document.createRange();
                range.selectNodeContents(prompt);
                const bounds = prompt.getBoundingClientRect();
                return [...range.getClientRects()].every((rect) => rect.right <= bounds.right + 1 && rect.left >= bounds.left - 1);
            });
            assert.ok(wraps, `${theme}: expanded prompt paths wrap without overflow at ${width}px`);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
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
        assert.equal(after.height, header.height, "header height is stable on PR failure");
        await page.selectOption("#review-mode", "worktree");
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
    const cachePage = await browser.newPage();
    await cachePage.goto(server.url);
    await cachePage.locator("#change-brief .brief-ai").waitFor();
    let releaseSelection, selectionStarted;
    const selectionGate = new Promise((resolve) => { releaseSelection = resolve; });
    const requestStarted = new Promise((resolve) => { selectionStarted = resolve; });
    await cachePage.route("**/api/review-target", async (route) => {
        selectionStarted();
        await selectionGate;
        await route.continue();
    }, { times: 1 });
    await cachePage.selectOption("#review-mode", "commit");
    await cachePage.waitForFunction(() => !document.querySelector("#review-ref").disabled);
    assert.equal(await cachePage.locator("#review-ref").inputValue(), "");
    await cachePage.selectOption("#review-ref", base);
    await requestStarted;
    assert.equal(await cachePage.locator(".workspace").isVisible(), false);
    assert.equal(await cachePage.locator("#change-brief").isVisible(), false);
    assert.equal(await cachePage.locator("#graph .node").count(), 0);
    assert.equal(await cachePage.locator("#attention .review-card").count(), 0);
    assert.equal(await cachePage.locator("#clean-review").isVisible(), false, "loading is not reported as an empty review");
    assert.equal(await cachePage.locator("#review-picker-notice").isVisible(), false, "loading does not show a redundant banner");
    releaseSelection();
    await cachePage.waitForFunction(() => !document.querySelector("#review-ref").disabled);
    assert.equal(await cachePage.locator("#review-options-status").textContent(), "", "successful commit loading has no total-count label");
    await cachePage.locator("#change-brief .brief-ai").waitFor();
    assert.equal(state.reviewTarget.mode, "commit");
    assert.match(await cachePage.locator(".quality-warning").textContent(), /historical snapshot.*not applied to commit or PR/);
    assert.doesNotMatch(await cachePage.locator(".quality-warning").textContent(), /1 analyzer warning/);
    const cachedSummaries = summaries;
    await cachePage.selectOption("#review-mode", "worktree");
    await cachePage.waitForFunction(() => document.querySelector("#status").textContent === "Saved review");
    assert.equal(state.reviewTarget.mode, "worktree");
    await cachePage.selectOption("#review-mode", "commit");
    await cachePage.waitForFunction(() => !document.querySelector("#review-ref").disabled);
    assert.equal(await cachePage.locator("#review-ref").inputValue(), "");
    assert.equal(state.reviewTarget.mode, "worktree", "switching type leaves the current review unchanged");
    await cachePage.selectOption("#review-ref", base);
    await cachePage.waitForFunction(() => document.querySelector("#status").textContent === "Saved review"
        && document.querySelector("#review-mode").value === "commit");
    assert.equal(state.reviewTarget.mode, "commit");
    assert.equal(summaries, cachedSummaries, "selecting saved commits opens them without regenerating summaries");
    await cachePage.selectOption("#review-mode", "worktree");
    await cachePage.waitForFunction(() => document.querySelector("#status").textContent === "Saved review");
    const originalAttention = state.model.attention;
    const areas = state.model.nodes.filter((node) => ["module", "class", "method", "function"].includes(node.kind)).slice(0, 5);
    assert.equal(areas.length, 5);
    state.model.attention = areas.map((node, index) => ({
        id: `test:area:${index}`, node_id: node.id, title: "Large implementation change",
        reason: "Inspect this changed area.", impact_score: 50 - index, evidence_ids: [],
    }));
    state.broadcast();
    await cachePage.locator('#attention .review-card[data-item-id="group:size"]').click();
    assert.equal(await cachePage.locator("#graph-title").textContent(), "Large changes · 5 areas");
    const rows = cachePage.locator("#graph .collection-row");
    assert.equal(await rows.count(), 5, "every grouped area has its own matching row");
    assert.deepEqual(await rows.evaluateAll((items) => items.map((item) => item.dataset.nodeId)), areas.map((area) => area.id));
    for (let index = 0; index < 5; index += 1) {
        assert.match(await rows.nth(index).textContent(), new RegExp(`^${index + 1}\\.`));
        assert.ok((await rows.nth(index).textContent()).includes(areas[index].path));
    }
    await rows.first().click();
    await cachePage.locator("#source-panel").waitFor();
    assert.ok((await cachePage.locator("#source-title").textContent()).startsWith(areas[0].path));
    state.model.attention = originalAttention;
    state.broadcast();
    await cachePage.close();
    console.log("PASS saved commit autoload and all five grouped areas individually visible with source navigation");
    const linesPage = await browser.newPage();
    await linesPage.goto(server.url);
    await linesPage.locator("#summary .metric").first().waitFor();
    await linesPage.locator("#summary .metric").filter({ hasText: "Lines", exact: false }).filter({ hasNotText: "Files" }).first().click();
    assert.equal(await linesPage.locator("#graph-title").textContent(), "Lines changed by file");
    const fileRows = linesPage.locator("#graph .collection-row");
    assert.equal(await fileRows.count(), state.model.changes.filter((change) => change.lines_added + change.lines_removed > 0).length);
    await fileRows.filter({ hasText: "pyproject.toml" }).click();
    await linesPage.locator("#source-panel").waitFor();
    assert.match(await linesPage.locator("#source-title").textContent(), /^pyproject\.toml/);
    await linesPage.close();
    console.log("PASS line totals include TOML files and navigate to their diff");
    await server.close();
    server = null;
    await git("add", "health.py", "pyproject.toml");
    await git("commit", "-qm", "review baseline");
    const cleanBase = (await git("rev-parse", "HEAD")).stdout.trim();
    let cleanSummaries = 0, customRuns = 0;
    const cleanState = new ReviewState(repo, {
        baseRef: cleanBase,
        generateAnnotation: async () => {
            cleanSummaries += 1;
            return "## Summary\n\n- A field changed.\n\n## Review order\n\n- Inspect the field.\n\n## Gaps\n\n- No coverage.";
        },
    });
    cleanState.runCustomAnalyses = async () => { customRuns += 1; return []; };
    await cleanState.refresh();
    server = await startReviewServer(cleanState);
    const cleanPage = await browser.newPage();
    const cleanErrors = [];
    cleanPage.on("pageerror", (error) => cleanErrors.push(error.message));
    await cleanPage.goto(server.url);
    await cleanPage.locator("#clean-review").waitFor();
    for (const selector of ["#change-brief", "#summary", ".workspace", "#custom-analyses"]) {
        assert.equal(await cleanPage.locator(selector).isVisible(), false, `${selector} is hidden for a clean worktree`);
    }
    assert.equal(cleanSummaries, 0);
    assert.equal(customRuns, 0);
    await writeFile(join(repo, "health.py"), "class HealthCheck:\n    name: str\n    severity: str\n    passed: bool\n    message: str\n    details: dict\n    restored: bool\n");
    await cleanState.refresh();
    await cleanPage.locator("#change-brief .brief-ai").waitFor();
    assert.equal(await cleanPage.locator("#clean-review").isVisible(), false);
    assert.equal(await cleanPage.locator(".workspace").isVisible(), true);
    assert.equal(await cleanPage.locator("#summary").isVisible(), true);
    assert.equal(cleanSummaries, 1);
    assert.equal(customRuns, 1);
    assert.deepEqual(cleanErrors, []);
    await cleanPage.close();
    await git("commit", "--allow-empty", "-qm", "empty review fixture");
    const emptyCommit = (await git("rev-parse", "HEAD")).stdout.trim();
    const emptyPage = await browser.newPage();
    await emptyPage.goto(server.url);
    await emptyPage.locator("#summary .metric").first().waitFor();
    const beforeEmpty = cleanSummaries;
    await emptyPage.selectOption("#review-mode", "commit");
    await emptyPage.waitForFunction(() => !document.querySelector("#review-ref").disabled);
    await emptyPage.selectOption("#review-ref", emptyCommit);
    await emptyPage.locator("#clean-review").waitFor();
    assert.equal(cleanState.reviewTarget.currentRef, emptyCommit);
    assert.equal(await emptyPage.locator(".workspace").isVisible(), false);
    assert.equal(await emptyPage.locator("#change-brief").isVisible(), false);
    assert.equal(cleanSummaries, beforeEmpty);
    const setTarget = cleanState.setReviewTarget.bind(cleanState);
    cleanState.setReviewTarget = async () => {
        cleanState.reviewTarget = { ...cleanState.reviewTarget, mode: "pr", label: "PR #1", ref: "1" };
        cleanState.broadcast("refreshed");
        return cleanState.model;
    };
    await emptyPage.route("**/api/review-targets?mode=pr*", (route) => route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: [{ ref: "1", number: 1, status: "open", title: "Empty PR", author: "Test" }], has_more: false }),
    }));
    await emptyPage.selectOption("#review-mode", "pr");
    await emptyPage.waitForFunction(() => !document.querySelector("#review-ref").disabled);
    assert.equal(cleanState.reviewTarget.mode, "commit", "switching to PR does not open the first PR");
    await emptyPage.selectOption("#review-ref", "1");
    await emptyPage.waitForFunction(() => document.querySelector("#review-target-label").textContent === "PR #1"
        && !document.querySelector("#clean-review").classList.contains("hidden"));
    assert.equal(await emptyPage.locator(".workspace").isVisible(), false);
    assert.equal(cleanSummaries, beforeEmpty);
    cleanState.setReviewTarget = setTarget;
    await emptyPage.close();
    console.log("PASS empty commit and PR automatically show only no-change status without AI calls");
    console.log("PASS clean worktree: concise empty state, zero AI/custom calls, normal review restored after edits");
} finally {
    await browser?.close();
    await server?.close();
    await rm(repo, { recursive: true, force: true });
}
