import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ReviewState, buildDecisionRequest, attachCoverage } from "../review-state.mjs";
import { linkedTestPlan, mapExecutedPaths, normalizePath, resolveTestPython, runLinkedTests, testCommand } from "../test-run.mjs";
import { decisionPromptContext, evidenceCounts, linkedTestOutcome, pathEvidence } from "../web/decision-map.mjs";

const execute = promisify(execFile);
const decision = (line, overrides = {}) => ({ kind: "exit", outcome: "empty", value: "None", when: ["not ref"], when_mode: "one",
    only_if: [], context: [], loop: null, on_error: null, thresholds: [], line, end_line: line, ...overrides });
const item = {
    id: "symbol:verify", qualname: "Checker.verify", path: "pkg/checker.py", line: 5, change: "added",
    counts: { added: 3 }, entries: [
        { status: "added", decision: decision(7), evidence: { level: "asserted", tests: [{ id: "tests/t.py::test_none", link: "direct",
            match: "no-result", assertion: { text: "data is None" }, ambiguous: 2 }] } },
        { status: "added", decision: decision(9, { outcome: "value", value: "found" }), evidence: { level: "reachable",
            tests: [{ id: "tests/t.py::TestApi::test_public", link: "via", via: "public" }] } },
        { status: "added", decision: decision(11), evidence: { level: "none", tests: [] } },
        { status: "removed", decision: decision(3), evidence: null },
    ],
};
const map = { status: "complete", callables: [item], verification: { tests: [
    { id: "tests/t.py::test_none", link: "direct", name: "test_none", path: "tests/t.py", line: 3, callables: ["Checker.verify"] },
    { id: "tests/t.py::TestApi::test_public", link: "via", via: "public", name: "test_public", path: "tests/t.py", line: 9, callables: ["Checker.verify"] },
    { id: "tests/other.py::test_other", link: "name-only", name: "test_other", path: "tests/other.py", line: 1, callables: ["Checker.verify"] },
] } };

test("evidence wording separates confirmed, inferred, and untested paths", () => {
    assert.match(pathEvidence(item, item.entries[0]).text, /^Asserted \(inferred\): `test_none` checks `data is None` — the same check matches 2 paths/);
    assert.match(pathEvidence(item, item.entries[1]).text, /^Reached via `public` from `test_public` \(inferred\)/);
    assert.equal(pathEvidence(item, item.entries[2]).text, "No test evidence");
    assert.equal(pathEvidence(item, item.entries[3]), null, "removed paths have no current evidence");
    const run = { status: "complete", planned: 2, ran: { "symbol:verify": 2 }, tests: [{ id: "tests/t.py::test_none" }, { id: "tests/t.py::TestApi::test_public" }],
        executed: { "symbol:verify:7": [{ id: "tests/t.py::test_none", outcome: "passed" }], "symbol:verify:9": [{ id: "x::test_bad", outcome: "failed" }], "symbol:verify:11": [] } };
    assert.match(pathEvidence(item, item.entries[0], run).text, /^Confirmed: executed by `test_none` \(passed\)/);
    assert.equal(pathEvidence(item, item.entries[1], run).tone, "failing");
    assert.match(pathEvidence(item, item.entries[2], run).text, /^Not executed by the 2 linked tests that ran · No test evidence/);
    assert.deepEqual(evidenceCounts(map, run), { confirmed: 2, inferred: 0, untested: 1 });
    assert.deepEqual(evidenceCounts(map, { ...run, stale: true }), { confirmed: 0, inferred: 2, untested: 1 }, "stale runs are ignored");
    const prompt = decisionPromptContext(map, map.callables, { run });
    assert.match(prompt.callables[0].changes[0], /test evidence: Confirmed: executed by `test_none`/);
    assert.match(prompt.evidence_note, /'inferred' links come from static analysis/);
});

test("run plans exclude name-only links and trace only current changed files", () => {
    const plan = linkedTestPlan(map, "C:\\repo");
    assert.deepEqual(plan.tests, ["tests/t.py::test_none", "tests/t.py::TestApi::test_public"]);
    assert.deepEqual(plan.files, [join("C:\\repo", "pkg/checker.py")]);
    assert.match(linkedTestPlan({ status: "complete", callables: [], verification: { tests: [] } }, "C:\\repo").reason, /No tests reach/);
    assert.deepEqual(testCommand({ executable: "py" }, plan).slice(0, 8), ["py", "-m", "pytest", "-p", "agent_review_trace", "-p", "no:cacheprovider", "-q"]);
    const repo = "C:\\repo";
    const { executed, ran } = mapExecutedPaths(map, { tests: {
        "tests/t.py::test_none": { outcome: "passed", lines: { [normalizePath(join(repo, "pkg/checker.py"))]: [6, 7] } },
        "tests/t.py::TestApi::test_public": { outcome: "passed", lines: { [join(repo, "pkg", "checker.py")]: [9] } },
    } }, repo);
    assert.deepEqual(executed["symbol:verify:7"].map((hit) => hit.id), ["tests/t.py::test_none"]);
    assert.deepEqual(executed["symbol:verify:9"].map((hit) => hit.id), ["tests/t.py::TestApi::test_public"], "trace paths are normalized");
    assert.deepEqual(executed["symbol:verify:11"], []);
    assert.equal("symbol:verify:3" in executed, false);
    assert.deepEqual(ran, { "symbol:verify": 2 }, "both linked tests produced results");
});

test("test interpreter prefers configuration, then environment, then the repository virtual environment", async (t) => {
    const repo = await mkdtemp(join(tmpdir(), "review-python-"));
    t.after(() => rm(repo, { recursive: true, force: true }));
    const previous = process.env.AGENT_REVIEW_TEST_PYTHON;
    t.after(() => { if (previous === undefined) delete process.env.AGENT_REVIEW_TEST_PYTHON; else process.env.AGENT_REVIEW_TEST_PYTHON = previous; });
    delete process.env.AGENT_REVIEW_TEST_PYTHON;
    assert.equal(resolveTestPython(repo).source, "PATH");
    const venv = join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
    await mkdir(venv, { recursive: true });
    await writeFile(join(venv, process.platform === "win32" ? "python.exe" : "python"), "");
    assert.equal(resolveTestPython(repo).source, ".venv virtual environment");
    process.env.AGENT_REVIEW_TEST_PYTHON = "custom-python";
    assert.equal(resolveTestPython(repo).executable, "custom-python");
    assert.equal(resolveTestPython(repo, { test_python: "tools/py" }).source, ".agent-review.json test_python");
});

test("coverage reports mark executed and missed path lines without claiming which test ran them", () => {
    const covered = attachCoverage({ callables: [structuredClone(item)] }, { coverage: { available: true,
        files: [{ path: "pkg/checker.py", covered_lines: [7], executable_lines: [7, 9, 11] }] } });
    const entries = covered.callables[0].entries;
    assert.deepEqual(entries.map((entry) => entry.evidence?.coverage ?? null), ["executed", "not executed", "not executed", null]);
    assert.match(pathEvidence(covered.callables[0], entries[1]).text, /coverage report: not executed$/);
});

test("decision requests carry callers, owners, and only test files that mention them", () => {
    const request = buildDecisionRequest({
        metadata: {}, nodes: [], changes: [{ path: "tests/test_checker.py", added_lines: [4] }],
        edges: [{ type: "calls", source: "s:public", target: "s:verify" }, { type: "calls", source: "s:test", target: "s:public" }],
        symbols: [
            { id: "s:verify", kind: "method", qualname: "Checker.verify", module: "pkg.checker", classification: "added", path: "pkg/checker.py" },
            { id: "s:public", kind: "function", qualname: "public", module: "pkg.api", classification: "unchanged", path: "pkg/api.py" },
            { id: "s:test", kind: "function", qualname: "test_api", module: "tests.test_api", classification: "unchanged", path: "tests/test_api.py" },
        ],
        source_files: {
            "pkg/checker.py": { current: "class Checker:\n    def verify(self): pass\n" },
            "tests/test_checker.py": { current: "def test_x():\n    Checker().verify()\n" },
            "tests/test_api.py": { current: "def test_api():\n    public()\n" },
            "tests/test_unrelated.py": { current: "def test_y():\n    other()\n" },
        },
    });
    const [callable] = request.files[0].callables;
    assert.deepEqual([callable.owner, callable.module, callable.callers], ["Checker", "pkg.checker", [{ name: "public", owner: null, module: "pkg.api" }]],
        "test functions are never treated as production callers");
    assert.deepEqual(request.tests.map((file) => [file.path, file.added_lines]),
        [["tests/test_checker.py", [4]], ["tests/test_api.py", []]]);
});

function stubModel() {
    return {
        metadata: {}, summary: {}, nodes: [], edges: [], attention: [], coverage: {}, warnings: [], evidence: {},
        changes: [{ path: "pkg/checker.py", status: "added", lines_added: 3, lines_removed: 0 }],
        source_files: { "pkg/checker.py": { current: "def verify():\n    return 1\n", diff: "" } },
        symbols: [{ id: "symbol:verify", kind: "function", qualname: "verify", classification: "added", path: "pkg/checker.py" }],
    };
}

test("linked test runs are explicit, worktree-only, cancellable, stale-aware, and reset by reanalysis", async () => {
    let finish;
    let signal;
    const state = new ReviewState(process.cwd(), {
        readWorktreeFingerprint: null,
        runAnalyzer: async () => stubModel(),
        runDecisions: async () => ({ callables: [item], verification: map.verification, totals: {}, warnings: [] }),
        runTests: (options) => {
            signal = options.signal;
            return new Promise((resolve, reject) => {
                finish = resolve;
                options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
            });
        },
    });
    await state.refresh();
    await state.decisionMapFor();
    assert.equal(state.testRun, null, "tests never run automatically");
    state.reviewTarget = { mode: "worktree" };
    state.worktreeChanged = true;
    await assert.rejects(state.runLinkedTests(), /worktree changed/);
    state.worktreeChanged = false;
    const run = await state.runLinkedTests();
    assert.equal(run.status, "running");
    assert.match(run.command, /-m pytest -p agent_review_trace .*tests\/t\.py::test_none/);
    await assert.rejects(state.runLinkedTests(), /already running/);
    finish({ exit_code: 1, output: "1 failed", trace: { tests: {
        "tests/t.py::test_none": { outcome: "passed", lines: { [normalizePath(join(process.cwd(), "pkg/checker.py"))]: [7] } },
        "tests/t.py::TestApi::test_public": { outcome: "failed", lines: {} },
    } } });
    await state.testRunPromise;
    assert.deepEqual(state.testRun.counts, { passed: 1, failed: 1, error: 0, skipped: 0 });
    assert.deepEqual(state.testRun.executed["symbol:verify:7"], [{ id: "tests/t.py::test_none", outcome: "passed" }]);
    assert.equal(state.testRun.ran["symbol:verify"], 2);
    state.worktreeChanged = true;
    assert.equal(state.snapshot().test_run.stale, true, "a later worktree edit makes the run stale");
    state.worktreeChanged = false;
    const second = state.runLinkedTests();
    await second;
    state.cancelTestRun();
    assert.equal(signal.aborted, true);
    assert.equal(state.testRun.status, "cancelled");
    await state.refresh();
    assert.equal(state.testRun, null, "reanalysis clears runs for the previous snapshot");
    await state.dispose();
});

test("runs that collect nothing fail loudly instead of marking every path untested", async (t) => {
    try { await execute("python", ["-c", "import pytest"]); } catch { t.skip("pytest is not installed"); return; }
    const repo = await mkdtemp(join(tmpdir(), "review-bad-ids-"));
    t.after(() => rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    await writeFile(join(repo, "test_ok.py"), "def test_ok():\n    assert True\n");
    await assert.rejects(runLinkedTests({ repoRoot: repo, python: { executable: "python" },
        plan: { tests: ["test_ok.py::test_ok", "test_ok.py::TestBase::test_missing"], files: [join(repo, "test_ok.py")] } }),
    /pytest exit 4: pytest rejected the command line or a linked test ID\. No path evidence was recorded/);
});

test("untraceable paths and paths whose tests never ran keep their static evidence", () => {
    const untraceable = { ...item.entries[0], decision: { ...item.entries[0].decision, trace: null } };
    const local = { ...item, entries: [untraceable, item.entries[2]] };
    const { executed } = mapExecutedPaths({ callables: [local], verification: map.verification }, { tests: {} }, "C:\\repo");
    assert.equal(executed["symbol:verify:7"], null, "a shared condition/exit line cannot prove the path");
    const run = { status: "complete", planned: 2, ran: { "symbol:verify": 1 }, executed };
    assert.match(pathEvidence(local, untraceable, run).text, /^Asserted \(inferred\).*the run cannot confirm this path/);
    const notRun = { ...run, ran: { "symbol:verify": 0 }, executed: { "symbol:verify:11": [] } };
    assert.equal(pathEvidence(local, item.entries[2], notRun).text, "No test evidence",
        "when none of this callable's linked tests ran, the run says nothing about it");
});

test("same-named callables in different files never share linked tests", () => {
    const first = { id: "symbol:a", qualname: "main", path: "a.py", line: 1, entries: [{ status: "added", decision: decision(3) }] };
    const second = { id: "symbol:b", qualname: "main", path: "b.py", line: 1, entries: [{ status: "added", decision: decision(3) }] };
    const { ran } = mapExecutedPaths({ callables: [first, second], verification: { tests: [
        { id: "tests/test_b.py::test_main", callables: ["main"], callable_ids: ["symbol:b"] },
    ] } }, { tests: { "tests/test_b.py::test_main": { outcome: "passed", lines: {} } } }, "C:\\repo");
    assert.deepEqual(ran, { "symbol:a": 0, "symbol:b": 1 });
});

test("parametrized results map to their linked test with the worst outcome", () => {
    const run = { tests: [{ id: "tests/t.py::test_x[a]", outcome: "passed" }, { id: "tests/t.py::test_x[b]", outcome: "failed" },
        { id: "tests/t.py::test_y", outcome: "passed" }] };
    assert.equal(linkedTestOutcome(run, "tests/t.py::test_x"), "failed");
    assert.equal(linkedTestOutcome(run, "tests/t.py::test_y"), "passed");
    assert.equal(linkedTestOutcome(run, "tests/t.py::test_z"), undefined);
});

test("concurrent run requests cannot both start pytest", async () => {
    let starts = 0;
    const state = new ReviewState(process.cwd(), {
        readWorktreeFingerprint: null,
        runAnalyzer: async () => stubModel(),
        runDecisions: async () => ({ callables: [item], verification: map.verification, totals: {}, warnings: [] }),
        runTests: (options) => { starts += 1; return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason))); },
    });
    await state.refresh();
    await state.decisionMapFor();
    state.reviewTarget = { mode: "worktree" };
    const results = await Promise.allSettled([state.runLinkedTests(), state.runLinkedTests()]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    assert.match(results.find((result) => result.status === "rejected").reason.message, /already running/);
    assert.equal(starts, 1);
    await state.dispose();
});

test("commit reviews run linked tests in an exported snapshot, never the dirty worktree", { timeout: 180000 }, async (t) => {
    try { await execute("python", ["-c", "import pytest"]); } catch { t.skip("pytest is not installed for python on PATH"); return; }
    const repo = await mkdtemp(join(tmpdir(), "review-commit-tests-"));
    const previous = process.env.AGENT_REVIEW_TEST_PYTHON;
    process.env.AGENT_REVIEW_TEST_PYTHON = "python";
    t.after(async () => {
        if (previous === undefined) delete process.env.AGENT_REVIEW_TEST_PYTHON; else process.env.AGENT_REVIEW_TEST_PYTHON = previous;
        await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "core.autocrlf", "false");
    await mkdir(join(repo, "pkg"));
    await mkdir(join(repo, "tests"));
    await writeFile(join(repo, "pkg", "__init__.py"), "");
    await writeFile(join(repo, "conftest.py"), "");
    await writeFile(join(repo, "pkg", "resolver.py"), "def resolve(ref):\n    return ref\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "pkg", "resolver.py"),
        "def resolve(ref):\n    if not ref:\n        return None\n    if ref == 'legacy':\n        raise ValueError(ref)\n    return ref\n");
    await writeFile(join(repo, "tests", "test_resolver.py"),
        "from pkg.resolver import resolve\n\ndef test_missing():\n    assert resolve('') is None\n");
    await git("add", ".");
    await git("commit", "-qm", "Add guards");
    // The worktree diverges after the commit; the run must test the committed snapshot.
    await writeFile(join(repo, "pkg", "resolver.py"), "def resolve(ref):\n    raise RuntimeError('worktree edit')\n");
    const statusBefore = (await git("status", "--porcelain=v2")).stdout;
    const state = new ReviewState(repo, {});
    t.after(() => state.dispose());
    await state.setReviewTarget({ mode: "commit", ref: "HEAD" });
    await state.decisionMapFor(60000);
    const plan = await state.testRunPlan();
    assert.equal(plan.available, true, plan.reason);
    assert.match(plan.location, /^a temporary export of Commit [a-f0-9]{7}$/);
    await state.runLinkedTests();
    const run = await state.testRunPromise;
    assert.equal(run.status, "complete", run.error);
    assert.deepEqual(run.counts, { passed: 1, failed: 0, error: 0, skipped: 0 }, "the committed code passes; the worktree edit would fail");
    const resolve = state.decisionMap.callables.find((entry) => entry.qualname === "resolve");
    const byLine = Object.fromEntries(resolve.entries.map((entry) => [entry.decision.line, pathEvidence(resolve, entry, run).text]));
    assert.match(byLine[3], /^Confirmed: executed by `test_missing` \(passed\)/);
    assert.match(byLine[5], /^Not executed by the 1 linked test that ran/);
    assert.equal((await git("status", "--porcelain=v2")).stdout, statusBefore, "the repository status is untouched");
    state.worktreeChanged = true;
    assert.equal(state.snapshot().test_run.stale, false, "commit snapshots never go stale");
});

test("real linked tests confirm which changed paths ran in a worktree review", { timeout: 180000 }, async (t) => {
    try { await execute("python", ["-c", "import pytest"]); } catch { t.skip("pytest is not installed for python on PATH"); return; }
    const repo = await mkdtemp(join(tmpdir(), "review-linked-tests-"));
    const previous = process.env.AGENT_REVIEW_TEST_PYTHON;
    process.env.AGENT_REVIEW_TEST_PYTHON = "python";
    t.after(async () => {
        if (previous === undefined) delete process.env.AGENT_REVIEW_TEST_PYTHON; else process.env.AGENT_REVIEW_TEST_PYTHON = previous;
        await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "core.autocrlf", "false");
    await mkdir(join(repo, "pkg"));
    await mkdir(join(repo, "tests"));
    await writeFile(join(repo, "pkg", "__init__.py"), "");
    await writeFile(join(repo, "pkg", "resolver.py"), "def resolve(ref):\n    return ref\n");
    await writeFile(join(repo, "conftest.py"), "");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "pkg", "resolver.py"),
        "def resolve(ref):\n    if not ref:\n        return None\n    if ref == 'legacy':\n        raise ValueError(ref)\n    return ref\n");
    await writeFile(join(repo, "tests", "test_resolver.py"),
        "from pkg.resolver import resolve\n\ndef test_missing():\n    assert resolve('') is None\n\ndef test_value():\n    assert resolve('x') == 'x'\n");
    const state = new ReviewState(repo, { baseRef: "HEAD" });
    t.after(() => state.dispose());
    await state.refresh();
    const decisions = await state.decisionMapFor(60000);
    assert.equal(decisions.status, "complete", decisions.error);
    const plan = await state.testRunPlan();
    assert.equal(plan.available, true, plan.reason);
    await state.runLinkedTests();
    const run = await state.testRunPromise;
    assert.equal(run.status, "complete", run.error);
    assert.deepEqual(run.counts, { passed: 2, failed: 0, error: 0, skipped: 0 });
    const resolve = decisions.callables.find((entry) => entry.qualname === "resolve");
    const byLine = Object.fromEntries(resolve.entries.map((entry) => [entry.decision.line, pathEvidence(resolve, entry, run).text]));
    assert.match(byLine[3], /^Confirmed: executed by `test_missing` \(passed\)/);
    assert.equal(byLine[6], undefined, "the unchanged success return is not a changed path");
    assert.match(byLine[5], /^Not executed by the 2 linked tests that ran/, "the untested raise is exposed as a boundary");
    const status = await execute("git", ["-C", repo, "status", "--short"]);
    assert.doesNotMatch(status.stdout, /pytest_cache|__pycache__/, "the run leaves no caches in the repository");
});
