import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), "review-verification-ui-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
process.env.AGENT_REVIEW_TEST_PYTHON ||= "python";
let server, browser, state;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "core.autocrlf", "false");
    await mkdir(join(repo, "pkg"));
    await mkdir(join(repo, "tests"));
    await writeFile(join(repo, "pkg", "__init__.py"), "");
    await writeFile(join(repo, "conftest.py"), "");
    await writeFile(join(repo, "pkg", "resolver.py"), "def resolve(ref):\n    return ref\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "pkg", "resolver.py"),
        "def resolve(ref):\n    if not ref:\n        return None\n    if ref == 'legacy':\n        raise ValueError(ref)\n    return ref\n");
    await writeFile(join(repo, "tests", "test_resolver.py"), [
        "from pkg.resolver import resolve", "",
        "def test_missing_reference_returns_nothing_for_review_purposes():", "    assert resolve('') is None", "",
        "def test_value():", "    assert resolve('x') == 'x'", "",
    ].join("\n"));
    state = new ReviewState(repo, {
        baseRef: "HEAD",
        generateAnnotation: async () => "## Summary\n\n- Resolver.\n\n## Review order\n\n- `resolve`.\n\n## Gaps\n\n- None.",
    });
    await state.refresh();
    const map = await state.decisionMapFor(60000);
    assert.equal(map.status, "complete", map.error);
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
        const metric = page.locator("#summary .metric").filter({ hasText: "Code paths" });
        await metric.waitFor();
        await metric.click();
        await page.locator(".verification-bar").waitFor();
        const filterText = () => page.locator(".verification-filters").textContent();
        const row = (line) => page.locator(`.decision-view .decision-row[data-line="${line}"]`);
        if (theme === "light") {
            assert.match(await metric.textContent(), /1 callable · 0 without test evidence/);
            assert.equal(await filterText(), "All2Untested0Inferred2Confirmed0");
            assert.match(await row(3).locator(".decision-evidence").textContent(),
                /Asserted \(inferred\): test_missing_reference_returns_nothing_for_review_purposes checks resolve\(''\) is None/);
            assert.match(await row(5).locator(".decision-evidence").textContent(), /Called by test_\w+; this outcome is not asserted \(inferred\)/);
            await page.waitForFunction(() => !document.querySelector(".verification-run-button").disabled);
            assert.match(await page.locator(".verification-status").textContent(), /Runs 2 linked tests in the worktree with python .*Executes repository code/);
            await page.locator(".verification-command summary").click();
            state.broadcast("annotation");
            await page.waitForTimeout(400);
            assert.equal(await page.locator(".verification-command").evaluate((details) => details.open), true,
                "the Command section stays open when server updates re-render the view");
            assert.match(await page.locator(".verification-command pre").textContent(), /-m pytest -p agent_review_trace -p no:cacheprovider/);
            await page.locator(".verification-run-button").click();
            await page.waitForFunction(() => /2 passed/.test(document.querySelector(".verification-status")?.textContent || ""), null, { timeout: 120000 });
        }
        assert.equal(await filterText(), "All2Untested1Inferred0Confirmed1");
        assert.match(await row(3).locator(".decision-evidence").textContent(),
            /Confirmed: executed by test_missing_reference_returns_nothing_for_review_purposes \(passed\)/);
        assert.match(await row(5).locator(".decision-evidence").textContent(), /Not executed by the 2 linked tests that ran/);
        assert.match(await metric.textContent(), /1 callable · 1 without test evidence/);
        assert.deepEqual(await page.locator(".linked-test .test-outcome").allTextContents(), ["passed", "passed"]);
        assert.equal(await page.locator(".linked-test .label-added").count(), 2, "tests added in this change are marked");
        await page.locator('.evidence-filter-untested').click();
        assert.deepEqual(await page.locator(".decision-view .decision-row").evaluateAll((rows) => rows.map((item) => item.dataset.line)), ["5"]);
        assert.equal(await page.locator('.evidence-filter-untested').getAttribute("aria-pressed"), "true");
        await page.locator('.evidence-filter-all').click();
        for (const width of [1440, 900, 560]) {
            await page.setViewportSize({ width, height: 1000 });
            const overflow = await page.locator(".verification-bar, .decision-row, .linked-test").evaluateAll((items) => items
                .filter((item) => item.scrollWidth > item.clientWidth + 1 || item.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
                .map((item) => item.className));
            assert.deepEqual(overflow, [], `${theme}: verification content fits at ${width}px`);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator(".linked-test").first().click();
        await page.waitForFunction(() => /tests\/test_resolver\.py:\d+$/.test(document.querySelector("#source-title").textContent));
        await page.click("#source-close");
        await row(3).click();
        await page.locator("#source-decisions .decision-evidence").first().waitFor();
        assert.match(await page.locator("#source-decisions").textContent(), /Confirmed: executed by/, "the source pane shows the same evidence");
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}: inferred evidence, explicit linked test run, confirmed/not-executed paths, filters, linked tests, source pane, responsive layout`);
    }
    const status = await git("status", "--short");
    assert.doesNotMatch(status.stdout, /pytest_cache|__pycache__/, "the run leaves no caches in the repository");
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
