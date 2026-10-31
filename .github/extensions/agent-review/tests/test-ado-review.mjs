import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { azureAccessToken, createAdoClient, parseAdoUrl, readAdoSnapshot } from "../ado-provider.mjs";
import { listReviewTargets, resolveReviewTarget } from "../review-target.mjs";
import { ReviewState } from "../review-state.mjs";
import { startReviewServer } from "../server.mjs";

const execute = promisify(execFile);
const repoId = "11111111-1111-1111-1111-111111111111";
const projectId = "22222222-2222-2222-2222-222222222222";
const url = "https://dev.azure.com/example/Project%20One/_git/sample/pullrequest/42";
const input = parseAdoUrl(url);
const repository = { id: repoId, name: "sample", project: { id: projectId, name: "Project One" } };
const source = "a".repeat(40), target = "b".repeat(40), common = "c".repeat(40);

function fakeAdo({ head = source, base = target, liveHead = head, liveTarget = base, ancestor = common, status = "active", change = () => {} } = {}) {
    const calls = [];
    const pr = { pullRequestId: 42, repository, status, supportsIterations: true,
        title: "Strict fallback", description: "Full PR description", createdBy: { displayName: "Author" },
        sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", lastMergeTargetCommit: { commitId: base } };
    const iteration = { id: 3, sourceRefCommit: { commitId: head }, targetRefCommit: { commitId: base }, commonRefCommit: { commitId: ancestor } };
    const client = async (repo, suffix = "", options = {}) => {
        calls.push({ repo, suffix, options });
        let result;
        assert.ok(!options.method || options.method === "GET", "ADO access must be read-only");
        if (suffix === "") result = repository;
        else if (suffix.endsWith("/iterations")) result = { value: [iteration] };
        else if (suffix === "/refs") result = { value: [
            { name: pr.sourceRefName, objectId: liveHead }, { name: pr.targetRefName, objectId: liveTarget },
        ] };
        else if (suffix === "/pullRequests") result = { value: Array.from({ length: 31 }, (_, index) => ({
            ...pr, pullRequestId: 42 + index, creationDate: "2026-10-10T01:00:00Z", isDraft: true,
        })) };
        else result = pr;
        return change(result, suffix, options, repo) || result;
    };
    return { client, calls, pr, iteration };
}

test("ADO identities normalize modern/legacy HTTPS and SSH; reject untrusted or malformed addresses", () => {
    assert.deepEqual(parseAdoUrl("https://example.visualstudio.com/Project%20One/_git/sample/pullrequest/42"), input);
    assert.deepEqual(parseAdoUrl("https://example.visualstudio.com/DefaultCollection/Project%20One/_git/sample/pullrequest/42"), input);
    assert.equal(parseAdoUrl("git@ssh.dev.azure.com:v3/example/Project%20One/sample", { repository: true }).project, "Project One");
    assert.equal(parseAdoUrl("example@vs-ssh.visualstudio.com:v3/example/Project%20One/sample", { repository: true }).ssh, true);
    assert.equal(parseAdoUrl("ssh://git@ssh.dev.azure.com/v3/example/Project%20One/sample", { repository: true }).ssh, true);
    assert.equal(parseAdoUrl("https://example@dev.azure.com/example/Project%20One/_git/sample", { repository: true }).repository, "sample");
    assert.equal(parseAdoUrl("https://github.com/example/sample/pull/42"), null);
    for (const bad of [
        url.replace("https:", "http:"), url.replace("dev.azure.com", "user:secret@dev.azure.com"),
        url.replace("Project%20One", "%2e%2e%2fsecret"), `${url}?token=secret`,
        url.replace("/42", "/0"), url.replace("dev.azure.com", "dev.azure.com:4433"),
        url.replace("/42", "/9007199254740993"),
        url.replace("/Project%20One/", "/Project%20One/../Project%20One/"),
        url.replace("/Project%20One/", "/Project%20One/%2e%2e/Project%20One/"),
    ]) assert.throws(() => parseAdoUrl(bad), /Azure DevOps/);
});

test("ADO client confines bearer credentials to validated endpoints and exposes safe failures", async () => {
    let tokens = 0;
    const calls = [];
    const client = createAdoClient({ getToken: async () => { tokens++; return "test-token"; },
        fetch: async (endpoint, options) => { calls.push({ endpoint, options }); return new Response('{"value":[]}'); } });
    await client(input, "/pullRequests", { query: { $top: "31", "searchCriteria.status": "all" } });
    await client(input, "/refs");
    assert.equal(tokens, 1);
    assert.equal(calls[0].endpoint.origin, "https://dev.azure.com");
    assert.match(calls[0].endpoint.pathname, /Project%20One/);
    assert.equal(calls[0].endpoint.searchParams.get("$top"), "31");
    assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
    assert.equal(calls[0].options.redirect, "error");
    for (const options of [{ method: "POST" }, { method: "PATCH" }, { method: "DELETE" }, { body: {} }]) {
        await assert.rejects(client(input, "/pullRequests/42/threads", options), /read-only/);
    }
    assert.equal(calls.length, 2, "write attempts must fail before token or network use");
    for (const status of [401, 403, 404, 429, 500]) {
        const failed = createAdoClient({ getToken: async () => "private-token",
            fetch: async () => new Response("private server data", { status }) });
        await assert.rejects(failed(input), (error) => {
            assert.match(error.message, new RegExp(`HTTP ${status}`));
            assert.doesNotMatch(error.message, /private/);
            return true;
        });
    }
    await assert.rejects(azureAccessToken(async (_, args) => {
        assert.ok(args.join(" ").includes("499b84ac-1321-427f-aa17-267ca6975798"));
        throw new Error("private diagnostic");
    }), /Install Azure CLI and run az login/);
});

test("ADO PR list uses the clone's origin, paginates and does not fake last-updated timestamps", async () => {
    const { client, calls } = fakeAdo();
    const run = async (command, args) => {
        assert.equal(command, "git");
        assert.deepEqual(args.slice(-3), ["remote", "get-url", "origin"]);
        return { stdout: "https://example.visualstudio.com/DefaultCollection/Project%20One/_git/sample\n" };
    };
    const result = await listReviewTargets("C:\\repo", { mode: "pr", page: 2 }, run, { adoClient: client });
    assert.equal(result.items.length, 30);
    assert.equal(result.has_more, true);
    assert.equal(result.provider, "ado");
    assert.equal(result.items[0].ref, url);
    assert.equal(result.items[0].date_kind, "created");
    assert.equal(result.items[0].draft, true);
    assert.equal(calls[1].options.query.$skip, "60");
    for (const origin of ["https://github.com/example/sample.git", null]) {
        const gh = [];
        const github = await listReviewTargets("C:\\repo", { mode: "pr" }, async (command, args) => {
            if (command === "git") {
                if (!origin) throw new Error("error: No such remote 'origin'");
                return { stdout: `${origin}\n` };
            }
            gh.push(args);
            return { stdout: args[0] === "repo" ? '{"nameWithOwner":"example/sample"}' : "[]" };
        }, { adoClient: async () => assert.fail("GitHub origins must not call Azure DevOps") });
        assert.equal(github.repository, "example/sample");
        assert.ok(gh.length >= 2, "non-ADO origins keep the existing GitHub flow");
    }
});

test("ADO resolves source/target Git objects rather than synthetic merge refs; validates identities", async () => {
    const { client } = fakeAdo();
    const calls = [];
    const resolved = await resolveReviewTarget("C:\\repo", { mode: "pr", ref: url }, async (command, args) => {
        calls.push({ command, args });
        return { stdout: args.includes("merge-base") ? common : args.includes("log") ? `${source}\0Feature\0Intent\x1e` : "" };
    }, { adoClient: client });
    assert.equal(resolved.currentRef, source);
    assert.equal(resolved.baseRef, common);
    assert.equal(resolved.targetRef, target);
    assert.equal(resolved.provider, "ado");
    assert.equal(resolved.iteration, 3);
    assert.equal(resolved.intent.body, "Full PR description");
    assert.ok(calls.filter((call) => call.args.includes("fetch")).every((call) => [source, target].includes(call.args.at(-1))));
    assert.ok(calls.every((call) => !call.args.includes("checkout")));
    const wrong = fakeAdo({ change: (result, suffix) => suffix === "/pullRequests/42"
        ? { ...result, repository: { ...repository, name: "other" } } : result });
    await assert.rejects(readAdoSnapshot(input, wrong.client), /different repository/);
    const moved = fakeAdo({ change: (result, suffix) => suffix === "/refs" ? { value: [] } : result });
    await assert.rejects(readAdoSnapshot(input, moved.client), /branches changed/);
    const ambiguous = fakeAdo({ change: (result, suffix) => suffix === "/pullRequests/42" ? { ...result, hasMultipleMergeBases: true } : result });
    await assert.rejects(readAdoSnapshot(input, ambiguous.client), /ambiguous merge bases/);
});

test("ADO rejects incomplete snapshots and local ambiguous ancestry without falling back to worktree source", async () => {
    for (const change of [
        (result, suffix) => suffix === "/pullRequests/42" ? { ...result, supportsIterations: false } : result,
        (result, suffix) => suffix.endsWith("/iterations") ? { value: [] } : result,
        (result, suffix) => suffix.endsWith("/iterations") ? { value: [{ ...result.value[0], sourceRefCommit: {} }] } : result,
        (result, suffix) => suffix === "/pullRequests/42" ? { ...result, repository: { ...repository, id: "invalid" } } : result,
        (result, suffix) => suffix === "/pullRequests/42" ? { ...result, forkSource: { repository: { id: "invalid" } } } : result,
    ]) {
        await assert.rejects(readAdoSnapshot(input, fakeAdo({ change }).client), /unsupported|complete PR snapshot|invalid.*identity|invalid fork/);
    }
    const { client } = fakeAdo();
    for (const mergeBases of ["", `${common}\n${source}`]) {
        await assert.rejects(resolveReviewTarget("C:\\repo", { mode: "pr", ref: url }, async (_, args) => ({
            stdout: args.includes("merge-base") ? mergeBases : "",
        }), { adoClient: client }), /single available merge base/);
    }
});

test("closed ADO PRs retain their pinned snapshot even after branches move or are deleted", async () => {
    for (const status of ["completed", "abandoned"]) {
        const { client, calls } = fakeAdo({ status, liveHead: null, liveTarget: "d".repeat(40), change: (result, suffix) => suffix === "/pullRequests"
            ? { value: [{ ...result.value[0], closedDate: "2026-10-11T01:00:00Z" }] } : result });
        const snapshot = await readAdoSnapshot(input, client);
        assert.equal(snapshot.head, source);
        assert.equal(snapshot.target, target);
        assert.ok(calls.every((call) => call.suffix !== "/refs"), "closed PRs do not require live branch refs");
        const result = await listReviewTargets("C:\\repo", { mode: "pr" }, async () => ({
            stdout: "https://dev.azure.com/example/Project%20One/_git/sample\n",
        }), { adoClient: client });
        assert.equal(result.items[0].status, status);
        assert.equal(result.items[0].date_kind, "closed");
        assert.equal(result.items[0].date, "2026-10-11T01:00:00Z");
    }
});

test("ADO fork metadata resolves a distinct source repository before fetching", async () => {
    const forkId = "33333333-3333-3333-3333-333333333333";
    const forkProjectId = "44444444-4444-4444-4444-444444444444";
    const { client } = fakeAdo({ change: (result, suffix, _, repo) => {
        if (suffix === "/pullRequests/42") return { ...result, forkSource: { repository: { id: forkId } } };
        if (suffix === "" && repo.repository === forkId) return {
            id: forkId, name: "fork", project: { id: forkProjectId, name: "Fork Project" },
        };
        return result;
    } });
    const calls = [];
    const resolved = await resolveReviewTarget("C:\\repo", { mode: "pr", ref: url }, async (_, args) => {
        calls.push(args);
        return { stdout: args.includes("merge-base") ? common : "" };
    }, { adoClient: client });
    assert.equal(resolved.sourceRepository.repositoryId, forkId);
    assert.ok(calls.some((args) => args.includes("https://dev.azure.com/example/Fork%20Project/_git/fork")));
});

test("ADO objects are fetched over SSH when the clone's origin uses an ADO SSH remote", async () => {
    const { client } = fakeAdo();
    const calls = [];
    await resolveReviewTarget("C:\\repo", { mode: "pr", ref: url }, async (_, args) => {
        calls.push(args);
        if (args.includes("get-url")) return { stdout: "git@ssh.dev.azure.com:v3/example/Project%20One/sample\n" };
        return { stdout: args.includes("merge-base") ? common : "" };
    }, { adoClient: client });
    const fetches = calls.filter((args) => args.includes("fetch"));
    assert.equal(fetches.length, 2);
    assert.ok(fetches.every((args) => args.includes("git@ssh.dev.azure.com:v3/example/Project%20One/sample")));
});

test("active ADO reviews pin the live target even when merge evaluation lags its branch", async () => {
    const advanced = "d".repeat(40);
    const fake = fakeAdo({ liveTarget: advanced });
    const original = await readAdoSnapshot(input, fakeAdo().client);
    const snapshot = await readAdoSnapshot(input, fake.client);
    assert.equal(snapshot.head, source);
    assert.equal(snapshot.target, advanced);
    assert.equal(snapshot.iteration, original.iteration);
    assert.notEqual(snapshot.fingerprint, original.fingerprint);
    const calls = [];
    const resolved = await resolveReviewTarget("C:\\repo", { mode: "pr", ref: url }, async (_, args) => {
        calls.push(args);
        return { stdout: args.includes("merge-base") ? common : "" };
    }, { adoClient: fake.client });
    assert.equal(resolved.targetRef, advanced);
    assert.equal(resolved.baseRef, common);
    assert.ok(calls.some((args) => args.includes("fetch") && args.at(-1) === advanced));
    assert.ok(!calls.some((args) => args.includes("fetch") && args.at(-1) === target));
    assert.ok(calls.some((args) => args.includes("merge-base") && args.includes(advanced) && args.includes(source)));
});

test("active ADO reviews still reject source iteration drift and unavailable target refs", async () => {
    await assert.rejects(readAdoSnapshot(input, fakeAdo({ liveHead: common }).client), /branches changed/);
    for (const liveTarget of ["", "not-a-commit", null]) {
        await assert.rejects(readAdoSnapshot(input, fakeAdo({ liveTarget }).client), /branches changed/);
    }
    const missingTarget = fakeAdo({ change: (result, suffix) => suffix === "/refs"
        ? { value: result.value.filter((ref) => ref.name !== "refs/heads/main") } : result });
    await assert.rejects(readAdoSnapshot(input, missingTarget.client), /branches changed/);
    const deletedSource = fakeAdo({ change: (result, suffix) => suffix === "/refs"
        ? { value: result.value.filter((ref) => ref.name !== "refs/heads/feature") } : result });
    await assert.rejects(readAdoSnapshot(input, deletedSource.client), /branches changed/);
});

async function gitRepository(t) {
    const root = await mkdtemp(join(tmpdir(), "ado-review-"));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const repo = join(root, "upstream");
    await mkdir(repo);
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    await git("init", "-qb", "main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "main.py"), "def run():\n    return 1\n");
    await git("add", ".");
    await git("commit", "-qm", "Base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("switch", "-qc", "feature");
    await writeFile(join(repo, "main.py"), "def run():\n    return 2\n");
    await git("commit", "-qam", "Feature");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    return { root, repo, git, base, head };
}

test("ADO real-Git review preserves dirty files, index and branch; publishing is unavailable", async (t) => {
    const { repo, git, base, head } = await gitRepository(t);
    const { client } = fakeAdo({ head, base, ancestor: base });
    await writeFile(join(repo, "main.py"), "def dirty_only():\n    return 999\n");
    const before = (await git("status", "--porcelain=v1")).stdout;
    const indexBefore = (await git("write-tree")).stdout;
    const command = async (file, args, options) => {
        if (args.includes("get-url")) return { stdout: "https://dev.azure.com/example/Project%20One/_git/sample\n" };
        if (args.includes("fetch")) {
            const updated = [...args];
            updated[updated.length - 2] = repo;
            return execute(file, updated, options);
        }
        assert.ok(!args.includes("clone") && !args.includes("checkout"));
        return execute(file, args, options);
    };
    const state = new ReviewState(repo, { adoClient: client, runTargetCommand: command });
    t.after(() => state.dispose());
    await state.setReviewTarget({ mode: "pr", ref: url });
    assert.match((await state.sourceForPath("main.py")).current, /return 2/);
    assert.equal((await git("status", "--porcelain=v1")).stdout, before);
    assert.equal((await git("write-tree")).stdout, indexBefore);
    assert.equal((await git("branch", "--show-current")).stdout.trim(), "feature");
    assert.match(await readFile(join(repo, "main.py"), "utf8"), /dirty_only/);
    const preview = await state.prepareHandoff();
    assert.equal(preview.provider.available, false);
    assert.match(preview.provider.reason, /read-only; publishing is unavailable/);
    assert.match(preview.markdown, /Iteration: 3/);
    await assert.rejects(state.submitHandoff({ token: preview.token, confirm: true }), /publishing is unavailable/);
});

test("ADO handoff never reaches the GitHub publisher, even through direct HTTP submission", async (t) => {
    const model = { metadata: { repo_root: "C:\\sample", head_sha: source, base_sha: common },
        changes: [], source_files: {}, nodes: [], attention: [], warnings: [] };
    let posts = 0;
    const state = new ReviewState("C:\\sample", {
        runAnalyzer: async () => model,
        submitHandoffReview: async () => { posts++; },
    });
    t.after(() => state.dispose());
    state.model = model;
    state.reviewTarget = { mode: "pr", provider: "ado", url, currentRef: source, baseRef: common };
    const server = await startReviewServer(state);
    t.after(() => server.close());
    for (const provider of ["ado", undefined, "github"]) {
        state.reviewTarget = { ...state.reviewTarget, provider };
        const preview = await state.prepareHandoff();
        assert.equal(preview.provider.available, false);
        const response = await fetch(`${server.url}api/review-handoff/submit`, {
            method: "POST", body: JSON.stringify({ token: preview.token, confirm: true }),
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /publishing is unavailable/);
    }
    assert.equal(posts, 0);
});

test("ADO reviews never reach GitHub's Viewed, thread or comment APIs; drafts stay local and export in the summary", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ado-pr-review-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const model = { metadata: { repo_root: root, head_sha: source, base_sha: common }, changes: [{ path: "a.js", status: "modified" }], nodes: [], attention: [], warnings: [],
        source_files: { "a.js": { current: "x\ny\n", baseline: "x\n", diff: "@@ -1 +1,2 @@\n x\n+y\n" } } };
    const githubCalls = [];
    let posts = 0;
    const state = new ReviewState(root, { runAnalyzer: async () => model, workspacePath: root,
        github: async (args) => { githubCalls.push(args); throw new Error("GitHub must not be called for Azure DevOps"); },
        submitHandoffReview: async () => { posts++; } });
    t.after(() => state.dispose());
    state.model = model;
    state.reviewTarget = { mode: "pr", provider: "ado", url, currentRef: source, baseRef: common, iteration: 3,
        targetBranch: "refs/heads/main", targetRef: common, label: "ADO PR #42" };

    await assert.rejects(state.pullRequestInfo({ fresh: true }), /not a GitHub pull request/);
    assert.equal(await state.pullRequestLines(), null);
    assert.equal(await state.syncViewed({}, { "review-file:a.js": { disposition: "reviewed", path: "a.js" } }), null);
    const view = await state.prReview();
    assert.equal(view.available, false);
    assert.match(view.reason, /Azure DevOps review is read-only/);
    await state.updateReviewDraft({ revision: 0, action: "add", comment: { path: "a.js", line: 2, side: "RIGHT", body: "Check y." } });
    const preview = await state.prepareHandoff();
    assert.equal(preview.provider.available, false);
    assert.match(preview.markdown, /## Line comments\n.*\n- ` a\.js:2 ` — Check y\./, "ADO drafts travel in the exported summary");
    assert.doesNotMatch(preview.markdown, /under your GitHub identity/);
    assert.match(preview.markdown, /publishing is unavailable/);
    await assert.rejects(state.submitHandoff({ token: preview.token, confirm: true }), /publishing is unavailable/);
    assert.deepEqual(githubCalls, []);
    assert.equal(posts, 0);
});

test("ADO list endpoint uses the clone's origin and PR cache keys distinguish provider and identity", async (t) => {
    const { repo } = await gitRepository(t);
    const { client } = fakeAdo();
    const state = new ReviewState(repo, { adoClient: client, runTargetCommand: async () => ({
        stdout: "https://dev.azure.com/example/Project%20One/_git/sample\n",
    }) });
    const server = await startReviewServer(state);
    t.after(async () => { await server.close(); await state.dispose(); });
    for (const refresh of [false, true]) {
        const response = await fetch(`${server.url}api/review-targets${refresh ? "/refresh" : "?mode=pr"}`,
            refresh ? { method: "POST", body: JSON.stringify({ mode: "pr" }) } : {});
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.provider, "ado");
        assert.equal(result.items[0].ref, url);
    }
    const other = { mode: "pr", provider: "ado", url, currentRef: source, baseRef: common };
    assert.notEqual(state.reviewCacheKey(other), state.reviewCacheKey({ ...other, url: url.replace("/42", "/43") }));
    assert.notEqual(state.reviewCacheKey(other), state.reviewCacheKey({ ...other, provider: "github" }));
});
