import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ReviewState, buildDecisionRequest } from "../review-state.mjs";
import {
    callablesForSubject, decisionConditions, decisionPromptContext, decisionText, decisionTotals,
} from "../web/decision-map.mjs";

const execute = promisify(execFile);

const decision = (overrides = {}) => ({
    kind: "exit", outcome: "empty", value: "(None, [], None)", when: ["not title"], when_mode: "one",
    only_if: [], context: [], loop: null, on_error: null, thresholds: [], line: 10, end_line: 10, ...overrides,
});

const map = {
    status: "complete",
    callables: [
        { id: "symbol:verify", qualname: "Checker.verify", path: "pkg/checker.py", change: "added", line: 5,
            decisions_base: 0, decisions_current: 2, counts: { added: 2, removed: 0, changed: 0, moved: 0 },
            entries: [
                { status: "added", decision: decision() },
                { status: "added", decision: decision({ outcome: "skip", value: null, when: ["str(year) not in found"],
                    only_if: ["year"], loop: "for row in rows", thresholds: [], line: 12 }) },
            ] },
        { id: "symbol:core", qualname: "Hybrid.core", path: "pkg/hybrid.py", change: "modified", line: 40,
            decisions_base: 3, decisions_current: 4, counts: { added: 1, removed: 0, changed: 0, moved: 0 },
            entries: [{ status: "added", decision: decision({ outcome: "value", value: "report", when: ["report"],
                only_if: ["getattr(self, 'reports', None)"], line: 50 }),
            after: { line: 45, label: "returns `best_incomplete` when `incomplete`" },
            before: { line: 55, label: "returns `official`" } }] },
        { id: "symbol:same", qualname: "Hybrid.same", path: "pkg/hybrid.py", change: "modified", line: 60,
            decisions_base: 1, decisions_current: 1, counts: { added: 0, removed: 0, changed: 0, moved: 0 }, entries: [] },
    ],
};

test("decision presentation keeps conditional gates, order, and totals explicit", () => {
    assert.deepEqual(decisionConditions(map.callables[0].entries[1].decision).map((part) => part.label), ["when", "only if", "per"]);
    const text = decisionText(map.callables[1].entries[0], "pkg/hybrid.py");
    assert.match(text, /^\[added\] Returns `report` when `report` only if `getattr\(self, 'reports', None\)` \(pkg\/hybrid\.py:50\)/);
    assert.match(text, /runs after: returns `best_incomplete` when `incomplete` \(line 45\); before: returns `official` \(line 55\)/);
    assert.deepEqual(decisionTotals(map), { added: 3, removed: 0, changed: 0, moved: 0, gates: 2, callables: 2, unchanged_callables: 1 });
});

test("decisions are scoped to the selected method, class, or file", () => {
    const model = { symbols: [{ id: "symbol:hybrid", qualname: "Hybrid" }] };
    assert.deepEqual(callablesForSubject(map, model, { id: "symbol:verify", kind: "method", path: "pkg/checker.py" }).map((item) => item.id), ["symbol:verify"]);
    assert.deepEqual(callablesForSubject(map, model, { id: "symbol:hybrid", kind: "class", path: "pkg/hybrid.py" }).map((item) => item.id), ["symbol:core", "symbol:same"]);
    assert.deepEqual(callablesForSubject(map, model, { kind: "file", path: "pkg/checker.py" }).map((item) => item.id), ["symbol:verify"]);
    assert.deepEqual(callablesForSubject(map, model, { kind: "component" }), []);
});

test("prompt context is bounded, ranks changed callables first, and reports unavailable extraction", () => {
    const context = decisionPromptContext(map);
    assert.deepEqual(context.callables.map((item) => item.callable), ["Checker.verify", "Hybrid.core", "Hybrid.same"]);
    assert.deepEqual(context.callables[2].changes, ["no code path changes (same exits, handlers, and wiring)"]);
    assert.match(context.note, /'only if' gates apply only when a value is present/);
    const tight = decisionPromptContext(map, map.callables, { maxCallables: 1, maxCharacters: 400 });
    assert.equal(tight.callables.length, 1);
    assert.equal(tight.limited, true);
    assert.ok(JSON.stringify(tight.callables).length < 1200);
    assert.equal(decisionPromptContext({ status: "loading" }), null);
    assert.deepEqual(decisionPromptContext({ status: "error", error: "boom" }), { unavailable: "boom" });
});

test("decision requests include only changed production callables and saved current text", () => {
    const request = buildDecisionRequest({
        metadata: { repo_root: "C:\\repo", base_sha: "abc" },
        nodes: [{ kind: "module", name: "pkg.checker" }],
        source_files: { "pkg/checker.py": { current: "def verify(): pass\n" }, "pkg/binary.py": { binary: true } },
        symbols: [
            { id: "a", kind: "method", qualname: "Checker.verify", classification: "added", path: "pkg/checker.py" },
            { id: "b", kind: "function", qualname: "same", classification: "unchanged", path: "pkg/checker.py" },
            { id: "c", kind: "function", qualname: "test_verify", classification: "added", path: "tests/test_checker.py" },
            { id: "d", kind: "class", name: "Checker", qualname: "Checker", module: "pkg.checker", classification: "added", path: "pkg/checker.py" },
            { id: "e", kind: "function", qualname: "decode", classification: "modified", path: "pkg/binary.py" },
            { id: "f", kind: "function", qualname: "render", classification: "modified", path: "web/app.js" },
        ],
    }, "C:\\fallback");
    assert.equal(request.base_sha, "abc");
    assert.deepEqual(request.files.map((file) => [file.path, file.current, file.callables.map((item) => item.id)]),
        [["pkg/binary.py", null, ["e"]], ["pkg/checker.py", "def verify(): pass\n", ["a"]]]);
    assert.deepEqual(request.known_classes, { Checker: ["pkg.checker"] });
    assert.deepEqual(request.known_modules, ["pkg.checker"]);
    assert.equal(buildDecisionRequest({ symbols: [], nodes: [] }), null);
});

function stubModel(revision) {
    return {
        metadata: { repo_root: "C:\\repo", base_sha: "base", revision },
        summary: {}, nodes: [{ id: "symbol:verify", kind: "method", name: "verify", path: "pkg/checker.py" }],
        edges: [], attention: [], coverage: {}, warnings: [], evidence: {},
        changes: [{ path: "pkg/checker.py", status: "added", lines_added: 3, lines_removed: 0 }],
        source_files: { "pkg/checker.py": { current: "def verify():\n    return 1\n", diff: "" } },
        symbols: [{ id: "symbol:verify", kind: "method", qualname: "Checker.verify", classification: "added", path: "pkg/checker.py" }],
    };
}

test("extraction starts only after analysis resolves and feeds summaries and briefings", async () => {
    const events = [];
    let finishDecisions;
    let analysisResolved = false;
    const contexts = [];
    const state = new ReviewState("C:\\repo", {
        readWorktreeFingerprint: null,
        runAnalyzer: async () => stubModel(1),
        runDecisions: (request, options) => {
            events.push({ analysisResolved, request, signal: options.signal });
            return new Promise((resolve) => { finishDecisions = resolve; });
        },
        generateAnnotation: async (context) => { contexts.push(context); return "## Summary\n\n- Ok."; },
    });
    state.subscribe((event) => events.push(event.type));
    const refresh = state.refresh().then(() => { analysisResolved = true; });
    await refresh;
    assert.equal(state.snapshot().decision_map.status, "loading", "summary metric shows extraction while it runs");
    await new Promise((resolve) => setImmediate(resolve));
    const run = events.find((event) => event.request);
    assert.equal(run.analysisResolved, true, "the decision extractor never runs on the analysis critical path");
    assert.deepEqual(run.request.files[0].callables, [{ id: "symbol:verify", qualname: "Checker.verify", change: "added",
        owner: "Checker", module: null, callers: [] }]);
    const overview = state.overviewFor();
    finishDecisions({ callables: [map.callables[0]], totals: { added: 2 }, limited: false, warnings: [], elapsed_ms: 5 });
    await overview;
    assert.equal(state.decisionMap.status, "complete");
    assert.ok(events.includes("decisions"));
    assert.equal(contexts[0].decision_map.callables[0].callable, "Checker.verify",
        "the automatic summary waits for deterministic decisions");
    await state.annotationFor("symbol:verify");
    assert.match(contexts[1].decision_changes.callables[0].changes[1], /only if `year`/);
    assert.equal(state.reviewCache.values().next().value.decisionMap.status, "complete", "completed maps are saved with the review");
});

test("failures are explicit, explanations do not wait forever, and dispose stops extraction", async () => {
    const failing = new ReviewState("C:\\repo", {
        readWorktreeFingerprint: null,
        runAnalyzer: async () => stubModel(1),
        runDecisions: async () => { throw new Error("python missing"); },
    });
    await failing.refresh();
    assert.deepEqual(await failing.decisionMapFor(), { status: "error", error: "Decision extraction failed: python missing" });

    let signal;
    const slow = new ReviewState("C:\\repo", {
        readWorktreeFingerprint: null,
        runAnalyzer: async () => stubModel(2),
        runDecisions: (_request, options) => new Promise((_resolve, reject) => {
            signal = options.signal;
            options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await slow.refresh();
    const started = Date.now();
    assert.equal((await slow.decisionMapFor(50)).status, "loading");
    assert.ok(Date.now() - started < 2000);
    await slow.dispose();
    assert.equal(signal.aborted, true);
    assert.equal(slow.decisionMap, null);
});

test("reanalysis supersedes a running extraction without stale results", async () => {
    const pending = [];
    let revision = 0;
    const state = new ReviewState("C:\\repo", {
        readWorktreeFingerprint: null,
        runAnalyzer: async () => stubModel(++revision),
        runDecisions: (request, options) => new Promise((resolve) => pending.push({ resolve, signal: options.signal })),
    });
    await state.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    await state.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending[0].signal.aborted, true);
    pending[0].resolve({ callables: [{ id: "stale" }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.decisionMap.status, "loading");
    pending[1].resolve({ callables: [], totals: {}, warnings: [] });
    await state.decisionMapFor();
    assert.deepEqual(state.decisionMap.callables, []);
});

test("reanalysis stops a running extraction before scanning; cancel restores the saved review's map", async () => {
    const extractions = [];
    let scans = 0;
    let releaseScan;
    const state = new ReviewState("C:\\repo", {
        readWorktreeFingerprint: null,
        runAnalyzer: async (_repo, _base, _progress, _ref, options) => {
            scans += 1;
            if (scans === 1) return stubModel(1);
            extractions.at(-1).abortedBeforeScan = extractions.at(-1).signal.aborted;
            await new Promise((resolve, reject) => {
                releaseScan = resolve;
                options.signal.addEventListener("abort", () => reject(options.signal.reason));
            });
            return stubModel(2);
        },
        runDecisions: (request, options) => new Promise((resolve) => {
            extractions.push({ signal: options.signal, resolve });
        }),
    });
    await state.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    const original = state.model;
    const reanalysis = state.refresh().catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(extractions[0].abortedBeforeScan, true, "the old extraction never overlaps the new scan");
    assert.equal(state.decisionMap, null);
    await state.cancel();
    await reanalysis;
    assert.equal(state.model, original);
    assert.equal(state.decisionMap.status, "loading", "cancel restarts extraction for the review still shown");
    await new Promise((resolve) => setImmediate(resolve));
    extractions.at(-1).resolve({ callables: [], totals: {}, warnings: [] });
    assert.equal((await state.decisionMapFor()).status, "complete");
    assert.equal(releaseScan !== undefined, true);
});

test("real extractor maps an actual commit's decisions through the provider", { timeout: 120000 }, async (t) => {
    const repo = await mkdtemp(join(tmpdir(), "review-decisions-"));
    t.after(() => rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "core.autocrlf", "false");
    await mkdir(join(repo, "pkg"));
    await writeFile(join(repo, "pkg", "__init__.py"), "");
    await writeFile(join(repo, "pkg", "resolver.py"),
        "def resolve(ref):\n    if not ref.title:\n        return None\n    if ref.partial:\n        return ref.partial\n    return official(ref)\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "pkg", "resolver.py"),
        "def resolve(ref):\n    if not ref.title:\n        return None\n    if ref.partial:\n        return ref.partial\n"
        + "    if ref.year and similarity(ref) >= 0.95:\n        return reports(ref)\n    return official(ref)\n");
    await git("commit", "-qam", "Add reports fallback");
    const state = new ReviewState(repo, { readWorktreeFingerprint: null });
    t.after(() => state.dispose());
    await state.setReviewTarget({ mode: "commit", ref: "HEAD" });
    const result = await state.decisionMapFor(60000);
    assert.equal(result.status, "complete", result.error);
    const resolve = result.callables.find((item) => item.qualname === "resolve");
    assert.deepEqual(resolve.counts, { added: 1, removed: 0, changed: 0, moved: 0 });
    const [added] = resolve.entries;
    assert.deepEqual([added.decision.only_if, added.decision.when, added.decision.thresholds], [["ref.year"], ["similarity(ref) >= 0.95"], ["0.95"]]);
    assert.match(added.after.label, /ref\.partial/);
    assert.match(added.before.label, /official\(ref\)/);
});
