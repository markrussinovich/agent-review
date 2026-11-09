import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileReviewId } from "../../web/review-ledger.mjs";
import { reviewSequence, workspaceNavigation } from "../../web/review-workspace.mjs";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review with several review groups.");
const endpoint = new URL("/api/review-progress", url);
const original = await fetch(endpoint).then((response) => response.json());
const readOnly = process.env.AGENT_REVIEW_NEXT_READ_ONLY === "1";
let isolated = original;
const snapshot = await fetch(new URL("/api/state", url)).then((response) => response.json());
const sections = await fetch(new URL("/api/review-sections", url)).then((response) => response.json());
const sequence = reviewSequence(workspaceNavigation(snapshot.model, sections));
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
const restore = async (entries = original.entries, cursor = original.cursor) => {
    if (readOnly) { isolated = { ...original, entries, cursor }; return; }
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = await fetch(endpoint).then((response) => response.json());
        const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({
            snapshot: current.snapshot, revision: current.revision, entries, cursor }) });
        if (response.status === 409) continue;
        assert.equal(response.status, 200, "restore only this test's review metadata");
        return;
    }
    throw new Error("Unable to restore test review metadata.");
};
const location = (page) => page.locator(".workspace-file[aria-current='location']").first()
    .evaluate((button) => ({ path: button.dataset.path, group: button.dataset.group }));
const progress = () => readOnly ? Promise.resolve(isolated) : fetch(endpoint).then((response) => response.json());
const screenshot = async (page, name) => {
    if (!process.env.AGENT_REVIEW_SCREENSHOT_DIR) return;
    await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, name) });
};
const waitForFile = (page, entry) => page.waitForFunction(({ path, group }) => {
    const button = document.querySelector(".workspace-file[aria-current='location']");
    return button?.dataset.path === path && button.dataset.group === group
        && document.querySelector("#source")?.getAttribute("aria-busy") !== "true"
        && !document.querySelector("#file-review-open-next")?.disabled;
}, entry);

try {
    for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
        await restore({}, null);
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        if (readOnly) {
            await page.route("**/api/**", async (route) => {
                const request = route.request();
                const path = new URL(request.url()).pathname;
                if (path === "/api/review-progress") {
                    if (request.method() === "POST") isolated = { ...isolated, ...request.postDataJSON(), revision: isolated.revision + 1 };
                    return route.fulfill({ json: isolated });
                }
                if (request.method() === "GET") return route.continue();
                if (path === "/api/annotation") return route.fulfill({ json: { annotation: snapshot.annotations?.[request.postDataJSON().id] || null } });
                if (path === "/api/layer-summaries") return route.fulfill({ json: { annotation: snapshot.annotations?.layers || { titles: {} } } });
                return route.fulfill({ json: {} });
            });
            await page.addInitScript(() => {
                window.EventSource = class {
                    addEventListener(type, listener) {
                        if (type === "state") fetch("/api/state").then((response) => response.json()).then((snapshot) => {
                            listener({ data: JSON.stringify({ ...snapshot, type: "connected" }) });
                            window.agentReviewNextConnected = true;
                        });
                    }
                    close() {}
                };
            });
        }
        await page.goto(`${url}?scoutTheme=${theme}`);
        if (readOnly) await page.waitForFunction(() => window.agentReviewNextConnected);
        await page.locator("#overview-start").click();
        await page.locator("#file-review-next").waitFor();
        let current = await location(page);
        assert.deepEqual(current, { path: sequence[0].path, group: sequence[0].group }, "Start opens the first file in the rail");
        await waitForFile(page, current);
        const first = current;
        const following = sequence.find((entry) => entry.path !== first.path);
        assert.ok(following, "Use a genuine review with at least two changed files.");
        const nextOnly = page.locator("#file-review-open-next");
        assert.equal(await nextOnly.textContent(), "Next file");
        assert.ok((await nextOnly.getAttribute("title")).includes(following.path));
        await page.locator("#file-review-disposition").selectOption("follow-up");
        await page.locator("#file-review-note").fill("Unsaved draft retained while browsing.");
        const before = (await progress()).entries;
        await page.locator("#file-review-save").focus();
        await page.keyboard.press("Tab");
        assert.equal(await nextOnly.evaluate((element) => element === document.activeElement && element.matches(":focus-visible")), true,
            "Next file has a visible focus indicator in the footer's tab order");
        for (const button of [nextOnly, page.locator("#file-review-next"), page.locator("#file-review-save")]) {
            const bounds = await button.boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 900,
                "footer actions fit the viewport");
        }
        await screenshot(page, `next-without-review-${theme}-${width}.png`);
        if (width < 900) await nextOnly.press("Enter");
        else await nextOnly.click();
        await waitForFile(page, { path: following.path, group: following.group });
        assert.deepEqual((await progress()).entries, before, "Next file must not save or mark any review decision");
        if (width < 900) await page.locator("#workspace-nav-toggle").click();
        const previous = page.locator(`.workspace-file[data-path=${JSON.stringify(first.path)}][data-group=${JSON.stringify(first.group)}]`).first();
        const group = previous.locator("xpath=ancestor::details").first();
        if (!await group.evaluate((element) => element.open)) await group.locator(":scope > summary").click();
        await previous.click();
        await waitForFile(page, first);
        assert.equal(await page.locator("#file-review-disposition").inputValue(), "follow-up");
        assert.equal(await page.locator("#file-review-note").inputValue(), "Unsaved draft retained while browsing.");
        await page.locator("#file-review-disposition").selectOption("pending");
        await page.locator("#file-review-note").fill("");
        current = await location(page);
        const reviewed = new Set();
        for (let step = 0; step < Math.min(5, sequence.length - 1); step++) {
            reviewed.add(current.path);
            const index = sequence.findIndex((entry) => entry.path === current.path && entry.group === current.group);
            const expected = [...sequence.slice(index + 1), ...sequence.slice(0, index + 1)].find((entry) => !reviewed.has(entry.path));
            await page.waitForFunction(() => !document.querySelector("#file-review-next").disabled);
            assert.match(await page.locator("#file-review-next").textContent(), new RegExp(`& next: ${expected.path.split("/").at(-1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
                `step ${step + 1}: Mark names the file it opens`);
            assert.match(await page.locator("#source-position").textContent(), /^\+\d[\d,]* −\d[\d,]*( · file \d+ of \d+ in .+)?$/);
            // Alternate the button and the M shortcut; both mark this file and open the named one.
            if (step % 2) {
                await page.locator("#source").focus();
                await page.keyboard.press("m");
            } else await page.locator("#file-review-next").click();
            await page.waitForFunction(({ path, group }) => {
                const button = document.querySelector(".workspace-file[aria-current='location']");
                return button?.dataset.path === path && button.dataset.group === group
                    && document.querySelector("#source")?.getAttribute("aria-busy") !== "true";
            }, { path: expected.path, group: expected.group }, { timeout: 15_000 }).catch(async (error) => {
                throw new Error(`step ${step + 1}: expected ${expected.group}:${expected.path}, got ${JSON.stringify(await location(page))}: ${error.message}`);
            });
            current = await location(page);
        }
        const decisions = Object.fromEntries([...new Set(sequence.map((entry) => entry.path))].map((path) => [
            fileReviewId(path), { path, disposition: path === current.path ? "pending" : "reviewed",
                note: "", line: null, updated_at: new Date().toISOString() },
        ]));
        await restore(decisions, null);
        await page.reload();
        if (readOnly) await page.waitForFunction(() => window.agentReviewNextConnected);
        await page.locator("#overview-start").click();
        await page.locator("#file-review-open-next").getByText("Review summary", { exact: true }).waitFor();
        await page.locator("#file-review-open-next").click();
        await page.locator("#review-finish").getByText("Review has remaining work", { exact: true }).waitFor();
        assert.deepEqual((await progress()).entries, decisions, "opening the summary must leave the last file not reviewed");
        await screenshot(page, `next-summary-unreviewed-${theme}-${width}.png`);
        assert.deepEqual(errors, []);
        console.log(`PASS ${theme}/${width}: Next preserves decisions and drafts; pending final file stays pending; Mark & next follows the rail for ${Math.min(5, sequence.length - 1)} steps`);
        await page.close();
    }
} finally {
    await browser.close();
    await restore();
}
