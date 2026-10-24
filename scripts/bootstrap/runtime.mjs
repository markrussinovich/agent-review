import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { installArchive } from "./managed-runtimes.mjs";
import { pythonCandidates } from "./python-runtime.mjs";

const execute = promisify(execFile);
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const requiredFiles = [
    "review-extension.mjs", "canvas-definition.mjs", "node-compiler.mjs",
    "node_modules/typescript/lib/typescript.js", "analyzer/analyze.py",
    "web/index.html",
    "dotnet-analyzer/bin/Release/net10.0/AgentReview.Dotnet.dll",
    "dotnet-analyzer/bin/Release/net10.0/AgentReview.Dotnet.deps.json",
    "dotnet-analyzer/bin/Release/net10.0/AgentReview.Dotnet.runtimeconfig.json",
    "dotnet-analyzer/bin/Release/net10.0/Microsoft.CodeAnalysis.dll",
    "dotnet-analyzer/bin/Release/net10.0/Microsoft.CodeAnalysis.CSharp.dll",
];

export function validateRelease(release) {
    if (!release || !/^[a-f0-9]{40}$/.test(release.source_commit)
        || !/^[a-f0-9]{64}$/.test(release.sha256)
        || !Number.isSafeInteger(release.bytes) || release.bytes < 1 || release.bytes > MAX_ARCHIVE_BYTES) {
        throw new Error("Agent Review's pinned release manifest is invalid. Reinstall the distribution loader.");
    }
    const url = new URL(release.url);
    if (url.origin !== "https://github.com"
        || !new RegExp(`^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/agent-review-${release.source_commit}/agent-review\\.zip$`).test(url.pathname)
        || url.search || url.hash || url.username || url.password) {
        throw new Error("Agent Review's bundle must come from its pinned GitHub release.");
    }
    return release;
}

export async function runPython(args, options = {}) {
    for (const [command, prefix] of pythonCandidates()) {
        try {
            return await execute(command, [...prefix, "-I", "-B", ...args],
                { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024, cwd: homedir(), ...options });
        } catch (error) {
            if (error.code !== "ENOENT") throw new Error(`Python preparation failed: ${error.stderr || error.message}`, { cause: error });
        }
    }
    throw new Error("The prepared Python runtime is unavailable. Reopen Agent Review to prepare Python 3.14, or correct AGENT_REVIEW_PYTHON, then retry.");
}

const extractScript = `
import pathlib, shutil, stat, sys, zipfile
assert sys.version_info >= (3, 11), "Python 3.11+ is required"
root = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) > 5000 or sum(item.file_size for item in entries) > 512 * 1024 * 1024:
        raise ValueError("Bundle exceeds extraction limits")
    seen = set()
    for item in entries:
        name = item.orig_filename.rstrip("/")
        parts = name.split("/")
        if (not name or "\\\\" in name or ":" in name or any(part in ("", ".", "..") for part in parts)
            or name == ".complete.json" or stat.S_ISLNK(item.external_attr >> 16)
            or item.flag_bits & 1 or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
            raise ValueError("Unsafe archive entry: " + item.filename)
        for part in parts:
            stem = part.split(".")[0].upper()
            if part.endswith((" ", ".")) or stem in {"CON", "PRN", "AUX", "NUL", *("COM"+str(i) for i in range(1,10)), *("LPT"+str(i) for i in range(1,10))}:
                raise ValueError("Unsupported archive path: " + name)
        if name.casefold() in seen:
            raise ValueError("Duplicate archive entry: " + name)
        seen.add(name.casefold())
    for item in entries:
        target = root.joinpath(*item.filename.rstrip("/").split("/"))
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as source, target.open("xb") as destination:
                shutil.copyfileobj(source, destination)
`;

export async function extractBundle(archive, directory, options = {}) {
    await runPython(["-c", extractScript, archive, directory], options);
}

export async function ensureBundle(release, {
    cacheRoot = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "agent-review", "runtime"),
    fetchRelease = fetch, onProgress = () => {}, signal,
} = {}) {
    validateRelease(release);
    const directory = await installArchive({
        url: release.url, hash: release.sha256, bytes: release.bytes, label: "Agent Review bundle",
        directory: join(cacheRoot, release.sha256), marker: { sha256: release.sha256, source_commit: release.source_commit },
        extract: (archive, target, abort) => extractBundle(archive, target, { signal: abort }),
        verify: async (root) => { for (const path of requiredFiles) await access(join(root, ...path.split("/"))); },
        fetchArchive: fetchRelease, onProgress, signal,
    });
    onProgress({ phase: "ready", message: "Agent Review is prepared. Opening the review..." });
    return directory;
}
