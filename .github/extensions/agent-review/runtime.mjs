import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
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
    throw new Error("First-run preparation requires Python 3.11+. Install Python or set AGENT_REVIEW_PYTHON, then retry.");
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

export async function extractBundle(archive, directory) {
    await runPython(["-c", extractScript, archive, directory]);
}

async function prepared(directory, release) {
    let marker;
    try {
        marker = JSON.parse(await readFile(join(directory, ".complete.json"), "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
    if (marker.sha256 !== release.sha256 || marker.source_commit !== release.source_commit) {
        throw new Error(`The cached Agent Review bundle is invalid: ${directory}. Remove that cache directory and retry.`);
    }
    for (const path of requiredFiles) await access(join(directory, ...path.split("/")));
    return true;
}

export async function ensureBundle(release, {
    cacheRoot = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "agent-review", "runtime"),
    fetchRelease = fetch, onProgress = () => {}, signal,
} = {}) {
    validateRelease(release);
    const directory = join(cacheRoot, release.sha256);
    if (await prepared(directory, release)) {
        onProgress({ phase: "ready", message: "Using the verified local bundle." });
        return directory;
    }
    await mkdir(cacheRoot, { recursive: true });
    const scratch = await mkdtemp(join(cacheRoot, "prepare-"));
    const downloadController = new AbortController();
    const timer = setTimeout(() => downloadController.abort(new Error("Bundle download timed out. Retry preparation.")), 120_000);
    const abort = () => downloadController.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
        onProgress({ phase: "download", message: "Downloading the pinned Agent Review bundle...", received: 0, total: release.bytes });
        const response = await fetchRelease(release.url, { signal: downloadController.signal });
        if (!response.ok) throw new Error(`Bundle download failed: HTTP ${response.status}. Check network access to GitHub and retry.`);
        if (!response.body) throw new Error("The GitHub release download returned no bundle.");
        const chunks = [];
        const hash = createHash("sha256");
        let received = 0;
        for await (const chunk of response.body) {
            received += chunk.length;
            if (received > release.bytes) throw new Error("Bundle download exceeds the pinned size.");
            hash.update(chunk);
            chunks.push(chunk);
            onProgress({ phase: "download", message: "Downloading the pinned Agent Review bundle...", received, total: release.bytes });
        }
        if (received !== release.bytes || hash.digest("hex") !== release.sha256) {
            throw new Error("Bundle size or SHA-256 verification failed. No downloaded code was loaded. Retry or reinstall the loader.");
        }
        const archive = join(scratch, "agent-review.zip");
        await writeFile(archive, Buffer.concat(chunks));
        const expanded = join(scratch, "expanded");
        await mkdir(expanded);
        onProgress({ phase: "extract", message: "Checksum verified. Preparing local extension files..." });
        await extractBundle(archive, expanded);
        for (const path of requiredFiles) await access(join(expanded, ...path.split("/")));
        await writeFile(join(expanded, ".complete.json"), JSON.stringify({
            sha256: release.sha256, source_commit: release.source_commit,
        }));
        const deadline = Date.now() + 2_000;
        while (true) {
            try {
                await rename(expanded, directory);
                break;
            } catch (error) {
                if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) && await prepared(directory, release)) break;
                // Windows indexers can briefly hold newly extracted assemblies open.
                if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code)
                    || Date.now() >= deadline) throw error;
                await delay(50);
            }
        }
        onProgress({ phase: "ready", message: "Agent Review is prepared. Opening the review..." });
        return directory;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}
