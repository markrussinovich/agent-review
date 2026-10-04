import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const historicalModule = process.env.AGENT_REVIEW_NATIVE_MODULE_ROOT
    ? pathToFileURL(join(process.env.AGENT_REVIEW_NATIVE_MODULE_ROOT, "historical-sessions.mjs"))
    : new URL("../../historical-sessions.mjs", import.meta.url);
const { loadHistoricalSessionContexts } = await import(historicalModule);
const repo = process.env.AGENT_REVIEW_SAMPLE_REPO || "C:\\temp\\codereview-session-attribution";
const expectedSession = process.env.AGENT_REVIEW_SAMPLE_SESSION || "8171c583-5ea5-4836-b87d-60df0553aaff";
const config = await mkdtemp(join(tmpdir(), "sample-browser-config-"));
let server, browser;
try {
    const state = new ReviewState(repo, {
        baseRef: "HEAD", currentSessionId: "sample-browser-review",
        customPromptOptions: { globalDirectory: config },
        getSessionEvents: async () => [],
        getHistoricalSessionContexts: () => loadHistoricalSessionContexts(repo, "sample-browser-review"),
        generateAnnotation: async () => "## Summary\n\n- YAML configuration import.\n\n## Review order\n\n- Review config validation.\n\n## Gaps\n\n- Coverage unknown.",
        generatePackageExplanation: async () => "## Why it was added\n\n- YAML configuration validation.\n\n## What uses it\n\n- The configuration module.\n\n## Risks and alternatives\n\n- Verify input constraints.\n\n## Review checklist\n\n- Run configuration tests.",
    });
    await state.refresh();
    const packages = state.model.package_changes.filter((item) => ["pydantic", "pyyaml"].includes(item.name.toLowerCase()));
    assert.equal(packages.length, 2);
    for (const item of packages) {
        assert.equal(item.change, "added");
        assert.ok(item.usage_locations.some((location) => location.startsWith("src/workflow_service/config.py:")),
            `${item.name} has an actual source import, not just a manifest declaration`);
        state.packageAssessments.set(`${item.name}@${item.resolved_current}`, {
            name: item.name, version: item.resolved_current,
            risk: { level: "unknown", score: 0, reasons: ["Public indicators are stubbed for this UI regression."] },
            sources: {}, indicators: {},
        });
    }
    state.refreshHistoricalSessionContexts();
    await state.historicalContextPromise;
    const attribution = state.attributionForPath("src/workflow_service/config.py");
    assert.equal(attribution[0]?.session_id, expectedSession, state.sessionContext?.history_error || "Wrong originating session");
    assert.match(attribution[0].prompt, /yaml|configuration/i);
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
    for (const item of packages) {
        await page.locator("#packages .review-card").filter({ hasText: new RegExp(item.name, "i") }).click();
        await page.locator("#package-detail .usage-list").waitFor();
        assert.match(await page.locator("#package-detail").textContent(), /Python import locations \([1-9]/);
        await page.locator("#package-detail .usage-list .source-reference").first().click();
        await page.waitForFunction((expected) => document.querySelector("#source-title").textContent === expected, item.usage_locations[0]);
        await page.locator("#source-provenance .provenance-prompt").first().waitFor();
        assert.equal(await page.locator("#source-provenance .provenance-prompt").first().textContent(), attribution[0].original_prompt || attribution[0].prompt);
        await page.locator("#source-provenance").getByRole("button", { name: "Open session history" }).first().click();
        await page.locator("#session-history-panel .history-highlight").waitFor();
        assert.match(await page.locator("#session-history-meta").textContent(), /codereview-session-attribution/);
        await page.click("#session-history-close");
        await page.click("#source-close");
    }
    assert.deepEqual(errors, []);
    console.log(`PASS sample: two real package imports and source links; genuine originating session ${expectedSession}; transcript navigation`);
} finally {
    await browser?.close();
    await server?.close();
    await rm(config, { recursive: true, force: true });
}
