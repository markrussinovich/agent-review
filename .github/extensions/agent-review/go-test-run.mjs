import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnOwnedAnalyzer } from "./ownership-guard.mjs";

const MAX_TESTS = 100;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function resolveTestGo(_repoRoot, config = {}) {
    return { executable: config.test_go || process.env.AGENT_REVIEW_TEST_GO || "go",
        source: config.test_go ? ".agent-review.json test_go" : "PATH / AGENT_REVIEW_TEST_GO" };
}

function parseId(id) {
    const split = String(id).lastIndexOf("::");
    return split < 0 ? null : { path: id.slice(0, split), name: id.slice(split + 2) };
}

export function goTestPlan(map, repoRoot) {
    const linked = (map?.verification?.tests || []).filter((test) => test.link !== "name-only");
    let reason = map?.status !== "complete" ? "Code paths are still being extracted."
        : !linked.length ? "No statically linked Go tests reach the changed code." : null;
    const records = [];
    for (const test of linked) {
        const parsed = parseId(test.id);
        const packagePath = test.package || (parsed?.path.includes("/") ? parsed.path.slice(0, parsed.path.lastIndexOf("/")) : ".");
        const full = resolve(repoRoot, packagePath);
        const rel = relative(repoRoot, full);
        const testRel = parsed ? relative(repoRoot, resolve(repoRoot, parsed.path)) : "..";
        if (!parsed || !/^Test[A-Z0-9_]\w*$/.test(parsed.name)
            || isAbsolute(packagePath) || rel.startsWith("..") || isAbsolute(rel)
            || testRel.startsWith("..") || isAbsolute(testRel)) {
            reason = "A linked Go test has an unsafe name or lies outside the reviewed snapshot.";
            continue;
        }
        records.push({ id: test.id, name: parsed.name, path: parsed.path, package: packagePath,
            source_hash: test.source_hash || null });
    }
    const tests = records.slice(0, MAX_TESTS).map((item) => item.id);
    const sourceHashes = { ...(map?.source_hashes || {}) };
    for (const callable of map?.callables || []) {
        if (callable.path && callable.source_hash) sourceHashes[callable.path] = callable.source_hash;
    }
    for (const test of records) if (test.source_hash) sourceHashes[test.path] = test.source_hash;
    return { tests, records: records.slice(0, MAX_TESTS), source_hashes: sourceHashes,
        omitted: Math.max(0, records.length - MAX_TESTS), files: [], reason,
        prerequisites: "A Go toolchain and the reviewed module dependencies. Explicit Run may download modules "
            + "and executes repository test/package initialization code; analysis never does." };
}

export function goTestCommand(runtime, plan) {
    const records = plan.records || plan.tests.map((id) => {
        const parsed = parseId(id);
        return { ...parsed, package: parsed.path.includes("/") ? parsed.path.slice(0, parsed.path.lastIndexOf("/")) : "." };
    });
    const packages = [...new Set(records.map((item) => item.package === "." ? "." : `.${sep}${item.package.replaceAll("/", sep)}`))];
    const names = [...new Set(records.map((item) => item.name))];
    return [runtime.executable, "test", ...packages, "-count=1", "-run", `^(?:${names.join("|")})$`, "-json"];
}

export function goSingleTestCommand(runtime, test, profile = "<temporary-coverprofile>") {
    const packageArg = test.package === "." ? "." : `.${sep}${test.package.replaceAll("/", sep)}`;
    return [runtime.executable, "test", packageArg, "-count=1", "-run", `^${test.name}$`, "-json",
        `-coverprofile=${profile}`];
}

export function formatGoTestCommand(runtime, plan) {
    const quote = (value) => /^[A-Za-z0-9_@.\\/:=+()^$-]+$/.test(value) ? value
        : process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
    return plan.records.map((test, index) =>
        goSingleTestCommand(runtime, test, `<temporary-coverprofile-${index + 1}>`).map(quote).join(" ")).join("\n");
}

async function verifySources(repoRoot, sourceHashes) {
    for (const [path, expected] of Object.entries(sourceHashes || {})) {
        const full = resolve(repoRoot, path);
        const rel = relative(repoRoot, full);
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Go source hash path is outside the reviewed snapshot: ${path}`);
        let raw;
        try { raw = await readFile(full); }
        catch (error) { throw new Error(`Reviewed Go source is unavailable before test execution: ${path}: ${error.message}`); }
        if (hash(raw) !== expected) throw new Error(`Reviewed Go source changed before test execution: ${path}. Reanalyze first.`);
    }
}

function runOwned(executable, args, { cwd, signal, workspacePath, timeoutMs }) {
    return new Promise((resolvePromise, reject) => {
        signal?.throwIfAborted();
        const child = spawnOwnedAnalyzer(executable, args, { cwd, workspacePath,
            env: { GOTOOLCHAIN: "local" } });
        let output = "", spawnError, timedOut = false;
        const append = (chunk) => { output = (output + chunk.toString("utf8")).slice(-12000); };
        child.stdout.on("data", append); child.stderr.on("data", append);
        child.on("message", (message) => {
            if (message.type === "spawn-error") spawnError = new Error(
                `Unable to start Go tests: ${message.message}. Install Go or configure test_go.`);
        });
        const stop = () => child.stop();
        signal?.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
        child.once("error", reject);
        child.once("close", (code) => {
            clearTimeout(timer); signal?.removeEventListener("abort", stop);
            if (signal?.aborted) reject(signal.reason);
            else if (spawnError) reject(spawnError);
            else if (timedOut) reject(new Error(`Go test exceeded ${Math.round(timeoutMs / 1000)}s and was stopped.\n${output}`));
            else resolvePromise({ code, output });
        });
    });
}

function outcome(output, name, code) {
    let state = code === 0 ? "passed" : "error", duration = 0;
    for (const line of output.split(/\r?\n/)) {
        try {
            const event = JSON.parse(line);
            if (event.Test !== name) continue;
            if (event.Action === "pass") state = "passed";
            else if (event.Action === "fail") state = "failed";
            else if (event.Action === "skip") state = "skipped";
            if (Number.isFinite(event.Elapsed)) duration = Math.round(event.Elapsed * 1000);
        } catch { /* ordinary go diagnostics are retained in output */ }
    }
    return { outcome: state, duration_ms: duration };
}

async function sourceFiles(repoRoot) {
    const goFiles = [];
    async function collect(directory) {
        const { readdir } = await import("node:fs/promises");
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.name === ".git" || entry.name === "vendor") continue;
            const full = join(directory, entry.name);
            if (entry.isDirectory()) await collect(full);
            else if (entry.name.endsWith(".go")) goFiles.push(full);
        }
    }
    await collect(repoRoot);
    return goFiles;
}

async function profileLines(profile, repoRoot, goFiles) {
    const result = {};
    let text;
    try { text = await readFile(profile, "utf8"); } catch { return result; }
    for (const row of text.split(/\r?\n/).slice(1)) {
        const match = /^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/.exec(row.trim());
        if (!match || Number(match[4]) <= 0) continue;
        const normalized = match[1].replaceAll("\\", "/");
        const candidates = goFiles.filter((path) =>
            normalized.endsWith("/" + relative(repoRoot, path).replaceAll("\\", "/")));
        if (candidates.length !== 1) continue;
        const lines = result[candidates[0]] ||= [];
        for (let line = Number(match[2]); line <= Number(match[3]); line++) lines.push(line);
    }
    return Object.fromEntries(Object.entries(result).map(([path, lines]) => [path, [...new Set(lines)].sort((a, b) => a - b)]));
}

export async function runGoTests({ repoRoot, python: runtime, plan, signal, workspacePath, timeoutMs = 180_000 }) {
    const directory = await mkdtemp(join(tmpdir(), "agent-review-go-tests-"));
    const trace = { tests: {}, per_test_path_evidence: true };
    let exitCode = 0, output = "";
    try {
        await verifySources(repoRoot, plan.source_hashes);
        const goFiles = await sourceFiles(repoRoot);
        for (let index = 0; index < plan.records.length; index++) {
            const test = plan.records[index], profile = join(directory, `${index}.cover`);
            const [executable, ...args] = goSingleTestCommand(runtime, test, profile);
            const result = await runOwned(executable, args, {
                cwd: repoRoot, signal, workspacePath,
                timeoutMs: Math.max(1000, Math.floor(timeoutMs / Math.max(1, plan.records.length))),
            });
            exitCode ||= result.code || 0;
            output = (output + result.output).slice(-12000);
            trace.tests[test.id] = { ...outcome(result.output, test.name, result.code),
                lines: await profileLines(profile, repoRoot, goFiles) };
        }
        await verifySources(repoRoot, plan.source_hashes);
        if (!Object.keys(trace.tests).length) throw new Error("No linked Go tests produced outcomes.");
        return { exit_code: exitCode, output, trace };
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}
