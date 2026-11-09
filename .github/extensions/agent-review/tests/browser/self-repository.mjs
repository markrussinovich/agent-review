import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";
import { openChangeDetails } from "./review-details-helper.mjs";

// Use complete production analyzer outputs from the actual repository, not fixtures.
const paths = [process.env.AGENT_REVIEW_SELF_REPORT, process.env.AGENT_REVIEW_EXCLUDED_REPORT];
assert.ok(paths.every(Boolean), "Set AGENT_REVIEW_SELF_REPORT and AGENT_REVIEW_EXCLUDED_REPORT to production analyzer JSON outputs.");
const reports = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
const execute = promisify(execFile);
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const artifacts = process.env.AGENT_REVIEW_BROWSER_ARTIFACTS;
if (artifacts) await mkdir(artifacts, { recursive: true });
let browser;
try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE
        || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    for (const [index, report] of reports.entries()) {
        assert.equal(report.metadata.repo_root.toLowerCase(), process.cwd().toLowerCase());
        const { base_sha: base, head_sha: head } = report.metadata;
        const expected = (await execute("git", ["diff", "--name-only", "--no-renames", "-z", base, head])).stdout.split("\0").filter(Boolean);
        const source = expected.find((path) => path.startsWith(".github/extensions/agent-review/") && path.endsWith(".mjs"));
        assert.ok(source, "The real comparison must change extension source.");
        if (!index) {
            assert.deepEqual(report.changes.filter((change) => change.status !== "unchanged").map((change) => change.path).sort(), expected.sort());
            assert.ok(report.source_files[source].baseline);
            assert.ok(report.source_files[source].current);
        } else {
            assert.equal(report.summary.files_changed, 0);
            assert.equal(report.metadata.snapshot_exclusions.changed_files, expected.length);
            assert.ok(report.metadata.snapshot_exclusions.rules.every((rule) => rule.reason === "user"));
        }
        const state = new ReviewState(process.cwd(), {
            baseRef: base, reviewTarget: { mode: "commit", baseRef: base, currentRef: head, label: `Commit ${head.slice(0, 7)}` },
            runAnalyzer: async () => report,
            getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
            generateAnnotation: async () => "## Evidence\n\nProduction saved-source UI check; no AI review was performed.",
        });
        state.startCustomAnalyses = () => {};
        let server;
        try {
            await state.refresh();
            server = await startReviewServer(state);
            for (const theme of ["light", "dark"]) {
                const page = await browser.newPage({ viewport: { width: 1366, height: 950 } });
                const errors = [];
                page.on("pageerror", (error) => errors.push(error.message));
                await page.goto(`${server.url}?scoutTheme=${theme}`);
                if (!index) {
                    await openChangeDetails(page);
                    await page.locator("#summary .metric").filter({ hasText: "Files" }).click();
                    await page.locator(".collection-row").filter({ hasText: source }).click();
                    await page.locator("#source-panel:not(.hidden)").waitFor();
                    assert.match(await page.locator("#source-title").textContent(), new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
                    const current = page.getByRole("button", { name: "Current", exact: true });
                    await current.click();
                    assert.ok((await page.locator("#source").textContent()).includes(report.source_files[source].current.split("\n").find((line) => line.trim())));
                    await page.getByRole("button", { name: "Base", exact: true }).click();
                    if (artifacts) await page.screenshot({ path: join(artifacts, `self-source-base-${theme}.png`) });
                    await page.locator("#source-close").click();
                    await openChangeDetails(page);
                } else {
                    await page.locator("#clean-review").waitFor();
                    assert.match(await page.locator("#clean-review p").textContent(), /changed files? excluded by snapshot rules/);
                    assert.match(await page.locator("#clean-review p").textContent(), /explicit exclude/);
                    assert.equal(await page.locator("#review-overview").isVisible(), false, "Empty reviews do not show a faded Start review panel.");
                    assert.equal(await page.locator("#review-background").isVisible(), false);
                }
                for (const width of [1366, 560]) {
                    await page.setViewportSize({ width, height: 950 });
                    await page.locator("#refresh").focus();
                    assert.equal(await page.evaluate(() => document.activeElement.id), "refresh");
                    await page.keyboard.press("Tab");
                    assert.notEqual(await page.evaluate(() => document.activeElement.tagName), "BODY");
                    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No horizontal page overflow.");
                    if (artifacts) await page.screenshot({ path: join(artifacts, `self-source-${index ? "excluded" : "included"}-${theme}-${width}.png`) });
                }
                assert.deepEqual(errors, []);
                await page.close();
            }
        } finally {
            await server?.close();
            await state.dispose();
        }
    }
    console.log("Real repository saved Base/Current source, exclusion counts/reasons, light/dark, narrow layout, keyboard focus: passed.");
} finally {
    await browser?.close();
}
