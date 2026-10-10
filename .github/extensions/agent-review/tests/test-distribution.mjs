import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDistribution, extensionPath } from "../../../../scripts/build-distribution.mjs";

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "agent-review-package-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "source");
    const put = async (path, content = "fixture") => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
    };
    for (const name of ["extension.mjs", "copilot-extension.json", "package.json", "package-lock.json",
        "analyzer/analyze.py", "web/app.js", "tests/fixture.py", "analyzer/__pycache__/cached.pyc",
        "dotnet-analyzer/Program.cs", "dotnet-analyzer/AgentReview.DotnetAnalyzer.csproj",
        "dotnet-analyzer/bin/stale.dll", "dotnet-analyzer/obj/stale.json", "node_modules/stale.js"]) {
        await put(join(source, ...name.split("/")));
    }
    const sdk = join(root, "dotnet", "sdk");
    for (const name of ["LICENSE.txt", "ThirdPartyNotices.txt"]) await put(join(dirname(sdk), name));
    const calls = [];
    const run = async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (args.includes("ci") || args.some((arg) => arg.startsWith("npm ci "))) {
            await put(join(options.cwd, "node_modules", "typescript", "lib", "typescript.js"));
            await put(join(options.cwd, "node_modules", ".bin", "tsc"));
        } else if (args[0] === "publish") {
            const binaries = args[args.indexOf("--output") + 1];
            for (const name of ["AgentReview.Dotnet.dll", "AgentReview.Dotnet.deps.json",
                "Microsoft.CodeAnalysis.dll", "Microsoft.CodeAnalysis.CSharp.dll"]) await put(join(binaries, name));
            await put(join(binaries, "AgentReview.Dotnet.runtimeconfig.json"), '{"runtimeOptions":{"tfm":"net10.0"}}');
            assert.deepEqual((await readdir(dirname(args[1]))).sort(),
                ["AgentReview.DotnetAnalyzer.csproj", "Program.cs"]);
            const configuration = JSON.parse(await readFile(join(dirname(options.cwd), "global.json"), "utf8"));
            assert.deepEqual(configuration, { sdk: { version: "10.0.401", rollForward: "disable" } });
        }
        return { stdout: args[0] === "--list-sdks"
            ? `10.0.100 [${sdk}]\n10.0.401 [${sdk}]\n11.0.100 [${sdk}]\n` : "" };
    };
    return { source, output: join(root, "distribution"), run, calls };
}

test("distribution includes runtime assets, notices, locked tooling, and managed helper only", async (t) => {
    const { source, output, run, calls } = await fixture(t);
    const extension = await buildDistribution({ sourceRoot: source, outputRoot: output, run, sourceRevision: "abc123" });
    assert.equal(extension, join(output, extensionPath));
    for (const name of ["extension.mjs", "LICENSE", "analyzer/analyze.py", "web/app.js",
        "node_modules/typescript/lib/typescript.js", "dotnet-analyzer/ThirdPartyNotices.txt",
        "dotnet-analyzer/bin/Release/net10.0/AgentReview.Dotnet.dll"]) {
        await access(join(extension, ...name.split("/")));
    }
    for (const name of ["tests", "analyzer/__pycache__", "node_modules/stale.js", "node_modules/.bin",
        "dotnet-analyzer/Program.cs", "dotnet-analyzer/obj", "dotnet-analyzer/bin/stale.dll"]) {
        await assert.rejects(access(join(extension, ...name.split("/"))), { code: "ENOENT" });
    }
    const publish = calls.find((call) => call.args[0] === "publish");
    assert(publish.args.includes("-p:UseAppHost=false"));
    assert(publish.args.includes("--no-self-contained"));
    assert(!publish.cwd.startsWith(source));
    assert(calls.some((call) => call.args.includes("--ignore-scripts")
        || call.args.some((arg) => arg.includes("--ignore-scripts"))));
    assert.equal(JSON.parse(await readFile(join(output, "distribution.json"), "utf8")).source_commit, "abc123");
});

test("an existing output is never overwritten", async (t) => {
    const { source, output, run, calls } = await fixture(t);
    await mkdir(output);
    await writeFile(join(output, "keep.txt"), "keep");
    await assert.rejects(buildDistribution({ sourceRoot: source, outputRoot: output, run }), { code: "EEXIST" });
    assert.equal(await readFile(join(output, "keep.txt"), "utf8"), "keep");
    assert.equal(calls.length, 0);
});

test("building inside the checkout is rejected before any process starts", async () => {
    const checkout = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
    await assert.rejects(buildDistribution({ outputRoot: join(checkout, "distribution"),
        run: () => { throw new Error("Unexpected build"); } }), /outside the source checkout/);
});

test("failed dependency preparation is reported without attempting a helper build", async (t) => {
    const { source, output, run } = await fixture(t);
    const failure = new Error("npm registry unavailable");
    await assert.rejects(buildDistribution({ sourceRoot: source, outputRoot: output,
        run: async (command, args, options) => {
            if (args[0] === "--list-sdks") return run(command, args, options);
            throw failure;
        } }), (error) => error === failure);
    await assert.rejects(access(join(output, "distribution.json")), { code: "ENOENT" });
});

test("a successful publish command without complete helper binaries cannot produce a distribution", async (t) => {
    const { source, output, run } = await fixture(t);
    await assert.rejects(buildDistribution({ sourceRoot: source, outputRoot: output,
        run: (command, args, options) => args[0] === "publish"
            ? Promise.resolve({ stdout: "" }) : run(command, args, options) }), { code: "ENOENT" });
    await assert.rejects(access(join(output, "distribution.json")), { code: "ENOENT" });
});

test("missing .NET SDK 10 fails before installing dependencies", async (t) => {
    const { source, output } = await fixture(t);
    let calls = 0;
    await assert.rejects(buildDistribution({ sourceRoot: source, outputRoot: output,
        run: async () => { calls++; return { stdout: "11.0.100 [unrelated]\n" }; } }), /requires a stable .NET SDK 10/);
    assert.equal(calls, 1);
});
