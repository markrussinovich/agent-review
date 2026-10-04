import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveReviewTarget } from "../review-target.mjs";
import { ReviewState } from "../review-state.mjs";

const exec = promisify(execFile);

test("commit review uses immutable source, diffs and AI context despite dirty worktree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "review-target-"));
    const git = (...args) => exec("git", ["-C", repo, ...args]);
    try {
        await git("init", "-q");
        await git("config", "user.name", "Test");
        await git("config", "user.email", "test@example.invalid");
        await writeFile(join(repo, "main.py"), "def run():\n    return 1\n");
        await git("add", ".");
        await git("commit", "-qm", "base");
        const base = (await git("rev-parse", "HEAD")).stdout.trim();
        await writeFile(join(repo, "main.py"), "def run():\n    return 2\n");
        await git("commit", "-qam", "feature");
        const head = (await git("rev-parse", "HEAD")).stdout.trim();
        await writeFile(join(repo, "main.py"), "def dirty_only():\n    return 999\n");
        const state = new ReviewState(repo, { baseRef: base });
        await state.setReviewTarget({ mode: "commit", ref: head });
        assert.equal(state.model.metadata.head_sha, head);
        assert.equal(state.model.metadata.base_sha, base);
        const resumed = new ReviewState(repo, { baseRef: base, reviewTarget: state.reviewTarget });
        await resumed.refresh();
        assert.equal(resumed.model.metadata.head_sha, head);
        assert.match((await resumed.sourceForPath("main.py")).current, /return 2/);
        const source = await state.sourceForPath("main.py");
        assert.match(source.current, /return 2/);
        assert.doesNotMatch(source.current, /dirty_only/);
        assert.match(source.diff, /\+    return 2/);
        const context = await state.codeContextFor({ subject: { path: "main.py", kind: "module" } });
        assert.doesNotMatch(JSON.stringify(context), /dirty_only|999/);
        await state.setReviewTarget({ mode: "worktree" });
        assert.match((await state.sourceForPath("main.py")).current, /dirty_only/);
        assert.equal(state.model.metadata.base_sha, base);
        await writeFile(join(repo, "untracked.py"), "import croniter\n");
        assert.match((await state.sourceForPath("untracked.py")).diff, /\+import croniter/);
        await state.setReviewTarget({ mode: "commit", ref: base });
        assert.equal(state.model.metadata.base_sha, null, "root commit compares against empty tree");
        assert.match((await state.sourceForPath("main.py")).diff, /\+def run/);
        await assert.rejects(state.setReviewTarget({ mode: "commit", ref: "-bad" }), /Enter a commit/);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("PR resolves GitHub metadata and merge base without checkout", async () => {
    const calls = [];
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const merge = "c".repeat(40);
    const target = await resolveReviewTarget("C:\\repo", { mode: "pr", ref: "12" }, async (command, args) => {
        calls.push([command, args]);
        if (command === "gh") return { stdout: JSON.stringify({ number: 12, title: "Feature", url: "https://github.com/example/repo/pull/12", baseRefOid: base, headRefOid: head }) };
        return { stdout: args.includes("merge-base") ? merge : "" };
    });
    assert.equal(target.baseRef, merge);
    assert.equal(target.currentRef, head);
    assert.equal(calls.filter(([command]) => command === "git").length, 2);
    assert.ok(calls.some(([, args]) => args.includes("refs/pull/12/head")));
    assert.ok(calls.every(([, args]) => !args.includes("checkout")));
    await assert.rejects(resolveReviewTarget("C:\\repo", { mode: "pr", ref: "https://untrusted.invalid/pull/12" }), /Enter a GitHub PR/);
});
