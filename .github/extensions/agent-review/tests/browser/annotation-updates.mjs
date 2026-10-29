import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";
import { openReviewTool } from "./review-details-helper.mjs";

const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const execute = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), "annotation-updates-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
const body = "## What changed\n\nThe selected function returns a saved value. See `first.py:1`.\n\n"
    + "## Background\n\n" + Array.from({ length: 30 }, (_, index) =>
        `Paragraph ${index}: inspect the source-backed behavior before accepting this change.\n\n`).join("")
    + "## Review focus\n\n**Requested:** Check the selected function.\n\nVerify the return value.";
let state, server, browser;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "baseline.py"), "value = 0\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "first.py"), "def first_target():\n    return 1\n");
    await writeFile(join(repo, "second.py"), "from first import first_target\n\ndef second_target():\n    return first_target()\n");
    state = new ReviewState(repo, {
        baseRef: "HEAD", readWorktreeFingerprint: null,
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        generateAnnotation: async () => body,
    });
    await state.refresh();
    const items = ["first", "second"].map((name) => state.model.nodes.find((node) => node.name === `${name}_target`));
    assert.ok(items.every(Boolean), "the production analyzer supplies both selectable symbols");
    const evidence = Object.keys(state.model.evidence).slice(0, 2);
    assert.ok(evidence.length, "use real analyzer evidence for citation controls");
    const initialAnnotations = () => ({
        overview: { body: "## Summary\n\nInspect the two changed functions.\n\n## Gaps\n\nCoverage unknown." },
        ...Object.fromEntries(items.map((item) => [item.id, { body, evidence_ids: evidence }])),
    });
    state.annotations = initialAnnotations();
    server = await startReviewServer(state);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync) });
    let update = 0;
    for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
        state.selection = null;
        state.annotations = initialAnnotations();
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript(() => {
            const NativeEventSource = window.EventSource;
            window.EventSource = class extends NativeEventSource {
                constructor(...args) {
                    super(...args);
                    this.addEventListener("state", (event) => {
                        const marker = JSON.parse(event.data).annotations?.regressionMarker;
                        setTimeout(() => { window.renderedMarker = marker; }, 0);
                    });
                }
            };
        });
        const broadcast = async (type = "annotation") => {
            const marker = ++update;
            state.annotations.regressionMarker = marker;
            state.broadcast(type);
            await page.waitForFunction((value) => window.renderedMarker === value, marker);
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        };
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await openReviewTool(page, "concerns");
        const select = async (item) => {
            await page.keyboard.press("Control+k");
            await page.locator("#review-command-query").fill(item.name);
            const sourceResponse = page.waitForResponse((response) => response.url().includes("/api/source?"));
            const attributionResponse = page.waitForResponse((response) => response.url().includes("/api/attribution?"));
            await page.locator("#review-command-results button").first().click();
            await (await sourceResponse).finished();
            await (await attributionResponse).finished();
            await page.waitForFunction((name) => document.querySelector("#source-annotation .annotation-heading strong")?.textContent === name,
                item.display_name || item.name);
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            if (await page.locator("#workspace-context").isVisible()) await page.locator("#workspace-context").click();
        };
        await select(items[0]);
        const annotation = page.locator("#source-annotation");
        const more = annotation.locator(".annotation-more");
        const citations = annotation.locator(".annotation-citations");
        const summary = more.locator(":scope > summary");
        assert.equal(await more.evaluate((node) => node.open), false);
        await summary.focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector(".annotation-more").open);
        await citations.locator(":scope > summary").click();
        await summary.focus();
        const scroll = await annotation.evaluate((panel) => {
            window.originalDisclosure = panel.querySelector(".annotation-more");
            const side = panel.closest(".source-side");
            side.scrollTop = panel.offsetTop + 180;
            return side.scrollTop;
        });
        assert.ok(scroll > 0, "the reader must genuinely scroll");
        const checkReading = async ({ sameNode = false } = {}) => {
            assert.equal(await more.evaluate((node) => node.open), true);
            assert.equal(await citations.evaluate((node) => node.open), true);
            assert.equal(await summary.evaluate((node) => node === document.activeElement), true);
            assert.ok(Math.abs(await page.locator(".source-side").evaluate((side) => side.scrollTop) - scroll) <= 1,
                "same-item background updates preserve the side-pane reading position");
            if (sameNode) assert.equal(await more.evaluate((node) => node === window.originalDisclosure), true);
        };
        state.annotations[items[1].id] = { body: `${body}\n\nAn unrelated update.` };
        await broadcast();
        await checkReading({ sameNode: true });
        // SSE JSON parsing produces fresh objects even when the selected content is identical.
        await broadcast();
        await checkReading({ sameNode: true });
        await broadcast("state");
        await checkReading({ sameNode: true });
        const attributionResponse = page.waitForResponse((response) => response.url().includes("/api/attribution?"));
        await broadcast("session-history");
        await (await attributionResponse).finished();
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await checkReading({ sameNode: true });
        await page.route("**/api/attribution?*", (route) => route.fulfill({ json: {
            status: "matched", attribution: [{ session_id: "updated-history", prompt_event_id: "request",
                prompt: "Check the selected function.", confidence: "high", reason: "Saved file activity." }],
        } }));
        await broadcast("session-history");
        await annotation.locator(".intent-link").waitFor();
        await checkReading();
        await page.unroute("**/api/attribution?*");
        state.annotations[items[0].id] = { body: `${body}\n\nUpdated selected explanation.`, evidence_ids: evidence };
        await broadcast();
        await annotation.getByText("Updated selected explanation.", { exact: true }).waitFor();
        await checkReading();
        assert.equal(await more.evaluate((node) => node === window.originalDisclosure), false,
            "changed content is actually rebuilt");
        const sourceLink = annotation.locator(".source-reference").first();
        await sourceLink.focus();
        state.annotations[items[0].id].body += "\n\nA second update.";
        await broadcast();
        assert.equal(await sourceLink.evaluate((node) => node === document.activeElement), true,
            "source-reference focus survives changed content");
        await citations.locator(":scope > summary").focus();
        state.annotations[items[0].id].evidence_ids = evidence.slice(0, 1);
        await broadcast();
        assert.equal(await citations.locator(":scope > summary").evaluate((node) => node === document.activeElement), true,
            "citation disclosure focus survives a changing evidence count");
        await annotation.locator(".evidence-link").first().focus();
        state.annotations[items[0].id].body += "\n\nA citation-focused update.";
        await broadcast();
        assert.equal(await annotation.locator(".evidence-link").first().evaluate((node) => node === document.activeElement), true,
            "evidence-link focus survives a selected annotation update");
        await page.locator("#show-evidence").focus();
        state.annotations[items[0].id].body += "\n\nA third update.";
        await broadcast();
        assert.equal(await page.locator("#show-evidence").evaluate((node) => node === document.activeElement), true,
            "an update does not steal focus from outside the annotation");
        await select(items[1]);
        assert.equal(await more.evaluate((node) => node.open), false, "another item starts collapsed");
        await select(items[0]);
        assert.equal(await more.evaluate((node) => node.open), true, "returning restores this item's choice");
        assert.equal(await citations.evaluate((node) => node.open), true);
        assert.equal(await page.locator(".source-side").evaluate((side) => side.scrollTop), 0,
            "explicit navigation still resets reading position");
        await summary.click();
        await broadcast();
        assert.equal(await more.evaluate((node) => node.open), false, "manual collapse survives background redraws");
        await select(items[1]);
        await select(items[0]);
        assert.equal(await more.evaluate((node) => node.open), false, "manual collapse survives switching away and back");
        await summary.click();
        await summary.focus();
        await more.evaluate((node) => { window.detachedDisclosure = node; });
        state.annotations[items[0].id] = { error: "Explanation is temporarily unavailable." };
        await broadcast();
        await annotation.getByText("Explanation is temporarily unavailable.", { exact: true }).waitFor();
        assert.equal(await annotation.locator(".annotation-heading").evaluate((node) => node === document.activeElement), true,
            "a removed focused control falls back to the remaining annotation heading");
        state.annotations[items[0].id] = { body, evidence_ids: evidence };
        await broadcast();
        assert.equal(await more.evaluate((node) => node.open), true, "success restores disclosure state after an error");
        await page.evaluate(() => { window.detachedDisclosure.open = false; window.detachedDisclosure.dispatchEvent(new Event("toggle")); });
        state.annotations[items[0].id].body += "\n\nAfter a detached toggle.";
        await broadcast();
        assert.equal(await more.evaluate((node) => node.open), true, "detached toggle events cannot overwrite current choices");
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
            await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
            await summary.focus();
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `annotation-${theme}-${width}.png`) });
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        // Test a generation transition while still loading, before resetReviewNavigation can run.
        state.reviewGeneration++;
        state.loading = true;
        await broadcast("state");
        await broadcast();
        assert.equal(await more.evaluate((node) => node.open), false, "a new generation never inherits an open disclosure");
        state.loading = false;
        state.selection = null;
        await broadcast("refreshed");
        await openReviewTool(page, "concerns");
        await select(items[0]);
        assert.equal(await more.evaluate((node) => node.open), false);
        await summary.click();
        await broadcast("repository-changed");
        await openReviewTool(page, "concerns");
        await select(items[0]);
        assert.equal(await more.evaluate((node) => node.open), false, "repository reset clears choices even with reused IDs");
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}/${width}: SSE redraws, scroll, focus, per-item disclosures, errors and snapshot resets`);
    }
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(repo, { recursive: true, force: true });
}
