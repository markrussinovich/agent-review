import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), "review-prompt-browser-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
let server, browser;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "main.py"), "def run():\n    return 1\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(repo, "main.py"), "def run():\n    return 2\n");
    await mkdir(join(repo, ".agent-review"));
    await writeFile(join(repo, ".agent-review", "prompts.json"), JSON.stringify({
        version: 1, prompts: [{ id: "discovered", title: "Discovered check", prompt: "Check error handling.", enabled: true }],
    }));
    let calls = 0, fail = false;
    const state = new ReviewState(repo, {
        baseRef: base,
        customPromptOptions: { globalDirectory: join(repo, ".git", "prompt-config") },
        generateAnnotation: async () => "## Summary\n\n- Changed run behavior.\n\n## Review order\n\n- Check main.\n\n## Gaps\n\n- Coverage unknown.",
        generateCustomAnalysis: async ({ context }) => {
            calls += 1;
            assert.match(context.files.find((file) => file.path === "main.py").current, /return [12]/);
            await new Promise((resolve) => setTimeout(resolve, 75));
            if (fail) throw new Error("Intentional provider failure");
            return "## Findings\n\n- Check `main.py:2` against the saved snapshot.\n\n## Verification\n\n- Test run output.";
        },
    });
    await state.refresh();
    server = await startReviewServer(state);
    const executablePath = process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url);
    await page.locator("#change-brief .brief-ai").waitFor();
    await page.locator("#custom-results").getByText("Approval required", { exact: true }).waitFor();
    assert.equal(calls, 0, "repository-discovered instructions never execute without approval");
    await page.click("#custom-manage");
    await page.locator(".prompt-record").filter({ hasText: "Discovered check" }).getByRole("button", { name: "Review / approve" }).click();
    assert.equal(await page.inputValue("#prompt-text"), "Check error handling.");
    await page.click("#prompt-save");
    await page.locator("#custom-results").getByText("complete", { exact: true }).waitFor();
    assert.equal(calls, 1);
    await page.selectOption("#prompt-scope", "global");
    await page.fill("#prompt-title", "Global compatibility");
    await page.fill("#prompt-text", "Check public API compatibility.");
    await page.click("#prompt-save");
    await page.waitForFunction(() => document.querySelectorAll(".custom-complete").length === 2);
    assert.equal(calls, 2);
    assert.match(await page.locator("#prompt-library").textContent(), /All repositories.*Enabled.*Approved/);
    await page.click("#prompt-manager-close");
    const discovered = page.locator(".custom-result").filter({ hasText: "Discovered check" });
    await discovered.locator("summary").click();
    await Promise.all([
        page.waitForResponse((response) => response.url().endsWith("/api/custom-analyses") && response.request().method() === "POST"),
        discovered.getByRole("button", { name: "Run again" }).click(),
    ]);
    assert.equal(calls, 3);
    await discovered.locator(".source-reference").click();
    await page.waitForFunction(() => document.querySelector("#source-title").textContent === "main.py:2");
    await page.click("#source-close");
    await page.selectOption("#review-mode", "commit");
    await page.waitForFunction(() => !document.querySelector("#review-ref").disabled);
    const commit = await page.locator("#review-ref option").nth(1).getAttribute("value");
    await page.selectOption("#review-ref", commit);
    await page.waitForFunction(() => document.querySelector("#review-target-label").textContent.startsWith("Commit ")
        && document.querySelector("#status").textContent === "Analysis current"
        && document.querySelectorAll(".custom-complete").length === 2);
    const beforeRestore = calls;
    await page.selectOption("#review-mode", "worktree");
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Saved review");
    assert.equal(calls, beforeRestore, "returning to a saved review reuses custom results");
    await page.click("#custom-manage");
    const globalRow = page.locator(".prompt-record").filter({ hasText: "Global compatibility" });
    await globalRow.getByRole("button", { name: "Edit", exact: true }).click();
    await page.uncheck("#prompt-enabled");
    await page.click("#prompt-save");
    await page.waitForFunction(() => document.querySelectorAll(".custom-result").length === 1);
    assert.equal(calls, beforeRestore, "disabling a check does not regenerate other results");
    await page.click("#prompt-manager-close");
    fail = true;
    await discovered.locator("summary").click();
    await discovered.getByRole("button", { name: "Run again" }).click();
    await page.locator("#custom-results .error").getByText("Intentional provider failure", { exact: true }).waitFor();
    fail = false;
    await discovered.getByRole("button", { name: "Run again" }).click();
    await page.locator(".custom-complete").waitFor();
    assert.equal(await page.locator("#custom-results .error").count(), 0);
    await page.click("#custom-manage");
    await page.locator(".prompt-record").filter({ hasText: "Discovered check" }).getByRole("button", { name: "Delete" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".custom-result").length === 0);
    for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
        await page.setViewportSize({ width: 680, height: 900 });
        const box = await page.locator("#prompt-manager").boundingBox();
        assert.ok(box.width <= 680 && box.x >= 0, "prompt manager fits narrow viewport");
    }
    assert.deepEqual(errors, []);
    console.log("PASS prompt manager: approval, repository/global CRUD, automatic checks, saved results, source links, disable, error/retry, delete, light/dark/narrow");
    await page.close();
} finally {
    await browser?.close();
    await server?.close();
    await rm(repo, { recursive: true, force: true });
}
