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
const repo = await mkdtemp(join(tmpdir(), "review-resize-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
const frames = (page) => page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
const svgWidth = (page) => page.locator("#graph svg").evaluate((root) => root.viewBox.baseVal.width);
const graphFits = (page) => page.evaluate(() => {
    const graph = document.querySelector("#graph");
    return graph.querySelector("svg").viewBox.baseVal.width === Math.max(graph.clientWidth, 320);
});
const rememberPanels = (page) => page.evaluate(() => {
    window.resizePanels = ["#change-brief > :first-child", "#summary > :first-child",
        "#attention > :first-child", "#graph > :first-child", "#graph svg", ".scope-findings"]
        .map((selector) => document.querySelector(selector)).filter(Boolean);
});
const panelsUnchanged = (page) => page.evaluate(() => resizePanels.every((node) => node.isConnected));
let state, server, browser;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "core.autocrlf", "false");
    for (let index = 0; index < 12; index++) {
        const imports = index ? `from module${index - 1} import calculate as previous\n` : "";
        await writeFile(join(repo, `module${index}.py`), `${imports}def calculate(value):\n    return value\n`);
    }
    await git("add", ".");
    await git("commit", "-qm", "base");
    for (let index = 0; index < 12; index++) {
        const imports = index ? `from module${index - 1} import calculate as previous\n` : "";
        await writeFile(join(repo, `module${index}.py`),
            `${imports}def calculate(value):\n    return ${index ? "previous(value)" : "value"} + ${index + 1}\n`);
    }
    await git("commit", "-qam", "Change calculations");
    state = new ReviewState(repo, {
        generateAnnotation: async () => "## Summary\n\n- Changed calculations.\n\n## Review order\n\n- Follow module calls.\n\n## Gaps\n\n- No tests.",
    });
    await state.setReviewTarget({ mode: "commit", ref: "HEAD" });
    await state.decisionPromise;
    await state.overviewFor();
    server = await startReviewServer(state);
    const executablePath = process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on("pageerror", (error) => {
            errors.push(error.message);
            console.error(error);
        });
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.locator(".review-plan-row").first().waitFor();
        await rememberPanels(page);
        await page.setViewportSize({ width: 1200, height: 1000 });
        await frames(page);
        assert.ok(await panelsUnchanged(page), "CSS-only walkthrough resize keeps the existing review content");

        await page.locator("#zoom-out").click();
        await page.locator("#graph .node").first().click();
        await page.waitForFunction(() => document.querySelectorAll("#graph .node").length === 12);
        assert.ok(await page.locator("#graph .edge").count(), "fixture exercises relationship relayout");
        const node = page.locator("#graph .node").first();
        await node.focus();
        await rememberPanels(page);
        await page.evaluate(() => {
            const root = document.querySelector("#graph svg");
            window.resizeNode = document.activeElement;
            window.viewBoxUpdates = 0;
            const setAttribute = root.setAttribute.bind(root);
            root.setAttribute = (name, value) => {
                if (name === "viewBox") viewBoxUpdates += 1;
                return setAttribute(name, value);
            };
        });
        const firstEdge = await page.locator("#graph .edge").first().getAttribute("d");
        for (const width of [1400, 1320, 1240, 1160, 1080, 1000, 920, 840]) {
            await page.setViewportSize({ width, height: 1000 });
            await frames(page);
            assert.ok(await graphFits(page), `${theme}: graph follows ${width}px without waiting for resize to stop`);
            assert.ok(await panelsUnchanged(page), "resize never replaces review panels, graph nodes, or scoped findings");
            assert.ok(await page.evaluate(() => document.activeElement === resizeNode), "keyboard focus survives graph relayout");
        }
        assert.notEqual(await page.locator("#graph .edge").first().getAttribute("d"), firstEdge, "edges follow moved nodes");
        const updates = await page.evaluate(() => viewBoxUpdates);
        await page.setViewportSize({ width: 840, height: 850 });
        await frames(page);
        await page.waitForTimeout(600);
        assert.equal(await page.evaluate(() => viewBoxUpdates), updates, "height changes and polling do not relayout an unchanged width");

        const burstUpdates = await page.evaluate(async () => {
            viewBoxUpdates = 0;
            document.querySelector(".workspace").style.maxWidth = "700px";
            for (let index = 0; index < 20; index++) {
                window.dispatchEvent(new Event("resize"));
                window.dispatchEvent(new Event("focus"));
                document.dispatchEvent(new Event("visibilitychange"));
            }
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return viewBoxUpdates;
        });
        assert.equal(burstUpdates, 1, "overlapping notifications coalesce into one width update");
        await page.evaluate(() => { document.querySelector(".workspace").style.maxWidth = ""; });
        await frames(page);
        await frames(page);
        assert.ok(await graphFits(page), "graph observer handles a CSS-only width change");
        const hiddenWidth = await svgWidth(page);
        await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { configurable: true, value: true });
            document.querySelector(".workspace").style.maxWidth = "700px";
            window.dispatchEvent(new Event("resize"));
        });
        await page.waitForTimeout(600);
        assert.equal(await svgWidth(page), hiddenWidth, "hidden canvases skip resize work");
        await page.evaluate(() => {
            delete document.hidden;
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await frames(page);
        assert.ok(await graphFits(page), "visibility recovery handles the width missed while hidden");
        await page.evaluate(() => { document.querySelector(".workspace").style.maxWidth = ""; });
        await frames(page);
        await frames(page);

        await page.locator("#graph .graph-viewport-controls button").first().click();
        const svg = page.locator("#graph svg");
        const box = await svg.boundingBox();
        await page.mouse.move(box.x + 8, box.y + 8);
        await page.mouse.down();
        await page.mouse.move(box.x + 38, box.y + 28, { steps: 4 });
        await page.mouse.up();
        const viewport = await page.locator(".graph-viewport").getAttribute("transform");
        await page.setViewportSize({ width: 1100, height: 1000 });
        await frames(page);
        assert.equal(await page.locator(".graph-viewport").getAttribute("transform"), viewport, "user pan and zoom survive resize");

        const tile = await node.boundingBox();
        await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
        await page.mouse.down();
        await page.mouse.move(tile.x + tile.width / 2 + 25, tile.y + tile.height / 2 + 20, { steps: 4 });
        const dragged = await node.getAttribute("transform");
        await page.setViewportSize({ width: 1200, height: 1000 });
        await frames(page);
        assert.ok(await svg.evaluate((root) => root.hasPointerCapture(1)), "resize preserves an active graph drag");
        await page.mouse.up();
        await frames(page);
        assert.ok(await graphFits(page), "deferred relayout finishes when the graph drag ends");
        assert.equal(await node.getAttribute("transform"), dragged, "dragged positions survive relayout");
        await page.setViewportSize({ width: 1000, height: 1000 });
        await frames(page);
        assert.equal(await node.getAttribute("transform"), dragged, "later resize keeps the dragged tile in place");
        const cancelTile = await node.boundingBox();
        await page.mouse.move(cancelTile.x + cancelTile.width / 2, cancelTile.y + cancelTile.height / 2);
        await page.mouse.down();
        await page.setViewportSize({ width: 1100, height: 1000 });
        await frames(page);
        await svg.evaluate((root) => root.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })));
        await page.mouse.up();
        await frames(page);
        assert.ok(await graphFits(page), "cancelled dragging releases deferred relayout");
        assert.equal(await page.locator("#graph .dragging").count(), 0);

        await page.locator("#graph .graph-viewport-controls button").filter({ hasText: "Fit" }).click();
        await page.locator("#rail-resize").focus();
        await page.keyboard.press("ArrowRight");
        await frames(page);
        assert.ok(await graphFits(page), "keyboard rail resize relayouts the existing graph");
        assert.ok(await panelsUnchanged(page), "rail resize keeps panels intact");
        const separator = await page.locator("#rail-resize").boundingBox();
        await page.mouse.move(separator.x + separator.width / 2, separator.y + 15);
        await page.mouse.down();
        await page.mouse.move(separator.x + 42, separator.y + 15, { steps: 4 });
        await page.mouse.up();
        await frames(page);
        assert.ok(await graphFits(page), "pointer rail resize relayouts the existing graph");
        await page.locator("#detail-toggle").click();
        await frames(page);
        assert.ok(await graphFits(page), "opening details relayouts the graph");
        await page.locator("#detail-toggle").click();

        await page.locator("#review-search").fill("no-matching-name");
        await page.locator("#graph .graph-empty").waitFor();
        await rememberPanels(page);
        await page.setViewportSize({ width: 600, height: 900 });
        await frames(page);
        assert.ok(await panelsUnchanged(page), "empty graphs and narrow layouts remain CSS-only");
        await page.locator("#summary .metric").filter({ hasText: "Files" }).click();
        await page.locator(".collection-row").filter({ hasText: "module0.py" }).click();
        await page.locator("#source .code-row").first().waitFor();
        await page.evaluate(() => { window.resizeSource = document.querySelector("#source .code-row"); });
        await rememberPanels(page);
        await page.setViewportSize({ width: 1100, height: 1000 });
        await frames(page);
        assert.ok(await panelsUnchanged(page), "collection resize does not rebuild its contents");
        assert.ok(await page.evaluate(() => resizeSource.isConnected), "resize does not replace source contents");
        await page.locator("#source-close").click();
        await page.locator("#summary .metric").filter({ hasText: "Architecture edges" }).click();
        await page.locator("#graph svg").waitFor();
        await rememberPanels(page);
        await page.setViewportSize({ width: 1000, height: 900 });
        await frames(page);
        assert.ok(await graphFits(page), "relationship graphs use the same live relayout");
        assert.ok(await panelsUnchanged(page), "relationship graph resize keeps existing content");
        assert.deepEqual(errors, []);
        await page.close();

        const fallback = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        await fallback.addInitScript(() => {
            window.ResizeObserver = class { observe() {} };
            const addEventListener = window.addEventListener.bind(window);
            window.addEventListener = (type, ...args) => {
                if (!["resize", "focus"].includes(type)) addEventListener(type, ...args);
            };
            window.visualViewport.addEventListener = () => {};
        });
        await fallback.goto(`${server.url}?scoutTheme=${theme}`);
        await fallback.locator(".review-plan-row").first().waitFor();
        await fallback.locator("#zoom-out").click();
        await fallback.locator("#graph .node").first().waitFor();
        await rememberPanels(fallback);
        await fallback.evaluate(() => { document.querySelector(".workspace").style.maxWidth = "1000px"; });
        await fallback.waitForFunction(() => {
            const graph = document.querySelector("#graph");
            return graph.querySelector("svg").viewBox.baseVal.width === Math.max(graph.clientWidth, 320);
        }, null, { timeout: 2000 });
        assert.ok(await panelsUnchanged(fallback), "polling recovers a missed notification without a full render");
        await fallback.close();
        console.log(`PASS ${theme}: live width-only relayout, stable panels/focus, pan/zoom, node/rail dragging, details, empty/source views, host fallback`);
    }
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
