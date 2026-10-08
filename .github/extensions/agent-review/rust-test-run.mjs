import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { spawnOwnedAnalyzer } from "./ownership-guard.mjs";

export function resolveCargoRuntime(root, config = {}) {
    const configured = config.test_cargo || process.env.AGENT_REVIEW_TEST_CARGO;
    const executable = configured && !isAbsolute(configured) && existsSync(join(root, configured))
        ? join(root, configured) : configured || "cargo";
    return { executable, source: config.test_cargo ? ".agent-review.json test_cargo"
        : process.env.AGENT_REVIEW_TEST_CARGO ? "AGENT_REVIEW_TEST_CARGO" : "PATH" };
}

export function cargoTestPlan(map, repoRoot) {
    const linked = (map?.verification?.tests || []).filter((test) => test.link !== "name-only");
    const manifests = [...new Set(linked.map((test) => test.manifest || "Cargo.toml"))];
    let reason = map?.status !== "complete" ? "Code paths are still being extracted."
        : !linked.length ? "No statically linked Rust #[test] functions reach changed code."
            : manifests.length !== 1 ? "Linked Rust tests must belong to one Cargo manifest per run." : null;
    const manifest = manifests[0] || null;
    if (manifest) {
        const local = relative(repoRoot, resolve(repoRoot, manifest));
        if (isAbsolute(manifest) || !local || local === ".." || local.startsWith(`..${sep}`)
            || isAbsolute(local) || !manifest.endsWith("Cargo.toml")) {
            reason = "The linked Cargo manifest is outside the reviewed snapshot.";
        }
    }
    const tests = linked.slice(0, 100).map((test) => test.id);
    const rust_tests = linked.slice(0, 100).map((test) => ({
        id: test.id, name: test.name, path: test.path, manifest: test.manifest || "Cargo.toml",
    }));
    return {
        tests, rust_tests, manifest, omitted: Math.max(0, linked.length - 100),
        files: (map?.callables || []).filter((item) => item.line).map((item) => resolve(repoRoot, item.path)),
        source_hashes: map?.source_hashes || {}, reason,
        prerequisites: "Rust/Cargo and all dependencies required by the saved lockfile. Explicit Run may "
            + "download dependencies, compile build scripts/procedural macros, build, and execute reviewed code. "
            + "Cargo outcomes confirm linked tests, but no per-path runtime trace is collected.",
    };
}

export function cargoTestCommand(runtime, plan, test = plan.rust_tests?.[0]) {
    const manifest = plan.manifest ? `.${sep}${normalize(plan.manifest)}` : `.${sep}Cargo.toml`;
    return [runtime.executable, "test", "--manifest-path", manifest, "--locked", "--", test?.name || "<test>", "--exact", "--nocapture"];
}

export function formatCargoTestCommand(runtime, plan) {
    const quote = (value) => /^[A-Za-z0-9_@.\\/:=+-]+$/.test(value) ? value
        : process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
    const command = cargoTestCommand(runtime, plan).map(quote).join(" ");
    return `${command}${(plan.tests?.length || 0) > 1 ? `  # repeated for ${plan.tests.length} exact linked tests` : ""}`;
}

async function verifySources(root, hashes) {
    for (const [path, expected] of Object.entries(hashes || {})) {
        const file = resolve(root, path);
        const local = relative(root, file);
        if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)
            || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid reviewed Rust source hash: ${path}`);
        let source;
        try { source = await readFile(file); }
        catch (error) { throw new Error(`Unable to verify reviewed Rust source ${path}: ${error.message}`); }
        if (createHash("sha256").update(source).digest("hex") !== expected) {
            throw new Error(`Reviewed Rust source changed: ${path}. Reanalyze before running linked tests.`);
        }
    }
}

function runOwned(executable, args, { repoRoot, signal, timeoutMs, workspacePath }) {
    return new Promise((resolvePromise, reject) => {
        signal?.throwIfAborted();
        const child = spawnOwnedAnalyzer(executable, args, {
            cwd: repoRoot, workspacePath, env: { CARGO_TERM_COLOR: "never" },
        });
        let output = "";
        let failure;
        let timedOut = false;
        const append = (chunk) => { output = (output + chunk.toString("utf8")).slice(-64000); };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("message", (message) => {
            if (message.type === "spawn-error") failure = new Error(
                `Unable to start Cargo tests: ${message.message}. Install Rust or configure test_cargo.`);
        });
        const stop = () => child.stop();
        signal?.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
        child.once("error", (error) => { failure = error; });
        child.once("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", stop);
            if (signal?.aborted) reject(signal.reason);
            else if (failure) reject(failure);
            else if (timedOut) reject(new Error(`Cargo tests exceeded ${timeoutMs / 1000}s and were stopped.\n${output}`));
            else resolvePromise({ code, output });
        });
    });
}

export async function runCargoTests({ repoRoot, python: runtime, plan, signal, workspacePath, timeoutMs = 300_000 }) {
    if (!plan.rust_tests?.length) throw new Error(plan.reason || "No linked Rust tests were selected.");
    await verifySources(repoRoot, plan.source_hashes);
    const trace = { tests: {}, per_test_path_evidence: false };
    let output = "";
    let exitCode = 0;
    const deadline = Date.now() + timeoutMs;
    for (const test of plan.rust_tests) {
        signal?.throwIfAborted();
        await verifySources(repoRoot, plan.source_hashes);
        const [executable, ...args] = cargoTestCommand(runtime, plan, test);
        const result = await runOwned(executable, args, {
            repoRoot, signal, timeoutMs: Math.max(1, deadline - Date.now()), workspacePath,
        });
        output += `${output ? "\n" : ""}$ ${[executable, ...args].join(" ")}\n${result.output}`;
        exitCode ||= result.code || 0;
        const escaped = test.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const line = new RegExp(`test\\s+${escaped}\\s+\\.\\.\\.\\s+(ok|FAILED|ignored)`, "i").exec(result.output);
        const outcome = line?.[1].toLowerCase() === "ok" ? "passed"
            : line?.[1].toLowerCase() === "ignored" ? "skipped" : "failed";
        trace.tests[test.id] = { outcome, executed_lines: {} };
    }
    return { exit_code: exitCode, output, trace,
        path_evidence_limitation: "Cargo confirms exact linked test outcomes only. No per-test Rust path tracing was collected." };
}
