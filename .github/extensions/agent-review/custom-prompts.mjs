import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SCOPES = new Set(["repository", "global"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const REVISION = /^[a-f0-9]{64}$/;
const RECORD_FIELDS = new Set(["id", "title", "prompt", "enabled"]);
const LOCK_WAIT_MS = 2000;
const LOCAL_HOST = createHash("sha256").update(hostname()).digest("hex");
const OWNER_NAME = /^owner-([a-f0-9]{64})-([1-9][0-9]*)-([a-f0-9-]{36})$/;

export class CustomPromptError extends Error {
    constructor(message, code, statusCode, cause) {
        super(message, cause ? { cause } : undefined);
        this.name = "CustomPromptError";
        this.code = code;
        this.statusCode = statusCode;
    }
}

function invalid(message) {
    throw new CustomPromptError(message, "INVALID_PROMPT", 400);
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateScope(scope) {
    if (!SCOPES.has(scope)) invalid("Prompt scope must be repository or global.");
}

function validateId(id) {
    if (typeof id !== "string" || !SAFE_ID.test(id)) invalid("Prompt id must be 1–120 safe letters, digits, underscores or hyphens, starting with a letter or digit.");
}

function validateRecord(record) {
    if (!isObject(record) || Object.keys(record).some((key) => !RECORD_FIELDS.has(key))) {
        invalid("A prompt must contain only id, title, prompt and enabled.");
    }
    validateId(record.id);
    if (typeof record.title !== "string" || !record.title.trim() || record.title.length > 120) {
        invalid("Prompt title must be nonempty and at most 120 characters.");
    }
    if (typeof record.prompt !== "string" || !record.prompt.trim() || record.prompt.length > 8000) {
        invalid("Prompt text must be nonempty and at most 8000 characters.");
    }
    if (typeof record.enabled !== "boolean") invalid("Prompt enabled must be a boolean.");
}

function canonicalRecord(record) {
    return { id: record.id, title: record.title, prompt: record.prompt, enabled: record.enabled };
}

function revision(record) {
    return createHash("sha256").update(JSON.stringify(canonicalRecord(record))).digest("hex");
}

function validateConfig(config) {
    if (!isObject(config) || config.version !== 1 || !Array.isArray(config.prompts)) {
        invalid("Expected version 1 with a prompts array.");
    }
    if (config.prompts.length > 50) invalid("Each scope supports at most 50 prompts.");
    const ids = new Set();
    for (const record of config.prompts) {
        validateRecord(record);
        if (ids.has(record.id)) invalid("Prompt ids must be unique within a scope.");
        ids.add(record.id);
    }
}

function validateApprovals(config) {
    if (!isObject(config) || config.version !== 1 || !isObject(config.approvals)) {
        invalid("Expected version 1 with an approvals object.");
    }
    for (const approvals of Object.values(config.approvals)) {
        if (!isObject(approvals)) invalid("Repository approvals must be an object.");
        for (const [id, hash] of Object.entries(approvals)) {
            validateId(id);
            if (typeof hash !== "string" || !REVISION.test(hash)) invalid("Approval revisions must be SHA256 hashes.");
        }
    }
}

async function readConfig(file, label, empty, validate) {
    let text;
    try {
        text = await readFile(file, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") return empty();
        throw new CustomPromptError(`Unable to read ${label}.`, "PROMPT_IO_ERROR", 500, error);
    }
    try {
        const config = JSON.parse(text);
        validate(config);
        return config;
    } catch (error) {
        throw new CustomPromptError(`Invalid ${label}: ${error.message}`, "INVALID_PROMPT_CONFIG", 500, error);
    }
}

async function atomicWrite(file, config, label) {
    const temporary = join(dirname(file), `.${randomUUID()}.prompts.tmp`);
    let created = false;
    try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        created = true;
        const deadline = Date.now() + 500;
        while (true) {
            try {
                await rename(temporary, file);
                break;
            } catch (error) {
                // Windows indexers/readers can briefly deny an otherwise valid rename.
                if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
                    Date.now() >= deadline) throw error;
                await delay(25);
            }
        }
    } catch (error) {
        // Only this operation's temporary file may be removed.
        if (created || error.code !== "EEXIST") {
            try {
                await rm(temporary, { force: true });
            } catch (cleanupError) {
                throw new CustomPromptError(`Unable to write or clean up ${label}.`, "PROMPT_IO_ERROR", 500, new AggregateError([error, cleanupError]));
            }
        }
        throw new CustomPromptError(`Unable to write ${label}.`, "PROMPT_IO_ERROR", 500, error);
    }
}

function lockError(message, cause) {
    return new CustomPromptError(message, "PROMPT_LOCK_ERROR", 500, cause);
}

function transientLockError(error) {
    return process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error.code);
}

async function removeOwnedDirectory(directory, deadline) {
    while (true) {
        try {
            await rmdir(directory);
            return;
        } catch (error) {
            if (!transientLockError(error) || Date.now() >= deadline) throw error;
            await delay(Math.min(10, Math.max(0, deadline - Date.now())));
        }
    }
}

async function releaseLock(lock, owner) {
    // Live owners cannot be reaped, so only this owner may release its lock.
    const deadline = Date.now() + 500;
    await removeOwnedDirectory(join(lock, owner), deadline);
    await removeOwnedDirectory(lock, deadline);
}

async function deadOwner(lock) {
    let names;
    try {
        names = await readdir(lock);
    } catch (error) {
        if (error.code === "ENOENT" || transientLockError(error)) return null;
        throw error;
    }
    if (names.length !== 1) return null;
    const match = OWNER_NAME.exec(names[0]);
    if (!match || match[1] !== LOCAL_HOST) return null;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid > 2147483647) return null;
    try {
        process.kill(pid, 0);
        return null;
    } catch (error) {
        // EPERM and all other failures are unknown owners, not proof of death.
        if (error.code !== "ESRCH") return null;
    }
    return names[0];
}

async function recoverDeadLock(lock, deadline) {
    const owner = await deadOwner(lock);
    if (!owner) return;
    const recovery = `${lock}.recovery`;
    try {
        await mkdir(recovery, { mode: 0o700 });
    } catch (error) {
        if (error.code === "EEXIST" || transientLockError(error)) return;
        throw error;
    }
    try {
        // Windows can let concurrent rmdir calls on a delete-pending marker
        // both succeed. An exclusive recovery gate prevents two reapers from
        // removing the root (or a freshly acquired replacement). Recheck after
        // taking the gate; a stale snapshot never authorizes a deletion.
        if (await deadOwner(lock) !== owner) return;
        await removeOwnedDirectory(join(lock, owner), deadline);
        await removeOwnedDirectory(lock, deadline);
    } finally {
        // Only our successful mkdir authorizes cleanup. An abandoned gate has
        // unknown ownership and must time out, never be evicted on age alone.
        await removeOwnedDirectory(recovery, Date.now() + 500);
    }
}

async function acquireLock(directory, deadline) {
    const lock = join(directory, ".prompts.lock");
    const owner = `owner-${LOCAL_HOST}-${process.pid}-${randomUUID()}`;
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        while (Date.now() < deadline) {
            let acquired = false;
            try {
                await mkdir(lock, { mode: 0o700 });
                acquired = true;
            } catch (error) {
                if (transientLockError(error)) {
                    await delay(Math.min(25, Math.max(0, deadline - Date.now())));
                    continue;
                }
                if (error.code !== "EEXIST") throw error;
            }
            if (acquired) {
                try {
                    // Atomic mkdir publishes the entire owner identity at once.
                    await mkdir(join(lock, owner), { mode: 0o700 });
                } catch (error) {
                    try {
                        await rmdir(lock);
                    } catch (cleanupError) {
                        throw new AggregateError([error, cleanupError], "Unable to initialize or clean up prompt lock.");
                    }
                    throw error;
                }
                return async () => {
                    try {
                        await releaseLock(lock, owner);
                    } catch (error) {
                        throw lockError("Unable to release owned prompt lock.", error);
                    }
                };
            }
            await recoverDeadLock(lock, deadline);
            await delay(Math.min(25 + Math.floor(Math.random() * 25), Math.max(0, deadline - Date.now())));
        }
    } catch (error) {
        throw lockError("Unable to acquire prompt lock.", error);
    }
    throw new CustomPromptError("Timed out waiting for prompt lock; its live or unknown owner was not removed.",
        "PROMPT_LOCK_TIMEOUT", 500);
}

async function withLocks(directories, operation) {
    const releases = [];
    let result;
    let failure;
    try {
        const deadline = Date.now() + LOCK_WAIT_MS;
        const held = new Set();
        for (const directory of directories) {
            let canonical;
            try {
                await mkdir(directory, { recursive: true, mode: 0o700 });
                canonical = await realpath(directory);
            } catch (error) {
                throw lockError("Unable to resolve prompt lock directory.", error);
            }
            const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
            if (held.has(key)) continue;
            releases.push(await acquireLock(canonical, deadline));
            held.add(key);
        }
        result = await operation();
    } catch (error) {
        failure = error;
    }
    for (const release of releases.reverse()) {
        try {
            await release();
        } catch (error) {
            failure = failure ? lockError("Prompt operation and lock cleanup failed.", new AggregateError([failure, error])) : error;
        }
    }
    if (failure) throw failure;
    return result;
}

/**
 * JSON-backed prompts. save({scope, id?, title, prompt, enabled}) is an explicit
 * user approval of that record only; consumers must require enabled && trusted.
 * Methods are asynchronous; remove(scope, id) returns whether a record existed.
 * Mutations take a shared global lock, then a repository lock when needed.
 * Lock contention is bounded to two seconds; live/unknown owners are never evicted.
 */
export class CustomPromptStore {
    constructor(repoRoot, options = {}) {
        if (typeof repoRoot !== "string" || !repoRoot.trim()) invalid("A repository root is required.");
        if (!isObject(options) || (options.globalDirectory !== undefined &&
            (typeof options.globalDirectory !== "string" || !options.globalDirectory.trim()))) {
            invalid("globalDirectory must be a nonempty directory path.");
        }
        this.repoRoot = resolve(repoRoot);
        this.globalDirectory = resolve(options.globalDirectory ?? join(homedir(), ".copilot", "agent-review"));
        this.files = {
            repository: join(this.repoRoot, ".agent-review", "prompts.json"),
            global: join(this.globalDirectory, "prompts.json"),
        };
        this.approvalsFile = join(this.globalDirectory, "prompt-approvals.json");
        this.pending = Promise.resolve();
    }

    async repositoryKey() {
        let path;
        try {
            path = await realpath(this.repoRoot);
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw new CustomPromptError("Unable to resolve repository path.", "PROMPT_IO_ERROR", 500, error);
            }
            path = this.repoRoot;
        }
        return process.platform === "win32" ? path.toLowerCase() : path;
    }

    readScope(scope) {
        return readConfig(this.files[scope], `${scope} prompt configuration`,
            () => ({ version: 1, prompts: [] }), validateConfig);
    }

    readApprovals() {
        return readConfig(this.approvalsFile, "prompt approval configuration",
            () => ({ version: 1, approvals: {} }), validateApprovals);
    }

    serialize(operation) {
        const result = this.pending.then(operation);
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }

    mutate(scope, operation) {
        // Consistent ordering also protects a repository shared by stores with
        // different global directories, without a lock-order cycle.
        const directories = [this.globalDirectory];
        if (scope === "repository") directories.push(dirname(this.files.repository));
        return withLocks(directories, operation);
    }

    list() {
        return this.serialize(async () => {
            const [repository, global, approvals, key] = await Promise.all([
                this.readScope("repository"), this.readScope("global"), this.readApprovals(), this.repositoryKey(),
            ]);
            const approved = Object.hasOwn(approvals.approvals, key) ? approvals.approvals[key] : {};
            return [["repository", repository], ["global", global]].flatMap(([scope, config]) =>
                config.prompts.map((record) => {
                    const hash = revision(record);
                    return { ...canonicalRecord(record), scope,
                        trusted: scope === "global" || (Object.hasOwn(approved, record.id) && approved[record.id] === hash),
                        revision: hash };
                }));
        });
    }

    save(input) {
        return this.serialize(async () => {
            if (!isObject(input) || Object.keys(input).some((key) => key !== "scope" && !RECORD_FIELDS.has(key))) {
                invalid("Save requires scope, optional id, title, prompt and enabled.");
            }
            validateScope(input.scope);
            const record = { id: input.id === undefined ? randomUUID() : input.id,
                title: input.title, prompt: input.prompt, enabled: input.enabled };
            validateRecord(record);
            return this.mutate(input.scope, async () => {
                const config = await this.readScope(input.scope);
                const index = config.prompts.findIndex((item) => item.id === record.id);
                if (index === -1 && config.prompts.length === 50) invalid("Each scope supports at most 50 prompts.");
                const hash = revision(record);
                let approvals;
                if (input.scope === "repository") {
                    approvals = await this.readApprovals();
                    const key = await this.repositoryKey();
                    const existing = Object.hasOwn(approvals.approvals, key) ? approvals.approvals[key] : {};
                    approvals.approvals = { ...approvals.approvals, [key]: { ...existing, [record.id]: hash } };
                }
                if (index === -1) config.prompts.push(record);
                else config.prompts[index] = record;
                await atomicWrite(this.files[input.scope], config, `${input.scope} prompt configuration`);
                // Write approvals second: an interrupted save must fail closed.
                if (approvals) await atomicWrite(this.approvalsFile, approvals, "prompt approval configuration");
                return { ...record, scope: input.scope, trusted: true, revision: hash };
            });
        });
    }

    remove(scope, id) {
        return this.serialize(async () => {
            validateScope(scope);
            validateId(id);
            // Preserve no-op behavior for missing configs without creating directories.
            const initial = await this.readScope(scope);
            if (!initial.prompts.some((record) => record.id === id)) return false;
            return this.mutate(scope, async () => {
                const config = await this.readScope(scope);
                const index = config.prompts.findIndex((record) => record.id === id);
                if (index === -1) return false;
                let approvals;
                if (scope === "repository") {
                    approvals = await this.readApprovals();
                    const key = await this.repositoryKey();
                    if (Object.hasOwn(approvals.approvals, key)) delete approvals.approvals[key][id];
                }
                config.prompts.splice(index, 1);
                await atomicWrite(this.files[scope], config, `${scope} prompt configuration`);
                if (approvals) await atomicWrite(this.approvalsFile, approvals, "prompt approval configuration");
                return true;
            });
        });
    }
}
