import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareSample } from "../prepare.mjs";

const execute = promisify(execFile);
const fixtures = fileURLToPath(new URL("../", import.meta.url));
const nodeEnv = { ...process.env };
delete nodeEnv.NODE_TEST_CONTEXT;
async function workspace(t) {
    // Windows runners can report 8.3 short temp paths; Git reports the canonical long path.
    const root = await realpath(await mkdtemp(join(tmpdir(), "agent-review-samples-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}
const git = async (repo, ...args) => (await execute("git", ["--no-pager", "-C", repo, ...args],
    { maxBuffer: 8 * 1024 * 1024 })).stdout;

test("preparation rejects unknown samples, nested repositories and existing destinations without overwriting", async (t) => {
    const root = await workspace(t);
    await assert.rejects(prepareSample("unknown", join(root, "unknown")), /Unknown sample/);
    await assert.rejects(prepareSample("coverage-demo"), /destination directory/);
    const nested = join(fixtures, "must-not-be-created");
    await assert.rejects(prepareSample("coverage-demo", nested), /outside the Agent Review checkout/);
    await assert.rejects(lstat(nested), { code: "ENOENT" });
    const existing = join(root, "existing");
    await mkdir(existing);
    await writeFile(join(existing, "keep.txt"), "User-owned content\n");
    await assert.rejects(prepareSample("coverage-demo", existing), { code: "EEXIST" });
    assert.equal(await readFile(join(existing, "keep.txt"), "utf8"), "User-owned content\n");
    const empty = join(root, "empty");
    await mkdir(empty);
    await assert.rejects(prepareSample("coverage-demo", empty), { code: "EEXIST" });
});

for (const [name, path] of [
    ["node-demo", "packages/core/src/resolver.js"],
    ["coverage-demo", "shipping.py"],
    ["dotnet-demo", "src/ReviewPolicy/ReviewPolicy.cs"],
    ["cpp-demo", "include/policy.hpp"],
]) {
    test(`${name} recreates a standalone baseline with the real feature left uncommitted`, async (t) => {
        const root = await workspace(t);
        const repo = join(root, name);
        const target = await prepareSample(name, repo);
        assert.deepEqual(target, { repository: repo, mode: "worktree", baseRef: "HEAD", currentRef: null });
        assert.equal(resolve((await git(repo, "rev-parse", "--show-toplevel")).trim()), repo);
        assert.equal((await git(repo, "branch", "--show-current")).trim(), "main");
        assert.equal((await git(repo, "remote")).trim(), "");
        assert.equal((await git(repo, "rev-list", "--count", "HEAD")).trim(), "1");
        assert.equal(await readFile(join(repo, path), "utf8"), await readFile(join(fixtures, name, "current", path), "utf8"));
        assert.notEqual(await git(repo, "show", `HEAD:${path}`), await readFile(join(repo, path), "utf8"));
        assert.match(await git(repo, "diff", "--name-only"), new RegExp(path.replaceAll(".", "\\.")));
        assert.equal(await readFile(join(repo, "README.md"), "utf8"), await readFile(join(fixtures, name, "README.md"), "utf8"));
        for (const output of ["node_modules", ".local-nuget", "TestResults", "coverage.json", "baseline", "current"]) {
            await assert.rejects(lstat(join(repo, output)), { code: "ENOENT" });
        }
        if (name === "coverage-demo") {
            assert.equal(JSON.parse(await readFile(join(repo, ".agent-review.json"), "utf8")).test_python, "python");
            assert.deepEqual((await git(repo, "diff", "--name-only")).trim().split(/\r?\n/).sort(),
                ["shipping.py", "tests/test_shipping.py"]);
        }
        if (name === "node-demo") {
            const run = await execute(process.execPath, ["--test", "--test-reporter=tap", "packages/core/test/resolver.test.mjs",
                "packages/core/test/missing-title.test.mjs"], { cwd: repo, env: nodeEnv });
            assert.match(run.stdout, /# tests 2\b/);
            assert.match(run.stdout, /# fail 0\b/);
        }
    });
}

test("large-repo preserves all 642 changes, passing baseline and exactly two planted head failures", async (t) => {
    const root = await workspace(t);
    const repo = join(root, "large-repo");
    assert.deepEqual(await prepareSample("large-repo", repo),
        { repository: repo, mode: "commit", baseRef: "main", currentRef: "large-change" });
    const changed = (await git(repo, "diff", "--name-only", "main...large-change")).trim().split(/\r?\n/);
    assert.equal(changed.length, 642);
    assert.equal(changed.filter((path) => path.startsWith("modules/")).length, 540);
    assert.equal(changed.filter((path) => path.startsWith(".generated/")).length, 91);
    assert.equal((await git(repo, "status", "--porcelain")).trim(), "");
    assert.equal((await git(repo, "remote")).trim(), "");
    const source = await readFile(join(repo, "src", "routing", "exception-rules.js"), "utf8");
    assert.ok(Buffer.byteLength(source) > 500 * 1024);
    assert.ok(source.split("\n").findIndex((line) => line.startsWith("export function resolveTerminalException")) > 16000);
    const inspect = await execute(process.execPath, ["tools/inspect-fixture.mjs"], { cwd: repo });
    assert.equal(JSON.parse(inspect.stdout).changedFiles, 642);
    const args = ["--test", "--test-reporter=tap", "tests/route-modules.test.js", "tests/retry-boundary.test.js",
        "tests/quote-boundary.test.js", "tests/contracts.test.js"];
    await git(repo, "switch", "--quiet", "main");
    const baseline = await execute(process.execPath, args, { cwd: repo, env: nodeEnv });
    assert.match(baseline.stdout, /# tests 282\b/);
    assert.match(baseline.stdout, /# fail 0\b/);
    await git(repo, "switch", "--quiet", "large-change");
    await assert.rejects(execute(process.execPath, args, { cwd: repo, env: nodeEnv }), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /# tests 283\b/);
        assert.match(error.stdout, /# pass 281\b/);
        assert.match(error.stdout, /# fail 2\b/);
        assert.match(error.stdout, /not ok \d+ - retry boundary: omitted override inherits three attempts/);
        assert.match(error.stdout, /not ok \d+ - quote boundary: a 45-minute route meets a 2-hour deadline without a surcharge/);
        return true;
    });
});
