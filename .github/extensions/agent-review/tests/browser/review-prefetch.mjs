import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const repo = process.env.AGENT_REVIEW_UX_REPO;
if (!repo) throw new Error("Set AGENT_REVIEW_UX_REPO to a real Git repository with uncommitted changes.");
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const scratch = await mkdtemp(join(tmpdir(), "review-prefetch-"));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const options = {
    baseRef: "HEAD", customPromptOptions: { globalDirectory: scratch },
    getSessionEvents: async () => [],
    getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
};
let browser, server, state, analyzed;
const pending = [];
try {
    analyzed = new ReviewState(repo, options);
    await analyzed.refresh();
    const map = await analyzed.decisionMapFor(60000);
    assert.equal(map.status, "complete", map.error);
    assert.ok(analyzed.model.changes.filter((file) => file.status !== "unchanged").length >= 3);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync) });
    for (const theme of ["light", "dark"]) {
        const overview = deferred(), layers = deferred(), discussion = deferred();
        pending.push(overview, layers, discussion);
        const generations = [], requests = [];
        let layerContext;
        state = new ReviewState(repo, { ...options,
            generateAnnotation: (context) => {
                if (context.kind === "overview") return overview.promise;
                const gate = { ...deferred(), id: context.item.id };
                generations.push(gate);
                pending.push(gate);
                return gate.promise;
            },
            generateLayerSummaries: (context) => { layerContext = context; return layers.promise; },
            generateDiscussion: (_input, { signal }) => new Promise((resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                discussion.promise.then(resolve, reject);
            }),
        });
        state.model = analyzed.model;
        state.reviewTarget = analyzed.reviewTarget;
        state.decisionMap = map;
        server = await startReviewServer(state);
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
            if (new URL(request.url()).pathname === "/api/annotation") requests.push(request.postDataJSON().id);
        });
        const screenshot = async (name) => {
            if (!process.env.AGENT_REVIEW_SCREENSHOT_DIR) return;
            await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `${name}-${theme}.png`) });
        };
        const waitForGeneration = async (id, count = 1) => {
            await page.waitForFunction(() => document.readyState === "complete");
            const deadline = Date.now() + 15000;
            while (generations.filter((entry) => !id || entry.id === id).length < count && Date.now() < deadline) {
                await page.waitForTimeout(25);
            }
            const matching = generations.filter((entry) => !id || entry.id === id);
            assert.ok(matching.length >= count, `Expected generation ${id || "(any)"} #${count}; got ${requests.join(", ")}`);
            return matching[count - 1];
        };
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.locator("#overview-description .ai-pending-line").first().waitFor();
        await page.locator("#overview-layers .ai-pending-line").first().waitFor();
        const fusionUpdate = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ai-settings");
        await page.getByLabel("Prefer HydraFusion").check();
        assert.equal((await fusionUpdate).status(), 200);
        assert.equal(state.useFusion, true, "the checkbox applies to server-side AI calls");
        assert.equal(await page.locator("#overview-layers .is-supporting .ai-pending-line").count(), 0, "supporting files are not sent for AI layer summaries");
        assert.equal(requests.length, 0, "item prefetch waits for the overview");
        await screenshot("overview-generating");
        assert.ok(layerContext?.layers.length);
        layers.resolve({ intents: Object.fromEntries(layerContext.layers.map((layer) => [layer.id, "Explains the saved changes in this area."])),
            titles: Object.fromEntries(layerContext.layers.map((layer) => [layer.id, `Review ${layer.name || layer.id}`])) });
        overview.resolve("## Summary\n\nPrefetch regression uses this repository's saved code.\n\n## Review order\n\nFollow the layers.");
        await page.locator("#overview-prefetch .ai-pending-line").waitFor();
        const first = await waitForGeneration();
        assert.equal(requests.length, 1, "Overview prefetches exactly one item, never a vacuous pass");
        await page.locator("#overview-start").click();
        await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true"
            && document.querySelector("#source .code-row"));
        await page.locator("#source-annotation .ai-pending-line").first().waitFor();
        assert.equal(requests.filter((id) => id === first.id).length, 1, "opening an in-flight prefetch shares the HTTP request");
        await page.locator("#workflow-overview").click();
        await page.locator("#overview-start").click();
        await page.locator("#source-annotation .ai-pending-line").first().waitFor();
        assert.equal(requests.filter((id) => id === first.id).length, 1, "resuming while the explanation is pending keeps its bars and request");
        await screenshot("annotation-generating");
        first.resolve(`## What changed\n\nPrefetched explanation for ${first.id}.`);
        await page.waitForFunction((id) => document.querySelector("#source-annotation")?.textContent.includes(`Prefetched explanation for ${id}`), first.id);
        const next = await waitForGeneration(null, 2);
        assert.notEqual(next.id, first.id, "reading prefetches the next item");
        next.reject(new Error("Deliberate prefetch failure"));
        await page.waitForFunction(() => document.querySelector("#workspace-prefetch")?.textContent.includes("Open the file to retry"));
        await page.locator("#file-review-next").click();
        const retry = await waitForGeneration(next.id, 2);
        await page.locator("#source-annotation .ai-pending-line").first().waitFor();
        retry.resolve(`## What changed\n\nRetried explanation for ${next.id}.`);
        await page.waitForFunction((id) => document.querySelector("#source-annotation")?.textContent.includes(`Retried explanation for ${id}`), next.id);
        assert.equal(requests.filter((id) => id === next.id).length, 2, "failed prefetch retries only when opened");
        assert.equal(await page.locator("#source-annotation .ai-pending-line").count(), 0);

        const header = page.locator(".workspace-layer-heading").first();
        assert.equal(await header.locator("button").count(), 0, "a layer header only expands/collapses; it has no nested action");
        const layer = page.locator(".workspace-layer").first();
        await header.click();
        assert.equal(await layer.evaluate((element) => element.open), false);
        await header.focus();
        await page.keyboard.press("Space");
        assert.equal(await layer.evaluate((element) => element.open), true);
        assert.equal(await header.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
        const reviewLayer = layer.locator(".workspace-layer-open");
        await reviewLayer.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await reviewLayer.evaluate((element) => element.matches(":focus-visible")), true);
        assert.equal(await reviewLayer.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true");
        assert.equal(await page.locator("#source-panel").isVisible(), true, "Review layer opens its next unreviewed file");
        await screenshot("navigation");

        await page.locator("#workspace-discuss").click();
        const pane = page.locator("#item-discussion");
        await pane.getByRole("textbox").fill("Explain this saved change.");
        await pane.getByRole("button", { name: "Send", exact: true }).click();
        await pane.locator(".discussion-assistant .ai-pending-line").first().waitFor();
        await screenshot("discussion-generating");
        await pane.getByRole("button", { name: "Stop answer", exact: true }).click();
        await pane.getByText(/Stopped:/).waitFor();
        assert.equal(await pane.locator(".ai-pending-line").count(), 0, "stopped answers remove the bars");
        discussion.resolve({ answer: "Stopped answer", limitation: "", citations: [], requests: [] });

        state.ruleCheck = { status: "running", coverage: { completed_units: 3, total_units: 10 } };
        state.annotations.overview = { ...state.annotations.overview, refining: true };
        state.broadcast("annotation");
        await page.locator("#workflow-overview").click();
        await page.getByText("Waiting for the repository rules review (3 of 10 evidence units reviewed)...").waitFor();
        state.annotations.overview.refining = false;
        state.broadcast("annotation");
        await page.waitForFunction(() => !document.querySelector("#overview-description .ai-pending-line"));
        await page.locator("#workflow-review").click();

        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator("#workspace-nav-toggle").click();
        await header.waitFor();
        await screenshot("navigation-narrow");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "narrow viewport has no horizontal overflow");
        const visibleFile = page.locator(".workspace-file:visible").first();
        await visibleFile.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await visibleFile.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true");
        assert.equal(await page.locator("#review-navigation").isVisible(), false, "selecting a file closes the narrow drawer");
        assert.equal(await page.locator("#source-panel").isVisible(), true);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.locator("#workflow-overview").click();
        state.annotations.overview.refining = true;
        state.broadcast("annotation");
        try {
            await page.locator("#overview-description .ai-pending-line").first().waitFor();
        } catch (error) {
            console.error(JSON.stringify({ theme, errors, overview: await page.locator("#overview-description").textContent(),
                bodyClass: await page.locator("body").getAttribute("class"),
                summary: state.annotations.overview, source: await page.locator("#source-title").textContent() }));
            await screenshot("refinement-failure");
            throw error;
        }
        assert.equal(await page.locator("#overview-description .ai-pending-line").first()
            .evaluate((element) => getComputedStyle(element).animationName), "none");
        assert.deepEqual(errors, []);
        console.log(`PASS ${theme}: real saved source; exact first/next prefetch, in-flight reuse, visible failure/retry, AI bars, layer disclosure, keyboard, narrow layout and reduced motion`);
        await page.close();
        for (const gate of generations) gate.resolve("## What changed\n\nSaved source explanation.");
        await server.close();
        server = null;
        await state.dispose();
        state = null;
    }
} finally {
    await browser?.close();
    for (const gate of pending) gate.resolve("## Summary\n\nTest cleanup.");
    await server?.close();
    await state?.dispose();
    await analyzed?.dispose();
    await rm(scratch, { recursive: true, force: true });
}
