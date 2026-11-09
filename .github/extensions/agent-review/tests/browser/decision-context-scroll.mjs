import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to a real repository review.");
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
const positions = (page) => page.evaluate(() => {
    const side = document.querySelector(".source-side");
    return {
        pane: document.body.dataset.readingPane, top: side.scrollTop, left: side.scrollLeft, window: scrollY,
        lists: [...document.querySelectorAll("#source-decisions .decision-rows")].map((list) => [list.scrollTop, list.scrollLeft]),
        disclosures: [...document.querySelectorAll("#source-annotation details")].map((details) => details.open),
    };
});

try {
    let payload;
    for (let attempt = 0; attempt < 60; attempt++) {
        payload = await (await fetch(new URL("/api/state", url))).json();
        if (payload.decision_map?.status !== "loading") break;
        await setTimeout(500);
    }
    const callable = [...(payload.decision_map?.callables || [])]
        .filter((item) => item.entries?.length && payload.annotations?.[item.id]?.body?.includes("Source check 30"))
        .sort((a, b) => b.entries.length - a.entries.length)[0];
    const subjectName = process.env.AGENT_REVIEW_SCROLL_SUBJECT;
    const readOnly = process.env.AGENT_REVIEW_SCROLL_READ_ONLY === "1";
    const uncached = readOnly && process.env.AGENT_REVIEW_SCROLL_CACHED !== "1";
    const node = payload.model.nodes.find((item) => subjectName
        ? item.name === subjectName || item.display_name === subjectName : item.id === callable?.id);
    assert.ok(node, `Use an annotated demo callable with real code-path changes (map: ${payload.decision_map?.status}).`);
    if (readOnly && !uncached) assert.ok(payload.annotations?.[node.id]?.body, "Use a subject with a cached explanation.");
    const progress = readOnly ? await (await fetch(new URL("/api/review-progress", url))).json() : null;
    for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        const annotationRequests = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
            if (readOnly) {
                const snapshot = uncached ? { ...payload, annotations: { ...payload.annotations, [node.id]: null } } : payload;
                await page.route("**/api/**", async (route) => {
                    const request = route.request();
                    const path = new URL(request.url()).pathname;
                    if (path === "/api/state") return route.fulfill({ json: snapshot });
                    if (request.method() === "GET") return route.continue();
                    if (path === "/api/annotation") {
                        annotationRequests.push(request.postDataJSON().id);
                        return route.fulfill({ json: { annotation: null } });
                    }
                    if (path === "/api/review-progress") {
                        return route.fulfill({ json: { ...progress, ...request.postDataJSON(), revision: progress.revision + 1 } });
                    }
                    if (path === "/api/layer-summaries") return route.fulfill({ json: { annotation: payload.annotations?.layers || { titles: {} } } });
                    return route.fulfill({ json: {} });
                });
                await page.addInitScript(() => {
                    window.EventSource = class {
                        addEventListener(type, listener) {
                            if (type === "state") fetch("/api/state").then((response) => response.json())
                                .then((snapshot) => {
                                    listener({ data: JSON.stringify({ ...snapshot, type: "connected" }) });
                                    window.agentReviewScrollConnected = true;
                                });
                        }
                        close() {}
                    };
                });
            }
            await page.goto(`${url}?scoutTheme=${theme}`);
            if (readOnly) await page.waitForFunction(() => window.agentReviewScrollConnected);
            await page.locator("#workspace-find").click();
            await page.locator("#review-command-query").fill(node.display_name || node.name);
            await page.locator("#review-command-results button").filter({ hasText: node.path }).first().click();
            await page.locator("#source-decisions .decision-row").first().waitFor({ state: "attached" });
            await page.waitForFunction(() => document.querySelector("#source").getAttribute("aria-busy") !== "true");
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            if (width < 900) await page.locator("#workspace-context").click();
            const more = page.locator("#source-annotation .annotation-more");
            if (uncached) await page.locator("#source-annotation").waitFor({ state: "hidden" });
            else if (await more.count() && !await more.evaluate((element) => element.open)) await more.locator(":scope > summary").click();
            for (const action of ["mouse", "keyboard"]) {
                const exactLine = process.env.AGENT_REVIEW_SCROLL_LINE;
                const row = action === "mouse" && exactLine ? page.locator(`#source-decisions .decision-removed[data-line="${exactLine}"]`).first()
                    : action === "mouse" ? page.locator("#source-decisions .decision-row").last()
                    : page.locator("#source-decisions .decision-row").first();
                await row.scrollIntoViewIfNeeded();
                await row.focus();
                const before = await positions(page);
                assert.ok(before.top > 0, "the evidence panel is scrolled before following a code path");
                const bounds = await row.boundingBox();
                const line = await row.getAttribute("data-line");
                const base = await row.evaluate((element) => element.classList.contains("decision-removed"));
                const requestsBefore = annotationRequests.filter((id) => id === node.id).length;
                await screenshot(page, `decision-before-${action}-${theme}-${width}.png`);
                const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/source");
                if (action === "mouse") await row.click();
                else await row.press("Enter");
                await loaded;
                const highlighted = page.locator(`#source .code-row.focus-line[data-${base ? "old" : "new"}-line="${line}"]`);
                await highlighted.first().waitFor({ state: "attached" });
                await page.waitForFunction(() => document.querySelector("#source").getAttribute("aria-busy") !== "true");
                await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                await screenshot(page, `decision-after-${action}-${theme}-${width}.png`);
                assert.deepEqual(await positions(page), before, "code-path activation must not move the evidence panel or its nested lists");
                assert.equal((await row.boundingBox()).y, bounds.y, "the clicked row stays in the same screen position");
                assert.equal(await row.evaluate((element) => element === document.activeElement), true);
                if (readOnly) {
                    assert.equal(annotationRequests.filter((id) => id === node.id).length, requestsBefore,
                        "following a code path must not start a new explanation for the existing subject");
                    if (uncached) assert.equal(await page.locator("#source-annotation").isVisible(), false);
                }
                assert.ok(await highlighted.count(),
                    "the source still highlights the requested code path");
            }
            assert.deepEqual(errors, []);
            console.log(`PASS ${theme}/${width}: mouse and keyboard code-path activation preserve panel/list scroll, reading pane and focus`);
        } finally { await page.close(); }
    }
} finally { await browser.close(); }
