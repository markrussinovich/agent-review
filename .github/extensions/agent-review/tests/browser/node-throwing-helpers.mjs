import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".node-browser-work");
await mkdir(root, { recursive: true });
const scratch = await mkdtemp(join(root, "throwing-helpers-"));
const realRepo = process.env.AGENT_REVIEW_GUARDS_REPO;
const repo = realRepo || join(scratch, "repo");
const artifacts = resolve(process.env.AGENT_REVIEW_BROWSER_ARTIFACTS || join(root, "screenshots"));
await mkdir(artifacts, { recursive: true });
const git = (...args) => execute("git", ["-C", repo, ...args]);
let state, server, browser;
try {
    if (!realRepo) {
        await mkdir(repo);
        await git("init", "-q");
        await git("config", "user.name", "Node guard regression");
        await git("config", "user.email", "test@example.invalid");
        await git("config", "core.autocrlf", "false");
        await writeFile(join(repo, "package.json"), '{"type":"module"}');
        await writeFile(join(repo, "main.mjs"), "function fail(m) {throw new Error(m);}\nexport function guard(x) {return x;}\n");
        await git("add", ".");
        await git("-c", "commit.gpgsign=false", "commit", "-qm", "baseline");
        await writeFile(join(repo, "main.mjs"), [
            "function fail(m) {throw new Error(m);}",
            "export function guard(x) {",
            ' if (!x) fail("bad");',
            " return x;",
            "}",
            "export function conditional(x) { check(x); }",
        ].join("\n"));
    }
    const before = (await git("status", "--short")).stdout;
    state = new ReviewState(repo, {
        baseRef: realRepo ? "HEAD~1" : "HEAD",
        getSessionEvents: async () => [],
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        generateAnnotation: async () => "Local static review; AI interpretation disabled for this regression.",
    });
    await state.refresh();
    const map = await state.decisionMapFor(120000);
    assert.equal(map.status, "complete", map.error);
    assert.ok(map.callables.some((item) => item.incomplete));
    if (!realRepo) {
        const guard = map.callables.find((item) => item.qualname === "guard");
        assert.ok(guard.entries.some((entry) => entry.decision.outcome === "raise" && entry.decision.value === 'fail("bad")'));
        assert.equal(guard.incomplete, false);
        assert.equal(map.callables.find((item) => item.qualname === "conditional").incomplete, true);
    }
    await writeFile(join(artifacts, "node-throwing-helpers-evidence.json"), JSON.stringify({ repo, model: state.model, decision_map: map }, null, 2));
    server = await startReviewServer(state);
    const executablePath = process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        const background = page.locator("#review-background");
        await background.waitFor();
        if (!await background.evaluate((element) => element.open)) await background.locator(":scope > summary").click();
        const metric = page.locator("#summary .metric").filter({ hasText: "Code paths" });
        await metric.waitFor();
        assert.match(await metric.textContent(), /Partial path model/);
        assert.doesNotMatch(await metric.textContent(), /0 without test evidence/);
        await metric.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await metric.evaluate((element) => element === document.activeElement && element.matches(":focus-visible")), true);
        await page.screenshot({ path: join(artifacts, `node-throwing-helpers-${realRepo ? "real" : "fixture"}-${theme}-metric-focus.png`), fullPage: !realRepo });
        await metric.press("Enter");
        await page.locator(".decision-view").waitFor();
        await page.locator(".decision-view .code-path-notes summary").click();
        assert.match(await page.locator(".decision-view").textContent(), /Decision counts are partial/);
        if (await page.locator(".decision-unchanged").count()) {
            assert.doesNotMatch(await page.locator(".decision-unchanged").textContent(), /have no exits|has no exits|same code paths/);
        }
        if (!realRepo) assert.match(await page.locator(".decision-view").textContent(), /Raises.*fail\("bad"\)/s);
        for (const width of [1440, 560]) {
            await page.setViewportSize({ width, height: 1000 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
            await page.screenshot({ path: join(artifacts, `node-throwing-helpers-${realRepo ? "real" : "fixture"}-${theme}-${width}.png`), fullPage: !realRepo });
        }
        assert.deepEqual(errors, []);
        await page.close();
    }
    if (!realRepo) {
        await writeFile(join(repo, "main.mjs"), [
            "function fail(m) {throw new Error(m);}",
            "export function guard(x) {return x;}",
            "export function conditional(x) {check(x);}",
        ].join("\n"));
        await state.refresh();
        const unknown = await state.decisionMapFor(60000);
        assert.equal(unknown.callables.length, 1);
        assert.equal(unknown.callables[0].entries.length, 0);
        const page = await browser.newPage({ viewport: { width: 560, height: 1000 } });
        await page.goto(`${server.url}?scoutTheme=light`);
        const background = page.locator("#review-background");
        await background.waitFor();
        if (!await background.evaluate((element) => element.open)) await background.locator(":scope > summary").click();
        const metric = page.locator("#summary .metric").filter({ hasText: "Code paths" });
        await metric.waitFor();
        assert.match(await metric.textContent(), /Unknown.*Partial path model/);
        assert.equal(await metric.evaluate((element) => element.classList.contains("metric-empty")), false);
        await page.screenshot({ path: join(artifacts, "node-throwing-helpers-unknown-metric.png"), fullPage: true });
        await metric.click();
        assert.match(await page.locator(".decision-view").textContent(), /omitted or unmodelled code remains unknown/);
        assert.doesNotMatch(await page.locator(".decision-view").textContent(), /keep the same exits|has no exits/);
        await page.close();
    }
    assert.equal((await git("status", "--short")).stdout, before, "review does not modify production sources");
    console.log(JSON.stringify({ repo, callables: map.callables.length, incomplete: map.callables.filter((item) => item.incomplete).length, artifacts }));
} finally {
    await browser?.close();
    state?.dispose();
    await server?.close();
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
