import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planReview, runReview, validateReviewResponse, consolidateFindings, retrieveEvidence,
    REVIEW_LIMITS, renderReview, buildReviewPrompt, reviewResponseSchema } from "../review-pipeline.mjs";
import { repositoryRuleSources } from "../review-contracts.mjs";
import { ReviewState } from "../review-state.mjs";
import { browserSnapshot, startReviewServer } from "../server.mjs";
import { reviewSnapshotKey } from "../web/review-ledger.mjs";

const response = (context, extra = {}) => ({
    completed: context.units.map((unit) => unit.id), observations: [], findings: [], unresolved: [], requests: [],
    ...(context.phase === "verify" ? { decisions: context.candidates.map((item) => ({
        id: item.id, verdict: "supported", title: item.title, detail: item.detail,
        reason: "Source demonstrates the failure.", citations: item.citations,
    })) } : {}),
    ...extra,
});
const model = (count = 1) => {
    const changes = Array.from({ length: count }, (_, index) => ({
        path: `src/module-${String(index).padStart(4, "0")}.js`, status: "modified", lines_added: 1, lines_removed: 1,
    }));
    return { metadata: {}, nodes: [], edges: [], attention: [], coverage: {}, changes,
        source_files: Object.fromEntries(changes.map(({ path }) => [path, {
            current: "export const delay = 1000;\n", baseline: "export const delay = 1;\n",
            diff: "@@ -1 +1 @@\n-export const delay = 1;\n+export const delay = 1000;\n",
        }])) };
};
const finding = (context, title = "Wrong delay unit") => {
    const item = context.evidence.find((item) => item.side === "current");
    return { title, detail: "Multiplying an already millisecond delay changes scheduling by a factor of 1000.",
        category: "units", severity: "high", confidence: 0.9,
        citations: [{ evidence_id: item.id, line: item.lines[0].line }] };
};

test("a 520-file change is processed internally without losing late files or exceeding request bounds", async () => {
    const reviewed = model(520);
    const seen = new Set();
    let calls = 0;
    const result = await runReview({ model: reviewed, instruction: "Check correctness.",
        generate: async (context) => {
            calls++;
            assert.ok(JSON.stringify(context).length <= REVIEW_LIMITS.requestCharacters);
            assert.ok(Buffer.byteLength(buildReviewPrompt(context)) + Buffer.byteLength(JSON.stringify(reviewResponseSchema(context)))
                <= REVIEW_LIMITS.requestCharacters, "instructions and schema share the request budget");
            context.units.forEach((unit) => seen.add(unit.path));
            return response(context);
        } });
    assert.equal(result.status, "complete");
    assert.equal(seen.size, 520);
    assert.ok(seen.has("src/module-0519.js"));
    assert.ok(calls > 1 && calls < 64);
    assert.deepEqual(result.coverage, { completed_files: 520, total_files: 520, supplied_units: 1040, completed_units: 1040, total_units: 1040 });
});

test("oversized hunks preserve late changed lines and base-side evidence", async () => {
    const reviewed = model();
    const path = reviewed.changes[0].path;
    const lines = Array.from({ length: 2500 }, (_, i) => `export const n${i} = ${i};`);
    reviewed.source_files[path] = { current: lines.join("\n"), baseline: "old\n",
        diff: "@@ -1 +1,2500 @@\n-old\n" + lines.map((line) => `+${line}\n`).join("") };
    const plan = planReview(reviewed);
    assert.ok(plan.units.length > 2);
    const base = plan.units.flatMap((unit) => unit.evidence).find((item) => item.side === "base");
    assert.deepEqual(base.lines, [{ line: 1, text: "old", changed: true }]);
    const supplied = new Set();
    const result = await runReview({ model: reviewed, instruction: "Inspect.",
        generate: async (context) => {
            for (const item of context.evidence) if (item.side === "current") {
                for (const line of item.lines) supplied.add(line.line);
            }
            return response(context);
        } });
    assert.equal(result.status, "complete");
    assert.equal(supplied.size, 2500);
    assert.ok(supplied.has(2500));
});

test("an oversized first file cannot starve later files, and changed callable boundaries get early evidence", () => {
    const reviewed = model(3);
    const first = reviewed.changes[0].path;
    reviewed.source_files[first].diff = "@@ -1 +1,4000 @@\n-old\n"
        + Array.from({ length: 4000 }, (_, i) => `+export const n${i} = ${i};\n`).join("");
    reviewed.nodes = [{ id: "tail", path: first, kind: "function", change: "modified", start_line: 3998, end_line: 4000 }];
    const plan = planReview(reviewed);
    assert.ok(plan.units.slice(0, 6).some((unit) => unit.path === reviewed.changes[2].path));
    assert.ok(plan.units.slice(0, 2).some((unit) => unit.evidence.some((item) =>
        item.lines.some((line) => line.line === 4000))), "late callable evidence is not buried behind boilerplate");
});

test("one large directory cannot bury changes in other components", () => {
    const reviewed = model(200);
    reviewed.changes.push({ path: "src/retry/resolve.js", status: "modified", lines_added: 1, lines_removed: 1 });
    reviewed.source_files["src/retry/resolve.js"] = { current: "return 1;\n", diff: "@@ -1 +1 @@\n-return 2;\n+return 1;\n" };
    const plan = planReview(reviewed);
    assert.ok(plan.units.slice(0, 8).some((unit) => unit.path === "src/retry/resolve.js"));
});

test("all applicable rule files and their later sections are scheduled, not just the first eight", () => {
    const reviewed = model();
    for (let index = 0; index < 12; index++) reviewed.source_files[`.github/instructions/r${index}.instructions.md`] = {
        current: "---\napplyTo: '**/*.js'\n---\n" + "Review this boundary.\n".repeat(900),
    };
    const sources = repositoryRuleSources(reviewed, { bounded: false });
    assert.equal(sources.length, 12);
    const plan = planReview(reviewed, sources);
    assert.equal(new Set(plan.units.filter((unit) => unit.kind === "rule").map((unit) => unit.path)).size, 12);
    assert.ok(plan.units.some((unit) => unit.kind === "rule" && unit.evidence[0].lines.some((line) => line.line > 800)));
});

test("explicit rule links resolve relative to the instruction file even when a root file has the same name", () => {
    const reviewed = model();
    reviewed.source_files["quality.md"] = { current: "Unrelated root document." };
    reviewed.source_files["docs/quality.md"] = { current: "Required quality checks.\n".repeat(1000) };
    const sources = [{ path: "docs/AGENTS.md", text: "Read [quality](quality.md).",
        line_offset: 0, applies_to: [reviewed.changes[0].path] }];
    const plan = planReview(reviewed, sources);
    const supporting = plan.units.filter((unit) => unit.kind === "referenced rule context");
    assert.ok(supporting.length > 1);
    assert.ok(supporting.every((unit) => unit.path === "docs/quality.md"));
    assert.ok(supporting.some((unit) => unit.evidence[0].lines.some((line) => line.line > 900)));
});

test("filename examples do not invent missing documents, but explicit rule links still report gaps", () => {
    const reviewed = model();
    reviewed.source_files["src/app.rs"] = { current: "pub fn app() {}\n" };
    reviewed.source_files["docs/style.md"] = { current: "Use the shared style.\n" };
    reviewed.source_files["docs/removed.md"] = { current: null, baseline: "Old guidance.\n" };
    const sources = [{
        path: "docs/AGENTS.md", line_offset: 0, applies_to: [reviewed.changes[0].path],
        text: [
            "```text", "src/", "  app.rs", "  main.rs", "```",
            "Runtime settings: `$HOME/.config/app/config.toml`, `settings.json`.",
            "Read `style.md`, `src/app.rs`, and `removed.md`.",
            "Follow [required guidance](missing.md#checks).",
            "See [remote guidance](https://example.invalid/guide.md) and [outside](../../outside.md).",
        ].join("\n"),
    }];
    const plan = planReview(reviewed, sources);
    assert.deepEqual(plan.gaps.map((gap) => gap.path).sort(), ["docs/missing.md", "docs/removed.md"]);
    assert.deepEqual(plan.units.filter((unit) => unit.kind === "referenced rule context")
        .map((unit) => unit.path).sort(), ["docs/style.md", "src/app.rs"]);
});

test("citations must reference an actually supplied line, including the correct snapshot side", () => {
    const plan = planReview(model());
    const item = plan.units[0].evidence[0];
    const context = { phase: "analyze", units: [plan.units[0]], evidence: [item] };
    assert.throws(() => validateReviewResponse(response(context, {
        observations: [{ claim: "Wrong", citations: [{ evidence_id: item.id, line: 900 }] }],
    }), context), /not supplied/);
    assert.throws(() => validateReviewResponse(response(context, {
        completed: ["foreign-unit"],
    }), context), /unassigned/);
    const validated = validateReviewResponse(response(context, {
        observations: [{ claim: "Before behavior", citations: [{ evidence_id: item.id, line: 1 }] }],
    }), context);
    assert.equal(validated.observations[0].citations[0].side, "base");
});

test("unchanged context is retrieved from the saved snapshot and investigated internally", async () => {
    const reviewed = model();
    reviewed.source_files["src/validator.js"] = { current: "export const milliseconds = value => value * 1000;\n" };
    let requested = false, supplied = false;
    const result = await runReview({ model: reviewed, instruction: "Check units.",
        generate: async (context) => {
            if (context.requested_range) {
                supplied = context.evidence.some((item) => item.path === "src/validator.js" && item.lines[0].text.includes("* 1000"));
                return response(context, { findings: [finding(context)] });
            }
            if (context.phase === "verify") return response(context);
            if (!requested) {
                requested = true;
                return response(context, { unresolved: [{ reason: "Need the saved validator.", citations: [] }],
                    requests: [{ path: "src/validator.js", side: "current", start_line: 1, end_line: 1 }] });
            }
            return response(context);
        } });
    assert.equal(supplied, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].verification, "supported");
    assert.equal(result.status, "complete", JSON.stringify(result.gaps));
    assert.equal(retrieveEvidence(reviewed, { path: "../outside", side: "current" }).gap.reason, "Invalid snapshot path");
    assert.match(retrieveEvidence(reviewed, { path: "missing.js", side: "current" }).gap.reason, /unavailable/);
});

test("collection cannot consume the time reserved for finding verification", async () => {
    const reviewed = model();
    reviewed.source_files["validator.js"] = { current: "export const valid = true;\n" };
    const phases = [];
    const result = await runReview({ model: reviewed, instruction: "Check.",
        limits: { timeoutMs: 300, requestTimeoutMs: 500 },
        generate: async (context) => {
            phases.push(context.phase);
            if (context.phase === "verify") return response(context);
            if (context.requested_range) return new Promise(() => {});
            return response(context, { findings: [finding(context)],
                requests: [{ path: "validator.js", side: "current", start_line: 1, end_line: 1 }] });
        } });
    assert.ok(phases.includes("verify"));
    assert.equal(result.status, "partial");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].verification, "supported");
});

test("verification can reject a plausible candidate rather than preserving an early misunderstanding", async () => {
    const result = await runReview({ model: model(), instruction: "Check.",
        generate: async (context) => context.phase === "verify"
            ? response(context, { decisions: context.candidates.map((item) => ({
                id: item.id, verdict: "rejected", reason: "Caller already normalizes the units.", citations: item.citations,
            })) })
            : response(context, { findings: [finding(context)] }) });
    assert.equal(result.findings.length, 0);
    assert.equal(result.status, "complete");
});

test("verification narrows supported claims and merges duplicate evidence without losing locations", async () => {
    const result = await runReview({ model: model(2), instruction: "Check.",
        generate: async (context) => {
            if (context.phase === "verify") {
                const [first, second] = context.candidates;
                return response(context, { decisions: [
                    { id: first.id, verdict: "supported", title: "Verified fallback failure",
                        detail: "The fallback uses a single attempt.", reason: "The wider claim was unverified.", citations: first.citations },
                    { id: second.id, verdict: "duplicate", duplicate_of: first.id,
                        reason: "Same failure, another location.", citations: second.citations },
                ] });
            }
            const currents = context.evidence.filter((item) => item.side === "current");
            return response(context, { findings: currents.map((item, index) => ({
                ...finding(context, `Candidate ${index}`), citations: [{ evidence_id: item.id, line: 1 }],
            })) });
        } });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].title, "Verified fallback failure");
    assert.equal(result.findings[0].detail, "The fallback uses a single attempt.");
    assert.equal(new Set(result.findings[0].citations.map((citation) => citation.path)).size, 2);
});

test("structured verification requires every candidate and uses the provider-compatible schema subset", () => {
    const plan = planReview(model());
    const context = { phase: "analyze", units: plan.units, evidence: plan.units.flatMap((unit) => unit.evidence) };
    const candidate = { ...finding(context), id: "candidate" };
    const verify = { ...context, phase: "verify", units: [], candidates: [candidate] };
    const schema = reviewResponseSchema(verify);
    assert.deepEqual(schema.properties.decisions.required, ["candidate"]);
    assert.equal(schema.properties.decisions.additionalProperties, false);
    assert.doesNotMatch(JSON.stringify(schema), /"minimum"|"maximum"|"minLength"|"maxLength"/);
    const validated = validateReviewResponse({ ...response(verify), decisions: {
        candidate: { verdict: "supported", title: candidate.title, detail: candidate.detail,
            reason: "Source supports it.", citations: candidate.citations, duplicate_of: "" },
    } }, verify);
    assert.equal(validated.decisions[0].id, "candidate");
});

test("a malformed response receives one counted repair attempt, never an unbounded retry", async () => {
    let calls = 0;
    const result = await runReview({ model: model(), instruction: "Check.",
        generate: async (context) => {
            calls++;
            if (calls === 1) return "not JSON";
            assert.match(context.validation_error, /JSON/);
            return response(context);
        } });
    assert.equal(result.status, "complete");
    assert.equal(calls, 2);
    assert.equal(result.requests, 2);
    let limitedCalls = 0;
    const limited = await runReview({ model: model(), instruction: "Check.", limits: { maxRequests: 1 },
        generate: async () => { limitedCalls++; return "not JSON"; } });
    assert.equal(limited.status, "partial");
    assert.equal(limitedCalls, 1);
});

test("large context requests are fulfilled in bounded ranges rather than silently clipping their tails", async () => {
    const reviewed = model();
    reviewed.source_files["support.js"] = { current: Array.from({ length: 501 }, (_, i) => `line ${i + 1}`).join("\n") };
    let asked = false;
    const supplied = new Set();
    const result = await runReview({ model: reviewed, instruction: "Check.",
        generate: async (context) => {
            if (context.requested_range) {
                for (const item of context.evidence.filter((item) => item.path === "support.js")) {
                    assert.ok(item.lines.length <= 200);
                    for (const line of item.lines) supplied.add(line.line);
                }
            } else if (!asked) {
                asked = true;
                return response(context, { requests: [{ path: "support.js", side: "current", start_line: 1, end_line: 501 }] });
            }
            return response(context);
        } });
    assert.equal(result.status, "complete", JSON.stringify(result.gaps));
    assert.equal(supplied.size, 501);
});

test("unverified candidates survive as evidence gaps rather than final findings", async () => {
    const result = await runReview({ model: model(), instruction: "Check.", limits: { maxRequests: 1 },
        generate: async (context) => response(context, { findings: [finding(context)] }) });
    assert.equal(result.status, "partial");
    assert.equal(result.findings.length, 0);
    assert.equal(result.unresolved_findings.length, 1);
    assert.match(result.content, /No supported findings in the completed analysis/);
});

test("deduplication preserves independent problems and trimming only limits presentation", () => {
    const cite = [{ evidence_id: "a", path: "src/a.js", side: "current", line: 1 }];
    const entries = Array.from({ length: 12 }, (_, i) => ({
        title: `Problem ${i}`, detail: `Failure ${i}`, category: "units", severity: i ? "low" : "high",
        confidence: 0.9, citations: cite,
    }));
    const merged = consolidateFindings([...entries, entries[0]]);
    assert.equal(merged.length, 12);
    assert.equal(merged[0].severity, "high");
    const text = renderReview({ status: "complete", findings: merged, gaps: [],
        coverage: { completed_files: 1, total_files: 1, completed_units: 2, total_units: 2 } });
    assert.match(text, /Showing 8 of 12 findings/);
    assert.equal((text.match(/^- \*\*/gm) || []).length, 8);
});

test("request limits retain partial results and disk checkpoints resume without repeating completed units", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-pipeline-"));
    const reviewed = model(100);
    const firstSeen = new Set();
    try {
        const options = { model: reviewed, instruction: "Check.", directory, limits: { maxRequests: 3 } };
        const first = await runReview({ ...options, generate: async (context) => {
            context.units.forEach((unit) => firstSeen.add(unit.id));
            return response(context);
        } });
        assert.equal(first.status, "partial");
        assert.ok(first.coverage.completed_units > 0 && first.coverage.completed_units < first.coverage.total_units);
        const second = await runReview({ ...options, generate: async (context) => {
            assert.ok(context.units.every((unit) => !firstSeen.has(unit.id)), "completed units are not repeated");
            return response(context);
        } });
        assert.ok(second.coverage.completed_units > first.coverage.completed_units);
        reviewed.source_files["src/module-0000.js"].current = "changed again";
        const changed = await runReview({ ...options, generate: async (context) => response(context) });
        assert.notEqual(changed.key, first.key);
        const path = join(directory, `${first.key}.json`);
        const checkpoint = JSON.parse(await readFile(path, "utf8"));
        checkpoint.passes[0].response.completed = [];
        await writeFile(path, JSON.stringify(checkpoint));
        reviewed.source_files["src/module-0000.js"].current = "export const delay = 1000;\n";
        await assert.rejects(runReview({ ...options, generate: async (context) => response(context) }), /checksum mismatch/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("failures and omitted completion receipts remain partial, and cancellation reaches the provider", async () => {
    const failed = await runReview({ model: model(), instruction: "Check.", generate: async () => { throw new Error("Provider failed"); } });
    assert.equal(failed.status, "partial");
    assert.ok(failed.gaps.some((gap) => /Provider failed/.test(gap.reason)));
    const omitted = await runReview({ model: model(), instruction: "Check.", generate: async (context) => response(context, { completed: [] }) });
    assert.equal(omitted.coverage.completed_files, 0);
    assert.equal(omitted.coverage.supplied_units, 2);
    assert.equal(omitted.status, "partial");
    const controller = new AbortController();
    let aborted = false;
    const cancelled = await runReview({ model: model(), instruction: "Check.", signal: controller.signal,
        generate: async (_context, { signal }) => {
            signal.addEventListener("abort", () => { aborted = true; });
            controller.abort(new Error("User cancelled"));
            return new Promise(() => {});
        } });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(aborted, true);
});

test("browser payloads omit repository source without changing review ledger identity or source access", async () => {
    const state = new ReviewState("C:\\repo");
    state.model = model(100);
    const originalKey = reviewSnapshotKey(state.model, state.reviewTarget);
    const snapshot = browserSnapshot(state.snapshot());
    assert.equal(reviewSnapshotKey(snapshot.model, state.reviewTarget), originalKey);
    assert.ok(Object.values(snapshot.model.source_files).every((source) => !("current" in source) && !("baseline" in source)));
    assert.equal(Object.keys(snapshot.model.source_files).length, 100);
    assert.ok(JSON.stringify(snapshot).length < JSON.stringify(state.snapshot()).length);
    const server = await startReviewServer(state);
    try {
        const source = await fetch(new URL("/api/source?path=src/module-0000.js", server.url)).then((response) => response.json());
        assert.equal(source.current, "export const delay = 1000;\n");
        const remote = await fetch(new URL("/api/state", server.url)).then((response) => response.json());
        assert.equal(reviewSnapshotKey(remote.model, remote.review_target), originalKey);
        assert.equal(remote.model.source_files["src/module-0000.js"].current, undefined);
    } finally {
        await server.close();
    }
});

test("request timeouts are partial and stale rule runs cannot overwrite a newer model", async () => {
    const timed = await runReview({ model: model(), instruction: "Check.", limits: { requestTimeoutMs: 10 },
        generate: async () => new Promise(() => {}) });
    assert.equal(timed.status, "partial");
    assert.ok(timed.gaps.some((gap) => /timed out/.test(gap.reason)));
    let started;
    let finish;
    const ready = new Promise((resolve) => { started = resolve; });
    const state = new ReviewState("C:\\repo", { generateReviewPass: async (context) => {
        started();
        await new Promise((resolve) => { finish = resolve; });
        return response(context);
    } });
    state.model = model();
    state.model.source_files["AGENTS.md"] = { current: "Preserve behavior." };
    const previous = state.model;
    const pending = state.runRuleCheck();
    await ready;
    state.model = model();
    state.ruleCheck = { status: "none", sources: [] };
    state.stopInternalReviews();
    finish();
    await pending;
    assert.equal(state.ruleCheck.status, "none");
    assert.notEqual(state.reviewEvidenceModel, previous);
});

test("removed Python context can be read from the immutable base without worktree fallback", async () => {
    const reviewed = model();
    let fetched = false;
    let asked = false;
    const result = await runReview({ model: reviewed, instruction: "Check.",
        readSource: async (path, side) => {
            assert.equal(path, "old.py");
            assert.equal(side, "base");
            fetched = true;
            return "def previous(): return 1\n";
        },
        generate: async (context) => {
            if (context.requested_range) {
                assert.ok(context.evidence.some((item) => item.path === "old.py" && item.side === "base"));
            } else if (!asked) {
                asked = true;
                return response(context, { requests: [{ path: "old.py", side: "base", start_line: 1, end_line: 1 }] });
            }
            return response(context);
        } });
    assert.equal(result.status, "complete");
    assert.equal(fetched, true);
});

test("the state exposes a single consolidated rules review with progress", async () => {
    const state = new ReviewState("C:\\repo", { generateReviewPass: async (context) => response(context) });
    state.model = model(150);
    state.model.source_files["AGENTS.md"] = { current: "Keep duration units consistent.\n" };
    const progress = [];
    state.subscribe((event) => { if (event.type === "rule-check-progress") progress.push(event.rule_check.coverage); });
    const result = await state.runRuleCheck();
    assert.equal(result.status, "complete", result.error);
    assert.equal(result.coverage.total_files, 150);
    assert.equal(result.coverage.completed_files, 150);
    assert.match(result.content, /Analysis completed for 150 of 150/);
    assert.ok(progress.length > 1);
    assert.equal(result.sources.length, 1);
});

test("summaries reuse accumulated review evidence and share one runtime across internal passes", async () => {
    let runtimes = 0, disposed = 0, passes = 0, summary;
    const state = new ReviewState("C:\\repo", {
        createReviewRuntime: async () => {
            runtimes++;
            return { client: "test-runtime", dispose: async () => { disposed++; } };
        },
        generateReviewPass: async (context, options) => {
            passes++;
            assert.equal(options.runtimeClient, "test-runtime");
            const item = context.evidence[0];
            return response(context, { observations: [{ claim: "The saved implementation changes the delay.",
                citations: [{ evidence_id: item.id, line: item.lines[0].line }] }] });
        },
        generateAnnotation: async (context) => {
            summary = context;
            return "## Summary\n\nThe delay changed.\n\n## Review order\n\nReview scheduling.\n\n## Gaps\n\nExecution is unverified.";
        },
    });
    state.model = model(150);
    state.model.source_files["AGENTS.md"] = { current: "Preserve duration units." };
    await state.runRuleCheck();
    assert.ok(passes > 1);
    assert.equal(runtimes, 1);
    assert.equal(disposed, 1);
    await state.overviewFor();
    assert.equal(runtimes, 1, "summary synthesis does not repeat already completed analysis");
    assert.deepEqual(summary.code_context, []);
    assert.ok(summary.review_evidence.some((item) => item.claim?.includes("delay")));
    assert.equal(summary.evidence_limits.completed_files, 150);
});

test("a quick summary arrives while the deep rules pass runs, then is refined from its evidence", async () => {
    let releaseReview;
    const reviewGate = new Promise((resolve) => { releaseReview = resolve; });
    const summaries = [];
    const state = new ReviewState("C:\\repo", {
        generateReviewPass: async (context) => {
            await reviewGate;
            const item = context.evidence[0];
            return response(context, { observations: [{ claim: "The saved implementation changes the delay.",
                citations: [{ evidence_id: item.id, line: item.lines[0].line }] }] });
        },
        generateAnnotation: async (context) => {
            summaries.push(context);
            return context.review_evidence ? "## Summary\n\nRefined from review evidence." : "## Summary\n\nQuick summary from saved code.";
        },
    });
    state.model = model(20);
    state.model.source_files["AGENTS.md"] = { current: "Preserve duration units." };
    const rules = state.runRuleCheck();
    const quick = await state.overviewFor();
    assert.match(quick.body, /Quick summary/, "the first summary does not wait for the deep pass");
    assert.equal(quick.basis, "saved-code");
    assert.equal(state.annotations.overview.refining, true);
    assert.equal(summaries.length, 1);
    releaseReview();
    await rules;
    await state.overviewRefinePromise;
    assert.match(state.annotations.overview.body, /Refined from review evidence/);
    assert.equal(state.annotations.overview.basis, "review");
    assert.equal(state.annotations.overview.refining, false);
    assert.ok(summaries.at(-1).review_evidence.some((item) => item.claim?.includes("delay")));
    assert.equal(await state.overviewFor(), state.annotations.overview, "the refined summary is the cached one");
});

test("approved custom checks use the same full-change pipeline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "large-custom-review-"));
    try {
        const state = new ReviewState(directory, {
            customPromptOptions: { globalDirectory: join(directory, "user") },
            generateReviewPass: async (context) => {
                assert.equal(context.instruction, "Check duration conversions.");
                return response(context);
            },
        });
        state.model = model(220);
        await state.promptStore().save({ scope: "global", title: "Units", prompt: "Check duration conversions.", enabled: true });
        const results = await state.runCustomAnalyses();
        assert.equal(results.length, 1);
        assert.equal(results[0].coverage.completed_files, 220);
        assert.equal(results[0].status, "complete");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
