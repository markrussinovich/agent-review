import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), "review-source-scroll-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
const prompt = Array.from({ length: 40 }, () =>
    "Review the new functions and verify their behavior against the requested changes.").join("\n");
let state, server, browser;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "baseline.py"), "value = 0\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    for (const name of ["first", "second"]) {
        await writeFile(join(repo, `${name}.py`), [
            ...Array.from({ length: 240 }, (_, index) => `# ${name} context ${index} ${"padding ".repeat(40)}`),
            `def ${name}_target():`, "    return 1", "",
        ].join("\n"));
    }
    state = new ReviewState(repo, {
        baseRef: "HEAD",
        getHistoricalSessionContexts: async () => ({
            contexts: [{
                session_id: "scroll-fixture", intent: [], recent_activity: [],
                referenced_files: ["first.py", "second.py"], event_count: 1,
                turns: [{
                    id: "scroll-request", session_id: "scroll-fixture",
                    started_at: "2026-10-01T10:00:00Z", prompt,
                    referenced_files: ["first.py", "second.py"],
                    agent_activity: [{
                        operation: "write", timestamp: "2026-10-01T10:01:00Z",
                        referenced_files: ["first.py", "second.py"],
                    }],
                }],
            }], failures: [],
        }),
        generateAnnotation: async () =>
            "## Summary\n\n- Inspect the saved source.\n\n## Review order\n\n- Verify the highlighted function.\n\n## Gaps\n\n- Coverage unknown.",
    });
    await state.refresh();
    server = await startReviewServer(state);
    const executablePath = process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
    for (const theme of ["light", "dark"]) {
        for (const width of [1280, 560]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${server.url}?scoutTheme=${theme}`);
            await page.locator("#change-brief .brief-ai").waitFor();
            const symbol = state.model.nodes.find((node) => node.name === "first_target");
            const module = state.model.nodes.find((node) => node.id === symbol.module_id);
            const component = state.model.nodes.find((node) => node.id === symbol.component_id);
            await page.locator(`.node[aria-label^="${component.name},"]`).click();
            await page.locator(`.node[aria-label^="${module.name},"]`).click();
            await page.locator('.node[aria-label^="first_target,"]').click();
            await page.locator("#source .focus-start").waitFor();
            assert.equal(await page.locator("#source").evaluate((code) => code.scrollTop), 0,
                "a new diff starts at the top, even when the highlighted function is near the end");
            assert.match(await page.locator("#source .focus-start").textContent(), /def first_target/);
            await page.locator('.tab[data-tab="current"]').click();
            assert.ok(await page.locator("#source").evaluate((code) => code.scrollTop > 0),
                "explicit source tabs still navigate to the referenced line");
            await page.locator('.tab[data-tab="diff"]').click();
            assert.equal(await page.locator("#source").evaluate((code) => code.scrollTop), 0);
            await page.locator("#source-provenance .provenance-prompt").waitFor();
            await page.locator("#source-annotation .annotation-body").waitFor();
            await page.locator("#source-provenance").getByRole("button", { name: "Show full prompt" }).click();
            const scrolled = await page.evaluate(() => {
                const code = document.querySelector("#source");
                const side = document.querySelector(".source-side");
                code.scrollTop = 1500;
                code.scrollLeft = 100;
                side.scrollTop = side.scrollHeight;
                return { code: code.scrollTop, horizontal: code.scrollLeft, side: side.scrollTop };
            });
            assert.ok(scrolled.code > 0 && scrolled.side > 0, "both panes must genuinely scroll");
            if (width === 1280) assert.ok(scrolled.horizontal > 0);
            await page.click("#source-close");
            await page.locator("#summary .metric").filter({ hasText: "Files" }).click();
            for (const name of ["second", "first"]) {
                await page.locator(".collection-row").filter({ hasText: `${name}.py` }).click();
                await page.waitForFunction((path) =>
                    document.querySelector("#source-title").textContent === path, `${name}.py`);
                await page.locator("#source-annotation .annotation-body").waitFor();
                assert.deepEqual(await page.evaluate(() => ({
                    code: document.querySelector("#source").scrollTop,
                    horizontal: document.querySelector("#source").scrollLeft,
                    side: document.querySelector(".source-side").scrollTop,
                })), { code: 0, horizontal: 0, side: 0 }, "new and reopened diffs reset both panes");
                await page.locator("#source").evaluate((code) => { code.scrollTop = 1000; });
                await page.locator(".source-side").evaluate((side) => { side.scrollTop = side.scrollHeight; });
                await page.click("#source-close");
            }
            assert.deepEqual(errors, []);
            await page.close();
            console.log(`PASS ${theme} ${width}px: new/reopened diffs and briefing panes start at top; highlights and source-tab focus retained`);
        }
    }
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(repo, { recursive: true, force: true });
}
