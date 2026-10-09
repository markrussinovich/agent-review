import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath } from "./build-distribution.mjs";
import { verifyDistribution } from "./verify-distribution.mjs";

const releaseRoot = process.argv[2];
const bootstrap = join(releaseRoot, "bootstrap", extensionPath);
const release = JSON.parse(await readFile(join(bootstrap, "release-manifest.json"), "utf8"));
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
} finally {
    await rm(cacheRoot, { recursive: true, force: true });
}
