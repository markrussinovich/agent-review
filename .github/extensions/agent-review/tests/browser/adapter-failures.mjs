import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState, runAnalyzer } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";
import { annotationHeadings } from "../../ai-prompts.mjs";

const repo = process.env.AGENT_REVIEW_UX_REPO;
if (!repo) throw new Error("Set AGENT_REVIEW_UX_REPO to a real changed mixed-language repository.");
const directory = await mkdtemp(join(tmpdir(), "adapter-failure-browser-"));
const artifacts = process.env.AGENT_REVIEW_BROWSER_ARTIFACTS || directory;
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const previous = { helper: process.env.AGENT_REVIEW_DOTNET_HELPER, runtime: process.env.AGENT_REVIEW_DOTNET };
let state, server, browser;
try {
    const helper = join(directory, "failed-helper.py");
    await writeFile(helper, "import sys\nprint('deliberate browser helper failure', file=sys.stderr)\nraise SystemExit(42)\n");
    process.env.AGENT_REVIEW_DOTNET_HELPER = helper;
    process.env.AGENT_REVIEW_DOTNET = process.env.AGENT_REVIEW_PYTHON || "python";
    const progress = [];
    const annotations = [];
    state = new ReviewState(repo, {
        workspacePath: directory, baseRef: process.env.AGENT_REVIEW_UX_BASE || "HEAD", readWorktreeFingerprint: null,
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        runAnalyzer: (...args) => runAnalyzer(args[0], args[1], (event) => {
            progress.push(event);
            args[2](event);
        }, args[3], args[4]),
        generateAnnotation: async (context) => {
            annotations.push(context);
            return annotationHeadings(context).map((heading) =>
                `## ${heading}\n\nControlled response: saved source remains reviewable; C# facts are unavailable.`).join("\n\n");
        },
    });
    // Keep the production decision extractor when observing the production analyzer through a progress tap.
    const { runDecisionExtractor } = await import("../../review-state.mjs");
    state.runDecisions = runDecisionExtractor;
    const model = await state.refresh();
    assert.equal(model.metadata.analysis_incomplete, true);
    assert.ok(model.metadata.unavailable_languages.some((item) => item.language === "csharp" && /exit 42/.test(item.reason)));
    assert.ok(progress.some((event) => event.phase === "adapter_unavailable"));
    assert.ok(model.symbols.some((symbol) => symbol.path.endsWith(".py")));
    assert.ok(model.symbols.some((symbol) => symbol.language === "node"));
    const changedNode = model.changes.find((change) => change.status !== "unchanged" && /\.(?:m?js|tsx?)$/.test(change.path));
    assert.ok(changedNode, "real repository must contain a changed Node source file");
    await state.decisionMapFor(120_000);
    assert.equal(state.decisionMap.status, "complete");
    assert.equal(state.decisionMap.limited, true);
    assert.ok(state.decisionMap.callables.length, "healthy code paths survive");
    server = await startReviewServer(state);
    browser = await chromium.launch({ headless: true,
        executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    await mkdir(artifacts, { recursive: true });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        const limitation = page.locator("#overview-limitation button");
        await limitation.focus();
        await limitation.press("Enter");
        const list = page.locator("#detail .analysis-warning-list");
        await list.waitFor();
        assert.match(await list.textContent(), /C# facts unavailable.*exit 42.*source diffs remain available/s);
        assert.match(await list.locator(".analysis-adapter-unavailable").textContent(), /C#.*scan failed.*exit 42/s);
        assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
        await page.screenshot({ path: join(artifacts, `adapter-failure-${theme}.png`) });
        await page.setViewportSize({ width: 560, height: 1000 });
        await list.locator(".analysis-adapter-unavailable").waitFor();
        assert.equal(await list.evaluate((element) => element.clientWidth > 0 && element.scrollWidth <= element.clientWidth + 1), true);
        assert.equal(await page.locator("#detail-pane").evaluate((element) =>
            element.getBoundingClientRect().width <= window.innerWidth), true);
        await page.screenshot({ path: join(artifacts, `adapter-failure-${theme}-narrow-limitations.png`) });
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#detail-pane").isVisible(), false);
        assert.equal(await page.locator("#detail-toggle").evaluate((element) => element === document.activeElement), true);
        await page.locator("#detail-toggle").press("Enter");
        await list.waitFor();
        await page.locator("#detail-close").focus();
        await page.locator("#detail-close").press("Enter");
        assert.equal(await page.locator("#detail-pane").isVisible(), false);
        assert.equal(await page.locator("#detail-toggle").evaluate((element) => element === document.activeElement), true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator("#workspace-files").click();
        await page.getByLabel("Find a changed file or group").fill(changedNode.path);
        await page.locator(".workspace-file:visible").filter({ hasText: changedNode.path.split("/").at(-1) }).first().click();
        await page.locator("#source-panel:not(.hidden)").waitFor();
        await page.waitForFunction(() => document.querySelector("#source-annotation")?.textContent.includes("Controlled response"));
        assert.ok(annotations.length, "the AI review request still reaches its provider");
        assert.ok(annotations.some((context) => context.analysis_quality?.warnings?.some((warning) =>
            warning.includes("C# facts unavailable"))), "AI context carries unavailable evidence, not healthy zeros");
        await page.getByRole("button", { name: "Diff", exact: true }).click();
        await page.locator("#source .code-lines").first().waitFor();
        await page.screenshot({ path: join(artifacts, `adapter-failure-${theme}-source.png`) });
        await page.setViewportSize({ width: 560, height: 1000 });
        await page.locator("#workspace-context").click();
        await page.locator("#source-annotation:visible").waitFor();
        assert.match(await page.locator("#source-annotation").textContent(), /C# facts are unavailable/);
        await page.screenshot({ path: join(artifacts, `adapter-failure-${theme}-narrow.png`) });
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}: real ${repo} model, light/dark/narrow limitations, Escape/close focus, saved diff and AI request`);
    }
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    for (const [key, value] of [["AGENT_REVIEW_DOTNET_HELPER", previous.helper], ["AGENT_REVIEW_DOTNET", previous.runtime]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
