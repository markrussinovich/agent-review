import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../review-state.mjs";
import { generateIsolatedExplanation } from "../ai-explainer.mjs";
import { buildCustomAnalysisPrompt, CUSTOM_ANALYSIS_HEADINGS, validateCustomAnalysis } from "../custom-analysis.mjs";

const repo = process.env.AGENT_REVIEW_AI_SMOKE_REPO;
if (!repo) throw new Error("Set AGENT_REVIEW_AI_SMOKE_REPO to the repository to review.");
const directory = await mkdtemp(join(tmpdir(), "review-ai-smoke-"));
try {
    const state = new ReviewState(repo, {
        baseRef: process.env.AGENT_REVIEW_AI_SMOKE_BASE || "HEAD",
        customPromptOptions: { globalDirectory: directory },
        customAnalysisTimeoutMs: 250_000,
        generateCustomAnalysis: ({ prompt, context }) => generateIsolatedExplanation({
            workingDirectory: repo,
            prompt: buildCustomAnalysisPrompt(prompt, context),
            requiredHeadings: CUSTOM_ANALYSIS_HEADINGS,
            validateResponse: (content) => validateCustomAnalysis(content, context),
        }),
    });
    await state.promptStore().save({
        scope: "global", title: "Input validation", enabled: true,
        prompt: "Review changed input validation and error handling. Focus on concrete boundary cases; do not invent defects.",
    });
    await state.refresh();
    const results = await state.runCustomAnalyses();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "complete", results[0].error);
    assert.match(results[0].content, /^## Findings/m);
    assert.match(results[0].content, /^## Verification/m);
    console.log(`PASS real isolated custom analysis (${state.model.changes.filter((file) => file.status !== "unchanged").length} changed files):\n${results[0].content}`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
