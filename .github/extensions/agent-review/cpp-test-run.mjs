import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { spawnOwnedAnalyzer } from "./ownership-guard.mjs";

const sourceHash = (source) => createHash("sha256").update(source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n")).digest("hex");

export function resolveCppTestRuntime(_root, config = {}) {
    const executable = config.test_cpp;
    const build = config.test_cpp_build;
    const validBuild = Array.isArray(build) && build.length > 0
        && build.every((argument) => typeof argument === "string" && argument.length > 0 && !argument.includes("\0"));
    const error = typeof executable !== "string" || !executable || executable.includes("\0")
        ? "Configure test_cpp with a repository-relative GoogleTest or Catch2 executable."
        : !validBuild ? "Configure test_cpp_build with an argv array that builds the reviewed tests before execution." : null;
    return { executable: typeof executable === "string" ? executable : "<test_cpp>",
        build: validBuild ? build : [], error, source: ".agent-review.json test_cpp and test_cpp_build" };
}

export function cppTestPlan(map, root) {
    const linked = (map?.verification?.tests || []).filter((test) => test.link !== "name-only");
    const eligible = linked.filter((test) => ["gtest", "catch2"].includes(test.framework)
        && typeof test.name === "string" && test.name.length && !test.name.startsWith("-") && !test.name.includes("\0"));
    const frameworks = new Set(eligible.map((test) => test.framework));
    return { tests: eligible.slice(0, 100).map((test) => test.id), cpp_tests: eligible.slice(0, 100),
        files: [...new Set((map?.callables || []).map((item) => resolve(root, item.path)))],
        source_hashes: map?.source_hashes || {}, omitted: Math.max(0, eligible.length - 100),
        reason: map?.status !== "complete" ? "Code paths are still being extracted."
            : !eligible.length ? "No supported GoogleTest or Catch2 tests are statically linked to changed code."
                : frameworks.size !== 1 ? "Run one C/C++ test framework at a time." : null,
        prerequisites: "Explicit Run executes your configured build command and test binary. It may download dependencies "
            + "and execute reviewed build scripts and code; a snapshot export is not a sandbox. Test outcomes do not confirm individual code paths." };
}

export function cppTestCommand(runtime, plan, test = plan.cpp_tests?.[0]) {
    const name = test?.name || "<test>";
    return test?.framework === "catch2"
        ? [runtime.executable, name.replace(/[\\,*[\]]/g, "\\$&"), "--reporter", "junit"]
        : [runtime.executable, `--gtest_filter=${name}`, "--gtest_color=no"];
}

export function formatCppTestCommand(runtime, plan) {
    const quote = (argument) => JSON.stringify(argument);
    return `${runtime.build.map(quote).join(" ")} && ${cppTestCommand(runtime, plan).map(quote).join(" ")}`;
}

async function verifySources(root, hashes) {
    for (const [path, expected] of Object.entries(hashes || {})) {
        const full = resolve(root, path), local = relative(root, full);
        if (!local || isAbsolute(path) || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)
            || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid reviewed C/C++ source hash: ${path}`);
        const source = await readFile(full, "utf8");
        if (sourceHash(source) !== expected) throw new Error(`Reviewed C/C++ source changed: ${path}. Reanalyze before running tests.`);
    }
}

function command(executable, args, { repoRoot, signal, timeoutMs, workspacePath }) {
    return new Promise((resolvePromise, reject) => {
        signal?.throwIfAborted();
        const child = spawnOwnedAnalyzer(executable, args, { cwd: repoRoot, workspacePath });
        let output = "", failure, timedOut = false;
        const append = (chunk) => { output = (output + chunk.toString("utf8")).slice(-64000); };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("message", (message) => { if (message.type === "spawn-error") failure = new Error(message.message); });
        child.once("error", (error) => { failure = error; });
        const stop = () => child.stop();
        signal?.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
        child.once("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", stop);
            if (signal?.aborted) reject(signal.reason);
            else if (failure) reject(failure);
            else if (timedOut) reject(new Error(`C/C++ build/test exceeded its timeout and was stopped.\n${output}`));
            else if (code === null) reject(new Error(`C/C++ build/test terminated without an exit code.\n${output}`));
            else resolvePromise({ code, output });
        });
    });
}

export async function runCppTests({ repoRoot, python: runtime, plan, signal, workspacePath, timeoutMs = 300_000 }) {
    if (runtime.error) throw new Error(runtime.error);
    if (plan.reason || !plan.cpp_tests?.length) throw new Error(plan.reason || "No linked C/C++ tests were selected.");
    const executable = resolve(repoRoot, runtime.executable);
    const local = relative(repoRoot, executable);
    if (!local || isAbsolute(runtime.executable) || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        throw new Error("test_cpp must name a binary built inside the reviewed snapshot.");
    }
    if (!Object.keys(plan.source_hashes || {}).length) throw new Error("Reviewed C/C++ source hashes are required.");
    await verifySources(repoRoot, plan.source_hashes);
    const deadline = Date.now() + timeoutMs;
    const options = () => ({ repoRoot, signal, workspacePath, timeoutMs: Math.max(1, deadline - Date.now()) });
    const [builder, ...args] = runtime.build;
    const build = await command(builder, args, options());
    if (build.code !== 0) throw new Error(`C/C++ test build failed (exit ${build.code}).\n${build.output}`);
    const trace = { tests: {}, per_test_path_evidence: false };
    let output = build.output, exitCode = 0;
    for (const test of plan.cpp_tests) {
        await verifySources(repoRoot, plan.source_hashes);
        const [, ...args] = cppTestCommand(runtime, plan, test);
        const result = await command(executable, args, options());
        output = `${output}\n${result.output}`.slice(-64000);
        const escaped = test.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        let outcome;
        if (test.framework === "gtest") {
            const match = new RegExp(`^\\[\\s*(OK|FAILED|SKIPPED)\\s*\\]\\s+${escaped}(?:\\s|$)`, "m").exec(result.output);
            if (!match) throw new Error(`GoogleTest did not report an outcome for ${test.name}; zero-test runs are not passing evidence.\n${result.output}`);
            outcome = { OK: "passed", FAILED: "failed", SKIPPED: "skipped" }[match[1]];
        } else {
            const cases = result.output.match(/<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g) || [];
            const entry = cases.find((entry) => {
                const name = /\bname="([^"]*)"/.exec(entry)?.[1]?.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
                return name === test.name;
            });
            if (!entry) throw new Error(`Catch2 did not report the selected test ${test.name}.\n${result.output}`);
            outcome = /<(?:failure|error)\b/.test(entry) ? "failed" : /<skipped\b/.test(entry) ? "skipped" : "passed";
        }
        if (result.code !== 0 && outcome === "passed") throw new Error(`C/C++ test process failed after reporting ${test.name} passed.\n${result.output}`);
        exitCode ||= result.code || Number(outcome === "failed");
        trace.tests[test.id] = { outcome, executed_lines: {} };
    }
    await verifySources(repoRoot, plan.source_hashes);
    return { exit_code: exitCode, output, trace,
        path_evidence_limitation: "C/C++ results confirm exact linked test outcomes only. No per-test path tracing was collected." };
}
