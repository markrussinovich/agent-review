import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("../fixtures/go-demo/", import.meta.url));
const scratchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".go-browser-work");
await mkdir(scratchRoot, { recursive: true });
const artifacts = join(scratchRoot, "screenshots");
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, "review-"));
const repo = join(scratch, "repo");
let state, server, browser;
try {
    await cp(join(fixture, "baseline"), repo, { recursive: true });
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    await git("init", "-q");
    await git("config", "user.name", "Go browser fixture");
    await git("config", "user.email", "go@example.invalid");
    await git("add", ".");
    await git("commit", "-qm", "baseline");
    await cp(join(fixture, "changed"), repo, { recursive: true });
    state = new ReviewState(repo, { baseRef: "HEAD", getSessionEvents: async () => [],
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }) });
    await state.refresh();
    const map = await state.decisionMapFor(30_000);
    assert.equal(map.status, "complete", map.error);
    assert.equal(map.adapter_id, "go");
    for (const dependency of state.model.package_dependencies) {
        state.packageAssessments.set(`gomod:${dependency.name}@${dependency.resolved_current}`, {
            name: dependency.name, version: dependency.resolved_current, ecosystem: "gomod",
            risk: { level: "unknown", score: null,
                reasons: ["Public services are disabled in this browser regression."] },
            sources: {}, indicators: {},
        });
    }
    server = await startReviewServer(state);
    const executablePath = process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.locator("#summary .metric").first().waitFor();
        assert.match(await page.locator("#summary").getAttribute("title"), /Go LOC/);
        assert.match(await page.locator(".quality-warning").textContent(), /Go coverprofile/);
        const plan = page.locator(".review-plan-row", { hasText: "Classify" }).first();
        await plan.waitFor();
        assert.match(await plan.textContent(), /Classify/);
        await plan.focus();
        assert.equal(await plan.evaluate((element) => element.matches(":focus-visible")), true);
        await page.screenshot({ path: join(artifacts, `go-${theme}-wide.png`), fullPage: true });
        await page.setViewportSize({ width: 560, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
        await page.screenshot({ path: join(artifacts, `go-${theme}-narrow.png`), fullPage: true });
        await page.locator("#summary .metric", { hasText: "Packages" }).click();
        const moduleRow = page.locator(".package-row", { hasText: "golang.org/x/text" });
        await moduleRow.click();
        assert.match(await page.locator("#package-detail").textContent(), /Go module.*checksum evidence/s);
        await page.locator("#package-detail .source-reference", { hasText: "go.sum" }).click();
        await page.waitForFunction(() => document.querySelector("#source-title")?.textContent.includes("go.sum"));
        assert.match(await page.locator("#source-title").textContent(), /go\.sum/);
        await page.screenshot({ path: join(artifacts, `go-${theme}-module-source.png`), fullPage: true });
        assert.deepEqual(errors, []);
        await page.close();
    }
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
