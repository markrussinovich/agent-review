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
const repo = await mkdtemp(join(tmpdir(), "review-browser-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
let server;
let browser;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "main.py"), "def run():\n    return 1\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(repo, "main.py"), "def run():\n    return 2\n");
    await git("commit", "-qam", "feature");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(repo, "main.py"), "def dirty_only():\n    return 999\n");
    const state = new ReviewState(repo, { baseRef: base });
    await state.refresh();
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
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.waitForFunction(() => document.querySelector("#status").textContent === "Analysis current");
        await page.selectOption("#review-mode", "commit");
        await page.fill("#review-ref", head);
        const response = page.waitForResponse((res) => res.url().endsWith("/api/review-target"));
        await page.click("#review-apply");
        assert.equal((await response).status(), 200);
        await page.waitForFunction(() => document.querySelector("#review-target-label").textContent.startsWith("Commit "));
        await page.locator("#summary .metric").filter({ hasText: "Files" }).click();
        await page.locator(".collection-row").filter({ hasText: "main.py" }).click();
        await page.waitForFunction(() => !document.querySelector("#source-panel").classList.contains("hidden"));
        const code = await page.locator("#source").textContent();
        assert.match(code, /return 2/);
        assert.doesNotMatch(code, /dirty_only|999/);
        await page.click("#source-close");
        await page.selectOption("#review-mode", "worktree");
        const worktreeResponse = page.waitForResponse((res) => res.url().endsWith("/api/review-target"));
        await page.click("#review-apply");
        assert.equal((await worktreeResponse).status(), 200);
        await page.waitForFunction(() => document.querySelector("#review-target-label").textContent === "Worktree");
        await page.selectOption("#review-mode", "pr");
        await page.fill("#review-ref", "not-a-pr");
        const bad = page.waitForResponse((res) => res.url().endsWith("/api/review-target"));
        await page.click("#review-apply");
        assert.equal((await bad).status(), 400);
        await page.waitForFunction(() => !document.querySelector("#error").classList.contains("hidden"));
        assert.match(await page.locator("#error").textContent(), /Enter a GitHub PR/);
        if (process.env.AGENT_REVIEW_LIVE_PR) {
            await page.fill("#review-ref", process.env.AGENT_REVIEW_LIVE_PR);
            const live = page.waitForResponse((res) => res.url().endsWith("/api/review-target"), { timeout: 180_000 });
            await page.click("#review-apply");
            const result = await live;
            assert.equal(result.status(), 200, await result.text());
            await page.waitForFunction(() => document.querySelector("#review-target-label").textContent.startsWith("PR #"));
            assert.equal(state.model.metadata.head_sha, state.reviewTarget.currentRef);
            assert.equal(state.model.metadata.base_sha, state.reviewTarget.baseRef);
        }
        await page.setViewportSize({ width: 760, height: 1000 });
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}: commit, immutable diff, worktree, PR validation${process.env.AGENT_REVIEW_LIVE_PR ? ", live PR" : ""}, narrow layout, no browser errors`);
    }
} finally {
    await browser?.close();
    await server?.close();
    await rm(repo, { recursive: true, force: true });
}
