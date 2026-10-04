import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
let summaries = 0;
const state = new ReviewState(process.env.AGENT_REVIEW_FINDINGS_REPO || "C:\\temp\\codereview-session-attribution", {
    generateAnnotation: async (context) => {
        if (context.kind === "overview") {
            summaries += 1;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return "## Summary\n\n- Health diagnostics.\n\n## Review order\n\n- Review the checks.\n\n## Gaps\n\n- Verify edge cases.";
    },
});
await state.setReviewTarget({ mode: "commit", ref: process.env.AGENT_REVIEW_FINDINGS_COMMIT || "92e0729" });
const module = state.model.nodes.find((node) => node.name === "tests.test_health");
assert.ok(module);
const component = state.model.nodes.find((node) => node.id === module.component_id);
const findings = state.model.attention.filter((finding) => {
    const node = state.model.nodes.find((item) => item.id === finding.node_id);
    return node && (node.id === module.id || node.module_id === module.id);
});
console.log("HEALTH FINDINGS", JSON.stringify(findings.map((finding) => ({ title: finding.title, type: finding.type,
    subject: state.model.nodes.find((node) => node.id === finding.node_id)?.name }))));
const server = await startReviewServer(state);
const executablePath = process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);
const browser = await chromium.launch({ headless: true, executablePath });
try {
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.locator("#change-brief .brief-ai").waitFor();
        assert.equal(await page.getByText("Highest-impact areas", { exact: true }).count(), 0);
        assert.ok(await page.evaluate(() => document.querySelector("#change-brief").getBoundingClientRect().top
            < document.querySelector("#summary").getBoundingClientRect().top));
        await page.locator(`.node[aria-label^="${component.name},"]`).click();
        const tile = page.locator(`.node[aria-label^="${module.name},"]`);
        assert.equal(await tile.locator(".attention-count").textContent(), "2");
        await tile.click();
        assert.equal(await page.locator(".scope-finding").count(), 2);
        assert.match(await page.locator(".scope-findings").textContent(), /module-level/);
        const subjectRow = page.locator(".scope-finding").filter({ hasText: "WorkflowHealthInspectorTests" });
        assert.equal(await subjectRow.count(), 1);
        const moduleRow = page.locator(".scope-finding").filter({ hasText: "module-level" });
        for (const row of [moduleRow, subjectRow]) {
            await row.click();
            await page.waitForFunction(() => !document.querySelector("#source-panel").classList.contains("hidden"));
            assert.match(await page.locator("#source-title").textContent(), /tests\/test_health.py/);
            await page.click("#source-close");
        }
        const first = page.locator("#attention .queue-item").first();
        const id = await first.getAttribute("data-item-id");
        await first.locator(".queue-toggle").click();
        const closed = page.locator("#attention .queue-item.is-closed");
        assert.ok(await closed.count());
        assert.equal(await page.locator("#attention .queue-item").last().getAttribute("data-item-id"), id);
        assert.equal(await closed.locator(".queue-toggle").textContent(), "Reopen");
        assert.equal(await page.locator("#source-panel").isVisible(), false, "closing a finding must not open source");
        const generated = summaries;
        await page.reload();
        await page.locator("#change-brief .brief-ai").waitFor();
        assert.equal(await page.locator("#attention .queue-item.is-closed").last().getAttribute("data-item-id"), id);
        assert.equal(summaries, generated, "reload uses cached summary");
        await page.locator("#attention .queue-item.is-closed .queue-toggle").click();
        assert.equal(await page.locator("#attention .queue-item.is-closed").count(), 0);
        await page.click("#refresh");
        await page.waitForFunction(() => document.querySelector("#status").textContent === "Analysis current");
        await page.locator("#change-brief .brief-ai").waitFor();
        assert.equal(summaries, generated + 1, "refresh automatically regenerates summary");
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}: badge 2 = scoped list 2, both findings open source, top automatic brief, close/reopen moves and persists, summary refresh`);
    }
} finally {
    await browser.close();
    await server.close();
}
