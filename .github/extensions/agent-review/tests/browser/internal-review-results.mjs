import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";
import { openChangeDetails } from "./review-details-helper.mjs";

// Use an actual changed checkout and the production analyzer/pipeline, with a controlled AI provider.
const repo = resolve(process.env.AGENT_REVIEW_UX_REPO || process.cwd());
const scratch = await mkdtemp(join(tmpdir(), "internal-review-results-"));
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
let browser, server, state, mode = "empty", calls = 0, emitted = false;
const generate = async (context, { signal }) => {
    calls++;
    if (mode === "hold") {
        await new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    }
    const response = { completed: context.units.map((unit) => unit.id), observations: [], findings: [],
        unresolved: [], requests: [] };
    if (context.phase === "verify") {
        response.decisions = context.candidates.map((candidate) => ({
            id: candidate.id, verdict: "supported", title: candidate.title, detail: candidate.detail,
            reason: "The cited saved source line is present.", citations: candidate.citations,
        }));
    } else {
        // Deliberately omit one receipt: full file supply is not full analysis.
        response.completed = response.completed.slice(1);
        if (mode === "findings" && !emitted) {
            emitted = true;
            const evidence = context.evidence.find((item) => item.side === "current" && item.lines.length >= 9);
            assert.ok(evidence, "the real review supplies at least nine source lines");
            response.findings = evidence.lines.slice(0, 9).map((line, index) => ({
                title: `Saved source observation ${index + 1}`, detail: `Inspect the supplied source: ${line.text}`,
                category: `browser-observation-${index}`, severity: "low", confidence: 0.9,
                citations: [{ evidence_id: evidence.id, line: line.line }],
            }));
        }
    }
    return response;
};

try {
    state = new ReviewState(repo, {
        baseRef: process.env.AGENT_REVIEW_UX_BASE || "HEAD",
        reviewDirectory: join(scratch, "reviews"),
        customPromptOptions: { globalDirectory: join(scratch, "prompts") },
        reviewLimits: { maxRequests: 12 },
    });
    await state.refresh();
    await state.decisionPromise;
    assert.ok(state.model, state.error);
    const changedFiles = state.model.changes.filter((change) => change.status !== "unchanged").length;
    assert.ok(changedFiles, "use a real checkout with uncommitted changes or set AGENT_REVIEW_UX_BASE");
    assert.ok(state.ruleCheck?.sources?.length, "the real repository must contain applicable instruction files");
    state.generateReviewPass = generate;
    await state.runRuleCheck({ force: true });
    assert.equal(state.ruleCheck.status, "partial");
    assert.equal(state.ruleCheck.findings.length, 0);
    assert.match(state.ruleCheck.content, /No supported findings so far/);
    const prompt = await state.promptStore().save({ scope: "global", title: "Saved source check",
        prompt: "Inspect the supplied saved source.", enabled: true });
    const customInput = { scope: prompt.scope, id: prompt.id, force: true };
    await state.runCustomAnalyses(customInput);
    server = await startReviewServer(state);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync) });

    for (const theme of ["light", "dark"]) {
        for (const width of [1280, 390]) {
            mode = "empty";
            await state.runRuleCheck({ force: true });
            await state.runCustomAnalyses(customInput);
            const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.stack));
            await page.goto(`${server.url}?scoutTheme=${theme}`);
            await openChangeDetails(page);
            const rules = page.locator(".rule-check");
            await rules.locator(".internal-review-notice").waitFor();
            assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
            const checkNotice = async (scope) => {
                const body = scope.locator(":scope > .annotation-body");
                const text = await body.textContent();
                assert.match(text, /Results incomplete.*not a clean bill of health/);
                assert.match(text, new RegExp(`analyzed ${state.ruleCheck.coverage.completed_files} of ${state.ruleCheck.coverage.total_files} changed files`));
                assert.doesNotMatch(text, /completed analysis/);
            };
            await checkNotice(rules);
            assert.match(await rules.textContent(), /No supported findings so far/);
            const custom = page.locator(".custom-result").filter({ hasText: "Saved source check" });
            await custom.locator(":scope > summary").click();
            await custom.locator(".internal-review-notice").waitFor();
            assert.match(await custom.locator(".annotation-body").textContent(), /Results incomplete.*No supported findings so far/);
            if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
                await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `internal-review-empty-${theme}-${width}.png`), fullPage: true });
            }
            const before = calls;
            await rules.getByRole("button", { name: "Continue review" }).focus();
            await page.keyboard.press("Tab");
            await page.keyboard.press("Shift+Tab");
            assert.ok(await rules.getByRole("button", { name: "Continue review" }).evaluate((button) => button === document.activeElement));
            assert.equal(await rules.getByRole("button", { name: "Continue review" }).evaluate((button) => getComputedStyle(button).outlineStyle), "solid");
            await Promise.all([
                page.waitForResponse((response) => response.url().endsWith("/api/rule-check")
                    && response.request().method() === "POST"),
                page.keyboard.press("Enter"),
            ]);
            await page.waitForFunction(() => document.querySelector(".rule-check .custom-status")?.textContent === "partial");
            assert.ok(calls > before, "keyboard continuation invokes the bounded production pipeline");

            mode = "findings";
            emitted = false;
            await state.runRuleCheck({ force: true });
            emitted = false;
            await state.runCustomAnalyses(customInput);
            await page.waitForFunction(() => document.querySelector(".rule-check")?.textContent.includes("All 9 findings")
                && document.querySelector(".custom-result")?.textContent.includes("All 9 findings")
                && document.querySelector(".custom-result .custom-status")?.textContent === "partial");
            await checkNotice(rules);
            const all = rules.locator("details").filter({ has: page.getByText("All 9 findings", { exact: true }) });
            await all.locator(":scope > summary").click();
            assert.equal(await all.locator(".internal-review-notice").isVisible(), true);
            assert.equal(await all.locator(":scope > ul > li").count(), 9);
            assert.match(await custom.locator(":scope > .annotation-body").textContent(), /Results incomplete.*Saved source observation/);
            const customAll = custom.locator("details").filter({ has: page.getByText("All 9 findings", { exact: true }) });
            await customAll.locator(":scope > summary").click();
            assert.equal(await customAll.locator(".internal-review-notice").isVisible(), true);
            await all.locator("button").first().click();
            await page.locator("#source .code-row").first().waitFor();
            await page.locator("#source-close").click();
            await openChangeDetails(page);
            await checkNotice(rules);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
            if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
                await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `internal-review-${theme}-${width}.png`), fullPage: true });
            }

            mode = "hold";
            const running = state.runRuleCheck({ force: true });
            await page.waitForFunction(() => document.querySelector(".rule-check")?.textContent.includes("Stop AI review"));
            await page.waitForFunction(() => document.querySelector(".rule-check .internal-review-notice")?.textContent.includes("Review in progress"));
            await rules.getByRole("button", { name: "Stop AI review" }).focus();
            await page.keyboard.press("Enter");
            await running;
            await page.waitForFunction(() => document.querySelector(".rule-check .internal-review-notice")?.textContent.includes("Review stopped"));
            assert.equal(state.ruleCheck.status, "cancelled");
            const stoppedCalls = calls;
            await page.waitForTimeout(250);
            assert.equal(calls, stoppedCalls, "a requested stop never auto-restarts");
            assert.match(await rules.textContent(), /No supported findings so far/);
            const customRunning = state.runCustomAnalyses(customInput);
            await page.waitForFunction(() => document.querySelector(".custom-result .internal-review-notice")?.textContent.includes("Review in progress"));
            await custom.getByRole("button", { name: "Stop AI review" }).focus();
            await page.keyboard.press("Enter");
            await customRunning;
            await page.waitForFunction(() => document.querySelector(".custom-result .internal-review-notice")?.textContent.includes("Review stopped"));
            const customStoppedCalls = calls;
            await page.waitForTimeout(250);
            assert.equal(calls, customStoppedCalls, "a stopped custom check never auto-restarts");
            // Baseline startup race is separately owned: approved prompts may arrive before /api/state.
            const baselineErrors = errors.filter((stack) => /^TypeError: Cannot read properties of null \(reading 'loading'\)\n\s+at renderCustomAnalyses .*\/app.js:\d+:\d+\)\n\s+at loadCustomPrompts .*\/app.js:\d+:\d+\)$/.test(stack));
            assert.deepEqual(errors.filter((stack) => !baselineErrors.includes(stack)), []);
            if (baselineErrors.length) console.log(`BASELINE startup limitation: ${baselineErrors[0].split("\n")[0]}`);
            await page.close();
            console.log(`PASS ${theme} ${width}px: real ${changedFiles}-changed-file review (${state.model.changes.length} saved paths), incomplete empty/full findings, citations, keyboard continue/stop`);
        }
    }

    // Acknowledge every supplied unit for the complete-state check.
    state.generateReviewPass = async (context) => ({ completed: context.units.map((unit) => unit.id),
        observations: [], findings: [], unresolved: [], requests: [] });
    const sources = state.ruleCheck.sources;
    state.ruleCheck = { ...await state.internalReview("Inspect all saved source.", { force: true }),
        sources };
    assert.equal(state.ruleCheck.status, "complete");
    state.broadcast("rule-check");
    await state.runCustomAnalyses(customInput);
    const page = await browser.newPage();
    await page.goto(server.url);
    await openChangeDetails(page);
    await page.locator(".rule-check .annotation-body").waitFor();
    assert.equal(await page.locator(".rule-check .internal-review-notice").count(), 0);
    assert.match(await page.locator(".rule-check .annotation-body").textContent(), /No supported findings\./);
    const custom = page.locator(".custom-result").filter({ hasText: "Saved source check" });
    await custom.locator(":scope > summary").click();
    assert.equal(await custom.locator(".internal-review-notice").count(), 0);
    assert.match(await custom.locator(".annotation-body").textContent(), /No supported findings\./);
    console.log("PASS complete review preserves its existing empty-findings wording");
    await page.close();
} finally {
    await browser?.close();
    await server?.close();
    state?.dispose();
    await rm(scratch, { recursive: true, force: true });
}
