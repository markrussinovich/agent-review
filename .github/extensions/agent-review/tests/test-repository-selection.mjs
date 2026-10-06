import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ReviewState } from "../review-state.mjs";
import { startReviewServer } from "../server.mjs";

const execute = promisify(execFile);

async function repositories(t) {
    const directory = await mkdtemp(join(tmpdir(), "review-repository-picker-"));
    t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const { mkdir } = await import("node:fs/promises");
    const roots = [join(directory, "original"), join(directory, "demo")];
    for (const root of roots) {
        await mkdir(root);
        const git = (...args) => execute("git", ["-C", root, ...args]);
        await git("init", "-q");
        await git("config", "user.name", "Test");
        await git("config", "user.email", "test@example.invalid");
        await writeFile(join(root, "main.py"), "def run():\n    return 1\n");
        await writeFile(join(root, ".agent-review.json"), '{"base_ref":"HEAD"}');
        await git("add", ".");
        await git("commit", "-qm", "baseline");
    }
    await writeFile(join(roots[1], "main.py"), "def run():\n    return 2\n");
    return roots;
}

test("explicit repository selection reviews the existing target directory and clears old evidence", { timeout: 120000 }, async (t) => {
    const [oldRepo, demo] = await repositories(t);
    const status = (repo) => execute("git", ["-C", repo, "status", "--porcelain=v2", "--branch"]);
    const before = await Promise.all([status(oldRepo), status(demo)]);
    const state = new ReviewState(oldRepo, { baseRef: "HEAD" });
    t.after(() => state.dispose());
    await state.refresh();
    state.annotations.old = { body: "Old repository evidence" };
    state.sessionHistories.set("old", {});
    state.sessionContext = { intent: ["old"] };
    state.generatedObservations.push({ id: "old", evidence_ids: [] });
    state.testRun = { status: "complete" };
    state.ruleCheck = { status: "complete", content: "old" };
    await state.setRepository({ repoPath: demo });
    assert.equal(state.repoRoot, demo);
    assert.equal(state.snapshot().repo_root, demo);
    assert.equal(state.model, null);
    assert.equal(state.worktreeBaseRef, "HEAD");
    assert.equal(state.resolveBaseRef && await state.resolveBaseRef(), "HEAD");
    assert.deepEqual(state.annotations, {});
    assert.equal(state.sessionContext, null);
    assert.equal(state.sessionHistories.size, 0);
    assert.equal(state.reviewCache.size, 0);
    assert.equal(state.testRun, null);
    assert.equal(state.ruleCheck, null);
    assert.deepEqual(state.generatedObservations, []);
    await state.refresh();
    assert.equal(state.model.metadata.repo_root, demo);
    assert.equal(state.model.summary.files_changed, 1);
    const after = await Promise.all([status(oldRepo), status(demo)]);
    assert.deepEqual(after.map((result) => result.stdout), before.map((result) => result.stdout),
        "selection never checks out, clones, or edits either repository");
});

test("invalid repository selections preserve the current review, and HTTP failures are explicit", { timeout: 120000 }, async (t) => {
    const [oldRepo, demo] = await repositories(t);
    const state = new ReviewState(oldRepo, { baseRef: "HEAD" });
    t.after(() => state.dispose());
    await state.refresh();
    const model = state.model;
    await assert.rejects(state.setRepository({ repoPath: join(demo, "missing") }), /cannot change|no such|not a git/i);
    assert.equal(state.repoRoot, oldRepo);
    assert.equal(state.model, model);
    await assert.rejects(state.setRepository({ repoPath: demo, baseRef: 42 }), /baseRef must be a string/);
    const server = await startReviewServer(state);
    t.after(() => server.close());
    const response = await fetch(`${server.url}api/repository`, {
        method: "POST", headers: { "content-type": "application/json" }, body: '{"repoPath":""}',
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Enter the local path/);
    state.loading = true;
    await assert.rejects(state.setRepository({ repoPath: demo }), /Wait for the active analysis/);
    state.loading = false;
});
