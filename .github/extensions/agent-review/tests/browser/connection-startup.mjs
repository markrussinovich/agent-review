import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), "review-connection-startup-"));
let browser, server, state;
try {
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "main.py"), "def run():\n    return 1\n");
    await git("add", ".");
    await git("commit", "-qm", "baseline");
    await writeFile(join(repo, "main.py"), "def run():\n    return 2\n");
    state = new ReviewState(repo, { baseRef: "HEAD",
        generateAnnotation: async () => "## Summary\n\n- Changed return.\n\n## Review order\n\n- Main.\n\n## Gaps\n\n- Tests." });
    await state.refresh();
    server = await startReviewServer(state);
    browser = await chromium.launch({ headless: true,
        executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const attempts = { state: 0, events: 0, prompts: 0 };
        for (const [key, path] of [["state", "api/state"], ["events", "events"], ["prompts", "api/custom-prompts"]]) {
            await page.route(`**/${path}`, (route) => ++attempts[key] === 1
                ? route.abort("connectionrefused") : route.continue());
        }
        await page.addInitScript(() => {
            window.connectionWarningFlashed = false;
            new MutationObserver(() => {
                const notice = document.querySelector("#connection-notice");
                if (notice && !notice.classList.contains("hidden")) window.connectionWarningFlashed = true;
            }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
        });
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        try {
            await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Analysis current", null, { timeout: 15000 });
        } catch (error) {
            throw new Error(`Startup did not recover: status=${await page.locator("#status").textContent()}; page errors=${errors.join(" | ")}; attempts=${JSON.stringify(attempts)}`, { cause: error });
        }
        await page.locator("#change-brief .brief-ai").waitFor();
        assert.equal(await page.evaluate(() => window.connectionWarningFlashed), false,
            `${theme}: a brief startup failure must recover without flashing the outage warning`);
        assert.ok(attempts.state > 1 && attempts.prompts > 1 && attempts.events > 1, "startup reads and event stream retry");
        assert.equal(await page.locator("#custom-results .error").count(), 0);
        assert.deepEqual(errors, []);
        await page.close();

        const delayed = await browser.newPage();
        let releaseRead;
        const readGate = new Promise((resolve) => { releaseRead = resolve; });
        let returnedRead;
        const readReturned = new Promise((resolve) => { returnedRead = resolve; });
        await delayed.route("**/api/state", async (route) => {
            const response = await route.fetch();
            const snapshot = await response.json();
            await readGate;
            await route.fulfill({ json: { ...snapshot, error: "Stale startup response" } });
            returnedRead();
        });
        await delayed.goto(`${server.url}?scoutTheme=${theme}`);
        await delayed.waitForFunction(() => document.querySelector("#status")?.textContent === "Analysis current");
        releaseRead();
        await readReturned;
        await delayed.waitForTimeout(100);
        assert.equal(await delayed.locator("#error").isVisible(), false,
            "a delayed initial read cannot replace newer event-stream state");
        assert.equal(await delayed.locator("#status").textContent(), "Analysis current");
        await delayed.close();

        const persistent = await browser.newPage();
        let blocked = true;
        for (const path of ["api/state", "events", "api/custom-prompts"]) {
            await persistent.route(`**/${path}`, (route) => blocked ? route.abort("connectionrefused") : route.continue());
        }
        await persistent.goto(`${server.url}?scoutTheme=${theme}`);
        await persistent.waitForTimeout(300);
        assert.equal(await persistent.locator("#connection-notice").isVisible(), false, "startup retry is neutral, not an immediate error");
        assert.match(await persistent.locator("#status").textContent(), /Connecting/);
        await persistent.locator("#connection-notice").waitFor({ state: "visible", timeout: 10000 });
        assert.equal(await persistent.locator("#status").textContent(), "Connection lost", "persistent failures are explicitly reported");
        assert.equal(await persistent.locator("#refresh").isDisabled(), true);
        blocked = false;
        await persistent.locator("#reconnect").click();
        await persistent.waitForFunction(() => document.querySelector("#status")?.textContent === "Analysis current");
        assert.equal(await persistent.locator("#connection-notice").isVisible(), false);
        await persistent.close();
        console.log(`PASS ${theme}: transient startup retry without alert flash; persistent outage, disabled actions, and recovery remain explicit`);
    }
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
