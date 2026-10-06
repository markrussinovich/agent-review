import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnOwnedAnalyzer } from "./ownership-guard.mjs";
import { callbackCoverageLines } from "./node-test-range-lines.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const constraint = "Only native ESM node:test on Node.js 22.15+, with one top-level test per file and no suites, subtests, hooks, todo, or concurrency, supports isolated path evidence.";

export function resolveTestNode(root, config = {}) {
    const configured = config.test_node || process.env.AGENT_REVIEW_TEST_NODE;
    if (configured) {
        const path = isAbsolute(configured) ? configured : join(root, configured);
        return { executable: existsSync(path) ? path : configured,
            source: config.test_node ? ".agent-review.json test_node" : "AGENT_REVIEW_TEST_NODE" };
    }
    return { executable: "node", source: "PATH" };
}

export function linkedNodeTestPlan(map, root) {
    if (map?.status !== "complete") return { tests: [], files: [], reason: "Code paths are still being extracted." };
    const linked = (map.verification?.tests || []).filter((test) => test.link !== "name-only");
    const eligible = linked.filter((test) => {
        return (test.runner === "node:test" || test.framework === "node:test")
            && test.test_file_count === 1 && !test.concurrent && !test.suite && !test.nested
            && !test.skip && !test.todo;
    });
    const sourceKey = (path) => path.replace(/\\/g, "/").replace(/^\.\//, "");
    const sourceHashes = Object.fromEntries(Object.entries(map.source_hashes || {}).map(([path, hash]) => [sourceKey(path), hash]));
    for (const item of [...(map.callables || []), ...(map.verification?.tests || [])]) {
        const path = item.path || item.file || (item.runner && item.id?.split("::")[0]);
        if (path && item.source_hash) sourceHashes[sourceKey(path)] ??= item.source_hash;
    }
    return {
        tests: eligible.slice(0, 100).map((test) => test.id),
        node_tests: eligible.slice(0, 100).map((test) => ({
            id: test.id, path: test.path || test.file || test.id.split("::")[0],
            name: test.name || test.id.split("::").slice(1).join("::"),
        })),
        files: [...new Set((map.callables || []).filter((item) => item.line
            && (item.entries || []).some((entry) => entry.status !== "removed")).map((item) => resolve(root, item.path)))],
        omitted: Math.max(0, eligible.length - 100),
        unsupported: linked.length - eligible.length,
        source_hashes: sourceHashes,
        reason: eligible.length ? null : linked.length ? constraint : "No tests reach the changed code paths.",
    };
}

export function nodeTestCommand(runtime, plan) {
    const command = [runtime.executable, join(directory, "node-test-runtime-launch.mjs"), "--experimental-strip-types",
        "--test", "--test-concurrency=1", "--import",
        pathToFileURL(join(directory, "node-test-isolation-preload.mjs")).href, "--test-reporter",
        pathToFileURL(join(directory, "node-test-isolation-reporter.mjs")).href];
    const id = plan.tests?.[0];
    const test = plan.node_tests?.[0] || { path: id?.split("::")[0],
        name: id?.split("::").slice(1).join("::") };
    if (!test.path && !id) return command;
    if (!test.path || !test.name) throw new Error("A linked node:test requires an exact path and test name.");
    const pattern = `^${test.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    return [...command, `--test-name-pattern=${pattern}`, test.path];
}

function ownedCommand(executable, args, { repoRoot, signal, timeoutMs, workspacePath, env }) {
    return new Promise((resolvePromise, reject) => {
        signal?.throwIfAborted();
        const child = spawnOwnedAnalyzer(executable, args, { cwd: repoRoot, workspacePath, env });
        let output = "";
        let error;
        let timedOut = false;
        const append = (chunk) => { output = (output + chunk.toString("utf8")).slice(-64000); };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("message", (message) => {
            if (message.type === "spawn-error") error = new Error(`Unable to launch Node.js: ${message.message}`);
        });
        child.once("error", (value) => { error = value; });
        const stop = () => child.stop();
        signal?.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
        child.once("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", stop);
            if (signal?.aborted) reject(signal.reason);
            else if (error) reject(error);
            else if (timedOut) reject(new Error(`Linked node:test exceeded its timeout and was stopped.\n${output}`));
            else resolvePromise({ code, output });
        });
        if (signal?.aborted) stop();
    });
}

async function verifySources(root, hashes = {}) {
    const entries = Object.entries(hashes);
    for (let index = 0; index < entries.length; index += 64) {
        await Promise.all(entries.slice(index, index + 64).map(async ([path, expected]) => {
            const file = resolve(root, path);
            const local = relative(root, file);
            if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)
                || typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
                throw new Error(`Invalid reviewed source hash: ${path}`);
            }

            let source;
            try { source = await readFile(file, "utf8"); }
            catch (error) { throw new Error(`Unable to verify reviewed source ${path}: ${error.message}`); }
            if (createHash("sha256").update(source).digest("hex") !== expected) {
                throw new Error(`Reviewed source changed: ${path}. Reanalyze before running linked tests. No path evidence was recorded.`);
            }
        }));
    }
}

function requireSelectedHashes(root, plan, tests) {
    if (plan.source_hashes === undefined) return;
    const required = [...(plan.files || []), ...tests.map((test) => resolve(root, test.path))];
    for (const file of required) {
        const path = relative(root, resolve(file)).replace(/\\/g, "/");
        if (!plan.source_hashes[path]) {
            throw new Error(`Reviewed source hash missing: ${path}. Reanalyze before running linked tests. No path evidence was recorded.`);
        }
    }
}

export async function runLinkedNodeTests({ repoRoot, python, plan, signal, timeoutMs = 180000, workspacePath }) {
    const tests = plan.node_tests || plan.tests.map((id) => ({
        id, path: id.split("::")[0], name: id.split("::").slice(1).join("::"),
    }));
    if (!tests.length) throw new Error(plan.reason || "No supported linked node:test was selected.");
    signal?.throwIfAborted();
    requireSelectedHashes(repoRoot, plan, tests);
    await verifySources(repoRoot, plan.source_hashes);
    const runtime = python || resolveTestNode(repoRoot);
    const deadline = Date.now() + timeoutMs;
    const version = await ownedCommand(runtime.executable, ["--version"],
        { repoRoot, signal, timeoutMs, workspacePath });
    const match = /^v(\d+)\.(\d+)/.exec(version.output.trim());
    if (version.code || !match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 15)) {
        throw new Error(constraint);
    }
    const work = await mkdtemp(join(repoRoot, ".agent-review-node-tests-"));
    const trace = { tests: {} };
    let output = "";
    let exitCode = 0;
    try {
        for (const [index, test] of tests.entries()) {
            signal?.throwIfAborted();
            await verifySources(repoRoot, plan.source_hashes);
            const file = resolve(repoRoot, test.path);
            const local = relative(repoRoot, file);
            if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
                throw new Error("Linked test paths must remain inside the reviewed snapshot.");
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error("Linked node:test exceeded its timeout.");
            const coverageDirectory = join(work, String(index));
            await mkdir(coverageDirectory);
            const capture = join(coverageDirectory, "callback.json");
            const [executable, ...args] = nodeTestCommand(runtime, { node_tests: [test] });
            const result = await ownedCommand(executable, args, { repoRoot, signal, timeoutMs: remaining, workspacePath,
                env: { NODE_V8_COVERAGE: coverageDirectory, AGENT_REVIEW_NODE_TRACE: capture,
                    AGENT_REVIEW_NODE_ROOT: repoRoot, NODE_OPTIONS: "" } });
            await verifySources(repoRoot, plan.source_hashes);
            signal?.throwIfAborted();
            output = (output + result.output).slice(-6000);
            const events = result.output.split(/\r?\n/).filter((line) => line.startsWith('{"agent_review_test":'))
                .map((line) => JSON.parse(line));
            const matches = events.filter((event) => event.name === test.name && event.nesting === 0);
            if (matches.length !== 1 || events.some((event) => event.name !== test.name)) {
                throw new Error(`Unsupported or uncollected isolated node:test. ${constraint}\n${result.output}`);
            }
            const event = matches[0];
            let lines = {};
            if (!event.skip && !event.todo) {
                let report;
                try { report = JSON.parse(await readFile(capture, "utf8")); }
                catch (error) { throw new Error(`The isolated test produced no valid callback coverage: ${error.message}\n${result.output}`); }
                if (report.unsupported) throw new Error(constraint);
                if (report.async_overlap) throw new Error("Repository setup async work overlapped the isolated test callback. No per-test path evidence was recorded.");
                lines = await callbackCoverageLines(report, plan.files || []);
            }
            if (result.code && event.outcome !== "failed") {
                throw new Error(`Node test tooling failed with exit ${result.code}.\n${result.output}`);
            }
            trace.tests[test.id] = { outcome: event.todo ? "skipped" : event.outcome,
                duration_ms: event.duration_ms, lines };
            if (event.outcome === "failed") exitCode = 1;
        }
        if ((plan.files || []).length && Object.values(trace.tests).some((test) => test.outcome !== "skipped")
            && !Object.values(trace.tests).some((test) => Object.keys(test.lines).length)) {
            throw new Error("The isolated tests did not execute the selected snapshot files. They may import an installed or compiled copy. No path evidence was recorded.");
        }
        return { exit_code: exitCode, output, trace };
    } finally {
        await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        signal?.throwIfAborted();
    }
}
