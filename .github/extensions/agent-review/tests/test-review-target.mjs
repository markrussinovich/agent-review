import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listReviewTargets, resolveReviewTarget } from "../review-target.mjs";
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
        const commits = await listReviewTargets(repo, { mode: "commit" });
        assert.deepEqual(commits.items.map((item) => item.ref), [head, base]);
        assert.equal(commits.items[0].title, "feature");
        assert.equal(commits.has_more, false);
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

test("commit list paginates recent history and preserves display metadata", async () => {
        const result = await listReviewTargets("C:\\repo", { mode: "commit", page: 2 }, async (command, args) => {
            assert.equal(command, "git");
            assert.ok(args.includes("--skip=60"));
            return { stdout: Array.from({ length: 31 }, (_, index) =>
                [index.toString(16).padStart(40, "0"), `Feature ${index}`, "Author", "2026-10-04T12:00:00Z", ""].join("\0")).join("") };
        });
        assert.equal(result.items.length, 30);
        assert.equal(result.has_more, true);
        assert.equal(result.items[0].author, "Author");
        assert.equal(result.page, 2);
        await assert.rejects(listReviewTargets("C:\\repo", { mode: "commit", page: -1 }), /Invalid review list page/);
    });

    test("PR list is repository scoped and includes open, closed and merged PRs", async () => {
        const calls = [];
        const result = await listReviewTargets("C:\\repo", { mode: "pr", page: 1 }, async (command, args) => {
            calls.push(args);
            assert.equal(command, "gh");
            return { stdout: args[0] === "repo" ? JSON.stringify({ nameWithOwner: "example/repo" })
                : JSON.stringify([
                    { number: 42, title: "Merged feature", html_url: "https://github.com/example/repo/pull/42",
                        state: "closed", merged_at: "2026-10-01", updated_at: "2026-10-02", user: { login: "author" } },
                    { number: 41, title: "Open feature", html_url: "https://github.com/example/repo/pull/41", state: "open" },
                    { number: 40, title: "Closed feature", html_url: "https://github.com/example/repo/pull/40", state: "closed" },
                ]) };
        });
        assert.match(calls[1][1], /repos\/example\/repo\/pulls\?state=all.*page=2/);
        assert.deepEqual(result.items.map((item) => item.status), ["merged", "open", "closed"]);
        assert.equal(result.items[0].ref, "https://github.com/example/repo/pull/42");
        assert.equal(result.has_more, false);
        await assert.rejects(listReviewTargets("C:\\repo", { mode: "pr" }, async () => { throw new Error("Authentication required"); }), /Authentication required/);
        const empty = await listReviewTargets("C:\\repo", { mode: "pr" }, async (_, args) => ({
            stdout: args[0] === "repo" ? '{"nameWithOwner":"example/repo"}' : "[]",
        }));
        assert.deepEqual(empty.items, []);
    });
