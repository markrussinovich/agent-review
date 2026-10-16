import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath } from "./build-distribution.mjs";
import { SEMVER, pluginVersion } from "./build-release-distribution.mjs";
import { verifyDistribution } from "./verify-distribution.mjs";

const releaseRoot = process.argv[2];
const pluginRoot = resolve(releaseRoot, "bootstrap");
const plugin = JSON.parse(await readFile(join(pluginRoot, "plugin.json"), "utf8"));
const template = JSON.parse(await readFile(new URL("./bootstrap/plugin.json", import.meta.url), "utf8"));
const marketplace = JSON.parse(await readFile(join(pluginRoot, ".github", "plugin", "marketplace.json"), "utf8"));
const sourceMarketplace = JSON.parse(await readFile(new URL("../.github/plugin/marketplace.json", import.meta.url), "utf8"));
assert.equal(plugin.name, "agent-review");
assert.deepEqual(plugin.extensions, [".github/extensions"]);
for (const field of ["name", "owner", "metadata"]) {
    assert.deepEqual(marketplace[field], sourceMarketplace[field], `Generated marketplace ${field} must match the source.`);
}
assert.equal(marketplace.plugins.length, 1);
const [entry] = marketplace.plugins;
assert.equal(entry.source, "./");
for (const field of ["name", "description", "version", "author", "homepage", "repository", "license", "keywords"]) {
    assert.deepEqual(entry[field], plugin[field], `Generated marketplace ${field} must match plugin.json.`);
}
const bootstrap = resolve(pluginRoot, plugin.extensions[0], plugin.name);
assert.equal(bootstrap, join(pluginRoot, extensionPath));
const release = JSON.parse(await readFile(join(bootstrap, "release-manifest.json"), "utf8"));
assert.deepEqual(JSON.parse(await readFile(join(releaseRoot, "release-manifest.json"), "utf8")), release);
assert.equal(plugin.version, pluginVersion(template.version, release.source_commit));
assert.equal(SEMVER.exec(plugin.version)?.[5], release.source_commit.slice(0, 7),
    "Plugin version must be valid SemVer with the pinned release's short source commit as build metadata.");
const repository = new URL(release.url).pathname.split("/").slice(1, 3).join("/");
assert.equal(plugin.repository, `https://github.com/${repository}`);
assert.equal(plugin.homepage, plugin.repository);
const { ensureBundle } = await import(pathToFileURL(join(bootstrap, "runtime.mjs")));
const zip = await readFile(join(releaseRoot, "agent-review.zip"));
const cacheRoot = await mkdtemp(join(tmpdir(), "agent-review-release-check-"));
try {
    let downloads = 0;
    const fetchRelease = async () => { downloads++; return new Response(zip); };
    const directory = await ensureBundle(release, { cacheRoot, fetchRelease });
    assert.equal(downloads, 1);
    assert.equal(await ensureBundle(release, { cacheRoot, fetchRelease }), directory);
    assert.equal(downloads, 1, "A verified cached bundle must work offline without another download.");
    await verifyDistribution(directory);
    console.log("Native plugin metadata, extension discovery paths, and pinned loader passed.");
} finally {
    await rm(cacheRoot, { recursive: true, force: true });
}
