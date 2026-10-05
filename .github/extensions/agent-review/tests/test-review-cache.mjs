import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewState } from "../review-state.mjs";

const execute = promisify(execFile);

test("switching restores saved model, source, summary, and package results; reanalysis updates them", async () => {
    const repo = await mkdtemp(join(tmpdir(), "review-cache-"));
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    try {
        await git("init", "-q");
        await git("config", "user.name", "Test");
        await git("config", "user.email", "test@example.invalid");
        await writeFile(join(repo, "main.py"), "def run():\n    return 1\n");
        await git("add", ".");
        await git("commit", "-qm", "base");
        const base = (await git("rev-parse", "HEAD")).stdout.trim();
        await writeFile(join(repo, "main.py"), "def run():\n    return 2\n");
        let generations = 0, customGenerations = 0;
        const state = new ReviewState(repo, {
            baseRef: base,
            generateAnnotation: async () => `Saved summary ${++generations}`,
            customPromptOptions: { globalDirectory: join(repo, ".git", "prompt-config") },
            generateCustomAnalysis: async () => `## Findings\n\nSaved custom result ${++customGenerations}.\n\n## Verification\n\nCheck source.`,
        });
        await state.promptStore().save({ scope: "global", title: "Cache check", prompt: "Check source.", enabled: true });
        await state.refresh();
        await state.checkWorktreeChanges();
        assert.equal(state.worktreeChanged, false, "analyzer reads do not count as edits");
        await state.runCustomAnalyses();
        const customResult = Object.values(state.customAnalyses)[0];
        const worktreeModel = state.model;
        const summary = await state.overviewFor();
        const assessment = { version: "25.0" };
        state.packageAssessments.set("packaging@25.0", assessment);
        state.packageRisks["packaging@25.0"] = { assessment, explanation: "Saved package explanation" };
        await state.setReviewTarget({ mode: "commit", ref: base });
        await state.runCustomAnalyses();
        const commitModel = state.model;
        await writeFile(join(repo, "main.py"), "def run():\n    return 999\n");
        await state.setReviewTarget({ mode: "worktree" });
        assert.equal(state.model, worktreeModel, "restore without rerunning analysis");
        assert.equal(state.restoredFromCache, true);
        await state.checkWorktreeChanges();
        assert.equal(state.worktreeChanged, true, "cached worktree remains readable but later edits suggest reanalysis");
        assert.equal(await state.overviewFor(), summary);
        assert.equal(generations, 1);
        await state.runCustomAnalyses();
        assert.equal(customGenerations, 2);
        assert.equal(Object.values(state.customAnalyses)[0], customResult, "restore custom results for the same saved snapshot");
        assert.equal(state.packageAssessments.get("packaging@25.0"), assessment);
        assert.equal(state.packageRisks["packaging@25.0"].explanation, "Saved package explanation");
        assert.equal(state.selection, null);
        const source = await state.sourceForPath("main.py");
        assert.match(source.current, /return 2/);
        assert.match(source.diff, /\+    return 2/);
        assert.doesNotMatch(source.diff, /999/);
        await state.setReviewTarget({ mode: "commit", ref: base });
        assert.equal(state.model, commitModel);
        assert.equal(state.snapshot().worktree_changed, false);
        await state.setReviewTarget({ mode: "worktree" });
        await state.refresh();
        await state.runCustomAnalyses();
        assert.equal(customGenerations, 3, "explicit reanalysis reruns enabled custom checks");
        assert.equal(state.restoredFromCache, false);
        await state.checkWorktreeChanges();
        assert.equal(state.worktreeChanged, false);
        assert.notEqual(state.model, worktreeModel);
        assert.match((await state.sourceForPath("main.py")).current, /999/);
        assert.equal(state.annotations.overview, undefined);
        assert.equal(state.packageAssessments.size, 0);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});
