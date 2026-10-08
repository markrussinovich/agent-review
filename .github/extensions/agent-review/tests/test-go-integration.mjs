import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ReviewState } from "../review-state.mjs";

const execute = promisify(execFile);
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "go-demo");

test("production review state analyzes a Go snapshot without running repository code", { timeout: 60_000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-review-go-integration-"));
    let state;
    try {
        await cp(join(fixture, "baseline"), repo, { recursive: true });
        const git = (...args) => execute("git", ["-C", repo, ...args]);
        await git("init", "-q");
        await git("config", "user.name", "Go fixture");
        await git("config", "user.email", "go@example.invalid");
        await git("add", ".");
        await git("commit", "-qm", "baseline");
        await cp(join(fixture, "changed"), repo, { recursive: true });
        state = new ReviewState(repo, { baseRef: "HEAD", getSessionEvents: async () => [],
            getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }) });
        await state.refresh();
        assert.equal(state.error, null);
        assert.deepEqual(state.model.metadata.review_languages, ["go"]);
        assert.ok(state.model.nodes.some((item) => item.language === "go" && item.kind === "method"));
        assert.ok(state.model.nodes.some((item) => item.language === "go" && item.kind === "struct"));
        assert.ok(state.model.edges.some((item) => item.type === "uses_package"));
        assert.equal(state.model.package_changes.find((item) => item.name === "golang.org/x/text").change, "modified");
        assert.equal(state.model.package_changes.find((item) => item.name === "golang.org/x/sync").change, "added");
        const map = await state.decisionMapFor(30_000);
        assert.equal(map.status, "complete", map.error);
        assert.equal(map.adapter_id, "go");
        assert.deepEqual(map.verification.tests.map((item) => item.id),
            ["internal/score/score_test.go::TestEvaluatorClassify"]);
        const plan = await state.testRunPlan();
        assert.equal(plan.available, true);
        assert.match(plan.command, /^go test/);
        assert.match(plan.prerequisites, /executes repository/);
    } finally {
        await state?.dispose();
        await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});
