import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { ensureRuntimes, supported } from "../managed-runtimes.mjs";

const manifest = JSON.parse(await readFile(new URL("../runtime-manifest.json", import.meta.url), "utf8"));
const kinds = Object.keys(manifest);
const platform = `${process.platform}-${process.arch}`;
const archive = Buffer.from("runtime archive fixture");

// Simulates a machine whose PATH offers `installed` versions; the fake tar "extracts" every pinned executable.
async function machine(t, installed = {}) {
    const root = await mkdtemp(join(tmpdir(), "agent-review-runtime-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const pins = structuredClone(manifest);
    for (const kind of kinds) pins[kind].artifacts[platform][1] = createHash(pins[kind].algorithm).update(archive).digest("hex");
    const calls = { downloads: 0, extracts: 0 };
    const report = (kind, executable, version) => ({ stdout: kind === "dotnet"
        ? `Microsoft.NETCore.App ${version} [${join(dirname(executable), "shared", "Microsoft.NETCore.App")}]\n`
        : JSON.stringify([version, executable]) });
    const options = {
        pins, embedded: true, cacheRoot: join(root, "cache"), env: { NODE_OPTIONS: "--import=untrusted.mjs" },
        fetchArchive: async () => { calls.downloads++; return new Response(archive); },
        run: async (command, args, settings) => {
            if (args[0] === "-xf") {
                calls.extracts++;
                for (const kind of kinds) {
                    const executable = join(args[3], ...pins[kind].artifacts[platform][2].split("/"));
                    await mkdir(dirname(executable), { recursive: true });
                    await writeFile(executable, "");
                }
                return { stdout: "" };
            }
            assert.equal(settings.env.NODE_OPTIONS, undefined, "Probes ignore inherited Node options.");
            const kind = args.includes("-p") ? "node" : args.includes("--list-runtimes") ? "dotnet" : "python";
            if (isAbsolute(command)) {
                await access(command);
                return report(kind, command, pins[kind].version);
            }
            if (!installed[kind]) throw Object.assign(new Error(`${command} not found`), { code: "ENOENT" });
            return report(kind, join(root, "installed", kind), installed[kind]);
        },
    };
    return { options, calls };
}

test("installed runtimes are reused only on supported release lines", () => {
    for (const [kind, version, expected] of [
        ["node", "24.0.0", true], ["node", "26.1.0", true], ["node", "22.20.0", false], ["node", "20.19.0", false],
        ["python", "3.14.0", true], ["python", "3.15.1", true], ["python", "3.13.9", false],
        ["dotnet", "10.0.0", true], ["dotnet", "9.0.9", false], ["dotnet", "11.0.0", false],
    ]) assert.equal(supported(kind, version), expected, `${kind} ${version}`);
});

test("pins cover Windows, macOS and Linux on x64 and ARM64 with HTTPS sources and full digests", () => {
    for (const kind of kinds) for (const os of ["win32", "darwin", "linux"]) for (const arch of ["x64", "arm64"]) {
        const [file, hash, executable] = manifest[kind].artifacts[`${os}-${arch}`];
        assert.match(hash, manifest[kind].algorithm === "sha512" ? /^[a-f0-9]{128}$/ : /^[a-f0-9]{64}$/);
        assert.equal(new URL(manifest[kind].baseUrl).protocol, "https:");
        assert(file.includes(manifest[kind].version) && !executable.includes(".."), `${kind} ${os}-${arch}`);
    }
});

test("compatible installed runtimes are reused without downloads or environment changes", async (t) => {
    const { options, calls } = await machine(t, { node: "26.1.0", python: "3.14.2", dotnet: "10.0.5" });
    const env = { ...options.env };
    const runtimes = await ensureRuntimes(options);
    assert.deepEqual(Object.keys(runtimes).sort(), ["AGENT_REVIEW_DOTNET", "AGENT_REVIEW_NODE", "AGENT_REVIEW_PYTHON"]);
    assert(Object.values(runtimes).every((path) => isAbsolute(path)));
    assert.deepEqual(options.env, env);
    assert.equal(calls.downloads, 0);
});

test("missing or outdated runtimes are verified, installed once, and reused offline", async (t) => {
    const { options, calls } = await machine(t, { node: "20.19.0" });
    const runtimes = await ensureRuntimes(options);
    assert.deepEqual(calls, { downloads: 3, extracts: 3 });
    for (const path of Object.values(runtimes)) await access(path);
    assert.deepEqual(await ensureRuntimes({ ...options,
        fetchArchive: () => assert.fail("Prepared runtimes must work offline.") }), runtimes);
    assert.equal((await readdir(options.cacheRoot)).length, 3);
});

test("an unusable explicit runtime fails clearly instead of being replaced", async (t) => {
    const { options, calls } = await machine(t, { node: "20.19.0" });
    await assert.rejects(ensureRuntimes({ ...options, kinds: ["node"], env: { AGENT_REVIEW_NODE: "node" } }),
        /AGENT_REVIEW_NODE must point to Node\.js 24 LTS/);
    assert.equal(calls.downloads, 0);
});

test("a tampered download is never extracted or cached, and retry succeeds", async (t) => {
    const { options, calls } = await machine(t);
    await assert.rejects(ensureRuntimes({ ...options, kinds: ["node"], fetchArchive: async () => new Response("tampered") }),
        /failed size or checksum verification/);
    assert.equal(calls.extracts, 0);
    assert.deepEqual(await readdir(options.cacheRoot), []);
    await ensureRuntimes({ ...options, kinds: ["node"] });
});
