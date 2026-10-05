import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const require = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url);
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), "review-decisions-ui-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
let server, browser, state;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "core.autocrlf", "false");
    await mkdir(join(repo, "pkg"));
    await writeFile(join(repo, "pkg", "__init__.py"), "");
    await writeFile(join(repo, "pkg", "resolver.py"), [
        "class Resolver:",
        "    def __init__(self):",
        "        self.primary = self._load('primary', 'PrimaryChecker')",
        "",
        "    def resolve(self, ref):",
        "        if not ref.title:",
        "            return None",
        "        if ref.legacy:",
        "            raise ValueError('legacy references are unsupported')",
        "        if similarity(ref) < 0.9:",
        "            return None",
        "        if ref.partial:",
        "            return ref.partial",
        "        return official(ref)",
        "",
        "class PrimaryChecker:",
        "    pass",
        "",
    ].join("\n"));
    await git("add", ".");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "pkg", "reports.py"), [
        "class ReportsChecker:",
        "    def verify(self, reference):",
        "        title = reference.get('title')",
        "        if not title or not str(reference.get('number', '')).isdigit():",
        "            return None, [], None",
        "        for row in self.rows():",
        `            # ${"long-review-comment-".repeat(12)}`,
        "            if row.year and str(row.year) not in reference.get('date', ''):",
        "                continue",
        "            return row.data, [], row.url",
        "        return None, [], None",
        "",
    ].join("\n"));
    await writeFile(join(repo, "pkg", "resolver.py"), [
        "class Resolver:",
        "    def __init__(self):",
        "        self.primary = self._load('primary', 'PrimaryChecker')",
        "        self.reports = self._load('reports', 'ReportsChecker')",
        "",
        "    def resolve(self, ref):",
        "        if not ref.title:",
        "            return None",
        "        if similarity(ref) < 0.95:",
        "            return None",
        "        if ref.partial:",
        "            return ref.partial",
        "        if getattr(self, 'reports', None):",
        "            try:",
        "                found = self.reports.verify(ref)",
        "            except Exception:",
        "                found = None",
        "            if found:",
        "                return found",
        "        return official(ref)",
        "",
        "class PrimaryChecker:",
        "    pass",
        "",
    ].join("\n"));
    await git("add", ".");
    await git("commit", "-qm", "Add reports fallback");
    let explanations = 0;
    state = new ReviewState(repo, {
        readWorktreeFingerprint: null,
        generateAnnotation: async (context) => {
            explanations += 1;
            return context.kind === "overview"
                ? "## Summary\n\n- Adds a reports fallback.\n\n## Review order\n\n- Review `Resolver.resolve`.\n\n## Gaps\n\n- None."
                : `## What changed\n\n- Briefing for ${context.subject?.name || "code"}.`;
        },
    });
    await state.setReviewTarget({ mode: "commit", ref: "HEAD" });
    const decisions = await state.decisionMapFor(60000);
    assert.equal(decisions.status, "complete", decisions.error);
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
        const metric = page.locator("#summary .metric").filter({ hasText: "Decisions" });
        await metric.waitFor();
        const metricText = await metric.textContent();
        assert.match(metricText, /\+7\/~1\/−1Decisions3 callables · 3 conditional gates/, metricText);
        const rows = await page.locator("#summary .metric").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().top));
        assert.equal(rows.length, 5);
        assert.ok(rows.every((top) => Math.abs(top - rows[0]) < 1), `${theme}: five summary metrics share one row at desktop width`);
        await metric.click();
        await page.locator(".decision-view .decision-group").first().waitFor();
        assert.equal(await page.locator("#graph-title").textContent(), "Decision changes");
        const resolve = page.locator(".decision-group").filter({ hasText: "Resolver.resolve" });
        const added = resolve.locator('.decision-row.decision-added[data-line="19"]');
        const addedText = await added.textContent();
        assert.match(addedText, /when\s*found/);
        assert.match(addedText, /only if\s*getattr\(self, 'reports', None\)/);
        assert.match(addedText, /After returns `?ref\.partial`? when `?ref\.partial`?/);
        assert.match(addedText, /Before returns `?official\(ref\)`?/);
        const changed = await resolve.locator(".decision-row.decision-changed").textContent();
        assert.match(changed, /threshold\s*0\.95.*Before.*0\.9/s);
        const removedRows = resolve.locator(".decision-row.decision-removed");
        assert.equal(await removedRows.count(), 1, "the removed legacy guard is shown once");
        assert.match(await removedRows.first().textContent(), /Raises\s*ValueError.*Base L9\s*when\s*ref\.legacy/s);
        assert.match(await resolve.locator(".decision-row").filter({ hasText: "Handles error and continues" }).textContent(), /on\s*Exception/);
        assert.match(await page.locator(".decision-group").filter({ hasText: "Resolver.__init__" }).textContent(),
            /Wires by name\s*ReportsChecker from pkg\.reports\s*via\s*self\._load/);
        assert.match(await page.locator(".decision-group").filter({ hasText: "ReportsChecker.verify" }).textContent(),
            /when any of\s*not title\s*or\s*not str/);
        for (const width of [1440, 900, 560]) {
            await page.setViewportSize({ width, height: 1000 });
            const overflow = await page.locator(".decision-row, .decision-group-heading").evaluateAll((items) => items
                .filter((item) => item.scrollWidth > item.clientWidth + 1 || item.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
                .map((item) => item.textContent.slice(0, 60)));
            assert.deepEqual(overflow, [], `${theme}: decision rows wrap within the view at ${width}px`);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await added.click();
        await page.waitForFunction(() => /pkg\/resolver\.py:\d+$/.test(document.querySelector("#source-title").textContent));
        assert.equal(await page.locator(".tab.active").textContent(), "Current", "decisions open the side that contains them");
        const line = Number((await page.locator("#source-title").textContent()).split(":").pop());
        assert.equal(Number(await page.locator("#source .focus-start").getAttribute("data-new-line")), line);
        await page.locator("#source-annotation .annotation-body").waitFor();
        const pane = page.locator("#source-decisions");
        assert.equal(await pane.isVisible(), true);
        assert.match(await pane.textContent(), /Decision changes/);
        assert.equal(await pane.locator(".decision-row").count(), await resolve.locator(".decision-row").count());
        const sideOverflow = await pane.locator(".decision-row").evaluateAll((items) => items.filter((item) => item.scrollWidth > item.clientWidth + 1).length);
        assert.equal(sideOverflow, 0, `${theme}: side-pane decisions wrap`);
        await pane.locator(".decision-row.decision-removed").first().click();
        await page.waitForFunction(() => document.querySelector(".tab.active").textContent === "Base");
        assert.equal(await page.locator("#source-back").isDisabled(), false, "decision links participate in source history");
        assert.equal(await pane.isVisible(), true, "the pane stays with the selected callable");
        await page.setViewportSize({ width: 560, height: 900 });
        assert.equal(await pane.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `${theme}: narrow side pane fits`);
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}: decision metric, grouped view, gates/thresholds/order/wiring, source focus, side pane, history, responsive layout`);
    }
    assert.ok(explanations >= 1);
} finally {
    await browser?.close();
    await server?.close();
    await state?.dispose();
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
