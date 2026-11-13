import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to a real repository review server.");
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

try {
    const payload = await (await fetch(new URL("/api/state", url))).json();
    const node = Object.keys(payload.annotations || {}).map((id) => payload.model.nodes.find((item) => item.id === id))
        .find((item) => item && payload.annotations[item.id].body?.includes("Source check 30"));
    assert.ok(node, "Use a saved demo explanation with enough content to test returning to the reading position.");
    const other = Object.keys(payload.annotations || {}).map((id) => payload.model.nodes.find((item) => item.id === id))
        .find((item) => item?.id !== node.id && item?.path && payload.annotations[item.id].body?.includes("Source check 30"));
    for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
            await page.route("**/api/attribution?*", (route) => route.fulfill({ json: {
                status: "matched", attribution: [{
                    prompt: "Check the changed source in this UI validation review.", confidence: "high",
                    reason: "Controlled saved history for testing the transcript overlay.",
                    session_id: "ui-return-flow", prompt_event_id: "ui-request",
                }],
            } }));
            await page.route("**/api/session-history?*", (route) => route.fulfill({ json: {
                summary: `Saved UI validation transcript for ${node.display_name || node.name}`,
                timeline: [{ event_id: "ui-request", role: "user", summary: "Check the changed source." }],
            } }));
            await page.goto(`${url}?scoutTheme=${theme}`);
            await page.locator("#workspace-find").click();
            await page.locator("#review-command-query").fill(node.display_name || node.name);
            await page.locator("#review-command-results button").filter({ hasText: node.path }).first().click();
            await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true");
            await page.locator("#source-annotation .annotation-more").waitFor({ state: "attached" });
            if (width < 900) await page.locator("#workspace-context").click();
            await page.locator('#source-panel [data-tab="current"]').click();
            const more = page.locator("#source-annotation .annotation-more");
            if (!await more.evaluate((element) => element.open)) await more.locator(":scope > summary").click();
            if (width > 900) {
                const resize = page.locator("#source-side-resize");
                const before = await page.locator(".source-side").evaluate((element) => element.offsetWidth);
                await resize.press("ArrowLeft");
                assert.notEqual(await page.locator(".source-side").evaluate((element) => element.offsetWidth), before);
                await resize.press("ArrowRight");
                assert.equal(await page.locator(".source-side").evaluate((element) => element.offsetWidth), before);
            }
            await screenshot(page, `return-heading-${theme}-${width}.png`);
            const sideScroll = await page.locator(".source-side").evaluate((element) => {
                element.scrollTop = 160;
                return element.scrollTop;
            });
            await screenshot(page, `return-source-${theme}-${width}.png`);
            const headingFits = await page.locator("#source-annotation .annotation-heading strong").evaluate((element) => {
                const box = element.getBoundingClientRect();
                const heading = element.parentElement.getBoundingClientRect();
                return box.left >= heading.left && box.right <= heading.right + 1;
            });
            await page.locator("#source-impact").click();
            await page.locator(".impact-toolbar").waitFor();
            await screenshot(page, `return-impact-${theme}-${width}.png`);
            assert.ok(headingFits, "long annotation titles fit within their heading without clipping");
            const assertReading = async () => {
                await page.waitForFunction((path) => !document.querySelector("#source-panel").classList.contains("hidden")
                    && document.querySelector("#source-title").textContent.includes(path)
                    && document.querySelector("#source").getAttribute("aria-busy") !== "true", node.path);
                assert.equal(await page.locator('[data-tab="current"]').evaluate((element) => element.classList.contains("active")), true);
                assert.equal(await more.evaluate((element) => element.open), true);
                assert.ok(Math.abs(await page.locator(".source-side").evaluate((element) => element.scrollTop) - sideScroll) <= 1,
                    "return preserves the explanation's reading position");
            };
            const assertHeader = async (back, close) => {
                const left = await back.boundingBox(), right = await close.boundingBox();
                assert.ok(left && right && Math.abs(left.y + left.height / 2 - right.y - right.height / 2) <= 1);
                assert.ok(left.x + left.width < right.x, "Back stays left; Close stays right");
            };
            await assertHeader(page.locator("#zoom-out"), page.locator("#graph-close"));
            const tile = page.locator(".impact-graph .node").first();
            const tileId = await tile.getAttribute("data-node-id");
            await tile.press("Enter");
            await page.locator("#detail-close").waitFor();
            await assertHeader(page.locator("#detail-back"), page.locator("#detail-close"));
            await screenshot(page, `return-detail-${theme}-${width}.png`);
            await page.locator(".impact-evidence").getByRole("button", { name: "Open source", exact: true }).click();
            await page.locator("#source-close").waitFor();
            await assertHeader(page.locator("#source-back"), page.locator("#source-close"));
            await page.locator("#source-close").click();
            await page.locator(".impact-evidence").waitFor();
            assert.equal(await page.locator("#detail-close").isVisible(), true, "node details work on narrow layouts too");
            await page.locator("#detail-close").click();
            assert.equal(await page.evaluate((id) => document.activeElement?.dataset.nodeId === id, tileId), true);
            await page.keyboard.press("Escape");
            await assertReading();
            assert.equal(await page.locator("#source-impact").evaluate((element) => element === document.activeElement), true);

            await page.locator("#source-impact").click();
            await page.locator("#zoom-out").click();
            await assertReading();
            for (const tool of ["priorities", "concerns", "groups", "architecture", "paths", "packages"]) {
                if (tool === "paths" && !payload.decision_map) continue;
                await page.locator(".workspace-explore > summary").click();
                await page.locator(`#explore-${tool}`).click();
                await assertHeader(page.locator("#zoom-out"), page.locator("#graph-close"));
                if (tool === "packages" && await page.getByRole("button", { name: "Close package details", exact: true }).count()) {
                    await page.getByRole("button", { name: "Close package details", exact: true }).click();
                    assert.match(await page.locator("#package-detail").textContent(), /Select a package/);
                    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("package-row")), true);
                }
                await page.locator("#graph-close").click();
                await assertReading();
                assert.equal(await page.locator(".workspace-explore > summary").evaluate((element) => element === document.activeElement), true);
            }

            await page.locator(".workspace-explore > summary").click();
            await page.locator("#explore-architecture").click();
            const rootTitle = await page.locator("#graph-title").textContent();
            const component = page.locator("#graph .node").first();
            await component.press("Enter");
            assert.notEqual(await page.locator("#graph-title").textContent(), rootTitle);
            await page.keyboard.press("Alt+ArrowLeft");
            assert.equal(await page.locator("#graph-title").textContent(), rootTitle);
            await page.locator("#graph .node").first().press("Enter");
            await page.locator("#graph-close").click();
            await assertReading();

            await page.locator("#workflow-finish").click();
            await page.getByRole("button", { name: "Close review summary", exact: true }).waitFor();
            await assertHeader(page.locator("#review-finish .view-back"), page.locator("#review-finish .view-close"));
            await screenshot(page, `return-finish-${theme}-${width}.png`);
            const handoff = page.locator("#review-finish").getByRole("button", { name: /Preview \/ export handoff|Review & submit to pull request/ });
            await handoff.click();
            await page.locator("#handoff-close").click();
            assert.equal(await handoff.evaluate((element) => element === document.activeElement), true);
            await page.getByRole("button", { name: "Close review summary", exact: true }).click();
            await assertReading();
            assert.equal(await page.locator("#workflow-finish").evaluate((element) => element === document.activeElement), true);
            await page.locator("#workspace-find").click();
            await page.keyboard.press("Escape");
            assert.equal(await page.locator("#workspace-find").evaluate((element) => element === document.activeElement), true);

            await page.locator("#source-focus").click();
            await page.locator("#source-impact").click();
            await page.locator("#graph-close").click();
            await page.waitForFunction(() => document.body.classList.contains("review-source-focus"));
            await page.locator("#source-focus").click();
            if (width < 900) await page.locator("#workspace-context").click();
            await assertReading();
            if (width < 900) await page.locator("#workspace-nav-toggle").click();
            const layer = page.locator("#workspace-nav-list .workspace-layer").last();
            if (!await layer.evaluate((element) => element.open)) await layer.locator(":scope > summary").click();
            const bulk = page.locator("#workspace-nav-list").getByRole("button", { name: /Review all (supporting|group) files/ }).last();
            if (await bulk.count()) {
                await bulk.click();
                await page.locator("#group-review-close").click();
                assert.equal(await bulk.evaluate((element) => element === document.activeElement), true);
            }
            if (width < 900) await page.keyboard.press("Escape");

            assert.ok(other, "the demo has a second saved symbol for source Back/Forward");
            await page.locator("#workspace-find").click();
            await page.locator("#review-command-query").fill(other.display_name || other.name);
            await page.locator("#review-command-results button").filter({ hasText: other.path }).first().click();
            await page.waitForFunction((path) => document.querySelector("#source-title").textContent.includes(path)
                && document.querySelector("#source").getAttribute("aria-busy") !== "true", other.path);
            if (width < 900) await page.locator("#workspace-context").click();
            await page.locator('#source-panel [data-tab="base"]').click();
            await page.locator("#source-back").click();
            await assertReading();
            await page.locator("#source-forward").click();
            await page.waitForFunction((path) => document.querySelector("#source-title").textContent.includes(path)
                && document.querySelector("#source").getAttribute("aria-busy") !== "true", other.path);
            assert.equal(await page.locator('[data-tab="base"]').evaluate((element) => element.classList.contains("active")), true);
            await page.keyboard.press("Alt+ArrowLeft");
            await assertReading();
            await page.locator("#source-origin > summary").click();
            const history = page.locator("#source-provenance").getByRole("button", { name: "Open session history", exact: true });
            await history.click();
            await page.locator("#session-history-close").waitFor();
            assert.equal(await page.locator("#session-history-close").evaluate((element) => element === document.activeElement), true);
            await screenshot(page, `return-transcript-${theme}-${width}.png`);
            await page.keyboard.press("Escape");
            assert.equal(await history.evaluate((element) => element === document.activeElement), true);

            await page.locator("#workflow-overview").click();
            const advanced = page.locator("#review-background");
            if (!await advanced.evaluate((element) => element.open)) await advanced.locator(":scope > summary").click();
            for (const [opener, close] of [["custom-manage", "prompt-manager-close"], ["change-repository", "repository-picker-close"]]) {
                await page.locator(`#${opener}`).click();
                await page.locator(`#${close}`).click();
                assert.equal(await page.locator(`#${opener}`).evaluate((element) => element === document.activeElement), true);
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
            console.log(`PASS ${theme}/${width}: aligned headers; nested Impact/source/details, all Explore exits, graph Back/Close, Finish, dialog focus and source Back/Forward preserve reading context`);
        } finally { await page.close(); }
    }
} finally { await browser.close(); }
