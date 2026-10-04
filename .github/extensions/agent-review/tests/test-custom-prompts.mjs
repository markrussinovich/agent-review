import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CustomPromptError, CustomPromptStore } from "../custom-prompts.mjs";

const record = (id = "first", overrides = {}) => ({ id, title: "Review correctness", prompt: "Find concrete bugs.", enabled: true, ...overrides });
const input = (scope = "repository", overrides = {}) => ({ scope, ...record(), ...overrides });
const config = (prompts = [], extra = {}) => ({ version: 1, prompts, ...extra });
const readJSON = async (file) => JSON.parse(await readFile(file, "utf8"));
const writeJSON = async (file, value) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value), "utf8");
};
const fixture = async (t) => {
    // Keep test scratch directories inside the project, never in the OS temp directory.
    const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), ".custom-prompts-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = join(root, "repo");
    const otherRepo = join(root, "other-repo");
    const globalDirectory = join(root, "global");
    await Promise.all([mkdir(repo), mkdir(otherRepo)]);
    return {
        root, repo, otherRepo, globalDirectory,
        repositoryFile: join(repo, ".agent-review", "prompts.json"),
        globalFile: join(globalDirectory, "prompts.json"),
        approvalsFile: join(globalDirectory, "prompt-approvals.json"),
        store: new CustomPromptStore(repo, { globalDirectory }),
        other: new CustomPromptStore(otherRepo, { globalDirectory }),
    };
};
const errorCode = (code) => (error) => error instanceof CustomPromptError && error.code === code &&
    error.statusCode === (code === "INVALID_PROMPT" ? 400 : 500);

test("missing files are empty and list has no filesystem side effects", async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await f.store.list(), []);
    assert.equal(await f.store.remove("repository", "missing"), false);
    assert.deepEqual((await readdir(f.root)).sort(), ["other-repo", "repo"]);
});

test("create generates a UUID and canonical SHA256 revision", async (t) => {
    const { store } = await fixture(t);
    const saved = await store.save(input("global", { id: undefined }));
    assert.match(saved.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const canonical = { id: saved.id, title: saved.title, prompt: saved.prompt, enabled: saved.enabled };
    assert.equal(saved.revision, createHash("sha256").update(JSON.stringify(canonical)).digest("hex"));
    assert.deepEqual(await store.list(), [saved]);
});

test("global and repository CRUD remain isolated even for identical ids", async (t) => {
    const f = await fixture(t);
    await f.store.save(input("global"));
    await f.store.save(input("repository", { title: "Repository" }));
    assert.equal((await f.store.list()).length, 2);
    assert.deepEqual((await f.other.list()).map((item) => item.scope), ["global"]);
    const updated = await f.store.save(input("repository", { title: "Updated", enabled: false }));
    assert.equal(updated.title, "Updated");
    assert.equal(updated.enabled, false);
    assert.equal(await f.store.remove("repository", "first"), true);
    assert.equal(await f.store.remove("repository", "first"), false);
    assert.deepEqual((await f.store.list()).map((item) => item.scope), ["global"]);
    assert.equal(await f.store.remove("global", "first"), true);
    assert.deepEqual(await f.store.list(), []);
});

test("committed repository prompts are untrusted regardless of enabled", async (t) => {
    const f = await fixture(t);
    await writeJSON(f.repositoryFile, config([record(), record("disabled", { enabled: false })]));
    const prompts = await f.store.list();
    assert.deepEqual(prompts.map((item) => item.trusted), [false, false]);
    assert.deepEqual(prompts.map((item) => item.enabled), [true, false]);
});

test("saving one repository prompt approves only that record", async (t) => {
    const f = await fixture(t);
    await writeJSON(f.repositoryFile, config([record(), record("second")]));
    await f.store.save(input());
    assert.deepEqual((await f.store.list()).map((item) => item.trusted), [true, false]);
    const fresh = new CustomPromptStore(f.repo, { globalDirectory: f.globalDirectory });
    assert.deepEqual((await fresh.list()).map((item) => item.trusted), [true, false]);
    const approvals = await readJSON(f.approvalsFile);
    assert.equal(Object.keys(approvals.approvals).length, 1);
    assert.deepEqual(Object.keys(Object.values(approvals.approvals)[0]), ["first"]);
});

test("every record field affects approval and explicit saves reapprove changed revisions", async (t) => {
    const f = await fixture(t);
    for (const overrides of [{ title: "Changed" }, { prompt: "Changed instructions" }, { enabled: false }]) {
        const original = await f.store.save(input());
        await writeJSON(f.repositoryFile, config([record("first", overrides)]));
        const [changed] = await f.store.list();
        assert.notEqual(changed.revision, original.revision);
        assert.equal(changed.trusted, false);
        await f.store.save(input("repository", overrides));
        assert.equal((await f.store.list())[0].trusted, true);
    }
    await writeJSON(f.repositoryFile, config([record("different-id")]));
    assert.equal((await f.store.list())[0].trusted, false);
});

test("approval keys isolate repositories but canonical path aliases share approval", async (t) => {
    const f = await fixture(t);
    await f.store.save(input());
    await writeJSON(join(f.otherRepo, ".agent-review", "prompts.json"), config([record()]));
    assert.equal((await f.other.list())[0].trusted, false);
    const alias = new CustomPromptStore(join(f.repo, "..", "repo"), { globalDirectory: f.globalDirectory });
    assert.equal((await alias.list())[0].trusted, true);
});

test("deleting approval prevents a subsequently restored record from inheriting trust", async (t) => {
    const f = await fixture(t);
    await f.store.save(input());
    await f.store.remove("repository", "first");
    await writeJSON(f.repositoryFile, config([record()]));
    assert.equal((await f.store.list())[0].trusted, false);
});

test("global records are always trusted, including external edits", async (t) => {
    const f = await fixture(t);
    await writeJSON(f.globalFile, config([record("global", { enabled: false })]));
    assert.equal((await f.store.list())[0].trusted, true);
    await writeJSON(f.globalFile, config([record("global", { prompt: "Edited externally" })]));
    assert.equal((await f.store.list())[0].trusted, true);
});

test("unrelated root configuration fields and unrelated approvals are preserved", async (t) => {
    const f = await fixture(t);
    await writeJSON(f.repositoryFile, config([record("second")], { metadata: { owner: "team" }, "__proto__": null }));
    await writeJSON(f.approvalsFile, { version: 1, approvals: { elsewhere: { other: "a".repeat(64) } }, metadata: [1, 2] });
    await f.store.save(input());
    assert.deepEqual((await readJSON(f.repositoryFile)).metadata, { owner: "team" });
    await f.store.remove("repository", "first");
    assert.deepEqual((await readJSON(f.repositoryFile)).prompts, [record("second")]);
    const approvals = await readJSON(f.approvalsFile);
    assert.deepEqual(approvals.metadata, [1, 2]);
    assert.deepEqual(approvals.approvals.elsewhere, { other: "a".repeat(64) });
});

test("validation rejects invalid input without writing", async (t) => {
    const f = await fixture(t);
    const invalidInputs = [
        null, [], {}, input("wrong"), input("repository", { id: "../escape" }),
        input("repository", { id: "" }), input("repository", { id: "x".repeat(121) }),
        input("repository", { id: null }), input("repository", { title: " " }),
        input("repository", { title: "x".repeat(121) }), input("repository", { title: 42 }),
        input("repository", { prompt: "" }), input("repository", { prompt: "x".repeat(8001) }),
        input("repository", { prompt: {} }), input("repository", { enabled: "true" }),
        input("repository", { enabled: undefined }), input("repository", { trusted: true }),
    ];
    for (const value of invalidInputs) await assert.rejects(f.store.save(value), errorCode("INVALID_PROMPT"));
    await assert.rejects(f.store.remove("wrong", "first"), errorCode("INVALID_PROMPT"));
    await assert.rejects(f.store.remove("global", "../escape"), errorCode("INVALID_PROMPT"));
    assert.deepEqual(await f.store.list(), []);
});

test("constructor rejects invalid paths and options", () => {
    for (const root of [undefined, null, 12, " "]) assert.throws(() => new CustomPromptStore(root), errorCode("INVALID_PROMPT"));
    for (const options of [null, [], { globalDirectory: "" }, { globalDirectory: 2 }]) {
        assert.throws(() => new CustomPromptStore(".", options), errorCode("INVALID_PROMPT"));
    }
});

test("limits accept boundary lengths and 50 records per scope but reject the 51st", async (t) => {
    const f = await fixture(t);
    for (const scope of ["repository", "global"]) {
        const file = scope === "repository" ? f.repositoryFile : f.globalFile;
        await writeJSON(file, config(Array.from({ length: 50 }, (_, i) => record(`p${i}`))));
        await f.store.save(input(scope, { id: "p0", title: "x".repeat(120), prompt: "x".repeat(8000) }));
        await assert.rejects(f.store.save(input(scope)), errorCode("INVALID_PROMPT"));
        assert.equal((await readJSON(file)).prompts.length, 50);
    }
    assert.equal((await f.store.list()).length, 100);
});

test("malformed JSON and invalid schemas fail explicitly without overwrite in either scope", async (t) => {
    const f = await fixture(t);
    const badConfigs = [
        "{", "null", "[]", JSON.stringify({ version: 2, prompts: [] }),
        JSON.stringify({ version: 1 }), JSON.stringify(config([record(), record()])),
        JSON.stringify(config([record("bad/id")])),
        JSON.stringify(config([record("first", { enabled: 1 })])),
        JSON.stringify(config([record("first", { extra: true })])),
        JSON.stringify(config(Array.from({ length: 51 }, (_, i) => record(`p${i}`)))),
    ];
    for (const [scope, file] of [["repository", f.repositoryFile], ["global", f.globalFile]]) {
        await mkdir(dirname(file), { recursive: true });
        for (const text of badConfigs) {
            await writeFile(file, text);
            await assert.rejects(f.store.list(), errorCode("INVALID_PROMPT_CONFIG"));
            await assert.rejects(f.store.save(input(scope)), errorCode("INVALID_PROMPT_CONFIG"));
            await assert.rejects(f.store.remove(scope, "first"), errorCode("INVALID_PROMPT_CONFIG"));
            assert.equal(await readFile(file, "utf8"), text);
        }
        await rm(file);
    }
});

test("corrupt approvals block repository mutations before overwriting prompts", async (t) => {
    const f = await fixture(t);
    await writeJSON(f.repositoryFile, config([record()]));
    const original = await readFile(f.repositoryFile, "utf8");
    const badApprovals = [
        "{", JSON.stringify({ version: 2, approvals: {} }),
        JSON.stringify({ version: 1, approvals: [] }),
        JSON.stringify({ version: 1, approvals: { repo: { first: "not-a-hash" } } }),
        JSON.stringify({ version: 1, approvals: { repo: { "../id": "a".repeat(64) } } }),
    ];
    await mkdir(f.globalDirectory);
    for (const text of badApprovals) {
        await writeFile(f.approvalsFile, text);
        await assert.rejects(f.store.list(), errorCode("INVALID_PROMPT_CONFIG"));
        await assert.rejects(f.store.save(input()), errorCode("INVALID_PROMPT_CONFIG"));
        await assert.rejects(f.store.remove("repository", "first"), errorCode("INVALID_PROMPT_CONFIG"));
        assert.equal(await readFile(f.repositoryFile, "utf8"), original);
        assert.equal(await readFile(f.approvalsFile, "utf8"), text);
    }
});

test("filesystem errors are public errors and atomic failures clean only their own temporary file", async (t) => {
    const f = await fixture(t);
    await mkdir(f.globalFile, { recursive: true });
    await assert.rejects(f.store.list(), errorCode("PROMPT_IO_ERROR"));
    // Direct atomic-write failure: approvals can be read, but their parent is not writable as a directory.
    await rm(f.globalFile, { recursive: true });
    const blocker = join(f.root, "blocker");
    await writeFile(blocker, "file");
    const blocked = new CustomPromptStore(f.repo, { globalDirectory: join(blocker, "child") });
    await assert.rejects(blocked.save(input("global")), errorCode("PROMPT_LOCK_ERROR"));
    assert.equal(await readFile(blocker, "utf8"), "file");
    assert.deepEqual((await readdir(f.globalDirectory)), []);
});

const moduleURL = new URL("../custom-prompts.mjs", import.meta.url).href;
const hostHash = createHash("sha256").update(hostname()).digest("hex");
const ownerName = (pid, host = hostHash) => `owner-${host}-${pid}-${randomUUID()}`;

function childProcess(t, code) {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    const ready = new Promise((resolve, reject) => {
        child.once("message", resolve);
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`Child exited before ready: ${stderr}`)));
    });
    const done = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolve() :
            reject(new Error(`Child failed (${code ?? signal}): ${stderr}`)));
    });
    // Keep early failures handled until the test awaits the child.
    ready.catch(() => {});
    done.catch(() => {});
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await done.catch(() => {});
    });
    return { child, ready, done };
}

async function createOwner(directory, owner) {
    const lock = join(directory, ".prompts.lock");
    await mkdir(lock, { recursive: true });
    if (owner) await mkdir(join(lock, owner));
    return lock;
}

test("independent stores preserve overlapping global records and same/different repository approvals", async (t) => {
    const f = await fixture(t);
    const stores = [
        f.store, new CustomPromptStore(f.repo, { globalDirectory: f.globalDirectory }), f.other,
    ];
    await Promise.all(stores.flatMap((store, i) => Array.from({ length: 6 }, async (_, j) => {
        await store.save(input("global", { id: `global-${i}-${j}` }));
        await store.save(input("repository", { id: `repo-${i}-${j}` }));
    })));
    const first = await f.store.list();
    const second = await f.other.list();
    assert.equal(first.filter((item) => item.scope === "global").length, 18);
    assert.equal(first.filter((item) => item.scope === "repository").length, 12);
    assert.equal(second.filter((item) => item.scope === "repository").length, 6);
    assert.ok([...first, ...second].every((item) => item.trusted));
    assert.deepEqual(Object.values((await readJSON(f.approvalsFile)).approvals).map((value) => Object.keys(value).length).sort((a, b) => a - b), [6, 12]);
});

test("separate Node processes preserve every global/repository record and approval under overlapping saves", async (t) => {
    const f = await fixture(t);
    const workers = Array.from({ length: 4 }, (_, i) => childProcess(t, `
        import { CustomPromptStore } from ${JSON.stringify(moduleURL)};
        const store = new CustomPromptStore(${JSON.stringify(i === 3 ? f.otherRepo : f.repo)},
            { globalDirectory: ${JSON.stringify(f.globalDirectory)} });
        process.send({ ready: true, pid: process.pid });
        process.once("message", async () => {
            try {
                for (let j = 0; j < 8; j++) {
                    for (const scope of ["global", "repository"]) {
                        await store.save({ scope, id: scope + "-${i}-" + j,
                            title: "Worker ${i}", prompt: "Check bugs", enabled: true });
                    }
                }
                process.disconnect();
            } catch (error) {
                console.error(error);
                process.exit(1);
            }
        });
    `));
    const ready = await Promise.all(workers.map((worker) => worker.ready));
    assert.equal(new Set(ready.map((message) => message.pid)).size, 4);
    for (const worker of workers) worker.child.send("start");
    const results = await Promise.allSettled(workers.map((worker) => worker.done));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const first = await f.store.list();
    const second = await f.other.list();
    assert.equal(first.filter((item) => item.scope === "global").length, 32);
    assert.equal(first.filter((item) => item.scope === "repository").length, 24);
    assert.equal(second.filter((item) => item.scope === "repository").length, 8);
    assert.ok([...first, ...second].every((item) => item.trusted));
    assert.deepEqual(Object.values((await readJSON(f.approvalsFile)).approvals).map((value) => Object.keys(value).length).sort((a, b) => a - b), [8, 24]);
    for (const directory of [f.globalDirectory, dirname(f.repositoryFile), join(f.otherRepo, ".agent-review")]) {
        assert.ok(!(await readdir(directory)).includes(".prompts.lock"));
    }
});

test("repository locks preserve records across stores with different global directories", async (t) => {
    const f = await fixture(t);
    const stores = [f.store, new CustomPromptStore(f.repo, { globalDirectory: join(f.root, "second-global") })];
    await Promise.all(stores.flatMap((store, i) => Array.from({ length: 8 }, (_, j) =>
        store.save(input("repository", { id: `separate-global-${i}-${j}` })))));
    for (const store of stores) {
        const prompts = await store.list();
        assert.equal(prompts.length, 16);
        assert.equal(prompts.filter((item) => item.trusted).length, 8);
    }
});

test("coincident repository/global config directories do not self-deadlock", async (t) => {
    const f = await fixture(t);
    const store = new CustomPromptStore(f.repo, { globalDirectory: dirname(f.repositoryFile) });
    await store.save(input("repository"));
    assert.equal((await store.list()).length, 2);
    assert.equal(await store.remove("repository", "first"), true);
    assert.deepEqual(await store.list(), []);
    assert.ok(!(await readdir(dirname(f.repositoryFile))).includes(".prompts.lock"));
});

test("overlapping removals and saves preserve unrelated records and approval revisions", async (t) => {
    const f = await fixture(t);
    const alternate = new CustomPromptStore(f.repo, { globalDirectory: f.globalDirectory });
    await Promise.all(Array.from({ length: 8 }, (_, i) => f.store.save(input("repository", { id: `old-${i}` }))));
    await Promise.all(Array.from({ length: 8 }, async (_, i) => {
        await alternate.remove("repository", `old-${i}`);
    }).concat(Array.from({ length: 8 }, (_, i) =>
        f.store.save(input("repository", { id: `new-${i}` })))));
    const prompts = await f.store.list();
    assert.equal(prompts.length, 8);
    assert.ok(prompts.every((item) => item.id.startsWith("new-") && item.trusted));
    const approved = Object.values((await readJSON(f.approvalsFile)).approvals)[0];
    assert.deepEqual(Object.keys(approved).sort(), prompts.map((item) => item.id).sort());
});

test("dead local process locks are safely recovered by competing stores", async (t) => {
    const f = await fixture(t);
    const dead = childProcess(t, `process.send({ pid: process.pid }); process.disconnect();`);
    const { pid } = await dead.ready;
    await dead.done;
    assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
    await createOwner(f.globalDirectory, ownerName(pid));
    await createOwner(dirname(f.repositoryFile), ownerName(pid));
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => new CustomPromptStore(f.repo, {
        globalDirectory: f.globalDirectory,
    }).save(input("repository", { id: `recovered-${i}` }))));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const prompts = await f.store.list();
    assert.equal(prompts.length, 10);
    assert.ok(prompts.every((item) => item.trusted));
    assert.ok(!(await readdir(f.globalDirectory)).includes(".prompts.lock"));
    assert.ok(!(await readdir(dirname(f.repositoryFile))).includes(".prompts.lock"));
    assert.ok(!(await readdir(f.globalDirectory)).includes(".prompts.lock.recovery"));
    assert.ok(!(await readdir(dirname(f.repositoryFile))).includes(".prompts.lock.recovery"));
});

test("an unknown recovery gate is never deleted even when the lock owner is dead", async (t) => {
    const f = await fixture(t);
    const dead = childProcess(t, `process.send({ pid: process.pid }); process.disconnect();`);
    const { pid } = await dead.ready;
    await dead.done;
    const owner = ownerName(pid);
    const lock = await createOwner(f.globalDirectory, owner);
    const recovery = `${lock}.recovery`;
    await mkdir(recovery);
    await writeFile(join(recovery, "unrelated"), "preserve");
    await assert.rejects(f.store.save(input("global")), errorCode("PROMPT_LOCK_TIMEOUT"));
    assert.deepEqual(await readdir(lock), [owner]);
    assert.equal(await readFile(join(recovery, "unrelated"), "utf8"), "preserve");
});

test("live process locks time out without eviction and acquired outer locks are released", async (t) => {
    const live = childProcess(t, `process.send({ pid: process.pid }); process.once("message", () => process.disconnect());`);
    const { pid } = await live.ready;
    await Promise.all(["global", "repository"].map(async (scope) => {
        const f = await fixture(t);
        const directory = scope === "global" ? f.globalDirectory : dirname(f.repositoryFile);
        const owner = ownerName(pid);
        const lock = await createOwner(directory, owner);
        const start = Date.now();
        await assert.rejects(f.store.save(input(scope)), errorCode("PROMPT_LOCK_TIMEOUT"));
        assert.ok(Date.now() - start < 4000, "lock wait is bounded");
        assert.deepEqual(await readdir(lock), [owner]);
        assert.deepEqual(await readdir(join(lock, owner)), []);
        if (scope === "repository") assert.ok(!(await readdir(f.globalDirectory)).includes(".prompts.lock"));
        assert.deepEqual(await f.store.list(), []);
    }));
    live.child.send("finish");
    await live.done;
});

test("unknown, foreign-host and incomplete owners are never removed", async (t) => {
    await Promise.all([undefined, "unknown-owner", ownerName(2147483647, "f".repeat(64))].map(async (owner) => {
        const f = await fixture(t);
        const lock = await createOwner(f.globalDirectory, owner);
        await assert.rejects(f.store.save(input("global")), errorCode("PROMPT_LOCK_TIMEOUT"));
        assert.deepEqual(await readdir(lock), owner ? [owner] : []);
    }));
});

test("lock filesystem errors are explicit and do not remove foreign files", async (t) => {
    const f = await fixture(t);
    await mkdir(f.globalDirectory);
    const lock = join(f.globalDirectory, ".prompts.lock");
    await writeFile(lock, "not a lock directory");
    await assert.rejects(f.store.save(input("global")), errorCode("PROMPT_LOCK_ERROR"));
    assert.equal(await readFile(lock, "utf8"), "not a lock directory");
    await rm(lock);
    await f.store.save(input("global"));
    assert.equal((await f.store.list()).length, 1);
});

test("own-lock cleanup refuses to delete a changed owner and reports the failure", async (t) => {
    const f = await fixture(t);
    const originalRead = f.store.readScope.bind(f.store);
    const lock = join(f.globalDirectory, ".prompts.lock");
    f.store.readScope = async (scope) => {
        const [owner] = await readdir(lock);
        await rename(join(lock, owner), join(lock, "unknown-replacement"));
        return originalRead(scope);
    };
    await assert.rejects(f.store.save(input("global")), errorCode("PROMPT_LOCK_ERROR"));
    assert.deepEqual(await readdir(lock), ["unknown-replacement"]);
    assert.deepEqual(await readdir(join(lock, "unknown-replacement")), []);
});

test("failed config validation releases owned locks and allows subsequent saves", async (t) => {
    const f = await fixture(t);
    await writeJSON(f.globalFile, { version: 2, prompts: [] });
    await assert.rejects(f.store.save(input("global")), errorCode("INVALID_PROMPT_CONFIG"));
    assert.deepEqual(await readdir(f.globalDirectory), ["prompts.json"]);
    await writeJSON(f.globalFile, config());
    await f.store.save(input("global"));
    assert.equal((await f.store.list()).length, 1);
});

test("concurrent mutations on a store preserve every saved record and leave no temporary files", async (t) => {
    const f = await fixture(t);
    await mkdir(f.globalDirectory);
    const unrelated = join(f.globalDirectory, ".unrelated.prompts.tmp");
    await writeFile(unrelated, "keep");
    await Promise.all(Array.from({ length: 10 }, (_, i) => f.store.save(input("global", { id: `p${i}` }))));
    assert.equal((await f.store.list()).length, 10);
    await assert.rejects(f.store.save(input("global", { prompt: "" })), errorCode("INVALID_PROMPT"));
    await f.store.save(input("global", { id: "after-error" }));
    assert.equal((await f.store.list()).length, 11);
    assert.deepEqual((await readdir(f.globalDirectory)).sort(), [".unrelated.prompts.tmp", "prompts.json"]);
});
