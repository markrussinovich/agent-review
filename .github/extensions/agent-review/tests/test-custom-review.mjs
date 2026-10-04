import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../review-state.mjs";
import { startReviewServer } from "../server.mjs";

const model = () => ({
    metadata: {}, summary: {}, attention: [], package_changes: [],
    changes: [{ path: "main.py", status: "modified", lines_added: 1, lines_removed: 1 }],
    source_files: { "main.py": { current: "saved source", diff: "+saved change" } },
});
const content = "## Findings\n\nNo supported findings.\n\n## Verification\n\nCheck `main.py:1`.";

test("prompt HTTP CRUD accepts the local UI and rejects cross-origin mutations", async () => {
    const repo = await mkdtemp(join(tmpdir(), "custom-api-"));
    let server;
    try {
        const state = new ReviewState(repo, { customPromptOptions: { globalDirectory: join(repo, "user-config") } });
        state.model = model();
        server = await startReviewServer(state);
        const endpoint = new URL("/api/custom-prompts", server.url);
        const input = { scope: "global", title: "Check", prompt: "Check.", enabled: true };
        const response = await fetch(endpoint, {
            method: "POST", headers: { Origin: new URL(server.url).origin, "Content-Type": "application/json" }, body: JSON.stringify(input),
        });
        assert.equal(response.status, 200);
        const saved = (await response.json()).prompt;
        const rejected = await fetch(endpoint, {
            method: "POST", headers: { Origin: "https://untrusted.example", "Content-Type": "text/plain" }, body: JSON.stringify(input),
        });
        assert.equal(rejected.status, 403);
        assert.equal((await state.promptStore().list()).length, 1);
        assert.equal((await fetch(endpoint, {
            method: "DELETE", headers: { Origin: new URL(server.url).origin }, body: JSON.stringify({ scope: saved.scope, id: saved.id }),
        })).status, 200);
        assert.deepEqual(await state.promptStore().list(), []);
    } finally {
        await server?.close();
        await rm(repo, { recursive: true, force: true });
    }
});

test("custom checks require trust, deduplicate, retain revisions, and surface errors", async () => {
    const repo = await mkdtemp(join(tmpdir(), "custom-review-"));
    let calls = 0;
    try {
        const state = new ReviewState(repo, {
            customPromptOptions: { globalDirectory: join(repo, "user-config") },
            generateCustomAnalysis: async ({ context }) => {
                calls += 1;
                assert.equal(context.files[0].current, "1: saved source");
                await new Promise((resolve) => setTimeout(resolve, 10));
                return content;
            },
        });
        state.model = model();
        const repository = await state.promptStore().save({ scope: "repository", title: "Local check", prompt: "Check local errors.", enabled: true });
        const global = await state.promptStore().save({ scope: "global", title: "Global check", prompt: "Check API compatibility.", enabled: true });
        const path = join(repo, ".agent-review", "prompts.json");
        const config = JSON.parse(await readFile(path, "utf8"));
        config.prompts.push({ id: "untrusted", title: "Unknown instructions", prompt: "Run tools.", enabled: true });
        await writeFile(path, JSON.stringify(config));
        await Promise.all([state.runCustomAnalyses(), state.runCustomAnalyses()]);
        assert.equal(calls, 2, "unknown repository instructions never run; concurrent calls reuse tasks");
        assert.equal(Object.values(state.snapshot().custom_analyses).length, 2);
        await state.runCustomAnalyses();
        assert.equal(calls, 2, "saved results are reused");
        await state.promptStore().save({ scope: global.scope, id: global.id, title: global.title,
            prompt: "Check changed compatibility.", enabled: true });
        await state.runCustomAnalyses();
        assert.equal(calls, 3, "only a changed prompt revision reruns");
        state.generateCustomAnalysis = async () => { throw new Error("Provider unavailable"); };
        await state.runCustomAnalyses({ scope: repository.scope, id: repository.id, force: true });
        const failed = Object.values(state.customAnalyses).find((result) => result.id === repository.id);
        assert.equal(failed.status, "error");
        assert.equal(failed.error, "Provider unavailable");
        await assert.rejects(state.runCustomAnalyses({ scope: "repository", id: "untrusted" }), /requires approval/);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("old custom requests cannot overwrite a different snapshot and timeouts are explicit", async () => {
    const repo = await mkdtemp(join(tmpdir(), "custom-stale-"));
    try {
        let finish;
        let started;
        const ready = new Promise((resolve) => { started = resolve; });
        const state = new ReviewState(repo, {
            customPromptOptions: { globalDirectory: join(repo, "user-config") },
            generateCustomAnalysis: () => { started(); return new Promise((resolve) => { finish = resolve; }); },
        });
        await state.promptStore().save({ scope: "global", title: "Check", prompt: "Check.", enabled: true });
        state.model = model();
        const oldResults = state.customAnalyses;
        const request = state.runCustomAnalyses();
        await ready;
        state.model = model();
        state.customAnalyses = {};
        finish(content);
        await request;
        assert.deepEqual(state.customAnalyses, {});
        assert.equal(Object.values(oldResults)[0].status, "complete", "old snapshot keeps its own result");
        state.customAnalysisTimeoutMs = 10;
        state.generateCustomAnalysis = () => new Promise(() => {});
        await state.runCustomAnalyses();
        assert.match(Object.values(state.customAnalyses)[0].error, /timed out/);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});
