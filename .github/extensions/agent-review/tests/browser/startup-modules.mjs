import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const repo = process.env.AGENT_REVIEW_UX_REPO;
if (!repo) throw new Error("Set AGENT_REVIEW_UX_REPO to a real Git repository.");
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const execute = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), "review-module-startup-"));
const source = new URL("../../", import.meta.url);
const oldSource = async (name) => (await execute("git", ["show",
    `4f0a67c:.github/extensions/agent-review/${name}`], { cwd: new URL("../../../../..", import.meta.url) })).stdout;
const missingModules = ["impact-model.mjs", "item-discussion-ui.mjs", "ai-activity.mjs",
    "review-location.mjs", "review-presentation.mjs", "review-workspace.mjs"];
let browser, state, currentServer, legacyServer, updatedServer;
try {
    state = new ReviewState(repo, { baseRef: "HEAD", readWorktreeFingerprint: null,
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        customPromptOptions: { globalDirectory: join(scratch, "prompts") } });
    await state.refresh();
    assert.equal(state.error, null);
    assert.equal(state.model.metadata.repo_root, repo, "use production analysis of the named real repository");
    await state.promptStore().save({ scope: "global", title: "Approved startup check",
        prompt: "Review the supplied saved source.", enabled: true });
    await cp(source, join(scratch, "legacy"), { recursive: true,
        filter: (path) => !/(?:^|[\\/])(?:node_modules|tests|bin|obj|__pycache__)(?:[\\/]|$)/.test(path) });
    let legacy = await oldSource("server.mjs");
    for (const name of missingModules) legacy = legacy.replace(`    ["/${name}", "${name}"],\n`, "");
    await writeFile(join(scratch, "legacy", "server.mjs"), legacy);
    await writeFile(join(scratch, "legacy", "web", "app.js"), await oldSource("web/app.js"));
    const oldProvider = await import(pathToFileURL(join(scratch, "legacy", "server.mjs")).href);
    legacyServer = await oldProvider.startReviewServer(state);
    browser = await chromium.launch({ headless: true,
        executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    const original = await browser.newPage();
    const missing = [];
    original.on("response", (response) => {
        if (response.status() === 404) missing.push(new URL(response.url()).pathname.slice(1));
    });
    await original.goto(legacyServer.url);
    await original.waitForTimeout(500);
    assert.equal(await original.locator("#status").textContent(), "Connecting", "original static imports never initialize");
    for (const name of missingModules) assert.ok(missing.includes(name), `original failure includes ${name}`);
    await original.close();

    // Keep the old provider running while updating only its source web files.
    await cp(new URL("../../web/", import.meta.url), join(scratch, "legacy", "web"), { recursive: true });
    currentServer = await startReviewServer(state);
    await cp(source, join(scratch, "updated"), { recursive: true,
        filter: (path) => !/(?:^|[\\/])(?:node_modules|tests|bin|obj|__pycache__)(?:[\\/]|$)/.test(path) });
    const updatedProvider = await import(pathToFileURL(join(scratch, "updated", "server.mjs")).href);
    updatedServer = await updatedProvider.startReviewServer(state);
    await writeFile(join(scratch, "updated", "web", "after-pull.mjs"), "export const addedAfterPull = true;\n");
    const screenshot = async (page, name) => {
        if (!process.env.AGENT_REVIEW_SCREENSHOT_DIR) return;
        await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `${name}.png`), fullPage: true });
    };
    for (const theme of ["light", "dark"]) {
        for (const width of [1280, 460]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${legacyServer.url}?scoutTheme=${theme}`);
            await page.locator("#error").waitFor({ state: "visible" });
            assert.equal(await page.locator("#status").textContent(), "Startup failed");
            assert.match(await page.locator("#error").textContent(), /Reload extensions.*same session/);
            assert.match(await page.locator("#error").textContent(), /no reload-extensions action.*original installation method/);
            assert.match(await page.locator("#error").textContent(), /do not restart an old provider/);
            assert.equal(await page.locator("#error details").getAttribute("open"), null);
            assert.ok(await page.locator("#error pre").textContent());
            assert.equal(await page.locator("#refresh").isDisabled(), true);
            await page.locator("#error button").focus();
            assert.ok(await page.locator("#error button").evaluate((button) => button.matches(":focus-visible")));
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement.tagName), "SUMMARY");
            await page.keyboard.press("Enter");
            assert.equal(await page.locator("#error details").getAttribute("open"), "");
            await page.keyboard.press("Enter");
            assert.equal(await page.locator("#error details").getAttribute("open"), null);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "narrow failure page fits");
            await screenshot(page, `legacy-module-failure-${theme}-${width}`);
            await page.locator("#error button").click();
            await page.locator("#error").waitFor({ state: "visible" });
            assert.equal(await page.locator("#status").textContent(), "Startup failed", "Retry page does not pretend to restart the provider");
            await page.goto(`${updatedServer.url}?scoutTheme=${theme}`);
            await page.locator("#error").waitFor({ state: "visible" });
            assert.equal(await page.locator("#status").textContent(), "Update requires reload");
            assert.match(await page.locator("#error pre").textContent(), /Loaded provider: [a-f0-9]{64}\nUpdated source: [a-f0-9]{64}/);
            await screenshot(page, `provider-source-mismatch-${theme}-${width}`);
            await page.goto(`${currentServer.url}?scoutTheme=${theme}`);
            try {
                await page.waitForFunction(() => ["Analysis current", "No changes", "Worktree changed", "Freshness unknown"]
                    .includes(document.querySelector("#status")?.textContent));
            } catch (error) {
                throw new Error(`Current-provider recovery failed: ${await page.locator("#status").textContent()}; ${
                    await page.locator("#error").textContent()}; browser errors: ${errors.join(" | ")}`, { cause: error });
            }
            assert.equal(await page.locator("#error").isVisible(), false, "a current provider recovers the real review");
            assert.ok(await page.locator("#repository-identity").textContent());
            assert.deepEqual(errors, []);
            await screenshot(page, `startup-recovered-${theme}-${width}`);
            await page.close();
        }
        const stalled = await browser.newPage();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        await stalled.route("**/impact-model.mjs", async (route) => { await gate; await route.continue(); });
        await stalled.goto(`${currentServer.url}?scoutTheme=${theme}`, { waitUntil: "domcontentloaded" });
        await stalled.locator("#error").waitFor({ state: "visible", timeout: 15000 });
        assert.equal(await stalled.locator("#status").textContent(), "Startup failed");
        assert.match(await stalled.locator("#error pre").textContent(), /exceeded 10 seconds/);
        release();
        await stalled.waitForTimeout(300);
        assert.equal(await stalled.locator("#status").textContent(), "Startup failed", "late imports cannot overwrite a timed-out startup");
        await stalled.close();
        const promptFirst = await browser.newPage();
        const promptErrors = [];
        promptFirst.on("pageerror", (error) => promptErrors.push(error.message));
        let releaseState;
        const stateGate = new Promise((resolve) => { releaseState = resolve; });
        for (const path of ["api/state", "events"]) {
            await promptFirst.route(`**/${path}`, async (route) => { await stateGate; await route.continue(); });
        }
        await promptFirst.goto(`${currentServer.url}?scoutTheme=${theme}`, { waitUntil: "domcontentloaded" });
        await promptFirst.waitForFunction(() => document.querySelector("#custom-results .custom-result"));
        assert.equal(await promptFirst.locator("#custom-results .custom-result > button").isDisabled(), true,
            "an approved prompt returned before review state cannot run yet");
        assert.deepEqual(promptErrors, [], "custom prompts arriving before state do not dereference null");
        releaseState();
        await promptFirst.waitForFunction(() => ["Analysis current", "No changes", "Worktree changed", "Freshness unknown"]
            .includes(document.querySelector("#status")?.textContent));
        assert.deepEqual(promptErrors, []);
        await promptFirst.close();
        console.log(`PASS ${theme}: actual stale provider/source update, build mismatch, timeout, narrow keyboard disclosure, page retry, and current-provider recovery for ${repo}`);
    }
    console.log(JSON.stringify({ repository: repo, base: state.model.metadata.base_sha,
        head: state.model.metadata.head_sha, changed_files: state.model.changes.filter((file) => file.status !== "unchanged").length,
        original_missing_modules: missing, legacy_provider_restarted: false }));
} finally {
    await browser?.close();
    await currentServer?.close();
    await legacyServer?.close();
    await updatedServer?.close();
    await state?.dispose();
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
