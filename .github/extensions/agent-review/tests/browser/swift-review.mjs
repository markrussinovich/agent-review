import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { baseline, current } from "../fixtures/swift-demo.mjs";
import { swiftHash } from "../../swift-syntax.mjs";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";
import { openChangeDetails, openReviewTool } from "./review-details-helper.mjs";

const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const execute = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), "swift-browser-review-"));
const repo = process.env.AGENT_REVIEW_UX_REPO ? resolve(process.env.AGENT_REVIEW_UX_REPO) : join(scratch, "repo");
const fixture = !process.env.AGENT_REVIEW_UX_REPO;
const artifacts = resolve(process.env.AGENT_REVIEW_BROWSER_ARTIFACTS || join(scratch, "screenshots"));
const git = (...args) => execute("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args]);
const writeSources = async (files) => {
    for (const [path, source] of Object.entries(files)) {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await writeFile(join(repo, path), source);
    }
};
let state, server, browser;
try {
    await mkdir(artifacts, { recursive: true });
    if (fixture) {
        await writeSources(baseline);
        await git("init", "-q", "--template=");
        await git("config", "user.name", "Swift browser fixture");
        await git("config", "user.email", "swift@example.invalid");
        await git("config", "core.autocrlf", "false");
        await git("add", ".");
        await git("commit", "-qm", "Saved Swift package baseline");
        const files = { ...current,
            "Package.swift": current["Package.swift"].replace("dependencies: []",
                'dependencies: [.package(url: "https://example.invalid/lib.git", from: "1.0.0")]')
                .replace('.target(name: "Core")', '.target(name: "Core", dependencies: [.product(name: "LibAPI", package: "lib")])'),
            "Sources/Core/Caller.swift": `import LibAPI\n${current["Sources/Core/Caller.swift"]}`,
            "Package.resolved": '{"version":3,"pins":[{"identity":"lib","location":"https://example.invalid/lib.git","state":{"version":"1.2.0","revision":"abc"}}]}',
        };
        await writeSources(files);
        const report = "SF:Sources/Core/Policy.swift\nDA:5,1\nDA:6,1\nDA:7,1\nDA:9,0\nend_of_record\n";
        const head = (await git("rev-parse", "HEAD")).stdout.trim();
        await writeSources({
            "lcov.info": report,
            "swift-coverage.json": JSON.stringify({ revision: head, report: "lcov.info",
                report_sha256: createHash("sha256").update(report).digest("hex"),
                source_hashes: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, swiftHash(text)])) }),
            ".agent-review.json": JSON.stringify({ test_swift: process.execPath }),
        });
    }
    state = new ReviewState(repo, {
        baseRef: process.env.AGENT_REVIEW_UX_BASE || "HEAD", getSessionEvents: async () => [],
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        generateAnnotation: async () => "## Summary\n\n- The saved Swift threshold changed.\n\n## Review order\n\n- Follow source-backed callers and inferred tests.\n\n## Gaps\n\n- Compiler semantics and per-test path evidence are unavailable.",
        generatePackageExplanation: async () => "## Evidence\n\n- A literal SwiftPM declaration and saved lock pin are separate evidence.\n\n## Limits\n\n- No manifest was evaluated and no public-registry risk assessment was performed.",
    });
    await state.refresh();
    const map = await state.decisionMapFor(60_000);
    assert.equal(state.error, null);
    assert.equal(map.status, "complete", map.error);
    assert.ok(map.callables.some((item) => item.language === "swift"), "Select a real review with changed Swift callables.");
    if (fixture) {
        assert.equal(state.model.coverage.available, true);
        assert.equal(map.verification.tests.length, 2);
        // Exercise the actual owned runner/HTTP/UI with a clearly identified stand-in
        // for Swift. This is not native Swift verification and does not execute a package.
        await writeSources({ test: `const fs = require("node:fs");
const cases = ${JSON.stringify(map.verification.tests)};
const swiftTesting = process.argv.includes("--enable-swift-testing");
const item = cases.find(item => (item.framework === "swift-testing") === swiftTesting);
const report = process.argv[process.argv.indexOf("--xunit-output") + 1];
setTimeout(() => fs.writeFileSync(report, '<testsuites><testsuite tests="1"><testcase classname="' + [item.target,item.suite].filter(Boolean).join(".") + '" name="' + item.function_name + '" time="0.001"/></testsuite></testsuites>'), 500);
` });
        // Changes to the stand-in must precede the authoritative review snapshot.
        await state.refresh();
        await state.decisionMapFor(60_000);
    }
    server = await startReviewServer(state);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync) });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        const details = page.locator("#review-background");
        await details.waitFor();
        if (!await details.evaluate((element) => element.open)) await details.locator(":scope > summary").click();
        const metric = page.locator("#summary .metric").filter({ hasText: "Code paths" });
        await metric.waitFor();
        assert.match(await page.locator("#summary").getAttribute("title"), /Swift LOC/);
        await openReviewTool(page, "architecture");
        await page.locator("#graph .node").first().waitFor();
        assert.ok(await page.locator("#graph .node").count() > 0);
        await page.screenshot({ path: join(artifacts, `swift-${theme}-architecture.png`), fullPage: true });
        await openReviewTool(page, "paths");
        await page.locator(".verification-bar").waitFor();
        assert.match(await page.locator(".decision-view").textContent(), /inferred/i);
        assert.match(await page.locator(".verification-filters").textContent(), /Confirmed0/);
        if (fixture) {
            await page.waitForFunction(() => !document.querySelector(".verification-run-button")?.disabled);
            await page.locator(".verification-command summary").click();
            assert.match(await page.locator(".verification-command pre").textContent(), /--force-resolved-versions/);
            const runButton = page.locator(".verification-run-button");
            assert.match(await runButton.getAttribute("title"), /no per-test path tracing/);
            await runButton.focus();
            assert.equal(await runButton.evaluate((element) => element === document.activeElement), true);
            if (theme === "light") {
                await runButton.press("Enter");
                await page.waitForFunction(() => /2 passed/.test(document.querySelector(".verification-status")?.textContent || ""), null, { timeout: 30_000 });
                assert.match(await page.locator(".verification-status").textContent(), /No per-test path tracing/);
            }
            assert.match(await page.locator(".verification-filters").textContent(), /Confirmed0/);
            assert.match(await page.locator(".decision-evidence").first().textContent(), /inferred/);
        }
        await page.screenshot({ path: join(artifacts, `swift-${theme}-paths.png`), fullPage: true });
        await page.locator(".decision-view .decision-row").first().click();
        await page.locator("#source-decisions").waitFor();
        assert.match(await page.locator("#source-title").textContent(), /\.swift/);
        if (fixture) {
            assert.match(await page.locator("#source-decisions").textContent(), /coverage report: executed/);
            assert.equal(await page.locator("#source .trace-legend").count(), 0);
            assert.equal(await page.locator("#source .line-number[data-trace]").count(), 0);
            if (theme === "light") {
                const layerRun = page.locator(".layer-verify-run");
                await layerRun.waitFor();
                await page.waitForFunction(() => !document.querySelector(".layer-verify-run")?.disabled);
                await layerRun.click();
                const cancel = page.locator(".layer-verify-actions button").filter({ hasText: "Cancel" });
                await cancel.waitFor();
                await cancel.click();
                await page.waitForFunction(() => !document.querySelector(".layer-verify-actions button[data-focus-key='cancel']"));
                assert.equal(state.testRun.history.at(-1).status, "cancelled");
                assert.equal(state.testRun.counts.passed, 2, "Cancellation retains earlier named outcomes without confirming paths.");
            }
            await page.screenshot({ path: join(artifacts, `swift-${theme}-source.png`), fullPage: true });
        }
        await page.locator("#source-close").click();
        if (fixture) {
            await openChangeDetails(page);
            await page.locator("#summary .metric").filter({ hasText: "Packages" }).click();
            await page.locator(".package-row").filter({ hasText: "lib" }).click();
            await page.locator("#package-detail").getByText("SwiftPM declarations and lock evidence").waitFor();
            assert.match(await page.locator("#package-detail").textContent(), /Literal declaration only/);
            assert.match(await page.locator("#package-detail").textContent(), /Saved Package.resolved pin/);
            const sourceLink = page.locator("#package-detail .source-reference").first();
            await sourceLink.focus();
            assert.equal(await sourceLink.evaluate((element) => element === document.activeElement), true);
            await page.screenshot({ path: join(artifacts, `swift-${theme}-packages.png`), fullPage: true });
        }
        await page.setViewportSize({ width: 560, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
        await page.screenshot({ path: join(artifacts, `swift-${theme}-narrow.png`), fullPage: true });
        assert.deepEqual(errors, []);
        await page.close();
    }
    console.log(`PASS Swift live application: ${fixture ? "Git-backed package, production parser and owned stand-in runner (not native Swift)" : repo}; light/dark, source, paths, coverage, packages, focus and narrow layouts.`);
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
