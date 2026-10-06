import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, `.dp-${randomUUID().slice(0, 8)}`);
const foundation = process.env.AGENT_REVIEW_PERFORMANCE_BASE || "141a461";
const prefix = ".github/extensions/agent-review/analyzer/";
const python = process.env.AGENT_REVIEW_PYTHON || "python";
const repetitions = 5;
const arguments_ = new Set(process.argv.slice(2));
assert.ok([...arguments_].every((argument) => ["--python-only", "--dotnet-only"].includes(argument)), "Supported options: --python-only, --dotnet-only");
assert.ok(!(arguments_.has("--python-only") && arguments_.has("--dotnet-only")), "Choose only one language-only option");
const runPython = !arguments_.has("--dotnet-only");
const runDotnet = !arguments_.has("--python-only");
const results = [];
const summaries = [];
const env = { ...process.env, TMP: join(scratch, "runtime"), TEMP: join(scratch, "runtime"), TMPDIR: join(scratch, "runtime"),
    DOTNET_CLI_HOME: join(scratch, "runtime", "dotnet-home"), DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_GENERATE_ASPNET_CERTIFICATE: "false", PYTHONDONTWRITEBYTECODE: "1",
    AGENT_REVIEW_DOTNET_HELPER: process.env.AGENT_REVIEW_DOTNET_HELPER
        || join(root, "dotnet-analyzer", "bin", "Release", "net10.0", "AgentReview.Dotnet.dll") };
const git = (repo, ...args) => execute("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024 });

async function exportAnalyzers() {
    const { stdout } = await git(root, "ls-tree", "-r", "--full-tree", "--name-only", foundation, "--", prefix);
    for (const path of stdout.trim().split(/\r?\n/).filter(Boolean)) {
        const relative = path.slice(prefix.length);
        const blob = await execute("git", ["-C", root, "show", `${foundation}:${path}`], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
        const destination = join(scratch, "foundation", "analyzer", relative);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, blob.stdout);
    }
    await cp(join(scratch, "foundation"), join(scratch, "current"), { recursive: true });
    await cp(join(root, "analyzer"), join(scratch, "current", "analyzer"), {
        recursive: true, filter: (path) => !path.includes("__pycache__"),
    });
}

async function repository(name, count, language) {
    const repo = join(scratch, name);
    await mkdir(join(repo, "src"), { recursive: true });
    await git(repo, "init", "-q");
    await git(repo, "config", "user.name", "Agent Review performance");
    await git(repo, "config", "user.email", "test@example.invalid");
    await git(repo, "config", "core.autocrlf", "false");
    if (language === "csharp") {
        await writeFile(join(repo, "Demo.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>');
    }
    for (let index = 0; index < count; index++) {
        await writeFile(join(repo, "src", `Policy${index}.${language === "csharp" ? "cs" : "py"}`),
            language === "csharp" ? `namespace PerformanceDemo;
public class Policy${index} {
    public int Evaluate(int value) { if (value < 90) return -1; return Normalize(value); }
    public int Normalize(int value) => value + ${index};
}
` : `def normalize(value):\n    return value + ${index}\n\ndef evaluate(value):\n    if value < 90:\n        return -1\n    return normalize(value)\n`);
    }
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "baseline");
    const changed = join(repo, "src", `Policy0.${language === "csharp" ? "cs" : "py"}`);
    await writeFile(changed, (await readFile(changed, "utf8")).replace("< 90", "< 95"));
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "raise threshold");
    return repo;
}

function graph(model) {
    return { symbols: model.symbols, edges: model.edges, nodes: model.nodes, aggregates: model.aggregates };
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function assertSameDto(actual, expected, message) {
    const differences = [];
    function compare(left, right, path) {
        if (differences.length >= 10 || left === right) return;
        if (left && right && typeof left === "object" && typeof right === "object") {
            for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
                if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
                    differences.push(`${path}.${key}: field ${Object.hasOwn(left, key) ? "added" : "removed"}`);
                } else compare(left[key], right[key], `${path}.${key}`);
                if (differences.length >= 10) break;
            }
        } else differences.push(`${path}: ${JSON.stringify(right)} → ${JSON.stringify(left)}`);
    }
    compare(actual, expected, "$");
    assert.equal(differences.length, 0, `${message}\n${differences.join("\n")}`);
}

async function scan(scanner, repo, mode, language, repetition) {
    const cache = join(scratch, "cache", scanner, repo.split(/[\\/]/).pop());
    if (mode === "cold") await rm(cache, { recursive: true, force: true });
    const started = performance.now();
    const output = await execute(python, [join(scratch, scanner, "analyzer", "analyze.py"), "--repo", repo,
        "--base-ref", "HEAD~1", "--current-ref", "HEAD", ...(mode === "no-cache" ? ["--no-cache"] : [])], {
        env: { ...env, AGENT_REVIEW_CACHE_DIR: cache,
            AGENT_REVIEW_DOTNET_CACHE: language === "csharp" && mode !== "no-cache" ? join(cache, "dotnet") : "",
            ...(language === "python" ? { AGENT_REVIEW_DOTNET: join(scratch, "never-start-dotnet.exe") } : {}) },
        maxBuffer: 256 * 1024 * 1024, timeout: 180000,
    });
    const elapsed = performance.now() - started;
    const model = JSON.parse(output.stdout);
    assert.ok(model.symbols.some((symbol) => symbol.classification === "modified"), `${scanner}: changed symbol detected`);
    if (language === "csharp") {
        assert.ok(model.symbols.some((symbol) => symbol.language === "csharp"), "Roslyn facts present");
        const calls = model.edges.filter((edge) => edge.type === "calls" && edge.change !== "removed");
        assert.equal(calls.length, repo.includes("large") ? 1000 : 30,
            `C# method calls resolve; edge types=${JSON.stringify([...new Set(model.edges.map((edge) => edge.type))])}; warnings=${JSON.stringify(model.warnings)}`);
        const identities = new Set(model.symbols.map((symbol) => symbol.id));
        assert.ok(calls.every((edge) => identities.has(edge.source) && identities.has(edge.target)),
            "current C# calls connect actual compiler-resolved source/target symbols");
        assert.ok(model.symbols.length >= (repo.includes("large") ? 2000 : 60), "full C# snapshot is scanned");
        assert.match(model.source_files["src/Policy0.cs"].baseline, /value < 90/);
        assert.match(model.source_files["src/Policy0.cs"].current, /value < 95/);
    } else {
        assert.ok(!output.stderr.includes('"phase":"csharp_graph"'), "Python-only review must not start the compiler");
    }
    results.push({ scanner, fixture: repo.split(/[\\/]/).pop(), mode, repetition, elapsed_ms: Math.round(elapsed * 100) / 100,
        symbols: model.symbols.length, edges: model.edges.length });
    assert.ok(elapsed < (mode === "no-cache" ? 180000 : 120000), `${scanner} ${mode}: bounded scan time`);
    return model;
}

try {
    await mkdir(join(scratch, "runtime"), { recursive: true });
    await exportAnalyzers();
    if (runDotnet) {
        assert.ok(existsSync(env.AGENT_REVIEW_DOTNET_HELPER), `Prepared Roslyn helper unavailable: ${env.AGENT_REVIEW_DOTNET_HELPER}`);
        await cp(dirname(env.AGENT_REVIEW_DOTNET_HELPER), join(scratch, "helper"), { recursive: true });
        env.AGENT_REVIEW_DOTNET_HELPER = join(scratch, "helper", "AgentReview.Dotnet.dll");
    }
    if (runPython) {
        const pythonRepo = await repository("python-only", 150, "python");
        const models = {};
        for (let repetition = 1; repetition <= repetitions; repetition++) {
            for (const mode of ["cold", "warm", "no-cache"]) {
                const order = repetition % 2 ? ["foundation", "current"] : ["current", "foundation"];
                for (const scanner of order) {
                    const model = await scan(scanner, pythonRepo, mode, "python", repetition);
                    if (models[scanner]) assertSameDto(model, models[scanner], `${scanner}: cache preserves the complete Python DTO`);
                    models[scanner] = model;
                }
            }
        }
        assertSameDto(models.current, models.foundation, "Python foundation/current DTOs remain exactly identical");
        for (const mode of ["cold", "warm", "no-cache"]) {
            const before = median(results.filter((item) => item.scanner === "foundation" && item.mode === mode).map((item) => item.elapsed_ms));
            const after = median(results.filter((item) => item.scanner === "current" && item.mode === mode).map((item) => item.elapsed_ms));
            summaries.push({ fixture: "python-only", mode, foundation_median_ms: before, current_median_ms: after,
                regression_percent: Math.round((after / before - 1) * 10000) / 100 });
        }
        for (const summary of summaries) {
            assert.ok(summary.current_median_ms <= summary.foundation_median_ms * 1.1,
                `Python ${summary.mode} median regression exceeds 10%: ${summary.foundation_median_ms}ms → ${summary.current_median_ms}ms`);
        }
    }
    if (runDotnet) assert.ok(existsSync(env.AGENT_REVIEW_DOTNET_HELPER), `Prepared Roslyn helper unavailable: ${env.AGENT_REVIEW_DOTNET_HELPER}`);
    for (const [name, count] of runDotnet ? [["dotnet-representative", 30], ["dotnet-large", 1000]] : []) {
        const repo = await repository(name, count, "csharp");
        let reference;
        for (let repetition = 1; repetition <= repetitions; repetition++) {
            for (const mode of ["cold", "warm", "no-cache"]) {
                const model = await scan("current", repo, mode, "csharp", repetition);
                if (reference) assertSameDto(graph(model), graph(reference), `${name}: warm/no-cache graph is identical`);
                reference = model;
            }
        }
        for (const mode of ["cold", "warm", "no-cache"]) {
            summaries.push({ fixture: name, mode, current_median_ms: median(results
                .filter((item) => item.fixture === name && item.mode === mode).map((item) => item.elapsed_ms)) });
        }
    }
    console.log(`PASS: ${runPython ? "interleaved Python medians within 10%, exact DTO equality, missing dotnet; " : ""}${runDotnet ? "representative and 1000-file C# scans, cache/no-cache graph equality" : ""}`);
} finally {
    console.log(JSON.stringify({ foundation, repetitions, sampling: `${runPython ? "Python interleaves foundation/current pairs, alternating first scanner. " : ""}Warm follows cold; every invocation starts a fresh process. Prepared helper artifacts are copied once to isolate concurrent rebuilds.`,
        thresholds: { python_median_regression_percent: 10, cached_ms: 120000, no_cache_ms: 180000 },
        medians: summaries, measurements: results }, null, 2));
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
