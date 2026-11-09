import { openChangeDetails } from "./review-details-helper.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";


const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
// The Copilot app prepends its theme to <head> as inline :root styles and marks the tone on <html>.
// These are real values from a custom plum app theme plus a light theme, so nothing here matches Primer.
const copilotThemes = {
    dark: {
        "--background-color-default": "#371d32", "--background-color-muted": "#3b2439",
        "--border-color-default": "color-mix(in srgb, #7f687b 40%, transparent)", "--border-color-emphasis": "#7f687b",
        "--text-color-default": "#f2e2f1", "--text-color-muted": "#b8a8c9", "--text-color-accent": "#19d3db",
        "--text-color-link": "#19d3db", "--text-color-success": "#c1edcc", "--text-color-danger": "#fb9495",
        "--text-color-attention": "#a9cdd6", "--text-color-on-emphasis": "#371d32",
        "--background-color-accent-emphasis": "#1fd0d8",
        "--background-color-accent-muted": "color-mix(in oklch, #3b283c 70%, #483345)", "--color-focus-outline": "#1fd0d8",
        "--background-color-button-primary-rest": "#bfe9c9", "--background-color-button-primary-hover": "#c1edcc",
        "--text-color-button-primary-rest": "#371d32",
        "--background-color-diffBlob-addLine": "#4b3847", "--background-color-diffBlob-additionNum": "#5b4f57",
        "--text-color-diffBlob-addSign": "#c1edcc", "--background-color-diffBlob-delLine": "#512d40",
        "--background-color-overlay": "#3b2439",
        "--font-sans": "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans\", Helvetica, Arial, sans-serif",
        "--font-mono": "\"Monaspace Neon\", ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace",
    },
    light: {
        "--background-color-default": "#fbf7fa", "--background-color-muted": "#f3ecf1",
        "--border-color-default": "#d9cdd6", "--border-color-emphasis": "#8d7a89",
        "--text-color-default": "#2b1a27", "--text-color-muted": "#6b5a68", "--text-color-accent": "#0b7d83",
        "--text-color-link": "#0b7d83", "--text-color-success": "#1f7a4d", "--text-color-danger": "#b4233c",
        "--text-color-attention": "#8a5a00", "--text-color-on-emphasis": "#ffffff",
        "--background-color-accent-emphasis": "#0b7d83", "--background-color-accent-muted": "#dff3f4",
        "--color-focus-outline": "#0b7d83", "--background-color-button-primary-rest": "#1f7a4d",
        "--background-color-button-primary-hover": "#1b6c44", "--text-color-button-primary-rest": "#ffffff",
    },
};
const injectCopilotTheme = (page, tone) => page.evaluate(({ tone, tokens }) => {
    let style = document.head.querySelector("style[data-copilot-canvas-theme-defaults]");
    if (!style) {
        style = document.createElement("style");
        style.setAttribute("data-copilot-canvas-theme-defaults", "variables");
        document.head.prepend(style);
    }
    style.textContent = `:root{${Object.entries(tokens).map(([key, value]) => `${key}:${value}`).join(";")}}`;
    document.documentElement.setAttribute("data-theme-source", "external");
    document.documentElement.setAttribute("data-theme-tone", tone);
}, { tone, tokens: copilotThemes[tone] });
const addDiffProbe = (page) => page.evaluate(() => document.body.insertAdjacentHTML("beforeend",
    "<div id=\"theme-diff-probe\" class=\"code-row diff-add\" hidden><span class=\"line-number\">1</span><span class=\"diff-prefix\">+</span></div>"));
const computed = (page, selector, ...properties) => page.locator(selector).first().evaluate((node, properties) =>
    Object.fromEntries(properties.map((property) => [property, getComputedStyle(node)[property]])), properties);
const capture = async (page, name) => {
    if (!process.env.AGENT_REVIEW_SCREENSHOT_DIR) return;
    await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
    await openChangeDetails(page);
    await page.locator(".brief-ai").waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".brief-ai")]
        .every((node) => Number(getComputedStyle(node).opacity) === 1));
    await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `${name}.png`) });
};
const state = new ReviewState(process.cwd(), { baseRef: "main", generateLayerSummaries: async () => ({ intents: {}, titles: {} }),
    generateAnnotation: async () => "## Summary\n\n- Theme check on the actual repository.\n\n## Review order\n\n- Inspect colors and focus.\n\n## Gaps\n\n- Browser contract check, not an AI review." });
let server, browser;
try {
    await state.refresh();
    assert.equal(state.model.metadata.repo_root.toLowerCase(), process.cwd().toLowerCase());
    server = await startReviewServer(state);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE
        || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    for (const host of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1366, height: 950 },
            colorScheme: host === "light" ? "dark" : "light" });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (event) => { if (event.type() === "error") errors.push(`${event.text()} ${event.location().url}`); });
        await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
        await page.goto(server.url);
        await openChangeDetails(page);
        await page.locator("#summary .metric").first().waitFor();
        const system = host === "light" ? "dark" : "light";
        assert.equal(await page.getAttribute("html", "data-theme"), system);
        const applyHost = async (mode, target = "root", tokensTarget = target) => page.evaluate(({ mode, target, tokensTarget }) => {
            const root = document.documentElement;
            const receiver = target === "body" ? document.body : root;
            const tokens = tokensTarget === "body" ? document.body : root;
            receiver.setAttribute("data-color-mode", mode);
            const colors = mode === "dark" ? ["#20242a", "#f1f3f5", "#949ba4", "#45505c", "#539bf5"]
                : ["#faf8f5", "#24292f", "#626b75", "#c7cdd3", "#0969da"];
            ["--background-color-default", "--text-color-default", "--text-color-muted", "--border-color-default",
                "--color-focus-outline"].forEach((key, index) => tokens.style.setProperty(key, colors[index]));
        }, { mode, target, tokensTarget });
        await applyHost(host);
        await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, host);
        let colors = await page.locator("body").evaluate((node) => ({
            background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color,
        }));
        assert.deepEqual(colors, host === "dark" ? { background: "rgb(32, 36, 42)", color: "rgb(241, 243, 245)" }
            : { background: "rgb(250, 248, 245)", color: "rgb(36, 41, 47)" });
        await page.evaluate(() => document.documentElement.style.setProperty("--background-color-default", "#2b3138"));
        assert.equal(await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor),
            "rgb(43, 49, 56)", "Ambient color updates apply without a mode change or reload");
        await applyHost(host);
        await page.locator("#refresh").focus();
        assert.equal(await page.locator("#refresh").evaluate((node) => getComputedStyle(node).outlineColor),
            host === "dark" ? "rgb(83, 155, 245)" : "rgb(9, 105, 218)");
        for (const width of [1366, 560]) {
            await page.setViewportSize({ width, height: 950 });
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
                "Theme tokens must not disturb responsive layout");
            await capture(page, `ambient-${host}-${width}`);
        }
        await applyHost(system);
        await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, system);
        await page.emulateMedia({ colorScheme: host });
        assert.equal(await page.getAttribute("html", "data-theme"), system, "OS changes cannot override the app");
        await page.evaluate(() => document.documentElement.removeAttribute("data-color-mode"));
        await applyHost(host, "body");
        await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, host);
        colors = await page.locator("body").evaluate((node) => ({
            background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color,
        }));
        assert.deepEqual(colors, host === "dark" ? { background: "rgb(32, 36, 42)", color: "rgb(241, 243, 245)" }
            : { background: "rgb(250, 248, 245)", color: "rgb(36, 41, 47)" });
        await page.reload();
        assert.equal(await page.getAttribute("html", "data-theme"), host, "Standalone fallback follows OS after reload");
        await page.emulateMedia({ colorScheme: system });
        await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, system);
        await page.goto(`${server.url}?scoutTheme=${host}`);
        await applyHost(system);
        assert.equal(await page.getAttribute("html", "data-theme"), host);
        assert.equal(await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor),
            host === "dark" ? "rgb(21, 27, 35)" : "rgb(246, 248, 250)", "Explicit preview keeps Primer colors");
        assert.deepEqual(errors, []);
        await page.close();
    }
    {
        // Replay the Copilot app's real injection: inline <style> tokens plus data-theme-tone, on an OS in the other mode.
        const page = await browser.newPage({ viewport: { width: 1366, height: 950 }, colorScheme: "light" });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (event) => { if (event.type() === "error") errors.push(`${event.text()} ${event.location().url}`); });
        await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
        await page.goto(server.url);
        await openChangeDetails(page);
        await page.locator("#summary .metric").first().waitFor();
        await injectCopilotTheme(page, "dark");
        await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
        assert.equal(await page.getAttribute("html", "data-agent-review-theme"), "host");
        assert.deepEqual(await computed(page, "body", "backgroundColor", "color"),
            { backgroundColor: "rgb(55, 29, 50)", color: "rgb(242, 226, 241)" }, "Inline app theme styles apply under the CSP");
        assert.equal((await computed(page, ".rail", "backgroundColor")).backgroundColor, "rgb(55, 29, 50)");
        assert.equal((await computed(page, ".rail-resize", "backgroundColor")).backgroundColor, "rgb(59, 36, 57)");
        assert.deepEqual(await computed(page, "#file-review-next", "backgroundColor", "color"),
            { backgroundColor: "rgb(191, 233, 201)", color: "rgb(55, 29, 50)" }, "Primary text follows the app, not white");
        assert.match((await computed(page, ".metric strong", "fontFamily")).fontFamily, /Monaspace Neon/);
        await page.locator("#refresh").focus();
        assert.equal((await computed(page, "#refresh", "outlineColor")).outlineColor, "rgb(31, 208, 216)");
        await addDiffProbe(page);
        assert.equal((await computed(page, "#theme-diff-probe", "backgroundColor")).backgroundColor, "rgb(75, 56, 71)",
            "Diff rows use the app's own diff colors");
        assert.deepEqual(await computed(page, "#theme-diff-probe > .diff-prefix", "backgroundColor", "color"),
            { backgroundColor: "rgb(91, 79, 87)", color: "rgb(193, 237, 204)" });
        assert.equal((await computed(page, ".workspace-explore > div", "backgroundColor")).backgroundColor, "rgb(59, 36, 57)",
            "Menus use the app's overlay color");
        for (const width of [1366, 560]) {
            await page.setViewportSize({ width, height: 950 });
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await capture(page, `ambient-copilot-dark-${width}`);
        }
        await injectCopilotTheme(page, "light");
        await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
        assert.deepEqual(await computed(page, "body", "backgroundColor", "color"),
            { backgroundColor: "rgb(251, 247, 250)", color: "rgb(43, 26, 39)" }, "Live app theme switches apply");
        assert.deepEqual(await computed(page, "#file-review-next", "backgroundColor", "color"),
            { backgroundColor: "rgb(31, 122, 77)", color: "rgb(255, 255, 255)" });
        assert.notEqual((await computed(page, "#theme-diff-probe", "backgroundColor")).backgroundColor, "rgb(75, 56, 71)",
            "A theme without diff tokens falls back instead of keeping the previous theme's diff colors");
        for (const width of [1366, 560]) {
            await page.setViewportSize({ width, height: 950 });
            await capture(page, `ambient-copilot-light-${width}`);
        }
        await page.goto(`${server.url}?scoutTheme=dark`);
        await injectCopilotTheme(page, "dark");
        await addDiffProbe(page);
        assert.equal(await page.getAttribute("html", "data-agent-review-theme"), "override");
        assert.equal((await computed(page, "body", "backgroundColor")).backgroundColor, "rgb(21, 27, 35)");
        assert.notEqual((await computed(page, "#theme-diff-probe", "backgroundColor")).backgroundColor, "rgb(75, 56, 71)",
            "Explicit previews keep Primer diffs inside a themed app");
        assert.notEqual((await computed(page, ".workspace-explore > div", "backgroundColor")).backgroundColor, "rgb(59, 36, 57)");
        assert.deepEqual(errors, [], "No Content-Security-Policy or page errors");
        await page.close();
    }
    console.log("Actual repository theme checks passed: Copilot app style injection and tone, app colors, diff and menu colors, live mode changes, body/root injection, focus, narrow layout, OS fallback, and preview overrides.");
} finally {
    await browser?.close();
    await server?.close();
    await state.dispose();
}
