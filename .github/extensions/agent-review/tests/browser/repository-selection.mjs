import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "review-repository-ui-"));
let browser;
const resources = [];
try {
    const [original, demo] = [join(directory, "original"), join(directory, "demo")];
    for (const root of [original, demo]) {
        await mkdir(root);
        const git = (...args) => execute("git", ["-C", root, ...args]);
        await git("init", "-q");
        await git("config", "user.name", "Test");
        await git("config", "user.email", "test@example.invalid");
        await writeFile(join(root, "main.py"), "def run():\n    return 1\n");
        await writeFile(join(root, ".agent-review.json"), '{"base_ref":"HEAD"}');
        await git("add", ".");
        await git("commit", "-qm", "baseline");
    }
    await writeFile(join(demo, "main.py"), "def run():\n    return 2\n");
    browser = await chromium.launch({ headless: true,
        executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    for (const theme of ["light", "dark"]) {
        const state = new ReviewState(original, { baseRef: "HEAD",
            generateAnnotation: async () => "## Summary\n\n- Demo change.\n\n## Review order\n\n- Main.\n\n## Gaps\n\n- Tests." });
        await state.refresh();
        const server = await startReviewServer(state);
        resources.push({ state, server });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.getByRole("heading", { name: "No changes to review" }).waitFor();
        await page.getByRole("button", { name: "Change repository", exact: true }).click();
        await page.locator("#repository-path").fill(join(directory, "missing"));
        await page.getByRole("button", { name: "Open repository", exact: true }).click();
        await page.locator("#repository-picker-error").waitFor({ state: "visible" });
        assert.equal(state.repoRoot, original);
        await page.locator("#repository-path").fill(demo);
        await page.getByRole("button", { name: "Open repository", exact: true }).click();
        await page.waitForFunction((root) => document.querySelector("#repository-identity").textContent.includes(root)
            && document.querySelector("#status").textContent === "Analysis current", demo, { timeout: 60000 });
        assert.equal(await page.locator("#repository-picker").isVisible(), false);
        assert.equal(await page.locator("#clean-review").isVisible(), false);
        assert.equal(await page.locator("#summary .metric").count(), 5);
        assert.equal(state.repoRoot, demo);
        assert.equal(state.model.summary.files_changed, 1);
        await page.locator("#summary .metric").filter({ hasText: "Files" }).click();
        await page.locator(".collection-row").filter({ hasText: "main.py" }).click();
        await page.waitForFunction(() => document.querySelector("#source-title").textContent === "main.py");
        assert.match(await page.locator("#source").textContent(), /return 2/);
        await page.setViewportSize({ width: 560, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}: clean wrong worktree -> explicit existing repository, actionable invalid path, changes visible, narrow layout`);
    }
} finally {
    await browser?.close();
    for (const { server, state } of resources) { await server.close(); await state.dispose(); }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
