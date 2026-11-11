import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewState, runAnalyzerProcess } from "../../review-state.mjs";
import { buildSessionContext } from "../../session-context.mjs";
import { startReviewServer } from "../../server.mjs";

const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const repo = resolve(process.env.AGENT_REVIEW_INTENT_REPO || process.cwd());
const screenshots = process.env.AGENT_REVIEW_BROWSER_ARTIFACTS;
const path = "README.md";
const privatePrompt = "Land the fix once you have confidence.";
const authorPrompt = "Require visible edits for review intent.";
let state, server, browser;
try {
    state = new ReviewState(repo, {
        baseRef: process.env.AGENT_REVIEW_UX_BASE || "HEAD",
        runAnalyzer: (root, base, progress, current, options) => runAnalyzerProcess("python", [
            fileURLToPath(new URL("../../analyzer/analyze.py", import.meta.url)),
            "--repo", root, "--base-ref", base,
            "--exclude", "test-repos", "--exclude", "fixtures", "--exclude", "dotnet-analyzer",
        ], progress, options),
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        generateAnnotation: async (context) => {
            assert.ok(!JSON.stringify(context).includes(privatePrompt), "unrelated triage is not sent to the explanation provider");
            return "## What changed\n\n- Review purpose requires visible edits to the selected file.\n\n"
                + "## Risk and review focus\n\n- Verify the snapshot cutoff.\n\n## Evidence and gaps\n\n- Intent does not prove authorship.";
        },
    });
    await state.refresh();
    await state.historicalContextPromise;
    const item = { name: path };
    assert.ok(state.model.changes.some((change) => change.path === path && change.status !== "unchanged"),
        "select actual analyzed repository changes, not a fixture");
    const time = Date.parse(state.lastAnalyzedAt);
    const stamp = (offset) => new Date(time + offset).toISOString();
    const history = (authored) => {
        const context = buildSessionContext([
            { id: "triage", type: "user.message", timestamp: stamp(-6000), data: { content: privatePrompt } },
            { id: "read", type: "tool.execution_start", timestamp: stamp(-5000),
                data: { toolName: "view", arguments: { path } } },
            ...(authored ? [
                { id: "author", type: "user.message", timestamp: stamp(-4000), data: { content: authorPrompt } },
                { id: "edit", type: "tool.execution_start", timestamp: stamp(-3000),
                    data: { toolName: "apply_patch", arguments: { patch: `*** Update File: ${path}\n+saved change` } } },
            ] : []),
            { id: "future", type: "user.message", timestamp: stamp(-2000), data: { content: "Fix another issue in README.md." } },
            { id: "future-edit", type: "tool.execution_start", timestamp: stamp(1000),
                data: { toolName: "apply_patch", arguments: { path } } },
        ], repo);
        context.historical_search_complete = true;
        return context;
    };
    state.refreshHistoricalSessionContexts = () => null;
    server = await startReviewServer(state);
    assert.equal((await fetch(new URL("/api/state", server.url))).status, 200);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync) });
    for (const authored of [false, true]) {
        state.sessionContext = history(authored);
        state.annotations = {};
        const snapshot = await fetch(new URL("/api/state", server.url)).then((response) => response.json());
        assert.equal(snapshot.session_context.historical_search_complete, true);
        assert.ok(!JSON.stringify(snapshot).includes(privatePrompt), "default browser snapshots omit raw session prompts");
        const expected = authored ? [authorPrompt] : [];
        assert.deepEqual(state.overviewContext().session_intent, expected);
        const provenance = await fetch(new URL(`/api/attribution?path=${encodeURIComponent(path)}`, server.url)).then((response) => response.json());
        assert.equal(provenance.status, authored ? "matched" : "no_match");
        assert.ok(!JSON.stringify(provenance).includes(privatePrompt));
        for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
            state.selection = null;
            const page = await browser.newPage({ viewport: { width, height: 844 } });
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${server.url}?scoutTheme=${theme}`);
            await page.locator("#overview-start").click();
            await page.keyboard.press("Control+k");
            await page.locator("#review-command-query").fill(item.name);
            const attributionResponse = page.waitForResponse((response) => response.url().includes("/api/attribution?"));
            await page.locator("#review-command-results button").first().click();
            await (await attributionResponse).finished();
            await page.locator("#source .code-row").first().waitFor({ state: "attached" });
            if (await page.locator("#workspace-context").isVisible()) await page.locator("#workspace-context").click();
            const origin = page.locator("#source-origin");
            await page.waitForFunction((text) => document.querySelector("#source-provenance").textContent.includes(text),
                authored ? authorPrompt : "Origin unknown");
            await origin.locator(":scope > summary").focus();
            if (await origin.evaluate((node) => node.open)) {
                await page.keyboard.press("Enter");
                await page.waitForFunction(() => !document.querySelector("#source-origin").open);
            }
            await page.keyboard.press("Enter");
            await page.waitForFunction(() => document.querySelector("#source-origin").open);
            const panel = page.locator("#source-provenance");
            if (authored) {
                await panel.locator(".provenance-prompt").first().waitFor();
                assert.equal(await panel.locator(".provenance-prompt").first().textContent(), authorPrompt);
                assert.match(await panel.textContent(), /likely match|write\/edit activity/);
            } else {
                await panel.getByText(/Origin unknown/).waitFor();
                assert.equal(await panel.locator(".provenance-prompt").count(), 0);
            }
            assert.ok(!(await panel.textContent()).includes(privatePrompt));
            assert.ok(!(await panel.textContent()).includes("Fix another issue"));
            assert.ok(await origin.locator(":scope > summary").evaluate((node) => node === document.activeElement));
            if (screenshots) {
                await mkdir(screenshots, { recursive: true });
                await page.screenshot({ path: join(screenshots, `intent-${authored ? "author" : "unknown"}-${theme}-${width}.png`) });
            }
            assert.deepEqual(errors, []);
            await page.close();
            console.log(`PASS ${authored ? "author" : "unknown"} ${theme}/${width}: real repository source, edit-backed provenance, cutoff and keyboard disclosure`);
        }
    }
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
}
