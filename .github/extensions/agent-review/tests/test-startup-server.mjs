import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), "agent-review-startup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await cp(new URL("../web/", import.meta.url), join(directory, "web"), { recursive: true });
    await cp(new URL("../server.mjs", import.meta.url), join(directory, "server.mjs"));
    const { startReviewServer } = await import(pathToFileURL(join(directory, "server.mjs")).href);
    const state = { subscribe: () => () => {}, snapshot: () => ({ repo_root: "example" }),
        startWorktreeMonitoring: () => () => {} };
    const server = await startReviewServer(state);
    t.after(() => server.close());
    return { directory, server, startReviewServer, state };
}

test("new web modules are served without a static allowlist; private files and traversal are not", async (t) => {
    const { directory, server } = await fixture(t);
    await writeFile(join(directory, "web", "new-module.mjs"), "export const updated = true;\n");
    const response = await fetch(`${server.url}new-module.mjs`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(await response.text(), /updated = true/);
    for (const path of ["missing.mjs", "server.mjs", "private.json", ".hidden.js", "nested/module.mjs",
        "%2e%2e%5cserver.mjs", "%2fserver.mjs", "app.js.map"]) {
        assert.equal((await fetch(`${server.url}${path}`)).status, 404, path);
    }
    assert.equal((await fetch(server.url)).status, 200);
    assert.equal((await fetch(`${server.url}index.html`)).status, 200);
    await mkdir(join(directory, "web", "folder.js"));
    assert.equal((await fetch(`${server.url}folder.js`)).status, 400, "directories are not served");
    await writeFile(join(directory, "private.js"), "private");
    try { await symlink(join(directory, "private.js"), join(directory, "web", "linked.js")); }
    catch (error) {
        if (!["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic("Symlink creation is not permitted on this machine.");
        return;
    }
    assert.equal((await fetch(`${server.url}linked.js`)).status, 404, "symlinks cannot escape web/");
});

test("a source update cannot change the identity of the already-loaded provider, even on another canvas", async (t) => {
    const { directory, server, startReviewServer, state } = await fixture(t);
    const build = async (url) => (await fetch(`${url}api/build`)).json();
    const original = await build(server.url);
    assert.equal(original.compatible, true);
    assert.match(original.provider, /^[a-f0-9]{64}$/);
    assert.equal(original.provider, original.source);
    await writeFile(join(directory, "web", "added-module.mjs"), "export const added = true;\n");
    const updated = await build(server.url);
    assert.equal(updated.compatible, false);
    assert.equal(updated.provider, original.provider);
    assert.notEqual(updated.source, original.source);
    const otherCanvas = await startReviewServer(state);
    t.after(() => otherCanvas.close());
    assert.deepEqual(await build(otherCanvas.url), updated);
    await rm(join(directory, "web", "added-module.mjs"));
    assert.deepEqual(await build(server.url), original);
    await writeFile(join(directory, "server.mjs"), `${await readFile(join(directory, "server.mjs"), "utf8")}\n// updated\n`);
    assert.equal((await build(server.url)).compatible, false, "provider source updates also require a reload");
});
