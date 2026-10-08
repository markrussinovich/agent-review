import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGoTests } from "../go-test-run.mjs";

let hasGo = true;
try { execFileSync("go", ["version"], { stdio: "ignore" }); } catch { hasGo = false; }
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("explicit Go run records exact-test outcome and per-test coverprofile lines", {
    skip: !hasGo, timeout: 120_000,
}, async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-review-go-run-"));
    const source = Buffer.from("package demo\nfunc Classify(v int) string {\n if v >= 10 { return \"high\" }\n return \"normal\"\n}\n");
    const testSource = Buffer.from("package demo\nimport \"testing\"\nfunc TestClassify(t *testing.T) { if Classify(10) != \"high\" { t.Fatal(\"bad\") } }\n");
    try {
        await writeFile(join(repo, "go.mod"), "module example.com/demo\n\ngo 1.23\n");
        await writeFile(join(repo, "score.go"), source);
        await writeFile(join(repo, "score_test.go"), testSource);
        const result = await runGoTests({ repoRoot: repo, python: { executable: "go" },
            plan: { records: [{ id: "score_test.go::TestClassify", name: "TestClassify",
                path: "score_test.go", package: "." }],
            source_hashes: { "score.go": digest(source), "score_test.go": digest(testSource) } } });
        assert.equal(result.trace.tests["score_test.go::TestClassify"].outcome, "passed");
        assert.ok(result.exit_code === 0 || (result.exit_code === 1 && /go: unlinkat .*Access is denied/i.test(result.output)),
            result.output);
        const paths = Object.keys(result.trace.tests["score_test.go::TestClassify"].lines);
        assert.equal(paths.length, 1);
        assert.match(paths[0], /score\.go$/);
        assert.ok(result.trace.tests["score_test.go::TestClassify"].lines[paths[0]].includes(3));
        assert.deepEqual(await readFile(join(repo, "score.go")), source, "test execution preserves reviewed source");
    } finally {
        await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});

test("cancelling a running Go test stops the owned process and returns no evidence", {
    skip: !hasGo, timeout: 120_000,
}, async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-review-go-cancel-"));
    const source = Buffer.from("package demo\nfunc Value() int { return 1 }\n");
    const testSource = Buffer.from(`package demo
import ("os"; "testing"; "time")
func TestSlow(t *testing.T) { os.WriteFile("started", []byte("yes"), 0600); time.Sleep(60*time.Second); Value() }
`);
    const controller = new AbortController();
    let pending;
    try {
        await writeFile(join(repo, "go.mod"), "module example.com/demo\n\ngo 1.23\n");
        await writeFile(join(repo, "value.go"), source);
        await writeFile(join(repo, "value_test.go"), testSource);
        pending = runGoTests({ repoRoot: repo, python: { executable: "go" }, signal: controller.signal,
            plan: { records: [{ id: "value_test.go::TestSlow", name: "TestSlow",
                path: "value_test.go", package: "." }],
            source_hashes: { "value.go": digest(source), "value_test.go": digest(testSource) } } });
        let started = false;
        for (let attempt = 0; attempt < 1200 && !started; attempt++) {
            try { started = (await readFile(join(repo, "started"), "utf8")) === "yes"; }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            if (!started) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(started, true);
        controller.abort(new DOMException("Cancelled Go fixture", "AbortError"));
        await assert.rejects(pending, /Cancelled Go fixture/);
    } finally {
        controller.abort(new DOMException("Fixture cleanup", "AbortError"));
        await pending?.catch(() => {});
        await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});
