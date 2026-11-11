import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState, runAnalyzer } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const repo = process.env.AGENT_REVIEW_UX_REPO;
if (!repo) throw new Error("Set AGENT_REVIEW_UX_REPO to a real changed Git checkout with prepared analyzer tooling.");
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const scratch = await mkdtemp(join(tmpdir(), "analyzer-error-"));
const diagnostic = "System.BadImageFormatException: Invalid IL format.\r\n   at AgentReview.Dotnet.Program.Main()\r\n<complete diagnostic>";
const options = { baseRef: "origin/main", customPromptOptions: { globalDirectory: scratch },
    getSessionEvents: async () => [], getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }) };
let browser, server, state;
try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync) });
    for (const theme of ["light", "dark"]) {
        // A real invalid comparison exercises the production analyzer, failure transport and recovery.
        state = new ReviewState(repo, { ...options, baseRef: "agent-review-deliberately-missing-base" });
        await assert.rejects(state.refresh());
        const realDiagnostic = state.error;
        assert.ok(realDiagnostic);
        server = await startReviewServer(state);
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
            permissions: ["clipboard-read", "clipboard-write"] });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const screenshot = async (name) => {
            if (!process.env.AGENT_REVIEW_SCREENSHOT_DIR) return;
            await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `${name}-${theme}.png`) });
        };
        const panel = page.locator("#error");
        const details = panel.locator("details");
        const summary = details.locator("summary");
        const retry = panel.getByRole("button", { name: "Retry", exact: true });
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await retry.waitFor();
        assert.match(await panel.textContent(), /couldn't finish analysis/);
        assert.equal(await details.evaluate((node) => node.open), false);
        assert.equal(await panel.locator("pre").textContent(), realDiagnostic);
        assert.equal(await page.locator(".workspace").isVisible(), false);
        await screenshot("analyzer-failed");
        await summary.focus();
        await page.keyboard.press("Enter");
        assert.equal(await details.evaluate((node) => node.open), true);
        assert.equal(await summary.evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
        await page.keyboard.press("Tab");
        const copy = details.locator("button");
        assert.equal(await copy.evaluate((node) => node === document.activeElement), true);
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector("#error button[aria-label='Copied']"));
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), realDiagnostic);
        state.broadcast("progress");
        await page.waitForTimeout(100);
        assert.equal(await details.evaluate((node) => node.open), true, "background updates retain disclosure");
        assert.equal(await copy.evaluate((node) => node === document.activeElement), true, "background updates retain keyboard focus");
        await screenshot("analyzer-details");

        // Denied API + fallback is an explicit recovery failure, not loss of the original diagnostic.
        await page.evaluate(() => {
            window.savedClipboardWrite = navigator.clipboard.writeText;
            window.savedExecCommand = document.execCommand;
            navigator.clipboard.writeText = async () => { throw new Error("Deliberate clipboard denial"); };
            document.execCommand = () => false;
        });
        await copy.click();
        await panel.getByText(/Unable to copy text/).waitFor();
        assert.equal(await panel.locator("pre").textContent(), realDiagnostic);
        await page.evaluate(() => {
            navigator.clipboard.writeText = window.savedClipboardWrite;
            document.execCommand = window.savedExecCommand;
        });
        await page.route("**/api/refresh", (route) => route.fulfill({ status: 400,
            contentType: "application/json", body: JSON.stringify({ error: "Deliberate retry request failure" }) }));
        await retry.click();
        await panel.getByText(/Deliberate retry request failure/).waitFor();
        assert.equal(await panel.locator("pre").textContent(), realDiagnostic);
        await page.unroute("**/api/refresh");
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await screenshot("analyzer-details-narrow");
        const generation = state.reviewGeneration;
        await retry.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await retry.evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
        await page.keyboard.press("Enter");
        await page.waitForFunction(async (before) => {
            const snapshot = await (await fetch("/api/state")).json();
            return snapshot.review_generation > before && !snapshot.loading && snapshot.error;
        }, generation);
        await retry.waitFor();
        assert.equal(await panel.locator("pre").textContent(), state.error, "repeated failure reports the latest full diagnostic");
        state.worktreeBaseRef = "origin/main";
        await retry.click();
        await page.locator("#review-overview:not(.hidden)").waitFor({ timeout: 120000 });
        assert.equal(await panel.isVisible(), false);
        assert.ok(state.model.changes.some((file) => file.status !== "unchanged"), "recovery loaded real saved changes");
        await screenshot("analyzer-recovered");

        const saved = state.model;
        const warnings = [...saved.warnings];
        // A controlled C# boundary failure tests classification without corrupting installed binaries.
        state.runAnalyzer = async () => { throw new Error(diagnostic); };
        await assert.rejects(state.refresh(), { message: diagnostic });
        await panel.getByText("The C# helper couldn't start on this machine.", { exact: true }).waitFor();
        await panel.getByText(/previous saved review/).waitFor();
        assert.equal(state.model, saved);
        assert.deepEqual(state.model.warnings, warnings);
        await screenshot("analyzer-previous-review");
        state.runAnalyzer = runAnalyzer;
        // Failed picker analysis used to render the same raw diagnostic in two places.
        state.reviewTarget = { mode: "none", label: "Choose review target" };
        state.model = null;
        state.error = null;
        state.reviewCache.clear();
        state.broadcast("refreshed");
        await page.waitForFunction(() => document.querySelector("#review-mode").value === "");
        await page.locator("#review-picker-notice:not(.hidden)").waitFor();
        state.runAnalyzer = async () => { throw new Error(diagnostic); };
        await page.locator("#review-mode").selectOption("worktree");
        await panel.getByText("The C# helper couldn't start on this machine.", { exact: true }).waitFor();
        assert.equal(await page.locator("#review-picker-notice").isVisible(), false);
        assert.doesNotMatch(await page.locator("#review-picker-notice").textContent(), /BadImageFormatException/);
        assert.equal(await page.locator("pre").filter({ hasText: diagnostic }).count(), 1);
        assert.equal(await details.evaluate((node) => node.open), false);
        await screenshot("analyzer-picker-failed-narrow");
        await summary.focus();
        await page.keyboard.press("Enter");
        await copy.click();
        await page.waitForFunction(() => document.querySelector("#error button[aria-label='Copied']"));
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), diagnostic);
        assert.equal(await panel.locator("pre").textContent(), diagnostic);
        assert.equal(await panel.locator("complete").count(), 0, "diagnostics are text, never interpreted as markup");
        await screenshot("analyzer-csharp-details-narrow");
        state.runAnalyzer = runAnalyzer;
        await retry.click();
        await page.locator("#review-overview:not(.hidden)").waitFor({ timeout: 120000 });
        assert.equal(await panel.isVisible(), false, "Retry also recovers a failed target selection");
        assert.deepEqual(errors, []);
        console.log(`PASS ${theme}: real analyzer failure/recovery; full clipboard; denial visible; stable disclosure/focus; narrow; previous review/warnings; C# picker failure not duplicated`);
        await context.close();
        await server.close();
        server = null;
        await state.dispose();
        state = null;
    }
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(scratch, { recursive: true, force: true });
}
