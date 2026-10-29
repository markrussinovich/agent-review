import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), "review-startup-interaction-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
let browser, server, state;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "main.py"), "def run():\n    return 1\n");
    await git("add", ".");
    await git("commit", "-qm", "baseline");
    state = new ReviewState(repo, {
        baseRef: "HEAD",
        reviewTarget: { mode: "none", label: "Choose review target", currentRef: null },
    });
    server = await startReviewServer(state);
    const executablePath = process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    // Hold the first state read and the event stream so the page has no payload when the user acts.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    for (const path of ["api/state", "events"]) {
        await page.route(`**/${path}`, async (route) => {
            await held;
            await route.continue();
        });
    }
    await page.goto(server.url);
    await page.selectOption("#review-mode", "commit");
    // Give the change handler and any list request time to settle while the state is still held.
    await page.waitForTimeout(500);
    assert.deepEqual(errors, [], "choosing a review before the first state arrives raised a page error");
    assert.doesNotMatch(await page.locator("#review-options-status").textContent(), /Unable to load/);

    release();
    await page.waitForFunction((root) => document.querySelector("#repository-identity")?.textContent === root,
        state.repoRoot, { timeout: 15_000 });
    assert.deepEqual(errors, []);
    assert.doesNotMatch(await page.locator("#review-options-status").textContent(), /Unable to load/);

    await page.selectOption("#review-mode", "commit");
    await page.locator("#review-ref option:not([disabled])").first().waitFor({ state: "attached", timeout: 15_000 });
    assert.deepEqual(errors, []);
    console.log("PASS: choosing a review before the first state arrives raises no error and leaves the picker usable");
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
