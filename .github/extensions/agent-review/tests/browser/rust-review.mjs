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
const fixture = fileURLToPath(new URL("../fixtures/rust-demo/", import.meta.url));
const scratchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".rust-browser-work");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, "review-"));
const repo = join(scratch, "repo");
const artifacts = resolve(process.env.AGENT_REVIEW_BROWSER_ARTIFACTS || join(scratchRoot, "screenshots"));
await mkdir(artifacts, { recursive: true });
const git = (...args) => execute("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args]);
let state, server, browser;
try {
    await cp(join(fixture, "baseline"), repo, { recursive: true });
    await git("init", "-q", "--template=");
    await git("config", "user.name", "Rust browser fixture");
    await git("config", "user.email", "rust-review@example.invalid");
    await git("config", "core.autocrlf", "false");
    await git("add", ".");
    await git("commit", "-qm", "Baseline Rust crate");
    await cp(join(fixture, "changed"), repo, { recursive: true });
    state = new ReviewState(repo, {
        baseRef: "HEAD", getSessionEvents: async () => [],
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        generateAnnotation: async () => "## Summary\n\n- Changes Rust score handling.\n\n## Review order\n\n- Review the threshold and crate addition.\n\n## Gaps\n\n- Runtime behavior is not executed during analysis.",
        generatePackageExplanation: async () => "## Evidence\n\n- The saved Cargo declaration and use statement identify adoption.\n\n## Limits\n\n- Browser fixtures do not contact public registries.",
    });
    await state.refresh();
    const map = await state.decisionMapFor(60_000);
    assert.equal(state.error, null);
    assert.equal(map.status, "complete", map.error);
    assert.equal(map.adapter_id, "rust");
    assert.ok(state.model.nodes.some((node) => node.language === "rust" && node.kind === "trait"));
    assert.ok(state.model.nodes.some((node) => node.language === "rust" && node.kind === "enum"));
    assert.ok(map.verification.tests.some((item) => item.name === "tests::accepts_large_values"));
    const dependency = state.model.package_changes.find((item) => item.name === "thiserror");
    assert.equal(dependency.resolved_current, "2.0.1");
    state.packageAssessments.set("cargo:thiserror@2.0.1", {
        name: "thiserror", version: "2.0.1", ecosystem: "cargo",
        risk: { level: "unknown", reasons: ["Public providers are disabled in this regression."] },
        sources: {}, indicators: {},
    });
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
        assert.match(await page.locator("#summary").getAttribute("title"), /Rust LOC/);
        assert.match(await page.locator(".quality-warning").textContent(), /rust-coverage\.json/);
        await page.getByRole("button", { name: "Architecture", exact: true }).click();
        assert.ok(await page.locator("#graph .node").count() > 0);
        await page.locator('.node[aria-label^="score,"]').click();
        await page.waitForFunction(() => /src\/lib\.rs:\d+/.test(
            document.querySelector("#source-title")?.textContent || ""));
        assert.match(await page.locator("#source-decisions").textContent(), /Returns|Code path/i);
        await page.locator("#source-close").click();
        await page.locator("#summary .metric").filter({ hasText: "Packages" }).click();
        await page.locator(".package-row").filter({ hasText: "thiserror" }).click();
        assert.match(await page.locator("#package-detail").textContent(), /Cargo.*2\.0\.1/s);
        const declaration = page.locator("#package-detail .package-declaration-note .source-reference").first();
        await declaration.focus();
        assert.equal(await declaration.evaluate((element) => document.activeElement === element), true);
        await page.screenshot({ path: join(artifacts, `rust-${theme}.png`), fullPage: true });
        await page.setViewportSize({ width: 560, height: 900 });
        assert.equal(await page.evaluate(() =>
            document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
        await page.screenshot({ path: join(artifacts, `rust-${theme}-narrow.png`), fullPage: true });
        assert.deepEqual(errors, []);
        await page.close();
    }
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
