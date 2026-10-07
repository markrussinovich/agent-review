import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewState } from "../review-state.mjs";
import { runDotnetTests } from "../dotnet-test-run.mjs";

const execute = promisify(execFile);
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dotnet");

test("explicit xUnit run executes an exported saved snapshot and never confirms untraced paths", {
    skip: !process.env.AGENT_REVIEW_DOTNET_EXECUTION_TESTS, timeout: 240_000,
}, async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-review-xunit-"));
    let state;
    try {
        await cp(fixture, repo, { recursive: true });
        const git = (...args) => execute("git", ["-C", repo, ...args]);
        await git("init", "-q");
        await git("config", "user.name", "Test");
        await git("config", "user.email", "test@example.invalid");
        const project = join(repo, "App", "App.csproj");
        await writeFile(project, (await readFile(project, "utf8")).replace("</Project>",
            '<Target Name="ReviewSafetySentinel" BeforeTargets="Build"><WriteLinesToFile File="$(MSBuildProjectDirectory)\\scan-built.txt" Lines="Explicit build only" Overwrite="true"/></Target></Project>'));
        await git("add", ".");
        await git("commit", "-qm", "baseline");
        const base = (await git("rev-parse", "HEAD")).stdout.trim();
        const widget = join(repo, "App", "Widget.cs");
        const source = await readFile(widget, "utf8");
        await writeFile(widget, source.replace("value < 10", "value < 20"));
        await git("add", ".");
        await git("commit", "-qm", "raise threshold");
        const head = (await git("rev-parse", "HEAD")).stdout.trim();
        // A dirty live source would fail the saved threshold assertion if executed.
        await writeFile(widget, source.replace("value < 10", "value < 5"));
        state = new ReviewState(repo, { baseRef: base, reviewTarget: {
            mode: "commit", label: "raise threshold", currentRef: head,
        } });
        await state.refresh();
        assert.equal(state.error, null);
        await assert.rejects(readFile(join(repo, "App", "scan-built.txt")), /ENOENT/);
        await state.decisionMapFor(120_000);
        assert.equal(state.decisionMap.status, "complete");
        const plan = await state.testRunPlan();
        assert.equal(plan.available, true, JSON.stringify(plan));
        assert.match(plan.command, /dotnet test/);
        const originalRun = state.runTests;
        let exported;
        state.runTests = async (options) => {
            exported = options.repoRoot;
            assert.notEqual(options.repoRoot, repo);
            assert.match(await readFile(join(options.repoRoot, "App", "Widget.cs"), "utf8"), /value < 20/);
            const result = await runDotnetTests(options);
            assert.match(await readFile(join(options.repoRoot, "App", "scan-built.txt"), "utf8"), /Explicit build only/);
            return result;
        };
        await state.runLinkedTests();
        const result = await state.testRunPromise;
        state.runTests = originalRun;
        assert.equal(result.status, "complete", result.error || result.output);
        assert.ok(result.counts.passed > 0, result.output);
        assert.equal(result.counts.failed, 0, result.output);
        assert.deepEqual(result.executed, {});
        assert.match(result.path_evidence_limitation, /No per-test path/);
        assert.match(await readFile(widget, "utf8"), /value < 5/);
        await assert.rejects(readFile(join(repo, "App", "scan-built.txt")), /ENOENT/);
        await assert.rejects(readFile(join(exported, "App", "Widget.cs")), /ENOENT/);
        console.log(`xUnit snapshot evidence: ${result.counts.passed} passed; ${result.path_evidence_limitation}`);
    } finally {
        await state?.dispose();
        await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});

test("owned .NET test process cancellation rejects without evidence", { timeout: 20_000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-review-dotnet-cancel-"));
    const controller = new AbortController();
    let pending;
    try {
        await writeFile(join(repo, "test"), "require('fs').writeFileSync('owned.pid', String(process.pid)); setInterval(() => {}, 1000);");
        pending = runDotnetTests({ repoRoot: repo, python: { executable: "node" },
            plan: { project: "fixture.csproj", tests: [] }, signal: controller.signal });
        let pid;
        for (let attempt = 0; attempt < 100 && !pid; attempt++) {
            try { pid = Number(await readFile(join(repo, "owned.pid"), "utf8")); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(pid, "the owned process must actually start before cancellation");
        controller.abort(new DOMException("Cancelled fixture", "AbortError"));
        await assert.rejects(pending, /Cancelled fixture/);
        assert.throws(() => process.kill(pid, 0), /ESRCH/);
    } finally {
        controller.abort(new DOMException("Fixture cleanup", "AbortError"));
        await pending?.catch(() => {});
        await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});

test("cancelling a real running xUnit test stops its owned testhost", {
    skip: !process.env.AGENT_REVIEW_DOTNET_EXECUTION_TESTS, timeout: 120_000,
}, async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-review-xunit-cancel-"));
    const proof = join(repo, "running-test.pid");
    const controller = new AbortController();
    let pending;
    try {
        await cp(fixture, repo, { recursive: true });
        await writeFile(join(repo, "Tests", "Slow.Tests.cs"), `using Xunit;
namespace Demo.Tests;
public class SlowTests {
    [Fact] public void WaitForCancellation() {
        System.IO.File.WriteAllText(${JSON.stringify(proof)}, System.Environment.ProcessId.ToString());
        System.Threading.Thread.Sleep(60000);
    }
}`);
        pending = runDotnetTests({ repoRoot: repo, python: { executable: "dotnet" },
            plan: { project: join("Tests", "Tests.csproj"), tests: ["Demo.Tests.SlowTests.WaitForCancellation"] },
            signal: controller.signal });
        let runError;
        void pending.catch((error) => { runError = error; });
        // Observe process startup without racing a build or restore against a fixed cancellation delay.
        let pid;
        for (let attempt = 0; attempt < 1200 && !pid && !runError; attempt++) {
            try { pid = Number(await readFile(proof, "utf8")); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (runError) throw runError;
        assert.ok(pid, "the xUnit test must actually run before cancellation");
        controller.abort(new DOMException("Cancelled real xUnit test", "AbortError"));
        await assert.rejects(pending, /Cancelled real xUnit test/);
        assert.throws(() => process.kill(pid, 0), /ESRCH/);
    } finally {
        controller.abort(new DOMException("Fixture cleanup", "AbortError"));
        await pending?.catch(() => {});
        await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});
