import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to a real repository review server.");
const payload = await fetch(new URL("/api/state", url)).then((response) => response.json());
const files = payload.model.changes.filter((file) => file.status !== "unchanged" && file.status !== "deleted"
    && !file.generated && /\.(?:py|cs|[cm]?[jt]sx?)$/.test(file.path));
assert.ok(files.length >= 2, "Use a real review with at least two changed source files.");
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
const screenshot = async (page, name) => {
    if (!process.env.AGENT_REVIEW_SCREENSHOT_DIR) return;
    await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, name) });
};
const waitForSource = (page, path) => page.waitForFunction((path) =>
    !document.querySelector("#source-panel").classList.contains("hidden")
    && document.querySelector("#source-title").textContent.includes(path)
    && document.querySelector("#source").getAttribute("aria-busy") !== "true", path);
const findFile = async (page, path) => {
    await page.locator("#workspace-find").click();
    await page.locator("#review-command-query").fill(path);
    await page.locator("#review-command-results button").filter({ hasText: path }).first().click();
    await waitForSource(page, path);
};
const openRailFile = async (page, path, width) => {
    if (width < 900) await page.locator("#workspace-nav-toggle").click();
    await page.locator("#workspace-files").click();
    await page.locator("#workspace-search").fill(path);
    await page.locator(`#workspace-nav-list .workspace-file[data-path=${JSON.stringify(path)}]`).click();
    await waitForSource(page, path);
};

try {
    for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
            await page.goto(`${url}?scoutTheme=${theme}`);
            await findFile(page, files[0].path);
            await page.locator("#source-focus").click();
            await page.locator("#source-section").press("Enter");
            assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("review-source-focus")), false,
                "Layer exits focus mode before showing navigation");
            assert.equal(await page.locator("#review-navigation").isVisible(), true);
            assert.equal(await page.evaluate(() => document.querySelector("#review-navigation").contains(document.activeElement)), true,
                "Layer moves keyboard focus into visible navigation");
            if (width < 900) {
                assert.equal(await page.locator("#workspace-nav-toggle").getAttribute("aria-expanded"), "true");
                await page.keyboard.press("Escape");
                assert.equal(await page.locator("#source-panel").evaluate((panel) => panel.inert), false);
                assert.equal(await page.evaluate(() => document.activeElement.id), "workspace-nav-toggle");
            }
            await page.locator("#source-close").click({ trial: true });
            await screenshot(page, `navigation-layer-${theme}-${width}.png`);
            if (width < 900) {
                await page.locator("#source-focus").click();
                await page.locator("#workspace-nav-toggle").press("Enter");
                assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("review-source-focus")), false);
                assert.equal(await page.locator("#review-navigation").isVisible(), true);
                assert.equal(await page.evaluate(() => document.activeElement.id), "workspace-search");
                await screenshot(page, `navigation-drawer-${theme}-${width}.png`);
                await page.keyboard.press("Escape");
                assert.equal(await page.locator("#source-panel").evaluate((panel) => panel.inert), false);
                await page.locator("#source-close").click({ trial: true });
            }
            await page.locator('[data-tab="base"]').click();
            await page.waitForFunction(() => document.querySelector("#source").getAttribute("aria-busy") !== "true");
            await page.locator(".workspace-explore > summary").first().click();
            await page.locator("#explore-architecture").click();
            await page.locator("#graph .node").first().press("Enter");
            const graphTitle = await page.locator("#graph-title").textContent();
            const graphScroll = await page.locator("#graph").evaluate((graph) => {
                graph.scrollTop = 200;
                return graph.scrollTop;
            });
            await openRailFile(page, files[1].path, width);
            await openRailFile(page, files[0].path, width);
            await page.locator("#source-close").click();
            await page.waitForFunction((title) => document.body.classList.contains("workspace-exploring")
                && document.querySelector("#graph-title").textContent === title
                && document.querySelector("#source-panel").classList.contains("hidden"), graphTitle);
            assert.equal(await page.locator("#graph").evaluate((graph) => graph.scrollTop), graphScroll,
                "Closing sidebar source restores the exploration's reading position");
            if (width < 900) {
                assert.equal(await page.locator("#review-navigation").isVisible(), true,
                    "Returning to the sidebar restores its open drawer");
                await page.keyboard.press("Escape");
                assert.equal(await page.locator(".workspace").evaluate((workspace) => workspace.inert), false);
            }
            await screenshot(page, `navigation-rail-return-${theme}-${width}.png`);
            await page.locator("#graph-close").click();
            await waitForSource(page, files[0].path);
            assert.equal(await page.locator(".tab.active").getAttribute("data-tab"), "base",
                "The exploration still returns to its original source tab");
            await page.locator("#workflow-finish").click();
            const decisions = page.locator("#review-finish details").filter({ hasText: "All file decisions" });
            await decisions.locator(":scope > summary").click();
            await decisions.locator(".finish-files button").filter({ hasText: files[1].path }).first().click();
            await waitForSource(page, files[1].path);
            await page.locator("#source-close").click();
            await page.locator("#review-finish").waitFor();
            assert.equal(await decisions.evaluate((details) => details.open), true,
                "Returning to Finish preserves the expanded file decisions");
            assert.equal(await decisions.evaluate((details) => details.contains(document.activeElement)), true,
                "Returning to Finish restores focus to the file that opened source");
            await screenshot(page, `navigation-finish-return-${theme}-${width}.png`);
            await page.locator("#review-finish .view-back").click();
            await waitForSource(page, files[0].path);
            for (const origin of ["overview", "finish"]) {
                await page.locator(`#workflow-${origin}`).click();
                const originPanel = page.locator(`#review-${origin}`);
                await originPanel.waitFor();
                await page.locator("#workspace-find").press("Enter");
                await page.locator("#review-command-query").fill(files[1].path);
                await page.locator("#review-command-query").press("Enter");
                await waitForSource(page, files[1].path);
                await page.locator("#source-close").click();
                await originPanel.waitFor();
                assert.equal(await page.evaluate(() => document.activeElement.id), "workspace-find",
                    `Find returns keyboard focus to its opener on ${origin}`);
                await screenshot(page, `navigation-find-${origin}-${theme}-${width}.png`);
            }
            await page.locator("#workflow-overview").click();
            await findFile(page, files[0].path);
            await page.locator('[data-tab="base"]').click();
            await page.waitForFunction(() => document.querySelector("#source").getAttribute("aria-busy") !== "true");
            await findFile(page, files[1].path);
            await page.locator('[data-tab="current"]').click();
            await page.waitForFunction(() => document.querySelector("#source").getAttribute("aria-busy") !== "true");
            await page.locator("#source-back").click();
            await waitForSource(page, files[0].path);
            assert.equal(await page.locator(".tab.active").getAttribute("data-tab"), "base");
            await page.locator("#source-forward").click();
            await waitForSource(page, files[1].path);
            assert.equal(await page.locator(".tab.active").getAttribute("data-tab"), "current");
            await page.keyboard.press("Alt+ArrowLeft");
            await waitForSource(page, files[0].path);
            assert.equal(await page.locator("#source-back").isEnabled(), true,
                "Source Back remains available at the first source entry when it has an origin");
            assert.match(await page.locator("#source-back").getAttribute("title"), /Back to Overview/);
            await page.locator("#source-back").press("Enter");
            await page.locator("#review-overview").waitFor();
            const symbol = payload.model.nodes.find((node) => node.change !== "unchanged" && node.path
                && ["function", "method"].includes(node.kind));
            assert.ok(symbol, "Use a real review with a changed callable for nested Impact navigation.");
            await findFile(page, symbol.path);
            await page.locator("#source-impact").click();
            await page.locator(".impact-graph .node").first().press("Enter");
            await page.locator(".impact-evidence").getByRole("button", { name: "Open source", exact: true }).click();
            await page.locator("#source-close").waitFor();
            await page.waitForFunction(() => document.querySelector("#source").getAttribute("aria-busy") !== "true");
            assert.equal(await page.locator("#source-back").isEnabled(), true);
            await page.locator("#source-focus").click();
            await page.keyboard.press("Alt+ArrowLeft");
            await page.locator(".impact-evidence").waitFor();
            assert.equal(await page.locator("#source-panel").isVisible(), false);
            assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("review-source-focus")), false,
                "Returning from focused source clears focus-mode styling on its parent view");
            await screenshot(page, `navigation-source-back-${theme}-${width}.png`);
            await page.locator("#detail-close").click();
            await page.locator("#graph-close").click();
            await waitForSource(page, symbol.path);
            if (width < 900) {
                const longFile = files.find((file) => file.current_lines > 100);
                if (longFile) await findFile(page, longFile.path);
                await page.locator("#source-focus").click();
                const scroll = await page.locator("#source").evaluate((source) => {
                    source.scrollTop = 100;
                    return source.scrollTop;
                });
                await page.locator("#workspace-context").press("Enter");
                assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("review-source-focus")), false,
                    "Context exits focus mode instead of hiding both reading panes");
                assert.equal(await page.locator(".source-side").isVisible(), true);
                assert.equal(await page.locator(".code-frame").isVisible(), false);
                assert.equal(await page.locator("#workspace-context").evaluate((button) => button.matches(":focus-visible")), true);
                await screenshot(page, `navigation-context-${theme}-${width}.png`);
                await page.locator("#workspace-code").press("Enter");
                assert.equal(await page.locator(".code-frame").isVisible(), true);
                assert.equal(await page.locator("#source").evaluate((source) => source.scrollTop), scroll);
                await page.locator("#workspace-context").click();
                await page.locator("#source-focus").click();
                assert.equal(await page.locator(".code-frame").isVisible(), true);
                await page.locator("#source-focus").press("Enter");
                assert.equal(await page.locator(".source-side").isVisible(), true,
                    "Exiting focus still restores the previously selected Context pane");
            }
            await page.locator("#source-focus").click();
            await page.locator("#workspace-discuss").click();
            await page.locator("#item-discussion").waitFor();
            assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("review-source-focus")), false);
            assert.equal(await page.locator(".source-side").isVisible(), true,
                "Ask about this also exposes discussion when starting in focus mode");
            assert.deepEqual(errors, []);
            console.log(`PASS ${theme}/${width}: all five navigation fixes, keyboard returns, source tabs, and visible Context/Discussion`);
        } finally { await page.close(); }
    }
} finally { await browser.close(); }
