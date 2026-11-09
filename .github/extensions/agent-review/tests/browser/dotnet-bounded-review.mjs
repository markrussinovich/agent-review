import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ReviewState, runDecisionExtractor } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";
import { impactSlice } from "../../web/impact-model.mjs";
import { reviewContext } from "../../web/review-presentation.mjs";
import { openChangeDetails, openReviewTool } from "./review-details-helper.mjs";

const repo = process.env.AGENT_REVIEW_UX_REPO;
const base = process.env.AGENT_REVIEW_BASE_REF;
const head = process.env.AGENT_REVIEW_CURRENT_REF;
const screenshots = process.env.AGENT_REVIEW_SCREENSHOT_DIR;
const savedRequest = process.env.AGENT_REVIEW_DOTNET_SAVED_REQUEST;
const savedModel = process.env.AGENT_REVIEW_DOTNET_MODEL;
const snapshotSource = savedModel ? "Saved analyzer DTO; compiler and full Git loader not rerun"
    : savedRequest ? "Saved Git-tree replay; full Git loader not exercised" : "Production Git loader";
const execute = promisify(execFile);
if (!repo || !base || !head || !screenshots)
    throw new Error("Set AGENT_REVIEW_UX_REPO, AGENT_REVIEW_BASE_REF, AGENT_REVIEW_CURRENT_REF and AGENT_REVIEW_SCREENSHOT_DIR to pinned real-repository inputs.");
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
let state, server, browser;
const started = performance.now();
try {
    state = new ReviewState(repo, { baseRef: base,
        reviewTarget: { mode: "commit", label: "Pinned real C# review", currentRef: head },
        workspacePath: screenshots,
        currentSessionId: "bounded-dotnet-regression",
        runDecisions: runDecisionExtractor,
        ...(savedModel ? { runAnalyzer: async () => JSON.parse(await readFile(savedModel, "utf8")) }
            : savedRequest ? { runAnalyzer: async () => {
            const result = await execute(process.env.AGENT_REVIEW_PYTHON || "python", [
                fileURLToPath(new URL("../dotnet_saved_review.py", import.meta.url)), savedRequest, repo, base, head,
            ], { maxBuffer: 256 * 1024 * 1024, timeout: 180_000 });
            await mkdir(screenshots, { recursive: true });
            await writeFile(join(screenshots, "real-csharp-model.json"), result.stdout);
            return JSON.parse(result.stdout);
        } } : {}),
        getSessionEvents: async () => [],
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        generateAnnotation: async () => "## AI interpretation\n\nInspect the saved C# change and source-backed relationships.\n\n## Gaps\n\nStatic analysis is incomplete; no reviewed code was executed.",
    });
    await state.refresh();
    assert.equal(state.error, null);
    const elapsed = Math.round(performance.now() - started);
    const model = state.model;
    assert.equal(model.metadata.head_sha, head);
    assert.equal(model.metadata.base_sha, base);
    await new Promise((resolve) => setImmediate(resolve));
    const map = await state.decisionMapFor(120_000);
    assert.equal(map?.status, "complete", map?.error || "Decision extraction must be scheduled before awaiting it.");
    assert.equal(map.limited, true);
    assert.equal(map.verification.limited, true);
    assert.ok(map.callables.some((item) => item.entries.length), "real changed callables precede the budget");
    const phantom = model.symbols.filter((symbol) => symbol.classification !== "unchanged" &&
        model.source_files[symbol.path]?.baseline != null &&
        model.source_files[symbol.path].baseline === model.source_files[symbol.path].current);
    assert.deepEqual(phantom.map((symbol) => `${symbol.path}:${symbol.qualname}`), []);
    const subject = model.nodes.find((node) => node.kind === "method" && node.name === "PrepareOperator");
    assert.ok(subject, "the reported real changed method is retained");
    const impact = impactSlice(model, subject.id);
    assert.ok(impact.counts["Potential consumer"] >= 1, "actual production callers are retained");
    assert.ok(impact.counts["Related test"] >= 3, "actual direct test callers are retained");
    const context = reviewContext(model, { path: subject.path, selected: subject, decisionMap: map });
    assert.deepEqual(context.impact.counts, impact.counts, "source context and Impact consume one relationship model");
    assert.ok(map.verification.tests.some((test) => test.callable_ids?.includes(subject.id)),
        "linked tests preserve exact compiler identity");
    await mkdir(screenshots, { recursive: true });
    await writeFile(join(screenshots, "real-csharp-evidence.json"), JSON.stringify({
        base, head, elapsed_ms: elapsed, symbols: model.symbols.length,
        code_path_changes: map.callables.filter((item) => item.entries.length).length,
        linked_tests: map.verification.tests.length, impact: impact.counts,
        direct_callers: subject.metrics.direct_callers, limited: map.limited,
        snapshot_source: snapshotSource,
    }, null, 2));
    server = await startReviewServer(state);
    assert.equal((await fetch(`${server.url}api/state`)).ok, true);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE
        || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await openChangeDetails(page);
        const metric = page.locator("#summary .metric").filter({ hasText: "Code paths" });
        await metric.waitFor();
        assert.match(await metric.textContent(), /Partial path model/);
        await metric.click();
        await page.locator(".decision-view").waitFor();
        assert.match(await page.locator(".decision-view").textContent(), /omitted or unmodelled code remains unknown/);
        assert.match(await page.locator(".linked-tests > summary").textContent(), /test candidates? not examined/);
        assert.doesNotMatch(await page.locator(".linked-tests > summary").textContent(), /shown of/);
        await page.screenshot({ path: join(screenshots, `bounded-decisions-${theme}.png`) });
        await page.keyboard.press("Control+k");
        await page.locator("#review-command-query").fill("PrepareOperator");
        const result = page.locator("#review-command-results button").filter({ hasText: "PrepareOperator" }).last();
        await result.focus();
        assert.equal(await result.evaluate((node) => node === document.activeElement), true);
        await page.keyboard.press("Enter");
        await page.locator("#source .code-row").first().waitFor();
        await page.locator("#source-review-context").waitFor();
        assert.match(await page.locator("#source-review-context").textContent(), /potential consumer components and \d+ related test/);
        assert.doesNotMatch(await page.locator("#source-review-context").textContent(), /No source-backed consumer relationship is established/);
        await page.screenshot({ path: join(screenshots, `bounded-source-${theme}.png`) });
        await page.locator("#source-impact").focus();
        await page.keyboard.press("Enter");
        await page.locator(".impact-counts").waitFor();
        assert.match(await page.locator(".impact-counts").textContent(), /Related test: [3-9]/);
        assert.match(await page.locator(".impact-toolbar").textContent(), /relationships are incomplete/);
        await page.screenshot({ path: join(screenshots, `bounded-impact-${theme}.png`) });
        const focus = page.locator(".impact-graph .node").filter({ hasText: "PrepareOperator" }).first();
        await focus.focus();
        await page.keyboard.press("Enter");
        const details = page.locator("#detail-pane .detail-grid");
        await details.waitFor();
        assert.match(await details.textContent(), /Direct callers[\s\S]*6 resolved.*incomplete/);
        await page.screenshot({ path: join(screenshots, `bounded-callers-${theme}.png`) });
        await page.locator("#detail-close").click();
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.screenshot({ path: join(screenshots, `bounded-narrow-${theme}.png`) });
        await openReviewTool(page, "paths");
        assert.match(await page.locator(".decision-view").textContent(), /Partial path model/);
        assert.deepEqual(errors, []);
        await page.close();
    }
    console.log(JSON.stringify({ status: "verified", base, head, elapsed_ms: elapsed, impact: impact.counts,
        snapshot_source: snapshotSource,
        linked_tests: map.verification.tests.length, themes: ["light", "dark"], narrow_width: 390 }));
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
}
