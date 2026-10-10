import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const state = new ReviewState(process.cwd(), { baseRef: "main",
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
            if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
                await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
                await page.locator(".brief-ai").waitFor();
                await page.waitForFunction(() => [...document.querySelectorAll(".brief-ai")]
                    .every((node) => Number(getComputedStyle(node).opacity) === 1));
                await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `ambient-${host}-${width}.png`) });
            }
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
    console.log("Actual repository theme checks passed: app colors, live mode changes, body/root injection, focus, narrow layout, OS fallback, and preview overrides.");
} finally {
    await browser?.close();
    await server?.close();
    await state.dispose();
}
