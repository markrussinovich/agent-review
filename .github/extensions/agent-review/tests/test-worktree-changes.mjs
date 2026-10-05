import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, rename, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fingerprintWorktree } from "../worktree-changes.mjs";
import { ReviewState } from "../review-state.mjs";
import { ReviewLifecycle } from "../review-lifecycle.mjs";
import { startReviewServer } from "../server.mjs";

const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const model = () => ({ metadata: {}, nodes: [], edges: [], attention: [], package_changes: [],
    evidence: {}, changes: [], summary: {}, coverage: {}, warnings: [] });

test("fingerprints cover same-sized edits, additions, deletions, renames, commits, and analysis inputs", async (t) => {
    const repo = await mkdtemp(join(tmpdir(), "worktree-fingerprint-"));
    t.after(() => rm(repo, { recursive: true, force: true }));
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "main.py"), "value = 1\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    let previous = await fingerprintWorktree(repo);
    const changed = async () => {
        const current = await fingerprintWorktree(repo);
        assert.notEqual(current, previous);
        previous = current;
    };
    assert.equal(await fingerprintWorktree(repo), previous);
    await mkdir(join(repo, "src"));
    assert.equal(await fingerprintWorktree(join(repo, "src")), previous, "a subfolder request checks the entire Git worktree");
    await writeFile(join(repo, "main.py"), "value = 2\n");
    await changed();
    await writeFile(join(repo, "new.py"), "value = 3\n");
    await changed();
    await rename(join(repo, "new.py"), join(repo, "renamed.py"));
    await changed();
    await rm(join(repo, "renamed.py"));
    await changed();
    await git("commit", "-qam", "agent changes");
    await changed();
    for (const path of ["coverage.json", ".agent-review.json"]) {
        await writeFile(join(repo, path), "{}");
        await changed();
    }
    for (const path of ["node_modules", ".venv", "__pycache__", ".pytest_cache", ".agent-review"]) {
        await mkdir(join(repo, path));
        await writeFile(join(repo, path, "generated.py"), "ignored = True\n");
        assert.equal(await fingerprintWorktree(repo), previous, `${path} is pruned before traversal`);
    }
    const sparse = await open(join(repo, "large.bin"), "w");
    await sparse.truncate(512 * 1024 * 1024);
    await sparse.close();
    await changed();
    assert.equal(await fingerprintWorktree(repo), previous, "large binary is checked by metadata, without reading contents");
});

test("worktree changes suggest reanalysis without rerunning; reanalysis clears stale state", async () => {
    let revision = "initial", runs = 0, checks = 0;
    const state = new ReviewState("C:\\fixture", {
        readWorktreeFingerprint: async () => { checks++; return revision; },
        runAnalyzer: async () => { runs++; return model(); },
    });
    state.startCustomAnalyses = () => {};
    await state.refresh();
    const saved = state.model;
    await state.checkWorktreeChanges();
    assert.equal(state.worktreeChanged, false);
    revision = "edited";
    await state.checkWorktreeChanges();
    assert.equal(state.snapshot().worktree_changed, true);
    assert.equal(state.model, saved);
    assert.equal(runs, 1);
    await state.refresh();
    await state.checkWorktreeChanges();
    assert.equal(state.worktreeChanged, false);
    assert.equal(runs, 2);
    const count = checks;
    state.reviewTarget = { mode: "commit" };
    await state.checkWorktreeChanges();
    state.reviewTarget = { mode: "pr" };
    await state.checkWorktreeChanges();
    assert.equal(checks, count, "immutable targets are never polled");
    await state.dispose();
});

test("edits during analysis are not mistaken for current results", async () => {
    let revision = "initial", finish;
    const state = new ReviewState("C:\\fixture", {
        readWorktreeFingerprint: async () => revision,
        runAnalyzer: () => new Promise((resolve) => { finish = resolve; }),
    });
    state.startCustomAnalyses = () => {};
    const pending = state.refresh();
    while (!finish) await sleep(5);
    revision = "edited during analysis";
    finish(model());
    await pending;
    await state.checkWorktreeChanges();
    assert.equal(state.worktreeChanged, true);
    await state.dispose();
});

test("check errors are explicit and old async checks cannot clobber a new generation", async () => {
    let failure = false, finish;
    const state = new ReviewState("C:\\fixture", {
        readWorktreeFingerprint: async () => {
            if (failure) throw new Error("Repository unavailable");
            return "initial";
        },
        runAnalyzer: async () => model(),
    });
    state.startCustomAnalyses = () => {};
    await state.refresh();
    failure = true;
    await state.checkWorktreeChanges();
    assert.match(state.snapshot().worktree_check_error, /Repository unavailable/);
    state.readWorktreeFingerprint = () => new Promise((resolve) => { finish = resolve; });
    const pending = state.checkWorktreeChanges();
    while (!finish) await sleep(5);
    state.reviewGeneration++;
    state.worktreeChanged = false;
    finish("late old edit");
    await pending;
    assert.equal(state.worktreeChanged, false);
    await state.dispose();
});

test("shared monitors stop only after the last server owner releases them", async () => {
    let checks = 0;
    const state = new ReviewState("C:\\fixture", {
        readWorktreeFingerprint: async () => { checks++; return "initial"; },
        runAnalyzer: async () => model(),
    });
    state.startCustomAnalyses = () => {};
    await state.refresh();
    const first = state.startWorktreeMonitoring(20);
    const second = state.startWorktreeMonitoring(20);
    await sleep(70);
    first();
    const count = checks;
    await sleep(70);
    assert.ok(checks > count);
    second();
    await state.worktreeCheckPromise;
    const stopped = checks;
    await sleep(70);
    assert.equal(checks, stopped);
    assert.equal(state.worktreeMonitorTimer, null);
    await state.dispose();
});

test("refresh HTTP request is acknowledged before long analysis finishes", async (t) => {
    let finish;
    const state = new ReviewState("C:\\fixture", {
        runAnalyzer: () => new Promise((resolve) => { finish = resolve; }),
    });
    state.startCustomAnalyses = () => {};
    const server = await startReviewServer(state);
    t.after(async () => { await state.dispose(); await server.close(); });
    const response = await fetch(`${server.url}api/refresh`, { method: "POST" });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(state.loading, true);
    while (!finish) await sleep(5);
    finish(model());
    await state.refreshPromise;
    assert.equal(state.loading, false);
});

test("reopening an instance waits for close and cannot revive a disposed provider", async () => {
    const lifecycle = Object.assign(Object.create(ReviewLifecycle.prototype), {
        closed: false, closedInstances: new Set(["canvas"]), closingInstances: new Map(),
    });
    let finish;
    lifecycle.closingInstances.set("canvas", new Promise((resolve) => { finish = resolve; }));
    const reopening = lifecycle.reopenInstance("canvas");
    await sleep(5);
    assert.equal(lifecycle.closedInstances.has("canvas"), true);
    finish();
    await reopening;
    assert.equal(lifecycle.closedInstances.has("canvas"), false);
    lifecycle.closed = true;
    await assert.rejects(lifecycle.reopenInstance("canvas"), /provider has been closed/);
});
