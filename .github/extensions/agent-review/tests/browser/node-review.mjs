import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("../fixtures/node-demo/", import.meta.url));
const scratchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".node-browser-work");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, "review-"));
const repo = join(scratch, "repo");
const config = join(scratch, "config");
const runtimeDirectory = join(scratch, "runtime");
const marker = join(scratch, "tests-executed.txt");
const artifacts = resolve(process.env.AGENT_REVIEW_BROWSER_ARTIFACTS || join(scratchRoot, "screenshots"));
await mkdir(artifacts, { recursive: true });
await mkdir(config);
await mkdir(runtimeDirectory);
const git = (...args) => execute("git", ["-C", repo, "-c", `core.hooksPath=${config}`, "-c", "commit.gpgsign=false", ...args]);
const previousMarker = process.env.AGENT_REVIEW_NODE_DEMO_MARKER;
const previousTemp = Object.fromEntries(["TEMP", "TMP", "TMPDIR"].map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const publicRequests = [];
process.env.AGENT_REVIEW_NODE_DEMO_MARKER = marker;
for (const name of Object.keys(previousTemp)) process.env[name] = runtimeDirectory;
globalThis.fetch = (input, options) => {
    const target = new URL(input?.url || input);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
        publicRequests.push(target.href);
        return Promise.reject(new Error("Public provider requests are disabled in the Node browser regression."));
    }
    return originalFetch(input, options);
};
async function keyboardFocus(page, control) {
    await control.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await control.evaluate((element) => document.activeElement === element), true);
    assert.equal(await control.evaluate((element) => element.matches(":focus-visible")), true);
}
let server, browser, state;
try {
    await cp(join(fixture, "baseline"), repo, { recursive: true });
    await git("init", "-q", "--template=");
    await git("config", "user.name", "Node browser fixture");
    await git("config", "user.email", "node-review@example.invalid");
    await git("config", "core.autocrlf", "false");
    await git("add", ".");
    await git("commit", "-qm", "Baseline reference workspace");
    await cp(join(fixture, "changed"), repo, { recursive: true });
    const reviewedStatus = (await git("status", "--short")).stdout;
    state = new ReviewState(repo, {
        baseRef: "HEAD",
        customPromptOptions: { globalDirectory: config },
        getSessionEvents: async () => [],
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        generateAnnotation: async () => "## Summary\n\n- Adds reference validation across an npm workspace.\n\n## Review order\n\n- Review resolver branches and UI imports.\n\n## Gaps\n\n- Legacy references are not exercised.",
        generatePackageExplanation: async () => "## Evidence\n\n- Saved npm declarations and source import locations.\n\n## Limits\n\n- Public registry assessment is disabled in this browser regression.",
    });
    await state.refresh();
    const map = await state.decisionMapFor(60000);
    await writeFile(join(artifacts, "node-review-evidence.json"), JSON.stringify({
        model: state.model, decision_map: map,
    }, null, 2));
    assert.equal(map.status, "complete", map.error);
    assert.equal(map.adapter_id, "node", "production test routing selects the Node adapter");
    assert.equal(map.callables.length, 4, "production extraction includes all changed workspace callables");
    assert.equal(map.verification.tests.length, 2, "both real node:test cases link to the changed resolver");
    assert.ok(map.verification.tests.every((test) => test.runner === "node:test"));
    assert.equal(existsSync(marker), false, "scanning and code-path extraction never execute repository tests");
    for (const extension of [".js", ".ts", ".jsx", ".tsx"]) {
        assert.ok(state.model.nodes.some((node) => node.path?.endsWith(extension) && node.kind === "function"),
            `${extension} callable appears in the production graph`);
    }
    assert.ok(state.model.edges.some((edge) => edge.type === "imports"), "workspace source imports produce structural edges");
    const packages = state.model.package_changes.filter((item) => ["lodash", "picocolors"].includes(item.name));
    assert.equal(packages.length, 2);
    assert.equal(packages.find((item) => item.name === "lodash").declared_base[0].resolved_version, "4.17.20");
    assert.equal(packages.find((item) => item.name === "lodash").resolved_current, "4.17.21");
    assert.equal(packages.find((item) => item.name === "picocolors").change, "added");
    for (const item of packages) {
        assert.ok(item.usage_locations.some((location) => location.startsWith("packages/ui/src/")));
        state.packageAssessments.set(`npm:${item.name}@${item.resolved_current}`, {
            name: item.name, version: item.resolved_current,
            risk: { level: "unknown", score: 0, reasons: ["No public services are contacted by this regression."] },
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
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.locator("#summary .metric").first().waitFor();
        await page.locator(".review-plan-row").first().waitFor();
        assert.match(await page.locator(".review-plan-row").first().textContent(), /resolveReference/);
        assert.match(await page.locator(".quality-warning").textContent(), /source-matched LCOV\/Istanbul JSON/);
        assert.doesNotMatch(await page.locator(".quality-warning").textContent(), /Generate coverage\.json or coverage\.xml/);
        await page.getByRole("button", { name: "Architecture", exact: true }).click();
        assert.ok(await page.locator("#graph .node").count() > 0, "actual structural graph is rendered");
        await page.screenshot({ path: join(artifacts, `node-${theme}-graph.png`), fullPage: true });
        await page.setViewportSize({ width: 560, height: 1000 });
        await page.screenshot({ path: join(artifacts, `node-${theme}-graph-narrow.png`), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        const resolver = state.model.nodes.find((node) => node.kind === "function" && node.name === "resolveReference");
        const module = state.model.nodes.find((node) => node.id === resolver.module_id);
        const component = state.model.nodes.find((node) => node.id === resolver.component_id);
        assert.ok(module && component, "callable retains workspace module and component graph identities");
        await page.locator(`.node[aria-label^="${component.name},"]`).click();
        await page.locator(`.node[aria-label^="${module.name},"]`).click();
        await page.locator('.node[aria-label^="resolveReference,"]').click();
        await page.waitForFunction(() => /packages\/core\/src\/resolver\.js:\d+/.test(document.querySelector("#source-title")?.textContent || ""));
        assert.match(await page.locator("#source-risk").textContent(), /Cyclomatic complexity increased.*Priority \d+\/100/);
        await page.locator("#source-decisions .source-verification").waitFor();
        assert.match(await page.locator("#source-decisions .source-verification").textContent(), /Run linked tests/);
        await page.locator("#source-close").click();
        await page.getByRole("button", { name: "Architecture", exact: true }).click();
        await page.locator("#summary .metric").filter({ hasText: "Packages" }).click();
        for (const item of packages) {
            await page.locator("#packages .review-card").filter({ hasText: new RegExp(item.name) }).click();
            await page.locator("#package-detail .usage-list").waitFor();
            assert.match(await page.locator("#package-detail").textContent(), new RegExp(item.resolved_current.replaceAll(".", "\\.")));
            const sourceLink = page.locator("#package-detail .usage-list .source-reference").first();
            await keyboardFocus(page, sourceLink);
            state.broadcast("package-risk");
            await page.waitForTimeout(100);
            assert.equal(await sourceLink.evaluate((element) => document.activeElement === element), true,
                "package and AI updates preserve the focused source link");
            if (item.name === "picocolors") {
                await page.screenshot({ path: join(artifacts, `node-${theme}-package-focus.png`), fullPage: true });
            }
            await sourceLink.press("Enter");
            try {
                await page.waitForFunction(() => /packages\/ui\/src\/.+:\d+/.test(document.querySelector("#source-title")?.textContent || ""));
            } catch (error) {
                throw new Error(`Opening ${await sourceLink.textContent()} failed: title=${await page.locator("#source-title").textContent()}; error=${await page.locator("#error").textContent()}`, { cause: error });
            }
            await page.locator("#source-close").click();
            await page.locator("#package-detail .package-declaration-note .source-reference").first().click();
            await page.waitForFunction(() => /^package\.json:\d+$/.test(document.querySelector("#source-title")?.textContent || ""));
            await page.locator("#source .package-reference-highlight").first().waitFor();
            assert.equal(await page.locator("#source .package-reference-highlight").first().textContent(), item.name);
            if (item.name === "lodash") {
                await page.locator('button[data-tab="diff"]').click();
                await page.waitForFunction(() => /4\.17\.20/.test(document.querySelector("#source")?.textContent || ""));
                assert.match(await page.locator("#source").textContent(), /4\.17\.20/);
                assert.match(await page.locator("#source").textContent(), /4\.17\.21/);
                await page.screenshot({ path: join(artifacts, `node-${theme}-manifest-diff.png`), fullPage: true });
            }
            await page.locator("#source-close").click();
        }
        await page.screenshot({ path: join(artifacts, `node-${theme}-packages.png`), fullPage: true });
        await page.setViewportSize({ width: 560, height: 1000 });
        await page.screenshot({ path: join(artifacts, `node-${theme}-packages-narrow.png`), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator("#summary .metric").filter({ hasText: "Code paths" }).click();
        await page.locator(".decision-view .decision-row").first().waitFor();
        assert.match(await page.locator(".decision-view").textContent(), /resolveReference|describeReference/);
        await page.locator(".verification-bar").waitFor();
        if (theme === "light") {
            assert.equal(existsSync(marker), false, "opening graph, package evidence, and code paths does not run tests");
            await page.waitForFunction(() => {
                const button = document.querySelector(".verification-run-button");
                return button && !button.disabled;
            });
            assert.match(await page.locator(".verification-status").textContent(), /2 linked tests/);
            assert.match(await page.locator(".verification-status").textContent(), /Executes repository code/i);
            assert.match(await page.locator('.decision-group').filter({ hasText: "packages/core/src/resolver.js" })
                .locator('.decision-row[data-line="3"] .decision-evidence').textContent(), /\(inferred\)/);
            await page.locator(".verification-command summary").click();
            assert.match(await page.locator(".verification-command pre").textContent(), /--test/);
            const run = page.locator(".verification-run-button");
            await keyboardFocus(page, run);
            await page.screenshot({ path: join(artifacts, "node-light-run-focus.png"), fullPage: true });
            await run.press("Enter");
            await page.waitForFunction(() => /passed/.test(document.querySelector(".verification-status")?.textContent || ""), null, { timeout: 120000 });
            assert.match(await readFile(marker, "utf8"), /Explicit node:test execution/);
        }
        assert.match(await page.locator(".verification-status").textContent(), /passed/);
        await writeFile(join(artifacts, "node-review-evidence.json"), JSON.stringify({
            model: state.model, decision_map: map, test_run: state.testRun,
        }, null, 2));
        await page.screenshot({ path: join(artifacts, `node-${theme}-run-result.png`), fullPage: true });
        assert.equal((await git("status", "--short")).stdout, reviewedStatus, "explicit execution leaves the reviewed tree unchanged");
        assert.equal(state.testRunStale(), false, "owned runtime captures must not make an unchanged worktree run stale");
        assert.deepEqual(await page.locator(".linked-test .test-outcome").allTextContents(), ["passed", "passed"]);
        const resolverGroup = page.locator(".decision-group").filter({ hasText: "packages/core/src/resolver.js" });
        assert.match(await resolverGroup.locator('.decision-row[data-line="3"] .decision-evidence').textContent(), /Confirmed: executed by/);
        assert.match(await resolverGroup.locator('.decision-row[data-line="8"] .decision-evidence').textContent(), /Confirmed: executed by/);
        assert.match(await resolverGroup.locator('.decision-row[data-line="6"] .decision-evidence').textContent(), /Not executed/);
        await page.locator(".evidence-filter-confirmed").click();
        assert.equal(await page.locator(".decision-view .decision-row").count(), 2);
        await page.locator(".evidence-filter-untested").click();
        assert.equal(await resolverGroup.locator('.decision-row[data-line="6"]').count(), 1);
        await page.locator(".evidence-filter-all").click();
        for (const width of [1440, 560]) {
            await page.setViewportSize({ width, height: 1000 });
            const overflow = await page.locator(".verification-bar, .decision-row, .linked-test").evaluateAll((elements) => elements
                .filter((element) => element.scrollWidth > element.clientWidth + 1
                    || element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
                .map((element) => element.className));
            assert.deepEqual(overflow, [], `${theme}: evidence fits ${width}px`);
            await page.screenshot({ path: join(artifacts, `node-${theme}-paths-${width}.png`), fullPage: true });
        }
        await page.locator(".linked-test").first().click();
        await page.waitForFunction(() => /(?:resolver|missing-title)\.test\.mjs:\d+/.test(document.querySelector("#source-title")?.textContent || ""));
        await page.locator("#source-close").click();
        await resolverGroup.locator('.decision-row[data-line="3"]').click();
        await page.locator("#source-decisions").waitFor();
        assert.match(await page.locator("#source-decisions").textContent(), /Confirmed: executed by/);
        await page.screenshot({ path: join(artifacts, `node-${theme}-source-narrow.png`), fullPage: true });
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}: production npm workspace graph, JS/TS/JSX/TSX, exact lock versions, import/source links, explicit node:test, keyboard focus, narrow layout`);
    }
    await writeFile(join(artifacts, "node-review-evidence.json"), JSON.stringify({
        model: state.model, decision_map: map, test_run: { ...state.testRun, stale: state.testRunStale() },
        execution_marker: await readFile(marker, "utf8"),
        public_requests: publicRequests,
    }, null, 2));
    assert.deepEqual(publicRequests, [], "no real package provider is contacted");
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    if (previousMarker === undefined) delete process.env.AGENT_REVIEW_NODE_DEMO_MARKER;
    else process.env.AGENT_REVIEW_NODE_DEMO_MARKER = previousMarker;
    for (const [name, value] of Object.entries(previousTemp)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    globalThis.fetch = originalFetch;
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (process.env.AGENT_REVIEW_BROWSER_ARTIFACTS) await rm(scratchRoot, { recursive: true, force: true });
}
