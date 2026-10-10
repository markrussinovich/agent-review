import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceExtension = join(repositoryRoot, ".github", "extensions", "agent-review");
export const extensionPath = join(".github", "extensions", "agent-review");

function inside(parent, child) {
    const path = relative(parent, child);
    return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export async function buildDistribution({
    outputRoot, sourceRoot = sourceExtension, sourceRevision = null, run = execute,
}) {
    if (!outputRoot) throw new Error("An empty distribution output directory is required.");
    outputRoot = resolve(outputRoot);
    sourceRoot = resolve(sourceRoot);
    if (inside(repositoryRoot, outputRoot) || inside(sourceRoot, outputRoot) || inside(outputRoot, sourceRoot)) {
        throw new Error("Build the distribution outside the source checkout.");
    }
    await mkdir(outputRoot);
    const extension = join(outputRoot, extensionPath);
    await mkdir(extension, { recursive: true });
    const scratch = await mkdtemp(join(tmpdir(), "agent-review-distribution-"));
    const options = { cwd: scratch, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 };
    try {
        const { stdout: sdks } = await run("dotnet", ["--list-sdks"], options);
        const sdk = sdks.split(/\r?\n/).map((line) => /^(10\.\d+\.\d+) \[(.+)\]$/.exec(line))
            .filter(Boolean).sort((a, b) => b[1].localeCompare(a[1], undefined, { numeric: true }))[0];
        if (!sdk) throw new Error("Building the distribution requires a stable .NET SDK 10.");
        await writeFile(join(scratch, "global.json"), JSON.stringify({
            sdk: { version: sdk[1], rollForward: "disable" },
        }));
        for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
            if (entry.isFile() && /\.(?:mjs|json)$/.test(entry.name)) {
                await cp(join(sourceRoot, entry.name), join(extension, entry.name));
            }
        }
        for (const name of ["analyzer", "web"]) {
            await cp(join(sourceRoot, name), join(extension, name), {
                recursive: true,
                filter: (path) => !["__pycache__", ".pytest_cache"].includes(path.split(sep).at(-1))
                    && !/\.py[co]$/.test(path),
            });
        }
        await cp(join(repositoryRoot, "LICENSE"), join(outputRoot, "LICENSE"));
        await cp(join(repositoryRoot, "LICENSE"), join(extension, "LICENSE"));

        const tooling = join(scratch, "tooling");
        await mkdir(tooling);
        for (const name of ["package.json", "package-lock.json"]) {
            await cp(join(sourceRoot, name), join(tooling, name));
        }
        const npmArgs = ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"];
        if (process.platform === "win32") {
            await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${npmArgs.join(" ")}`],
                { ...options, cwd: tooling });
        } else {
            await run("npm", npmArgs, { ...options, cwd: tooling });
        }
        await cp(join(tooling, "node_modules"), join(extension, "node_modules"), {
            recursive: true,
            filter: (path) => ![".bin", ".package-lock.json"].includes(path.split(sep).at(-1)),
        });

        const helper = join(scratch, "helper");
        await mkdir(helper);
        for (const entry of await readdir(join(sourceRoot, "dotnet-analyzer"), { withFileTypes: true })) {
            if (entry.isFile() && /\.(?:cs|csproj)$/.test(entry.name)) {
                await cp(join(sourceRoot, "dotnet-analyzer", entry.name), join(helper, entry.name));
            }
        }
        const binaries = join(extension, "dotnet-analyzer", "bin", "Release", "net10.0");
        await run("dotnet", ["publish", join(helper, "AgentReview.DotnetAnalyzer.csproj"),
            "-c", "Release", "--output", binaries, "--no-self-contained",
            "-p:UseAppHost=false", "-p:ImportDirectoryBuildProps=false",
            "-p:ImportDirectoryBuildTargets=false", "-p:UseSharedCompilation=false",
            "-p:ContinuousIntegrationBuild=true", `-p:PathMap=${helper}=/agent-review/dotnet-analyzer`, "-nodeReuse:false"],
        { ...options, cwd: helper });

        const dotnetRoot = dirname(sdk[2]);
        for (const name of ["LICENSE.txt", "ThirdPartyNotices.txt"]) {
            await cp(join(dotnetRoot, name), join(extension, "dotnet-analyzer", name));
        }

        for (const name of ["AgentReview.Dotnet.dll", "AgentReview.Dotnet.deps.json",
            "AgentReview.Dotnet.runtimeconfig.json", "Microsoft.CodeAnalysis.dll", "Microsoft.CodeAnalysis.CSharp.dll"]) {
            await access(join(binaries, name));
        }
        await access(join(extension, "node_modules", "typescript", "lib", "typescript.js"));
        const runtime = JSON.parse(await readFile(join(binaries, "AgentReview.Dotnet.runtimeconfig.json"), "utf8"));
        if (runtime.runtimeOptions?.tfm !== "net10.0") throw new Error("The helper must target .NET 10.");
        await writeFile(join(outputRoot, "distribution.json"), `${JSON.stringify({
            source_commit: sourceRevision, extension_path: extensionPath.split(sep).join("/"),
            prerequisites: { python: "3.11+", node: "20+", dotnet: "10.0" },
        }, null, 2)}\n`);
        return extension;
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    buildDistribution({ outputRoot: process.argv[2], sourceRevision: process.env.GITHUB_SHA || null })
        .then((extension) => console.log(`Built import-ready extension: ${extension}`))
        .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
