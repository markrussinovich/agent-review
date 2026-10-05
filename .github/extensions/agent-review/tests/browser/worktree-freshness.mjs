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
const repo = await mkdtemp(join(tmpdir(), "review-freshness-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
const source = (value) => `def run():\n    return ${value}\n`;
let browser, state, server;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "main.py"), source(1));
    await git("add", ".");
    await git("commit", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const createState = () => new ReviewState(repo, {
        baseRef: base,
        customPromptOptions: { globalDirectory: join(repo, ".git", "prompt-config") },
        generateAnnotation: async () => "## Summary\n\n- Changed return value.\n\n## Review order\n\n- `main.py`.\n\n## Gaps\n\n- Coverage unknown.",
    });
    const executablePath = process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
    for (const theme of ["light", "dark"]) {
        await writeFile(join(repo, "main.py"), source(1));
        state = createState();
        await state.refresh();
        server = await startReviewServer(state, { worktreeCheckIntervalMs: 250 });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.waitForFunction(() => document.querySelector("#status").textContent === "No changes");
        assert.equal(await page.locator("#worktree-notice").isVisible(), false);
        const original = state.model;
        const generation = state.reviewGeneration;
        await writeFile(join(repo, "main.py"), source(2));
        await page.locator("#worktree-notice").waitFor();
        assert.equal(await page.locator("#status").textContent(), "Worktree changed");
        assert.match(await page.locator("#clean-review").textContent(), /Previous snapshot had no changes/);
        assert.equal(state.model, original);
        assert.equal(state.reviewGeneration, generation, "detection does not restart analysis or AI");
        for (const width of [1280, 560]) {
            await page.setViewportSize({ width, height: 900 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        }
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) await page.screenshot({
            path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `worktree-stale-${theme}.png`), fullPage: true,
        });
        const response = page.waitForResponse((res) => res.url().endsWith("/api/refresh"));
        await page.click("#worktree-reanalyze");
        assert.equal((await response).status(), 202);
        await page.waitForFunction(() => document.querySelector("#status").textContent === "Analysis current");
        assert.equal(await page.locator("#worktree-notice").isVisible(), false);
        assert.match(state.model.source_files["main.py"].current, /return 2/);
        await page.selectOption("#review-mode", "commit");
        await page.waitForFunction(() => !document.querySelector("#review-ref").disabled);
        await page.selectOption("#review-ref", base);
        await page.waitForFunction(() => document.querySelector("#review-target-label").textContent.startsWith("Commit "));
        await writeFile(join(repo, "main.py"), source(3));
        await page.waitForTimeout(600);
        assert.equal(await page.locator("#worktree-notice").isVisible(), false);
        await page.selectOption("#review-mode", "worktree");
        await page.locator("#worktree-notice").waitFor();
        assert.equal(state.restoredFromCache, true);
        assert.match(state.model.source_files["main.py"].current, /return 2/);
        await page.click("#worktree-reanalyze");
        await page.waitForFunction(() => document.querySelector("#status").textContent === "Analysis current");
        assert.match(state.model.source_files["main.py"].current, /return 3/);
        const snapshot = state.model;
        const outage = page.waitForResponse((res) => res.url().endsWith("/api/refresh"));
        await page.click("#refresh");
        assert.equal((await outage).status(), 202);
        await page.locator("#analysis-progress").waitFor();
        const { port, url } = server;
        await server.close();
        server = null;
        await page.locator("#connection-notice").waitFor();
        assert.equal(await page.locator("#status").textContent(), "Connection lost");
        assert.equal(await page.locator("#analysis-progress").isVisible(), false, "lost provider never leaves a frozen progress bar");
        assert.equal(await page.locator("#refresh").isDisabled(), true);
        assert.equal(state.model, snapshot, "last completed results remain visible");
        assert.equal(await page.locator("#error").isVisible(), false, "network failure is not duplicated as a generic Failed to fetch");
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) await page.screenshot({
            path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `provider-disconnected-${theme}.png`), fullPage: true,
        });
        await state.dispose();
        state = createState();
        server = await startReviewServer(state, { port, exactPort: true, worktreeCheckIntervalMs: 250 });
        assert.equal(server.url, url);
        await page.click("#reconnect");
        await page.waitForFunction(() => document.querySelector("#status").textContent === "Analysis current");
        assert.equal(await page.locator("#connection-notice").isVisible(), false);
        assert.equal(await page.locator("#refresh").isEnabled(), true);
        assert.match(state.model.source_files["main.py"].current, /return 3/);
        assert.deepEqual(errors, []);
        await page.close();
        await state.dispose();
        await server.close();
        server = null;
        state = null;
        console.log(`PASS ${theme}: stale clean snapshot, explicit reanalysis, cached worktree, immutable commit, provider outage during analysis, same-URL recovery, narrow layout`);
    }
    if (process.env.AGENT_REVIEW_FRESHNESS_REPO) {
        const actualRepo = process.env.AGENT_REVIEW_FRESHNESS_REPO;
        const before = (await execute("git", ["-C", actualRepo, "status", "--porcelain"])).stdout;
        state = new ReviewState(actualRepo, {
            customPromptOptions: { globalDirectory: join(repo, ".git", "prompt-config") },
            generateAnnotation: async () => "## Summary\n\n- Review the actual worktree.\n\n## Review order\n\n- Changed checker code.\n\n## Gaps\n\n- Coverage unknown.",
        });
        await state.refresh();
        assert.ok(state.model.summary.files_changed > 0, "actual RefChecker agent changes must be reviewable");
        await state.checkWorktreeChanges();
        assert.equal(state.worktreeChanged, false, "analyzing the real worktree does not create a false stale notice");
        server = await startReviewServer(state);
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(server.url);
        await page.locator("#summary .metric").first().waitFor();
        assert.equal(await page.locator("#worktree-notice").isVisible(), false);
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) await page.screenshot({
            path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, "refchecker-fresh-worktree.png"), fullPage: true,
        });
        assert.equal((await execute("git", ["-C", actualRepo, "status", "--porcelain"])).stdout, before);
        console.log(`PASS actual RefChecker ${state.model.metadata.head_sha.slice(0, 7)}: ${state.model.summary.files_changed} changed files, current snapshot, preserved worktree`);
        await page.close();
    }
} finally {
    await browser?.close();
    await state?.dispose();
    await server?.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
