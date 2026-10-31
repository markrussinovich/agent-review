import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";
import { annotationHeadings } from "../../ai-prompts.mjs";

const repo = process.env.AGENT_REVIEW_UX_REPO;
if (!repo) throw new Error("Set AGENT_REVIEW_UX_REPO to a real changed repository.");
const path = process.env.AGENT_REVIEW_MARKDOWN_PATH || "extensions/radius/skills/radius-app-bicep/references/runtime-contract.md";
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const directory = await mkdtemp(join(tmpdir(), "markdown-browser-"));
let browser, server, state, activePage;
try {
    const calls = [];
    state = new ReviewState(repo, {
        workspacePath: directory, baseRef: "HEAD", readWorktreeFingerprint: null,
        getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
        generateAnnotation: async (context) => {
            calls.push(context);
            return (context.kind === "overview" ? ["Summary", "Review order", "Gaps"] : annotationHeadings(context))
                .map((heading) => `## ${heading}\n\n${heading === "What changed and how obligations change"
                    ? `Controlled browser response: before \`base:${path}:1\`; after \`current:${path}:2\`.`
                    : "Controlled browser response; validates presentation only."}`).join("\n\n");
        },
    });
    if (process.env.AGENT_REVIEW_UX_MODEL) {
        state.model = JSON.parse(await readFile(process.env.AGENT_REVIEW_UX_MODEL, "utf8"));
        for (const saved of Object.values(state.model.source_files)) if (saved.baseline_same) saved.baseline = saved.current;
        await state.rolesForReview();
    } else await state.refresh();
    assert.equal(state.model.instruction_documents.current.documents[path].role, "instructions");
    const progress = await state.progressForReview();
    assert.equal(progress.durable, true);
    server = await startReviewServer(state);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE });
    const errors = [];
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
        activePage = page;
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.getByRole("button", { name: /Browse all \d+ files?/ }).click();
        await page.getByRole("button", { name: "Files", exact: true }).click();
        await page.getByLabel("Find a changed file or group").fill(path);
        await page.locator(`.workspace-file[data-path="${path}"]:visible`).first().click();
        const panel = page.locator("#source-review-context");
        await panel.getByRole("heading", { name: "Document role", exact: true }).waitFor();
        assert.match(await panel.innerText(), /Agent instructions · Current saved snapshot/);
        assert.match(await panel.innerText(), /SKILL\.md:\d+.*prescribes use of/s);
        assert.match(await panel.innerText(), /Observed agent behavior: unavailable/);
        assert.match(await panel.innerText(), /not proof that an agent received, read, or obeyed/);
        for (const [side, line] of [["base", 1], ["current", 2]]) {
            const citation = page.locator("#source-annotation").getByRole("button", { name: `${side}:${path}:${line}`, exact: true });
            await citation.waitFor();
            await citation.focus();
            const [request] = await Promise.all([
                page.waitForRequest((request) => {
                    const url = new URL(request.url());
                    return url.pathname === "/api/source" && url.searchParams.get("side") === side
                        && url.searchParams.get("path") === path && url.searchParams.get("line") === String(line);
                }),
                citation.press("Enter"),
            ]);
            assert.equal(new URL(request.url()).searchParams.get("side"), side);
            await page.waitForFunction((side) => document.querySelector("#source-review-context")?.textContent
                .includes(side === "base" ? "Base saved snapshot" : "Current saved snapshot"), side);
        }
        await panel.getByRole("button", { name: "Classification evidence", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#source-title")?.textContent.includes("SKILL.md"));
        await page.locator(`.workspace-file[data-path="${path}"]:visible`).first().click();
        await page.waitForFunction((path) => document.querySelector("#source-title")?.textContent.endsWith(path.split("/").at(-1)), path);
        await panel.getByRole("heading", { name: "Document role", exact: true }).waitFor();
        await page.getByRole("button", { name: "Base", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#source-review-context")?.textContent.includes("Base saved snapshot"));
        await page.getByRole("button", { name: "Diff", exact: true }).click();
        await panel.getByLabel("Correct document role").selectOption("documentation");
        await page.route("**/api/document-roles", async (route) => {
            if (route.request().method() === "POST") await route.fulfill({
                status: 409, contentType: "application/json", body: JSON.stringify({ error: "Role revision changed elsewhere. Reload before retrying." }),
            });
            else await route.continue();
        });
        await panel.getByRole("button", { name: "Save role", exact: true }).click();
        await panel.getByRole("status").filter({ hasText: "Unable to save:" }).waitFor();
        assert.equal(await panel.getByRole("button", { name: "Save role", exact: true }).isEnabled(), true);
        await page.unroute("**/api/document-roles");
        await panel.getByRole("button", { name: "Save role", exact: true }).click();
        await page.waitForFunction(() => {
            const text = document.querySelector("#source-review-context")?.textContent || "";
            return text.includes("Ordinary documentation · Current saved snapshot") && text.includes("Reviewer correction");
        });
        await page.reload();
        await page.getByRole("button", { name: /Browse all \d+ files?/ }).click();
        await page.getByRole("button", { name: "Files", exact: true }).click();
        await page.getByLabel("Find a changed file or group").fill(path);
        await page.locator(`.workspace-file[data-path="${path}"]:visible`).first().click();
        await page.waitForFunction(() => document.querySelector("#source-review-context")?.textContent.includes("Reviewer correction"));
        await panel.getByRole("button", { name: "Reset to analyzer", exact: true }).click();
        await page.waitForFunction(() => {
            const text = document.querySelector("#source-review-context")?.textContent || "";
            return text.includes("Agent instructions · Current saved snapshot") && !text.includes("Reviewer correction");
        });
        await panel.getByLabel("Correct document role").focus();
        assert.equal(await panel.getByLabel("Correct document role").evaluate((node) => node === document.activeElement), true);
        await panel.getByLabel("Correct document role").press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Save role");
        await page.getByRole("button", { name: "Ask for a deeper walkthrough", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#item-question")?.value.includes("before/after obligations"));
        assert.doesNotMatch(await page.locator("#item-question").inputValue(), /control flow/);
        await page.getByRole("button", { name: "Evidence", exact: true }).click();
        const outgoing = panel.locator("summary").filter({ hasText: "Local and external references" });
        await outgoing.click();
        assert.equal(await outgoing.evaluate((summary) => summary.parentElement.open), true);
        await outgoing.click();
        await panel.getByRole("heading", { name: "Document role", exact: true }).scrollIntoViewIfNeeded();
        const screenshot = async (label) => {
            if (!process.env.AGENT_REVIEW_BROWSER_ARTIFACTS) return;
            await mkdir(process.env.AGENT_REVIEW_BROWSER_ARTIFACTS, { recursive: true });
            await page.evaluate(async () => {
                await Promise.all(document.getAnimations().filter((animation) =>
                    Number.isFinite(animation.effect?.getTiming().iterations)).map((animation) => animation.finished.catch(() => {})));
            });
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_BROWSER_ARTIFACTS, `${label}-${theme}.png`) });
        };
        await screenshot("markdown-wide");
        await page.setViewportSize({ width: 420, height: 900 });
        const contextButton = page.getByRole("button", { name: "Context / Discussion", exact: true });
        if (await contextButton.isVisible()) await contextButton.click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await panel.getByLabel("Correct document role").focus();
        await panel.getByLabel("Correct document role").press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Save role");
        await panel.getByRole("button", { name: "Save role", exact: true }).scrollIntoViewIfNeeded();
        const saveBox = await panel.getByRole("button", { name: "Save role", exact: true }).boundingBox();
        const footerBox = await page.locator("#file-review-form").boundingBox();
        assert.ok(saveBox.y + saveBox.height <= footerBox.y, "Role controls must scroll above the fixed decision footer.");
        await screenshot("markdown-narrow");
        await page.close();
        activePage = null;
    }
    assert.deepEqual(errors, []);
    assert.ok(calls.some((context) => context.instruction_context?.role === "instructions"));
    assert.ok(calls.some((context) => context.instruction_context?.role === "documentation"));
    assert.deepEqual((await state.progressForReview()).entries, progress.entries);
    console.log("Markdown UI: roles, source navigation, before/after, save conflicts, correction/reset/reopen, discussion, keyboard focus, light/dark and narrow layouts passed.");
} catch (error) {
    if (activePage) {
        console.error((await activePage.locator("#source-review-context").innerText()).slice(0, 1500));
        console.error(await activePage.locator("body").innerText().then((text) => text.slice(-2000)));
        if (process.env.AGENT_REVIEW_BROWSER_ARTIFACTS) {
            await mkdir(process.env.AGENT_REVIEW_BROWSER_ARTIFACTS, { recursive: true });
            await activePage.screenshot({ path: join(process.env.AGENT_REVIEW_BROWSER_ARTIFACTS, "markdown-failure.png") });
        }
    }
    throw error;
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(directory, { recursive: true, force: true });
}
