import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewState, runDecisionExtractor } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

// Replay genuine saved model/progress output, not a successful owned-process-launch test.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || join(root, "package.json"));
const { chromium } = require("playwright-core");
assert.ok(process.env.AGENT_REVIEW_PROGRESS_MODEL, "Set AGENT_REVIEW_PROGRESS_MODEL to an actual saved C# ReviewModel JSON.");
assert.ok(process.env.AGENT_REVIEW_PROGRESS_EVENTS, "Set AGENT_REVIEW_PROGRESS_EVENTS to that run's recorded progress JSON.");
const model = JSON.parse(await readFile(process.env.AGENT_REVIEW_PROGRESS_MODEL, "utf8"));
const events = JSON.parse(await readFile(process.env.AGENT_REVIEW_PROGRESS_EVENTS, "utf8"));
assert.ok(model.symbols.some(symbol => symbol.language === "csharp"), "real C# model required");
assert.match(model.repository.head, /^[a-f0-9]{40}$/);
const compile = events.find(event => /Compiling .*windows.*\(.*baseline\)/.test(event.message));
const elapsed = events.find(event => /Compiling .*current\).*elapsed/.test(event.message));
const relationships = events.find(event => /^Resolving relationships in .*current\)/.test(event.message));
assert.ok(compile && elapsed && relationships, "recorded project/TFM/snapshot compilation, elapsed, and relationships events required");
const scratch = await mkdtemp(join(tmpdir(), "agent-review-dotnet-progress-"));
const screenshots = process.env.AGENT_REVIEW_SCREENSHOT_DIR;
const pages = [];
const errors = [];
const captures = [];
let acceptRun;
const state = new ReviewState(model.repository.root, {
    workspacePath: scratch, currentSessionId: "recorded-real-dotnet-progress",
    reviewTarget: {
        mode: "commit", currentRef: model.repository.head, baseRef: model.repository.base_commit,
        label: `Progress rendering replay · real C# snapshot ${model.repository.head.slice(0, 7)}`,
    },
    getSessionEvents: async () => [],
    getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
    customPromptOptions: { globalDirectory: join(scratch, "empty-prompts") },
    runDecisions: runDecisionExtractor,
    runAnalyzer: (repo, base, progress, current, { signal }) => new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        acceptRun({
            progress,
            finish: () => {
                signal.removeEventListener("abort", abort);
                resolve(model);
            },
        });
    }),
});
async function beginReplay() {
    const admitted = new Promise(resolve => { acceptRun = resolve; });
    const run = state.refresh();
    run.catch(() => {});
    return { run, controller: await admitted };
}
async function render(event) {
    await Promise.all(pages.map(async ({ page }) => {
        await page.waitForFunction(message => document.querySelector("#progress-message")?.textContent === message,
            event.message);
        assert.equal(await page.locator("#analysis-progress").isVisible(), true);
        assert.equal(await page.locator("#analysis-progress").getAttribute("aria-live"), "polite");
        assert.equal(await page.locator(".progress-track").getAttribute("aria-valuenow"), String(event.percent));
        assert.equal(await page.locator("#progress-percent").textContent(), `${event.percent}%`);
    }));
}
async function capture(name) {
    for (const { page, theme, width } of pages) {
        const path = screenshots && join(screenshots, `dotnet-progress-${name}-${theme}-${width}.png`);
        if (path) await page.screenshot({ path });
        captures.push({ name, theme, width, path });
    }
}
let server, browser;
try {
    if (screenshots) await mkdir(screenshots, { recursive: true });
    server = await startReviewServer(state);
    assert.equal((await fetch(`${server.url}api/state`)).ok, true);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE
        || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    for (const theme of ["light", "dark"]) {
        for (const width of [1440, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 1000 } });
            page.on("pageerror", error => errors.push(error.message));
            await page.goto(`${server.url}?scoutTheme=${theme}`);
            assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
            pages.push({ page, theme, width });
        }
    }
    const cancelled = await beginReplay();
    cancelled.controller.progress(compile);
    await render(compile);
    const keyboard = pages[0].page;
    await keyboard.locator("#cancel-analysis").focus();
    await keyboard.keyboard.press("Shift+Tab");
    assert.notEqual(await keyboard.evaluate(() => document.activeElement?.id), "cancel-analysis");
    await keyboard.keyboard.press("Tab");
    assert.equal(await keyboard.evaluate(() => document.activeElement?.id), "cancel-analysis",
        "Cancel is reachable in the natural tab order");
    await keyboard.keyboard.press("Enter");
    await assert.rejects(cancelled.run, { name: "AbortError" });
    await Promise.all(pages.map(({ page }) => page.locator("#analysis-cancelled").waitFor()));
    assert.equal(state.loading, false);
    assert.equal(state.cancelled, true);
    await capture("cancelled");

    const replay = await beginReplay();
    for (const [name, event] of [["compile", compile], ["elapsed", elapsed], ["relationships", relationships]]) {
        replay.controller.progress(event);
        await render(event);
        for (const { page, width } of pages) {
            const box = await page.locator("#progress-message").boundingBox();
            assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${name} progress fits ${width}px viewport`);
            const clipped = await page.locator("#progress-message").evaluate(element =>
                element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
            assert.equal(clipped, false, `${name} project/TFM detail is not clipped`);
            await page.locator("#cancel-analysis").focus();
            assert.equal(await page.evaluate(() => document.activeElement?.id), "cancel-analysis");
            assert.notEqual(await page.locator("#cancel-analysis").evaluate(element => getComputedStyle(element).outlineStyle),
                "none", "keyboard focus has a visible outline");
        }
        await capture(name);
    }
    replay.controller.finish();
    assert.equal(await replay.run, model);
    await Promise.all(pages.map(({ page }) => page.waitForFunction(() =>
        document.querySelector("#analysis-progress")?.classList.contains("hidden"))));
    assert.equal(state.loading, false);
    assert.equal(state.error, null);
    assert.deepEqual(errors, []);
    await capture("complete");
    const result = {
        proof: "Progress rendering replay of real recorded events and frozen model; does not run Roslyn or prove owned-process launch.",
        head: model.repository.head, events: [compile.message, elapsed.message, relationships.message],
        checks: ["light/dark", "1440px/390px", "unclipped project/TFM/count/snapshot/elapsed",
            "polite live region and progressbar values", "keyboard focus/tab/Enter cancellation",
            "cancellation and reanalysis", "completion hides progress", "no page errors"],
        captures,
    };
    if (screenshots) await writeFile(join(screenshots, "dotnet-progress-replay.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} finally {
    if (browser) await browser.close();
    await state.dispose();
    if (server) await server.close();
    await rm(scratch, { recursive: true, force: true });
}
