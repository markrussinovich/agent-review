import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { extensionPath } from "./build-distribution.mjs";

const execute = promisify(execFile);
export async function verifyDistribution(extension) {
    const options = { cwd: extension, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 };
    const manifest = JSON.parse(await readFile(join(extension, "copilot-extension.json"), "utf8"));
    assert.equal(manifest.name, "agent-review");
    await access(join(extension, "extension.mjs"));
    for (const name of ["tests", "dotnet-analyzer/obj", "dotnet-analyzer/AgentReview.DotnetAnalyzer.csproj",
        "node_modules/.bin"]) {
        await assert.rejects(access(join(extension, ...name.split("/"))), { code: "ENOENT" });
    }
    const { analyzeSnapshot } = await import(pathToFileURL(join(extension, "node-compiler.mjs")));
    const node = analyzeSnapshot({ current: {
        "app.ts": "export function run(): number { const values = new Map<string, number>(); return values.size; }",
    } });
    assert(node.symbols.some((symbol) => symbol.name === "run"), "Bundled TypeScript did not analyze the snapshot.");

    const helper = join(extension, "dotnet-analyzer", "bin", "Release", "net10.0", "AgentReview.Dotnet.dll");
    const { stdout } = await execute("dotnet", [helper, "--self-test"], options);
    assert.match(stdout, /PASS:/);

    const { pythonCandidates } = await import(pathToFileURL(join(extension, "python-runtime.mjs")));
    const script = `
import sys
assert sys.version_info >= (3, 11), "Python 3.11+ is required"
sys.path.insert(0, sys.argv[1])
from dotnet_adapter import run_dotnet_helper
facts = run_dotnet_helper({"baseline": {}, "current": {"App.cs": "class App { public int Run() => 1; }"},
                           "mode": "graph", "use_cache": False})
assert any(symbol["name"] == "Run" for symbol in facts["symbols"]), "No C# method extracted"
print("Bundled Python-to-Roslyn bridge passed.")
`;
    let python;
    for (const [executable, prefix] of pythonCandidates()) {
        try {
            python = await execute(executable, [...prefix, "-B", "-c", script, join(extension, "analyzer")], options);
            break;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    assert(python, "Python 3.11+ was not found.");
    console.log(stdout.trim());
    console.log(python.stdout.trim());
    console.log("Prepared distribution passed Node, C#, and Python bridge checks.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await verifyDistribution(resolve(process.argv[2], extensionPath));
}
