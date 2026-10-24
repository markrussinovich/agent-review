import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isSea } from "node:sea";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { pythonCandidates } from "./python-runtime.mjs";

const execute = promisify(execFile);
const pinned = JSON.parse(await readFile(new URL("./runtime-manifest.json", import.meta.url), "utf8"));
const variables = { node: "AGENT_REVIEW_NODE", python: "AGENT_REVIEW_PYTHON", dotnet: "AGENT_REVIEW_DOTNET" };

// Downloads, verifies, extracts and atomically promotes an archive; a completed directory is reused offline.
export async function installArchive({ url, hash, algorithm = "sha256", bytes, maxBytes = bytes, directory, label,
    marker = { hash }, extract, verify, fetchArchive = fetch, onProgress = () => {}, signal }) {
    const prepared = async () => {
        let saved;
        try {
            saved = JSON.parse(await readFile(join(directory, ".complete.json"), "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") return false;
            throw error;
        }
        try {
            if (Object.entries(marker).some(([key, value]) => saved[key] !== value)) throw new Error("Marker mismatch");
            await verify(directory);
            return true;
        } catch (error) {
            throw new Error(`The cached ${label} is invalid: ${directory}. Remove that directory and retry.`, { cause: error });
        }
    };
    if (await prepared()) return directory;
    await mkdir(dirname(directory), { recursive: true });
    const scratch = await mkdtemp(join(dirname(directory), "prepare-"));
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`${label} preparation timed out. Retry preparation.`)), 180_000);
    try {
        const message = `Downloading ${label}...`;
        onProgress({ phase: "download", message, received: 0, total: bytes });
        const response = await fetchArchive(url, { signal: controller.signal });
        if (!response.ok || !response.body) {
            throw new Error(`${label} download failed: HTTP ${response.status}. Check network access to ${new URL(url).hostname} and retry.`);
        }
        const total = bytes || Number(response.headers.get("content-length")) || undefined;
        const digest = createHash(algorithm), chunks = [];
        let received = 0;
        for await (const chunk of response.body) {
            received += chunk.length;
            if (received > maxBytes) throw new Error(`${label} download exceeds its pinned size.`);
            digest.update(chunk);
            chunks.push(chunk);
            onProgress({ phase: "download", message, received, total });
        }
        if ((bytes && received !== bytes) || digest.digest("hex") !== hash) {
            throw new Error(`${label} failed size or checksum verification. Nothing downloaded was run; retry preparation.`);
        }
        const archive = join(scratch, decodeURIComponent(basename(new URL(url).pathname)));
        const expanded = join(scratch, "expanded");
        await writeFile(archive, Buffer.concat(chunks));
        await mkdir(expanded);
        onProgress({ phase: "extract", message: `Checksum verified. Extracting ${label}...` });
        await extract(archive, expanded, controller.signal);
        await verify(expanded);
        await writeFile(join(expanded, ".complete.json"), JSON.stringify(marker));
        controller.signal.throwIfAborted();
        const deadline = Date.now() + 2_000;
        while (true) {
            try {
                await rename(expanded, directory);
                return directory;
            } catch (error) {
                if (["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code) && await prepared()) return directory;
                // Windows indexers can briefly hold newly extracted files open.
                if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code)
                    || Date.now() >= deadline) throw error;
                await delay(50);
            }
        }
    } catch (error) {
        throw signal?.aborted ? signal.reason : error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}

// Installed runtimes are reused only on the managed lines: Node.js LTS or newer, the same Python 3 release
// or newer, and the .NET major the Roslyn helper targets.
export function supported(kind, version, pins = pinned) {
    const [major, minor] = version.split(".").map(Number);
    const [line, lineMinor] = pins[kind].version.split(".").map(Number);
    if (kind === "node") return major >= line;
    if (kind === "python") return major === line && minor >= lineMinor;
    return major === line;
}

async function probe(kind, command, prefix, { pins, run, env, platform, signal }) {
    const args = {
        node: ["-p", "JSON.stringify([process.versions.node, process.execPath])"],
        python: ["-I", "-B", "-c", "import json, sys; print(json.dumps(['%d.%d.%d' % sys.version_info[:3], sys.executable]))"],
        dotnet: ["--list-runtimes"],
    }[kind];
    // Probes run outside the reviewed repository and ignore Node options meant for another process.
    const { stdout } = await run(command, [...prefix, ...args], { cwd: homedir(), signal, windowsHide: true,
        env: { ...env, NODE_OPTIONS: undefined, NODE_PATH: undefined }, encoding: "utf8", timeout: 15_000 });
    if (kind !== "dotnet") {
        const [version, executable] = JSON.parse(stdout);
        return supported(kind, version, pins) && isAbsolute(executable) ? executable : null;
    }
    for (const line of stdout.split(/\r?\n/)) {
        const [, version, shared] = /^Microsoft\.NETCore\.App (\S+) \[(.+)\]$/.exec(line) || [];
        if (version && supported(kind, version, pins)) {
            return isAbsolute(command) ? command : join(dirname(dirname(shared)), platform === "win32" ? "dotnet.exe" : "dotnet");
        }
    }
    return null;
}

async function install(kind, { pins, cacheRoot, platform, arch, env, run, fetchArchive, onProgress, signal }) {
    const { label, version, algorithm, baseUrl, artifacts } = pins[kind];
    if (!artifacts[`${platform}-${arch}`]) {
        throw new Error(`${label} cannot be installed automatically on ${platform}-${arch}. Set ${variables[kind]} to a compatible executable.`);
    }
    const [file, hash, executable] = artifacts[`${platform}-${arch}`];
    const binary = (root) => join(root, ...executable.split("/"));
    // Windows' built-in bsdtar also extracts ZIP archives.
    const tar = platform === "win32" ? join(env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
    const directory = await installArchive({
        url: new URL(encodeURIComponent(file), baseUrl).href, hash, algorithm, maxBytes: 128 * 1024 * 1024,
        directory: join(cacheRoot, `${kind}-${version}-${hash.slice(0, 12)}`), label: `${label} (${version})`,
        fetchArchive, onProgress, signal,
        extract: (archive, target, abort) => run(tar, ["-xf", archive, "-C", target],
            { cwd: homedir(), signal: abort, windowsHide: true, timeout: 120_000 }),
        verify: async (root) => {
            if (!await probe(kind, binary(root), [], { pins, run, env, platform, signal })) {
                throw new Error(`${label} (${version}) cannot run on this machine.`);
            }
        },
    });
    return binary(directory);
}

export async function ensureRuntimes({ kinds = Object.keys(variables), pins = pinned,
    cacheRoot = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "agent-review", "runtime", "tools"),
    platform = process.platform, arch = process.arch, env = process.env,
    embedded = isSea() || Boolean(process.versions.bun), run = execute, fetchArchive = fetch,
    onProgress = () => {}, signal } = {}) {
    const options = { pins, cacheRoot, platform, arch, env, run, fetchArchive, onProgress, signal };
    const runtimes = {};
    for (const kind of kinds) {
        const variable = variables[kind], explicit = env[variable], { label } = pins[kind];
        onProgress({ phase: "runtime", message: `Checking ${label}...` });
        // Copilot's embedded executable cannot run arbitrary scripts, so it never counts as Node.
        const candidates = explicit ? [[explicit, []]]
            : kind === "node" ? [...(embedded ? [] : [[process.execPath, []]]), ["node", []]]
                : kind === "python" ? pythonCandidates({ platform, executable: "" }) : [["dotnet", []]];
        for (const [command, prefix] of candidates) {
            runtimes[variable] ||= await probe(kind, command, prefix, options).catch(() => null);
        }
        signal?.throwIfAborted();
        if (!runtimes[variable] && explicit) {
            throw new Error(`${variable} must point to ${label} or a newer compatible release. Correct or unset it, then retry.`);
        }
        runtimes[variable] ||= await install(kind, options);
    }
    return runtimes;
}

export async function prepareRuntimes(options) {
    const runtimes = await ensureRuntimes(options);
    Object.assign(process.env, runtimes);
    return runtimes;
}
