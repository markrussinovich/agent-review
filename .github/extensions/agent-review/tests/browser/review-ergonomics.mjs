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
const repo = await mkdtemp(join(tmpdir(), "review-ergonomics-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
let server, browser, state;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "core.autocrlf", "false");
    const lines = Array.from({ length: 300 }, (_, index) => `    value_${index + 1} = ${index + 1}`);
    const module = (edit) => ["def build():", ...edit(lines), "    return value_1", ""].join("\n");
    await writeFile(join(repo, "AGENTS.md"), ["# Rules", "Keep one entry point.", "", "## Parity", "Mirror CLI and WebUI.", "Share checker logic.", ""].join("\n"));
    await writeFile(join(repo, "worker.py"), module((source) => source));
    await git("add", ".");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "worker.py"), module((source) => source.map((line, index) =>
        index === 149 ? "    value_150 = 'changed'" : index === 289 ? "    value_290 = 'changed'" : line)));
    await git("commit", "-qam", "Change two values");
    let releaseOverview;
    const overviewGate = new Promise((resolve) => { releaseOverview = resolve; });
    state = new ReviewState(repo, {
        readWorktreeFingerprint: null,
        generateAnnotation: async (context) => {
            if (context.kind === "overview") await overviewGate;
            return context.kind === "overview"
                ? "## Summary\n\n- Two values change.\n\n## Review order\n\n- `worker.py`.\n\n## Gaps\n\n- None."
                : "## What this code is\n\n- A builder.";
        },
        generateCustomAnalysis: async () => "## Findings\n\nNo supported findings.\n\n## Verification\n\n"
            + "- Entry point is Satisfied (`AGENTS.md:2`, `worker.py:150`).\n- Parity is Not verifiable (`AGENTS.md:4-6`).",
    });
    await state.setReviewTarget({ mode: "commit", ref: "HEAD" });
    await state.runRuleCheck();
    server = await startReviewServer(state);
    const executablePath = process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        if (theme === "light") {
            const pending = page.locator("#change-brief .ai-pending");
            await pending.waitFor();
            assert.match(await pending.textContent(), /Copilot is summarizing the whole change/);
            assert.equal(await pending.locator(".ai-pending-line").count(), 4, "the placeholder previews the result's shape");
            releaseOverview();
            await page.locator("#change-brief .brief-ai.ai-reveal").waitFor();
            assert.equal(await page.locator("#change-brief .ai-pending").count(), 0);
        } else {
            await page.locator("#change-brief .brief-ai").waitFor();
            assert.equal(await page.locator("#change-brief .brief-ai.ai-reveal").count(), 0, "results already present do not re-animate");
        }

        const rules = page.locator("#change-brief .rule-check");
        assert.equal(await rules.locator(".rule-rerun").textContent(), "Check again");
        const savedContent = state.ruleCheck.content;
        let releaseRules;
        state.generateCustomAnalysis = () => new Promise((resolve) => { releaseRules = resolve; });
        const checkingRules = state.runRuleCheck({ force: true });
        await rules.locator(".ai-pending").waitFor();
        assert.equal(await rules.locator(".rule-rerun").count(), 0, "no redundant action while the automatic check is running");
        releaseRules(savedContent);
        await checkingRules;
        await rules.locator(".rule-rerun").waitFor();
        assert.equal(await rules.locator(".rule-rerun").textContent(), "Check again");
        assert.match(await rules.locator(".rule-sources").textContent(), /AGENTS\.md applies to 1 changed file · 2 cited sections/);
        await rules.locator(".rule-source-link").click();
        await page.waitForFunction(() => document.querySelector("#source-title").textContent === "AGENTS.md");
        assert.deepEqual(await page.locator("#source .cited-line").evaluateAll((rows) => rows.map((row) => row.dataset.newLine)),
            ["2", "4", "5", "6"], "every cited section is highlighted");
        assert.equal(await page.locator("#source .cited-start").count(), 2);
        await page.click("#source-close");

        await page.locator("#summary .metric").filter({ hasText: "Files" }).click();
        await page.locator(".collection-row").filter({ hasText: "worker.py" }).click();
        await page.waitForFunction(() => document.querySelector("#source-title").textContent === "worker.py");
        assert.equal(await page.locator(".workspace").evaluate((node) => node.classList.contains("detail-collapsed")), true,
            "a file selection opens no redundant detail panel");
        const toggles = page.locator("#source .diff-gap-toggle");
        assert.deepEqual(await toggles.allTextContents(), [
            "▾Show 146 unchanged lines (1–146)", "▾Show 131 unchanged lines (156–286)", "▾Show 7 unchanged lines (296–302)"]);
        assert.equal(await page.locator('#source .code-row[data-new-line="100"]').count(), 0);
        await toggles.nth(0).click();
        assert.equal(await page.locator('#source .code-row[data-new-line="100"]').count(), 1);
        await page.locator("#source").evaluate((code) => { code.scrollTop = 600; });
        const before = await page.locator("#source").evaluate((code) => code.scrollTop);
        assert.ok(before > 0, "the expanded diff scrolls");
        await page.locator('#source [data-gap="156-286"]').evaluate((row) => row.click());
        assert.equal(await page.locator('#source .code-row[data-new-line="200"]').getAttribute("data-old-line"), "200",
            "expanded lines keep base and current numbers");
        assert.equal(await page.locator("#source").evaluate((code) => code.scrollTop), before, "expanding keeps the reader's place");
        assert.equal(await page.locator('#source [data-gap="156-286"]').getAttribute("aria-expanded"), "true");
        assert.match(await page.locator('#source [data-gap="156-286"]').textContent(), /Hide 131 unchanged lines/);
        await page.locator('#source [data-gap="156-286"]').focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.locator('#source .code-row[data-new-line="200"]').count(), 0, "the region collapses again");
        assert.equal(await page.locator('#source [data-gap="156-286"]').evaluate((row) => row === document.activeElement), true,
            "focus stays on the toggle for keyboard users");

        await page.locator('.tab[data-tab="current"]').click();
        const ruler = page.locator("#source-ruler");
        assert.equal(await ruler.isVisible(), true, "long files show a change ruler");
        const marks = await ruler.locator(".ruler-mark").evaluateAll((items) => items.map((mark) => mark.title));
        assert.deepEqual(marks, ["Changed lines at line 151", "Changed lines at line 291"]);
        const geometry = await page.evaluate(() => {
            const code = document.querySelector("#source");
            const bar = document.querySelector("#source-ruler").getBoundingClientRect();
            return { rulerRight: bar.right, codeRight: code.getBoundingClientRect().right, scrollbar: code.offsetWidth - code.clientWidth };
        });
        assert.ok(Math.abs(geometry.codeRight - geometry.scrollbar - geometry.rulerRight) < 1.5, `${theme}: ruler sits beside the scrollbar`);
        await page.locator("#source").evaluate((code) => { code.scrollTop = 0; });
        await ruler.locator(".ruler-mark").nth(1).click();
        assert.ok(await page.locator('#source .code-row[data-new-line="291"]').evaluate((row) => {
            const view = document.querySelector("#source").getBoundingClientRect();
            const box = row.getBoundingClientRect();
            return box.top >= view.top && box.bottom <= view.bottom;
        }), "clicking a mark brings that change into view");
        assert.match(await page.locator('#source .code-row[data-new-line="151"]').getAttribute("class"), /diff-modified/);

        await page.click("#source-close");
        assert.equal(await page.locator("#source-panel").isVisible(), false);
        assert.equal(await page.locator(".workspace").evaluate((node) => node.classList.contains("detail-collapsed")), true,
            "closing a file leaves no stale side panel");
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}: AI placeholder and reveal, cited rule sections, gap expand/collapse, change ruler, file panel cleanup`);
    }
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
