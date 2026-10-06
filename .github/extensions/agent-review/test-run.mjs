import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawnOwnedAnalyzer } from "./ownership-guard.mjs";
import { baseTestId, sameTest } from "./web/decision-map.mjs";

const execFileAsync = promisify(execFile);

const traceDirectory = join(dirname(fileURLToPath(import.meta.url)), "analyzer", "pytest_trace");
const MAX_RUN_TESTS = 100;
const OUTPUT_TAIL = 6000;

export function normalizePath(path) {
    const value = resolve(path);
    return process.platform === "win32" ? value.toLowerCase() : value;
}

// The project's interpreter, not the analyzer's: tests need the repository's dependencies.
export function resolveTestPython(repoRoot, config = {}) {
    if (config.test_python) {
        const configured = isAbsolute(config.test_python) ? config.test_python : join(repoRoot, config.test_python);
        return { executable: existsSync(configured) ? configured : config.test_python, source: ".agent-review.json test_python" };
    }
    if (process.env.AGENT_REVIEW_TEST_PYTHON) return { executable: process.env.AGENT_REVIEW_TEST_PYTHON, source: "AGENT_REVIEW_TEST_PYTHON" };
    for (const name of [".venv", "venv", "env"]) {
        for (const candidate of process.platform === "win32" ? ["Scripts\\python.exe"] : ["bin/python"]) {
            const path = join(repoRoot, name, candidate);
            if (existsSync(path)) return { executable: path, source: `${name} virtual environment` };
        }
    }
    return { executable: process.platform === "win32" ? "python" : "python3", source: "PATH" };
}

export function linkedTestPlan(map, repoRoot) {
    if (map?.status !== "complete") return { tests: [], files: [], reason: "Code paths are still being extracted." };
    const tests = (map.verification?.tests || []).filter((test) => test.link !== "name-only");
    const files = [...new Set((map.callables || [])
        .filter((item) => item.line && (item.entries || []).some((entry) => entry.status !== "removed"))
        .map((item) => resolve(repoRoot, item.path)))];
    return {
        tests: tests.slice(0, MAX_RUN_TESTS).map((test) => test.id),
        omitted: Math.max(0, tests.length - MAX_RUN_TESTS),
        files,
        reason: tests.length ? null : "No tests reach the changed code paths.",
    };
}

export function testCommand(python, plan) {
    return [python.executable, "-m", "pytest", "-p", "agent_review_trace", "-p", "no:cacheprovider", "-q", "--no-header", ...plan.tests];
}

// A commit or PR snapshot is materialized from Git objects through a throwaway index,
// so the repository's index, refs, and worktree are never touched.
export async function exportSnapshot(repoRoot, ref, { signal } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "agent-review-snapshot-"));
    const indexDirectory = await mkdtemp(join(tmpdir(), "agent-review-index-"));
    const options = { env: { ...process.env, GIT_INDEX_FILE: join(indexDirectory, "index") }, signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
    try {
        await execFileAsync("git", ["-C", repoRoot, "read-tree", ref], options);
        await execFileAsync("git", ["-C", repoRoot, `--work-tree=${directory}`, "checkout-index", "--all", "--force"], options);
        return directory;
    } catch (error) {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        throw signal?.aborted ? signal.reason : new Error(`Unable to export the reviewed snapshot for testing: ${error.message}`);
    } finally {
        await rm(indexDirectory, { recursive: true, force: true });
    }
}

export async function runLinkedTests({ repoRoot, python, plan, signal, timeoutMs = 180_000, workspacePath }) {
    const directory = await mkdtemp(join(tmpdir(), "agent-review-tests-"));
    const output = join(directory, "trace.json");
    const [executable, ...args] = testCommand(python, plan);
    try {
        const { code, tail, timedOut } = await new Promise((resolvePromise, reject) => {
            signal?.throwIfAborted();
            const child = spawnOwnedAnalyzer(executable, args, {
                workspacePath,
                cwd: repoRoot,
                env: {
                    PYTHONPATH: [traceDirectory, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
                    PYTHONDONTWRITEBYTECODE: "1",
                    AGENT_REVIEW_TRACE_FILES: JSON.stringify(plan.files),
                    AGENT_REVIEW_TRACE_OUTPUT: output,
                },
            });
            let text = "";
            let spawnError = null;
            let expired = false;
            const append = (chunk) => { text = (text + chunk.toString("utf8")).slice(-OUTPUT_TAIL); };
            child.stdout.on("data", append);
            child.stderr.on("data", append);
            child.on("message", (message) => {
                if (message.type === "spawn-error") spawnError = Object.assign(new Error(message.message), { code: message.code });
            });
            const stop = () => child.stop();
            signal?.addEventListener("abort", stop, { once: true });
            const timer = setTimeout(() => { expired = true; child.stop(); }, timeoutMs);
            child.once("error", reject);
            child.once("close", (exitCode) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", stop);
                if (signal?.aborted) { reject(signal.reason); return; }
                if (spawnError) { reject(spawnError); return; }
                resolvePromise({ code: exitCode, tail: text, timedOut: expired });
            });
        });
        let trace = null;
        try { trace = JSON.parse(await readFile(output, "utf8")); } catch { /* reported below */ }
        if (timedOut) throw new Error(`Linked tests exceeded ${Math.round(timeoutMs / 1000)}s and were stopped.\n${tail}`);
        if (!trace) {
            const missing = /No module named pytest/.test(tail)
                ? `pytest is not installed for ${executable}. Set "test_python" in .agent-review.json or AGENT_REVIEW_TEST_PYTHON to the project's interpreter.\n`
                : "";
            throw new Error(`${missing}The test run produced no trace (exit ${code}).\n${tail}`.trim());
        }
        // Exit 1 means tests ran and some failed; other non-zero codes mean pytest could not run them.
        const status = Number.isInteger(trace.exit_status) ? trace.exit_status : code;
        if (!Object.keys(trace.tests || {}).length || [2, 3, 4, 5].includes(status)) {
            const reason = { 2: "test collection was interrupted or failed", 3: "pytest hit an internal error",
                4: "pytest rejected the command line or a linked test ID", 5: "no linked tests were collected" }[status]
                || "no linked tests produced results";
            throw new Error(`pytest exit ${status}: ${reason}. No path evidence was recorded.\n${tail}`.trim());
        }
        // Tests that import an installed copy of the package never execute the files being traced.
        if (!Object.values(trace.tests).some((record) => Object.keys(record.lines || {}).length)) {
            throw new Error(`The linked tests ran but none executed the changed files under ${repoRoot}. `
                + "They may import an installed copy of the package rather than this checkout. "
                + "Set \"test_python\" in .agent-review.json to an environment that imports from the repository. "
                + `No path evidence was recorded.\n${tail}`.trim());
        }
        return { exit_code: code, output: tail, trace };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// Parametrized results (`test_x[case]`) belong to the statically linked `test_x`.
export { baseTestId, sameTest };

// Which linked tests executed each current-side code path, keyed by callable id and line.
// `null` marks a path whose proof line also runs when the path is not taken (asserts, one-line guards).
export function mapExecutedPaths(map, trace, repoRoot) {
    const executed = {};
    const ran = {};
    const tests = Object.entries(trace?.tests || {});
    for (const item of map?.callables || []) {
        const key = normalizePath(join(repoRoot, item.path));
        const linked = new Set([
            ...(map.verification?.tests || []).filter((test) => test.callable_ids
                ? test.callable_ids.includes(String(item.id)) : test.callables?.includes(item.qualname)).map((test) => test.id),
            ...(item.entries || []).flatMap((entry) => (entry.evidence?.tests || []).map((test) => test.id)),
        ]);
        ran[item.id] = tests.filter(([id]) => [...linked].some((linkedId) => sameTest(id, linkedId))).length;
        for (const entry of item.entries || []) {
            if (entry.status === "removed" || entry.decision.implicit) continue;
            const pathKey = `${item.id}:${entry.decision.line}`;
            const range = entry.decision.trace === undefined ? [entry.decision.line, entry.decision.end_line || entry.decision.line] : entry.decision.trace;
            if (!range) {
                executed[pathKey] = null;
                continue;
            }
            const [from, to] = range;
            const hits = [];
            for (const [id, record] of tests) {
                const lines = record.lines?.[key] || Object.entries(record.lines || {})
                    .find(([path]) => normalizePath(path) === key)?.[1];
                if (lines?.some((line) => line >= from && line <= to)) hits.push({ id, outcome: record.outcome });
            }
            executed[pathKey] = hits;
        }
    }
    return { executed, ran };
}
