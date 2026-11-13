import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { reviewSequence, workspaceNavigation } from "../../web/review-workspace.mjs";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review with several changed files.");
const endpoint = new URL("/api/review-progress", url);
const original = await fetch(endpoint).then((response) => response.json());
const snapshot = await fetch(new URL("/api/state", url)).then((response) => response.json());
const sections = await fetch(new URL("/api/review-sections", url)).then((response) => response.json());
const sequence = reviewSequence(workspaceNavigation(snapshot.model, sections));
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
const current = (page) => page.locator(".workspace-file[aria-current='location']").first()
    .evaluate((button) => ({ path: button.dataset.path, group: button.dataset.group }));

try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator("#overview-start").click();
    await page.waitForFunction(() => document.querySelector("#source .code-row") && document.querySelector(".workspace-file[aria-current='location']")
        && /\d+ layers?/.test(document.querySelector("#workspace-count")?.textContent || ""));
    await page.waitForTimeout(300);
    const start = await current(page);
    const index = sequence.findIndex((entry) => entry.path === start.path && entry.group === start.group);
    assert.ok(index >= 0, `the rail selection is in the layered sequence: ${JSON.stringify(start)}`);
    const target = sequence[(index + 3) % sequence.length];
    // Simulate a cold server: each source response takes longer than the gap between key presses.
    await page.route("**/api/source?*", async (route) => { await new Promise((resolve) => setTimeout(resolve, 1500)); await route.continue(); });
    await page.locator("#source-title").click();
    for (let press = 0; press < 3; press++) {
        await page.keyboard.press("j");
        await page.waitForTimeout(300);
    }
    assert.deepEqual(await current(page), { path: target.path, group: target.group }, "the rail moves to the destination immediately");
    assert.match(await page.locator("#source-title").textContent(), new RegExp(`^${target.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · loading…$`));
    assert.equal(await page.locator("#source").getAttribute("aria-busy"), "true");
    assert.equal(await page.locator("#file-review-next").isDisabled(), true, "a decision cannot target a file that has not rendered");
    assert.equal(await page.locator("#file-review-open-next").isDisabled(), true, "Next file cannot race a source load");
    await page.waitForFunction((path) => document.querySelector("#source-title")?.textContent.startsWith(path)
        && !document.querySelector("#source-title").textContent.includes("loading")
        && document.querySelector("#source")?.getAttribute("aria-busy") !== "true", target.path, { timeout: 15_000 });
    assert.deepEqual(await current(page), { path: target.path, group: target.group }, "the settled source matches the rail");
    assert.deepEqual(errors, []);
    console.log(`PASS: three quick J presses show ${target.path} immediately and settle on it`);
} finally {
    await browser.close();
    const latest = await fetch(endpoint).then((response) => response.json());
    await fetch(endpoint, { method: "POST", body: JSON.stringify({ snapshot: latest.snapshot, revision: latest.revision,
        entries: original.entries, cursor: original.cursor }) });
}
