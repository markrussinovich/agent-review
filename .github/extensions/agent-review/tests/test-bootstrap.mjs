import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { ensureBundle, extractBundle, runPython, validateRelease } from "../../../../scripts/bootstrap/runtime.mjs";
import { startSetupServer } from "../../../../scripts/bootstrap/setup-server.mjs";
import { SEMVER, buildBootstrap, pluginVersion } from "../../../../scripts/build-release-distribution.mjs";
import { canvasDefinition } from "../canvas-definition.mjs";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const commit = "a".repeat(40);
function release(bytes) {
    return { source_commit: commit,
        url: `https://github.com/octo/review/releases/download/agent-review-${commit}/agent-review.zip`,
        bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
const sourceMarketplace = async () => JSON.parse(await readFile(new URL("../../../plugin/marketplace.json", import.meta.url), "utf8"));
const pluginTemplate = async () => JSON.parse(await readFile(new URL("../../../../scripts/bootstrap/plugin.json", import.meta.url), "utf8"));
async function scratch(t) {
    const directory = await mkdtemp(join(tmpdir(), "agent-review-bootstrap-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}
async function archive(root, entries) {
    const path = join(root, "payload.zip");
    await runPython(["-c", `import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    for name in json.loads(sys.argv[2]):
        entry = zipfile.ZipInfo()
        entry.filename = name
        archive.writestr(entry, "fixture")
`, path, JSON.stringify(entries)]);
    return readFile(path);
}
const files = ["review-extension.mjs", "canvas-definition.mjs", "node-compiler.mjs",
    "node_modules/typescript/lib/typescript.js", "analyzer/analyze.py", "web/index.html",
    ...["AgentReview.Dotnet.dll", "AgentReview.Dotnet.deps.json", "AgentReview.Dotnet.runtimeconfig.json",
        "Microsoft.CodeAnalysis.dll", "Microsoft.CodeAnalysis.CSharp.dll"]
        .map((name) => `dotnet-analyzer/bin/Release/net10.0/${name}`)];

test("loader fits import limits and pins the release checksum and commit", async (t) => {
    const root = await scratch(t);
    const output = join(root, "bootstrap");
    const descriptor = release(Buffer.from("zip"));
    const extension = await buildBootstrap(descriptor, output);
    let bytes = 0;
    for (const name of await readdir(extension)) {
        const content = await readFile(join(extension, name));
        assert(content.length <= 1_000_000, name);
        assert.equal(content.toString("utf8").includes("\0"), false, name);
        bytes += content.length;
    }
    assert(bytes < 5_000_000);
    assert.deepEqual(JSON.parse(await readFile(join(extension, "release-manifest.json"), "utf8")), descriptor);
    const { canvasDefinition: loaderCanvas } = await import(pathToFileURL(join(extension, "canvas-definition.mjs")).href);
    assert.deepEqual(loaderCanvas, canvasDefinition);
    assert.deepEqual(loaderCanvas.inputSchema.type, ["object", "null"]);
});

test("source marketplace installs the prepared dist plugin with the template's metadata", async () => {
    const marketplace = await sourceMarketplace();
    const plugin = await pluginTemplate();
    assert.equal(marketplace.name, "agent-review-plugins");
    assert.equal(marketplace.plugins.length, 1);
    const [entry] = marketplace.plugins;
    assert.match(entry.source.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.deepEqual(entry.source, { source: "github", repo: entry.source.repo, ref: "dist" });
    for (const field of ["name", "description", "author", "license", "keywords"]) {
        assert.deepEqual(entry[field], plugin[field], field);
    }
    assert.equal(entry.repository, `https://github.com/${entry.source.repo}`);
    assert.equal(entry.homepage, entry.repository);
    assert.equal(entry.version, undefined, "Only the generated dist catalog knows the current release version.");
});

test("native plugin discovers the same loader as folder imports and retains licenses", async (t) => {
    const root = await scratch(t);
    const output = join(root, "plugin");
    const descriptor = release(Buffer.from("zip"));
    const extension = await buildBootstrap(descriptor, output);
    const plugin = JSON.parse(await readFile(join(output, "plugin.json"), "utf8"));
    assert.equal(plugin.name, "agent-review");
    assert.equal(plugin.version, `${(await pluginTemplate()).version}+${commit.slice(0, 7)}`);
    assert.equal(plugin.license, "MIT");
    assert.equal(plugin.repository, "https://github.com/octo/review");
    assert.equal(plugin.homepage, plugin.repository);
    assert.deepEqual(plugin.extensions, [".github/extensions"]);
    assert.equal(join(output, plugin.extensions[0], plugin.name), extension);
    assert.equal(JSON.parse(await readFile(join(extension, "copilot-extension.json"), "utf8")).name, plugin.name);
    assert.deepEqual(JSON.parse(await readFile(join(extension, "release-manifest.json"), "utf8")), descriptor);
    assert.equal(await readFile(join(output, "LICENSE"), "utf8"), await readFile(join(extension, "LICENSE"), "utf8"));
    assert.match(await readFile(join(extension, "extension.mjs"), "utf8"), /from "\.\/runtime\.mjs"/);
    await assert.rejects(access(join(extension, "node_modules")), { code: "ENOENT" });
    const marketplace = JSON.parse(await readFile(join(output, ".github", "plugin", "marketplace.json"), "utf8"));
    const catalog = await sourceMarketplace();
    assert.equal(marketplace.name, catalog.name);
    assert.deepEqual(marketplace.owner, catalog.owner, "The generated catalog keeps the curated owner.");
    assert.deepEqual(marketplace.plugins, [{
        name: plugin.name, description: plugin.description, version: plugin.version, author: plugin.author,
        homepage: "https://github.com/octo/review", repository: "https://github.com/octo/review",
        license: plugin.license, keywords: plugin.keywords, source: "./",
    }]);
});

test("each release stamps its short source commit into a SemVer plugin version without changing existing loaders", async (t) => {
    const root = await scratch(t);
    const { version } = await pluginTemplate();
    const first = release(Buffer.from("first"));
    const nextCommit = "b".repeat(40);
    const next = { ...release(Buffer.from("next")), source_commit: nextCommit,
        url: first.url.replace(commit, nextCommit) };
    for (const [name, descriptor] of [["first", first], ["next", next]]) {
        const output = join(root, name);
        const extension = await buildBootstrap(descriptor, output);
        const plugin = JSON.parse(await readFile(join(output, "plugin.json"), "utf8"));
        assert.equal(plugin.version, `${version}+${descriptor.source_commit.slice(0, 7)}`);
        assert.equal(SEMVER.exec(plugin.version)?.[5], descriptor.source_commit.slice(0, 7));
        assert.deepEqual(JSON.parse(await readFile(join(extension, "release-manifest.json"), "utf8")), descriptor);
    }
    assert.deepEqual(JSON.parse(await readFile(join(root, "first", ".github", "extensions", "agent-review",
        "release-manifest.json"), "utf8")), first);
    await assert.rejects(buildBootstrap(next, join(root, "first")), { code: "EEXIST" });
});

test("plugin versions are valid SemVer and invalid template versions are rejected", () => {
    for (const valid of ["1.0.0-alpha+001", "1.0.0+20130313144700", "1.0.0-beta+exp.sha.5114f85"]) {
        assert.match(valid, SEMVER, valid);
    }
    assert.equal(pluginVersion("0.1.0", "f3da8f022109864630564ba3987ba210342006ae"), "0.1.0+f3da8f0");
    assert.equal(pluginVersion("2.1.0-beta.1", commit), "2.1.0-beta.1+aaaaaaa");
    for (const template of ["", "1.0", "v1.0.0", "01.0.0", "1.0.0+local", "1.0.0 "]) {
        assert.throws(() => pluginVersion(template, commit), /not valid SemVer/, JSON.stringify(template));
    }
});

test("first use verifies and extracts once; subsequent use works without network access", async (t) => {
    const root = await scratch(t);
    const bytes = await archive(root, files);
    const descriptor = release(bytes);
    const phases = [];
    let requests = 0;
    const options = { cacheRoot: join(root, "cache"), fetchRelease: async () => {
        requests++; return new Response(bytes);
    }, onProgress: (state) => phases.push(state.phase) };
    const directory = await ensureBundle(descriptor, options);
    await access(join(directory, "review-extension.mjs"));
    assert(phases.includes("download") && phases.includes("extract") && phases.includes("ready"));
    assert.equal(await ensureBundle(descriptor, { ...options,
        fetchRelease: () => { throw new Error("Offline"); } }), directory);
    assert.equal(requests, 1);
    assert.deepEqual(await readdir(options.cacheRoot), [descriptor.sha256]);
});

test("checksum and length mismatches never install downloaded code", async (t) => {
    const root = await scratch(t);
    const bytes = await archive(root, files);
    for (const descriptor of [
        { ...release(bytes), sha256: "0".repeat(64) }, { ...release(bytes), bytes: bytes.length - 1 },
    ]) {
        const cacheRoot = join(root, descriptor.sha256);
        await assert.rejects(ensureBundle(descriptor, { cacheRoot,
            fetchRelease: async () => new Response(bytes) }), /SHA-256|pinned size/);
        assert.deepEqual(await readdir(cacheRoot), []);
    }
});

test("download failure is actionable and preparation can be retried", async (t) => {
    const root = await scratch(t);
    const bytes = await archive(root, files);
    const cacheRoot = join(root, "cache");
    await assert.rejects(ensureBundle(release(bytes), { cacheRoot,
        fetchRelease: async () => new Response("missing", { status: 404 }) }), /HTTP 404/);
    await ensureBundle(release(bytes), { cacheRoot, fetchRelease: async () => new Response(bytes) });
});

test("archive traversal and Windows-ambiguous paths are rejected", async (t) => {
    const root = await scratch(t);
    for (const path of ["../escape", "/absolute", "C:/drive", "a\\escape", "CON.txt", "trailing."]) {
        await archive(root, [path]);
        await assert.rejects(extractBundle(join(root, "payload.zip"), join(root, "expanded")), /Unsafe archive|Unsupported archive/, path);
    }
    await assert.rejects(access(join(root, "escape")), { code: "ENOENT" });
});

test("symlinks and case-insensitive duplicate archive entries are rejected", async (t) => {
    const root = await scratch(t);
    await archive(root, ["App.cs", "app.cs"]);
    await assert.rejects(extractBundle(join(root, "payload.zip"), join(root, "expanded")), /Duplicate archive/);
    await runPython(["-c", `import sys, zipfile
entry = zipfile.ZipInfo("link")
entry.external_attr = 0o120777 << 16
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr(entry, "/outside")
`, join(root, "link.zip")]);
    await assert.rejects(extractBundle(join(root, "link.zip"), join(root, "expanded")), /Unsafe archive/);
});

test("incomplete archives are never marked as prepared", async (t) => {
    const root = await scratch(t);
    const bytes = await archive(root, ["review-extension.mjs"]);
    const cacheRoot = join(root, "cache");
    await assert.rejects(ensureBundle(release(bytes), { cacheRoot,
        fetchRelease: async () => new Response(bytes) }), { code: "ENOENT" });
    assert.deepEqual(await readdir(cacheRoot), []);
});

test("concurrent preparations converge on a complete checksum-addressed cache", async (t) => {
    const root = await scratch(t);
    const bytes = await archive(root, files);
    const options = { cacheRoot: join(root, "cache"), fetchRelease: async () => new Response(bytes) };
    const [first, second] = await Promise.all([
        ensureBundle(release(bytes), options), ensureBundle(release(bytes), options),
    ]);
    assert.equal(first, second);
    assert.deepEqual(await readdir(options.cacheRoot), [release(bytes).sha256]);
});

test("release validation rejects unpinned URLs and excessive sizes", () => {
    const descriptor = release(Buffer.from("zip"));
    for (const invalid of [
        { ...descriptor, url: "https://example.com/payload.zip" },
        { ...descriptor, url: descriptor.url.replace(commit, "latest") },
        { ...descriptor, sha256: "bad" }, { ...descriptor, bytes: 100_000_000 },
    ]) assert.throws(() => validateRelease(invalid));
});

test("Python preparation cannot import shadow standard-library modules from the reviewed cwd", async (t) => {
    const root = await scratch(t);
    await writeFile(join(root, "zipfile.py"), 'raise RuntimeError("Reviewed project code executed")\n');
    const { stdout } = await runPython(["-c", 'import zipfile; print(zipfile.ZipFile.__name__)'], { cwd: root });
    assert.equal(stdout.trim(), "ZipFile");
});

test("setup serves visible state, error and retry controls without cross-origin mutation", async (t) => {
    let retries = 0;
    const state = { message: "Checksum verified", repository: "D:\\github\\agent-review", source: commit };
    const server = await startSetupServer(() => state, () => retries++,
        { stylesPath: join(source, "web", "styles.css") });
    t.after(() => server.close());
    assert.deepEqual(await (await fetch(`${server.url}state`)).json(), state);
    assert.match(await (await fetch(server.url)).text(), /role="status"/);
    assert.equal((await fetch(`${server.url}styles.css`)).status, 200);
    assert.equal((await fetch(`${server.url}retry`, { method: "POST",
        headers: { Origin: "https://example.com" } })).status, 403);
    assert.equal(retries, 0);
    assert.equal((await fetch(`${server.url}retry`, { method: "POST",
        headers: { Origin: new URL(server.url).origin } })).status, 202);
    assert.equal(retries, 1);
});
