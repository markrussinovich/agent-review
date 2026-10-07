import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), "review-warning-list-"));
let browser, server, state;
try {
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "main.py"), "def run():\n    return 1\n");
    await writeFile(join(repo, "src", "App.csproj"), "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n");
    await git("add", ".");
    await git("commit", "-qm", "baseline");
    await writeFile(join(repo, "main.py"), "def run():\n    return 2\n");
    state = new ReviewState(repo, { baseRef: "HEAD",
        generateAnnotation: async () => "## Summary\n\n- Changed return.\n\n## Review order\n\n- Main.\n\n## Gaps\n\n- Types." });
    await state.refresh();
    await state.decisionMapFor();
    state.model.warnings = [
        "[Base] main.py:2: unresolved call dynamic.value; target is unknown.",
        "baseline: src/App.csproj@net10.0: PackageReference 'Newtonsoft.Json' unavailable; no restore or assembly loading from reviewed paths.",
        "current: src/App.csproj@net10.0: implicit SDK usings unavailable; unresolved unqualified names remain unresolved.",
        "current: src/App.csproj@net10.0: configuration incomplete; only supported literal XML and supplied sources were analyzed.",
        ...Array.from({ length: 75 }, (_, index) => `Additional analyzer limitation ${index + 1}: source resolution is incomplete.`),
    ];
    state.decisionMap = { status: "error",
        error: 'Decision extraction failed: Invalid command format. Did you mean: copilot -i "node-codepaths.mjs --input request.json"?' };
    server = await startReviewServer(state);
    browser = await chromium.launch({ headless: true,
        executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.locator(".quality-warning").click();
        const list = page.locator("#detail .analysis-warning-list");
        await list.waitFor();
        assert.equal(await list.locator(":scope > li").count(), 79, "one semantic list item per note");
        assert.equal(await list.evaluate((node) => node.clientHeight <= Math.min(window.innerHeight * 0.6, 600) + 1
            && node.scrollHeight > node.clientHeight), true, "long lists scroll without stretching the page");
        assert.equal(await list.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
            return node.scrollTop > 0;
        }), true, "all notes remain reachable by scrolling");
        assert.equal(await page.locator("#detail .factor-chips").count(), 0, "analysis notes are not chips");
        assert.match(await page.locator("#detail .analysis-warning-intro").textContent(), /not confirmed code defects/);
        assert.match(await list.textContent(), /Package assembly not loaded.*Newtonsoft.Json.*Base.*net10\.0/s);
        assert.match(await list.textContent(), /does not mean your installed package is missing/);
        await list.getByRole("button", { name: "main.py:2", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#source-title").textContent === "main.py:2");
        assert.equal(await page.locator(".tab.active").textContent(), "Base");
        assert.match(await page.locator("#source .focus-start").textContent(), /return 1/);
        await page.locator("#source-close").click();
        await list.getByRole("button", { name: "src/App.csproj", exact: true }).nth(0).click();
        await page.waitForFunction(() => document.querySelector("#source-title").textContent === "src/App.csproj");
        assert.equal(await page.locator(".tab.active").textContent(), "Base", "baseline project note opens its saved base file");
        await page.locator("#source-close").click();
        await list.getByRole("button", { name: "src/App.csproj", exact: true }).nth(1).click();
        await page.waitForFunction(() => document.querySelector(".tab.active").textContent === "Current");
        await page.locator("#source-close").click();
        await page.setViewportSize({ width: 560, height: 900 });
        assert.equal(await list.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, "warning list wraps in narrow detail pane");
        const failureMap = state.decisionMap;
        state.decisionMap = { status: "complete", callables: [], totals: {}, warnings: state.model.warnings };
        state.broadcast("decisions");
        await page.locator("#summary .metric").filter({ hasText: "Code paths" }).click();
        const codeNotes = page.locator(".code-path-notes");
        await codeNotes.locator(":scope > summary").click();
        assert.equal(await codeNotes.locator(".analysis-warning-list > li").count(), 79, "code-path notes share the same linked list");
        await codeNotes.getByRole("button", { name: "src/App.csproj", exact: true }).nth(0).click();
        await page.waitForFunction(() => document.querySelector("#source-title").textContent === "src/App.csproj"
            && !document.querySelector("#source-panel").classList.contains("hidden")
            && document.querySelector(".tab.active").textContent === "Base");
        assert.equal(await page.locator(".tab.active").textContent(), "Base");
        await page.locator("#source-close").click();
        state.decisionMap = failureMap;
        state.broadcast("decisions");
        const failure = page.locator(".code-path-error");
        await failure.waitFor();
        assert.match(await failure.textContent(), /analyzer failure, not a finding about your code/);
        assert.match(await failure.textContent(), /Reload extensions and reopen/);
        await failure.locator("summary").click();
        assert.match(await failure.locator("pre").textContent(), /Invalid command format/);
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}: explanatory warning list, Base/Current project links, narrow layout, separate readable extraction failure`);
    }
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
