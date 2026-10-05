import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const root = dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch(t, executable, args, config, environment = {}) {
    const directory = join(root, `.native-review-${randomUUID()}`);
    await mkdir(join(directory, "workspace"), { recursive: true });
    const configFile = join(directory, "config.json");
    await writeFile(configFile, JSON.stringify({ ...config, workspacePath: join(directory, "workspace") }));
    const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
            ...process.env,
            ...environment,
            AGENT_REVIEW_NATIVE_CONFIG: configFile,
            AGENT_REVIEW_STATE_DIR: join(directory, "markers"),
            COPILOT_EXTENSION_PARENT_PID: String(process.pid),
        },
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { errors += data; });
    const closed = new Promise((resolve) => child.once("close", resolve));
    t.after(async () => {
        if (child.connected) child.send({ type: "shutdown" });
        await closed;
        await rm(directory, { recursive: true, force: true });
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const ready = output.split(/\r?\n/).find((line) => line.startsWith('{"type":"ready"'));
        if (ready) return { child, directory, ...JSON.parse(ready) };
        assert.equal(child.exitCode, null, `Provider exited: ${errors}`);
        await sleep(30);
    }
    assert.fail(`Provider did not register its Canvas marker: ${errors}`);
}

test("ownership guards do not inherit provider bootstrap imports", { timeout: 20000 }, async (t) => {
    const preload = join(root, `.guard-preload-${randomUUID()}.mjs`);
    await writeFile(preload, 'if (process.argv[1]?.endsWith("ownership-guard.mjs")) process.exit(42);\n');
    t.after(() => rm(preload, { force: true }));
    const result = await launch(t, process.execPath,
        ["--import", pathToFileURL(preload).href, join(root, "native-review-provider.mjs")], { repo: root });
    assert.equal(result.embedded, false);
    await access(join(result.directory, "markers", "native-review-test__canvas.json"));
});

test("embedded Copilot runtime opens RefChecker and cancels actual Python graph analysis", {
    skip: !process.env.AGENT_REVIEW_NATIVE_CLI || !process.env.AGENT_REVIEW_NATIVE_BOOTSTRAP || !process.env.AGENT_REVIEW_NATIVE_REPO,
    timeout: 90000,
}, async (t) => {
    const repo = process.env.AGENT_REVIEW_NATIVE_REPO;
    const git = async (...args) => (await execute("git", ["-C", repo, ...args])).stdout.trim();
    const currentRef = await git("rev-parse", "HEAD");
    const baseRef = await git("rev-parse", "HEAD^");
    const result = await launch(t, process.env.AGENT_REVIEW_NATIVE_CLI,
        ["--no-warnings", process.env.AGENT_REVIEW_NATIVE_BOOTSTRAP], {
            repo,
            baseRef,
            reviewTarget: { mode: "commit", ref: "HEAD", currentRef, baseRef, label: `Commit ${currentRef.slice(0, 7)}` },
        }, { EXTENSION_PATH: join(root, "native-review-provider.mjs") });
    assert.equal(result.embedded, true, "must exercise Copilot's embedded executable, not plain Node");
    let page;
    if (process.env.AGENT_REVIEW_BROWSER_CDP) {
        const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
        const { chromium } = require("playwright-core");
        const browser = await chromium.connectOverCDP(process.env.AGENT_REVIEW_BROWSER_CDP);
        page = await browser.contexts()[0].newPage();
        t.after(async () => { await page.close(); await browser.close(); });
        await page.goto(result.url);
    }
    const deadline = Date.now() + 60000;
    let state;
    while (Date.now() < deadline) {
        state = await (await fetch(`${result.url}api/state`)).json();
        assert.equal(state.error, null);
        if (state.progress?.phase === "python_graph" && state.progress.message.includes(" of ")) break;
        await sleep(50);
    }
    assert.equal(state.progress?.phase, "python_graph", "cancel the actual RefChecker analyzer, after snapshot loading");
    assert.match(state.progress.message, /(?:files:|module) \d[\d,]* of \d[\d,]*.*\.py/);
    if (page) {
        for (const theme of ["light", "dark"]) {
            await page.goto(`${result.url}?scoutTheme=${theme}`);
            await page.locator("#analysis-progress").waitFor({ state: "visible" });
            await page.waitForFunction(() => document.querySelector("#progress-message").textContent.includes(" of "));
            const cancel = page.locator("#cancel-analysis");
            const colors = async () => cancel.evaluate((button) => {
                const probe = document.createElement("span");
                document.body.append(probe);
                const token = (name) => {
                    probe.style.color = `var(${name})`;
                    return getComputedStyle(probe).color;
                };
                const style = getComputedStyle(button);
                const result = { color: style.color, background: style.backgroundColor, border: style.borderTopColor,
                    danger: token("--cp-danger"), foreground: token("--cp-accent-fg") };
                probe.remove();
                return result;
            });
            await page.mouse.move(0, 0);
            const normal = await colors();
            assert.equal(normal.color, normal.danger, `${theme}: Cancel has danger-colored text`);
            await cancel.hover();
            const hover = await colors();
            assert.equal(hover.background, hover.danger, `${theme}: Cancel hover has a danger background`);
            assert.equal(hover.border, hover.danger);
            assert.equal(hover.color, hover.foreground);
            await page.mouse.move(0, 0);
            for (const width of [1280, 560]) {
                await page.setViewportSize({ width, height: 850 });
                const panel = await page.locator("#analysis-progress").boundingBox();
                const button = await page.locator("#cancel-analysis").boundingBox();
                assert(button.width < 120 && button.height < 36, "Cancel is a compact control");
                assert(button.x + button.width <= panel.x + panel.width && button.x > panel.x + panel.width / 2, "Cancel is on the right of the progress panel");
                assert.equal(await page.locator("#review-picker-notice").isVisible(), false);
                assert.equal(await page.locator("#progress-detail").count(), 0);
                assert.doesNotMatch(await page.locator("body").innerText(), /Elapsed \d|Last progress update|Loading the selected review/);
            }
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR || result.directory, `refchecker-progress-${theme}.png`), fullPage: true });
        }
    }
    const started = Date.now();
    let response;
    if (page) {
        const pending = page.waitForResponse((response) => response.url().endsWith("/api/cancel"));
        await page.locator("#cancel-analysis").click();
        response = await pending;
        assert.equal(response.status(), 200);
    } else {
        response = await fetch(`${result.url}api/cancel`, { method: "POST" });
        assert.equal(response.status, 200);
    }
    const cancelled = await response.json();
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.loading, false);
    assert.ok(Date.now() - started < 6000);
    await sleep(300);
    assert.equal((await (await fetch(`${result.url}api/state`)).json()).cancelled, true);
    console.log(`Native RefChecker ${currentRef.slice(0, 7)}: Canvas registered, Python graph cancelled in ${Date.now() - started}ms`);
});
