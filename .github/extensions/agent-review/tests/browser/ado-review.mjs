import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const execute = promisify(execFile);
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const root = await mkdtemp(join(tmpdir(), "ado-browser-"));
const repo = join(root, "upstream");
const prUrl = "https://dev.azure.com/example/Project%20One/_git/sample/pullrequest/42";
const metadata = { id: "11111111-1111-1111-1111-111111111111", name: "sample",
    project: { id: "22222222-2222-2222-2222-222222222222", name: "Project One" } };
let browser;
try {
    await mkdir(repo);
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    await git("init", "-qb", "main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "main.py"), "def run():\n    return 1\n");
    await git("add", ".");
    await git("commit", "-qm", "Base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("switch", "-qc", "feature");
    await writeFile(join(repo, "main.py"), "def run():\n    return 2\n");
    await git("commit", "-qam", "Feature");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(repo, "main.py"), "def dirty_only():\n    return 999\n");
    const before = (await git("status", "--porcelain=v1")).stdout;
    const pr = { pullRequestId: 42, repository: metadata, status: "active", supportsIterations: true,
        title: "Validate fallback boundary", description: "Change the saved return value.",
        sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", lastMergeTargetCommit: { commitId: base },
        createdBy: { displayName: "Author" }, creationDate: "2026-10-10T01:00:00Z", isDraft: true };
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync) });
    for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
        let moved = false, failList = false, submissions = 0;
        const client = async (_, suffix = "", options = {}) => {
            assert.ok(!options.method || options.method === "GET");
            if (!suffix) return metadata;
            if (suffix === "/pullRequests") {
                if (failList) throw new Error("Azure DevOps returned HTTP 403. Check az login and repository read permissions.");
                return { value: [pr, { ...pr, pullRequestId: 43, status: "completed", closedDate: "2026-10-11T01:00:00Z" }] };
            }
            if (suffix.endsWith("/iterations")) return { value: [{ id: 3,
                sourceRefCommit: { commitId: head }, targetRefCommit: { commitId: base }, commonRefCommit: { commitId: base } }] };
            if (suffix === "/refs") return { value: [
                { name: pr.sourceRefName, objectId: moved ? base : head }, { name: pr.targetRefName, objectId: base },
            ] };
            return pr;
        };
        const run = (file, args, options) => {
            assert.ok(!args.includes("clone") && !args.includes("checkout"));
            if (args.includes("get-url")) return Promise.resolve({ stdout:
                "https://dev.azure.com/example/Project%20One/_git/sample\n" });
            if (args.includes("fetch")) {
                const local = [...args];
                local[local.length - 2] = repo;
                return execute(file, local, options);
            }
            return execute(file, args, options);
        };
        const state = new ReviewState(repo, { baseRef: base, adoClient: client, runTargetCommand: run,
            submitHandoffReview: async () => { submissions++; throw new Error("ADO must never reach a publisher"); } });
        await state.refresh();
        const server = await startReviewServer(state);
        const page = await browser.newPage({ viewport: { width, height: 950 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
            await page.goto(`${server.url}?scoutTheme=${theme}`);
            await page.locator("#review-mode").selectOption("pr");
            await page.waitForFunction(() => !document.querySelector("#review-ref").disabled);
            assert.equal(await page.locator("#review-remote").count(), 0, "no remote selector is added");
            await page.locator("#review-mode").focus();
            await page.keyboard.press("Tab");
            assert.equal(await page.locator("#review-ref").evaluate((element) => element === document.activeElement), true);
            assert.match(await page.locator("#review-ref option").nth(1).textContent(), /active · draft.*created /);
            assert.match(await page.locator("#review-ref option").nth(2).textContent(), /completed.*closed /);
            await page.locator("#review-ref").selectOption(prUrl);
            await page.waitForFunction(() => !document.querySelector("#review-mode").disabled);
            assert.equal(state.reviewTarget.provider, "ado");
            assert.equal(state.model.metadata.head_sha, head);
            assert.equal(state.model.metadata.base_sha, base);
            assert.match((await state.sourceForPath("main.py")).current, /return 2/);
            assert.doesNotMatch((await state.sourceForPath("main.py")).current, /dirty_only/);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
            await page.locator("#workflow-finish").click();
            await page.getByRole("button", { name: "Preview / export handoff", exact: true }).click();
            await page.locator("#handoff-provider-status").getByText(/read-only; publishing is unavailable/).waitFor();
            assert.equal(await page.locator("#handoff-confirm").isDisabled(), true);
            assert.equal(await page.locator("#handoff-submit").isDisabled(), true);
            assert.equal(await page.locator("#handoff-markdown-save").isEnabled(), true);
            assert.equal(await page.locator("#handoff-state-save").isEnabled(), true);
            assert.match(await page.locator("#handoff-markdown").inputValue(), /Iteration: 3/);
            if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
                await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `ado-read-only-${theme}-${width}.png`) });
            }
            await page.keyboard.press("Escape");
            await page.locator("#workflow-overview").click();
            failList = true;
            await page.locator("#review-list-refresh").click();
            await page.locator("#review-options-status").getByText(/HTTP 403/).waitFor();
            failList = false;
            await page.locator("#review-list-refresh").click();
            await page.locator("#review-options-status").getByText(/list refreshed/).waitFor();
            moved = true;
            const loaded = state.model;
            await page.locator("#review-ref").selectOption(prUrl);
            await page.locator("#review-picker-notice").getByText(/PR branches changed/).waitFor();
            assert.equal(state.model, loaded, "a failed snapshot validation must not replace the loaded model");
            assert.equal(submissions, 0);
            assert.equal((await git("status", "--porcelain=v1")).stdout, before);
            assert.deepEqual(errors, []);
            console.log(`PASS ${theme}/${width}: read-only ADO list from origin, keyboard focus, created/closed dates, pinned source, unavailable publishing, recoverable errors`);
        } finally {
            await page.close();
            await server.close();
            await state.dispose();
        }
    }
} finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
