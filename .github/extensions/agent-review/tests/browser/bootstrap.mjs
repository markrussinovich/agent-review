import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startSetupServer } from "../../../../../scripts/bootstrap/setup-server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repository = (await execute("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
const source = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
let state = { phase: "download", message: "Downloading the pinned Agent Review bundle...",
    received: 25, total: 100, repository, source };
let retries = 0;
const server = await startSetupServer(() => state, () => {
    retries++;
    state = { ...state, error: null, phase: "download", message: "Retrying preparation...", received: 0 };
}, { stylesPath: join(root, "web", "styles.css") });
let browser;
try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE
        || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    for (const theme of ["light", "dark"]) {
        for (const width of [1280, 390]) {
            state = { ...state, error: null, phase: "download", received: 25, total: 100,
                message: "Downloading the pinned Agent Review bundle..." };
            const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(server.url);
            await page.waitForFunction(() => document.querySelector("#repository").textContent.startsWith("Repository: "));
            assert((await page.locator("#repository").textContent()).includes(repository));
            assert.equal(await page.getAttribute("html", "data-theme"), theme);
            const override = theme === "light" ? "dark" : "light";
            await page.evaluate((value) => { document.documentElement.dataset.colorMode = value; }, override);
            await page.waitForFunction((value) => document.documentElement.dataset.theme === value, override);
            await page.evaluate((value) => { document.documentElement.dataset.colorMode = value; }, theme);
            await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
            assert.equal(await page.locator("progress").getAttribute("value"), "25");
            state = { ...state, phase: "extract", message: "Checksum verified. Preparing local extension files..." };
            await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Checksum verified."));
            assert.equal(await page.locator("progress").getAttribute("value"), null);
            state = { ...state, message: "Preparation failed.", error: "Bundle download failed: HTTP 503. Check network access to GitHub and retry." };
            await page.waitForFunction(() => !document.querySelector("#retry").hidden);
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement.id), "retry");
            assert.equal(await page.locator("#retry").evaluate((button) => getComputedStyle(button).outlineStyle), "solid");
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal overflow");
            if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
                await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `bootstrap-${theme}-${width}.png`), fullPage: true });
            }
            const previous = retries;
            await page.keyboard.press("Enter");
            await page.waitForFunction(() => document.querySelector("#status").textContent === "Retrying preparation...");
            assert.equal(retries, previous + 1);
            assert.equal(await page.locator("#error").isVisible(), false);
            assert.deepEqual(errors, []);
            await page.close();
        }
    }
    console.log("Bootstrap UI passed progress, error, keyboard retry, light/dark, and narrow-layout checks.");
} finally {
    await browser?.close();
    await server.close();
}
