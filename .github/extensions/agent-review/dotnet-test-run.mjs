import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawnOwnedAnalyzer } from "./ownership-guard.mjs";
import { pythonCandidates } from "./python-runtime.mjs";

const execute = promisify(execFile);
const parser = join(dirname(fileURLToPath(import.meta.url)), "analyzer", "dotnet_trx.py");

export function resolveDotnetRuntime(_repoRoot, config = {}) {
    return { executable: config.test_dotnet || process.env.AGENT_REVIEW_TEST_DOTNET || "dotnet",
        source: config.test_dotnet ? ".agent-review.json test_dotnet" : "PATH / AGENT_REVIEW_TEST_DOTNET" };
}

export function dotnetTestPlan(map, repoRoot) {
    const linked = (map?.verification?.tests || []).filter((test) => test.link !== "name-only");
    const projects = [...new Set(linked.map((test) => test.project).filter(Boolean))];
    let reason = map?.status !== "complete" ? "Code paths are still being extracted."
        : !linked.length ? "No statically resolved xUnit tests reach the changed C# code."
        : projects.length !== 1 ? "Linked .NET tests must belong to one test project per run." : null;
    const project = projects[0] || null;
    if (project) {
        const rel = relative(repoRoot, resolve(repoRoot, project));
        if (isAbsolute(project) || rel.startsWith("..") || isAbsolute(rel) || !project.toLowerCase().endsWith(".csproj")) {
            reason = "The linked test project is outside the reviewed snapshot.";
        }
    }
    const tests = [...new Set(linked.map((test) => test.full_name || test.id))];
    if (tests.some((id) => !/^[A-Za-z_][A-Za-z0-9_.+`]*$/.test(id))) {
        reason = "A linked test name cannot safely be represented in a VSTest exact-name filter.";
    }
    return { tests: tests.slice(0, 100), omitted: Math.max(0, tests.length - 100), project,
        files: [], reason, prerequisites: ".NET SDK, Microsoft.NET.Test.Sdk and xunit.runner.visualstudio. "
            + "Explicit Run builds/restores this test project and executes reviewed code. "
            + "TRX records test outcomes, not per-test path execution; paths remain inferred." };
}

export function dotnetTestCommand(runtime, plan) {
    const project = plan.project ? `.${sep}${normalize(plan.project)}` : "<test-project.csproj>";
    return [runtime.executable, "test", project, "--filter",
        plan.tests.map((id) => `FullyQualifiedName=${id}`).join("|"), "--logger", "trx", "--nologo",
        "-p:UseSharedCompilation=false", "-nodeReuse:false"];
}

export function formatDotnetTestCommand(runtime, plan) {
    const args = dotnetTestCommand(runtime, plan);
    const quote = (value) => /^[A-Za-z0-9_@.\\/:=+-]+$/.test(value) ? value
        : process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
    return `${process.platform === "win32" && quote(args[0]) !== args[0] ? "& " : ""}${args.map(quote).join(" ")}`;
}

export async function runDotnetTests({ repoRoot, python: runtime, plan, signal, workspacePath, timeoutMs = 180_000 }) {
    const directory = await mkdtemp(join(tmpdir(), "agent-review-dotnet-tests-"));
    try {
        const [executable, ...args] = dotnetTestCommand(runtime, plan);
        args.push("--results-directory", directory);
        const { code, output } = await new Promise((resolvePromise, reject) => {
            signal?.throwIfAborted();
            const child = spawnOwnedAnalyzer(executable, args, { cwd: repoRoot, workspacePath,
                env: { DOTNET_CLI_USE_MSBUILD_SERVER: "0", MSBUILDDISABLENODEREUSE: "1" } });
            let text = "";
            let failure;
            let timedOut = false;
            const append = (chunk) => { text = (text + chunk.toString("utf8")).slice(-6000); };
            child.stdout.on("data", append);
            child.stderr.on("data", append);
            child.on("message", (message) => {
                if (message.type === "spawn-error") failure = new Error(
                    `Unable to start .NET tests: ${message.message}. Install the project's .NET SDK or configure test_dotnet.`);
            });
            const stop = () => child.stop();
            signal?.addEventListener("abort", stop, { once: true });
            const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
            child.once("error", (error) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", stop);
                child.stop();
                reject(error);
            });
            child.once("close", (code) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", stop);
                if (signal?.aborted) reject(signal.reason);
                else if (failure) reject(failure);
                else if (timedOut) reject(new Error(`.NET tests exceeded ${timeoutMs / 1000}s and were stopped.\n${text}`));
                else resolvePromise({ code, output: text });
            });
        });
        let trace;
        for (const [python, prefix] of pythonCandidates()) {
            try {
                const result = await execute(python, [...prefix, parser, directory, JSON.stringify(plan.tests)],
                    { signal, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
                trace = JSON.parse(result.stdout);
                break;
            } catch (error) {
                if (error.code === "ENOENT") continue;
                throw new Error(`Unable to read .NET test evidence (exit ${code}): ${error.stderr || error.message}\n${output}`);
            }
        }
        if (!trace) throw new Error("Reading .NET TRX results requires Python 3 on PATH.");
        return { exit_code: code, output, trace,
            path_evidence_limitation: "TRX confirms individual test outcomes only. No per-test path tracing was collected." };
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}
