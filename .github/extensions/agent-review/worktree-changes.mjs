import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const excludes = JSON.parse(await readFile(new URL("./analyzer/snapshot-excludes.json", import.meta.url), "utf8"));
const inputFiles = [".agent-review.json", ".coverage", "coverage.json", "coverage.xml"];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const matchers = excludes.map((pattern) => ({
    pattern,
    expression: new RegExp(`^${pattern.split("*").map(escape).join(".*")}(?:/.*)?$`),
}));

function excluded(path) {
    const parts = path.split("/");
    return matchers.some(({ pattern, expression }) => parts.includes(pattern) || expression.test(path));
}

async function fileStamp(path) {
    try {
        const value = await stat(path, { bigint: true });
        // Windows ChangeTime can advance on reads, without any content edit.
        return value.isFile() ? [value.size.toString(), value.mtimeNs.toString(), value.birthtimeNs.toString()] : null;
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
    }
}

export async function fingerprintWorktree(repoRoot, { baseRef = null, signal } = {}) {
    const git = async (...args) => (await execute("git", ["-C", repoRoot, ...args], {
        encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, signal,
    })).stdout;
    const refs = ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master",
        "refs/heads/main", "refs/heads/master"];
    if (baseRef) refs.push(baseRef.startsWith("origin/") ? `refs/remotes/${baseRef}` : baseRef,
        `refs/heads/${baseRef}`, `refs/remotes/origin/${baseRef}`);
    const [root, head, bases] = await Promise.all([
        git("rev-parse", "--show-toplevel"),
        git("rev-parse", "HEAD"),
        git("for-each-ref", "--sort=refname", "--format=%(refname) %(objectname)", "--", ...refs),
    ]);
    repoRoot = resolve(root.trimEnd());
    const hash = createHash("sha256").update(head).update(bases);
    const directories = [""];
    while (directories.length) {
        signal?.throwIfAborted();
        const directory = directories.pop();
        let entries;
        try { entries = await readdir(join(repoRoot, directory), { withFileTypes: true }); }
        catch (error) {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
            throw error;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const files = [];
        for (const entry of entries) {
            const path = directory ? `${directory}/${entry.name}` : entry.name;
            if (excluded(path)) continue;
            if (entry.isDirectory()) directories.push(path);
            else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
        }
        for (let offset = 0; offset < files.length; offset += 32) {
            signal?.throwIfAborted();
            const batch = files.slice(offset, offset + 32);
            const stamps = await Promise.all(batch.map((path) => fileStamp(join(repoRoot, ...path.split("/")))));
            stamps.forEach((stamp, index) => {
                if (stamp) hash.update(JSON.stringify([batch[index], ...stamp]));
            });
        }
    }
    for (const path of inputFiles) {
        signal?.throwIfAborted();
        hash.update(JSON.stringify([path, await fileStamp(join(repoRoot, path))]));
    }
    return hash.digest("hex");
}
