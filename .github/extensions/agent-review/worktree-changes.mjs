import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const excludes = JSON.parse(await readFile(new URL("./analyzer/snapshot-excludes.json", import.meta.url), "utf8"));
const selfRepositoryMarkers = JSON.parse(await readFile(new URL("./analyzer/self-repository-markers.json", import.meta.url), "utf8"));
const inputFiles = [".agent-review.json", ".coverage", "coverage.json", "coverage.xml",
    "lcov.info", "coverage-final.json", "coverage/lcov.info", "coverage/coverage-final.json", "coverage/sources.json",
    "coverage.out", "cover.out", "coverage.txt", "coverage.sources.json", "coverage.out.sources.json",
    "rust-coverage.json"];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const matchersFor = (excludes) => excludes.map((pattern) => ({
    pattern,
    expression: new RegExp(`^${pattern.split("*").map(escape).join(".*")}(?:/.*)?$`),
}));
const pathspecsFor = (excludes) => excludes.flatMap((pattern) => {
    const prefix = !pattern.includes("/") && !/[*?\[]/.test(pattern) ? "**/" : "";
    return [`:(top,exclude,glob)${prefix}${pattern}`, `:(top,exclude,glob)${prefix}${pattern}/**`];
});

function excluded(path, matchers) {
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
        encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024, signal,
    })).stdout;
    const refs = ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master",
        "refs/heads/main", "refs/heads/master"];
    if (baseRef) refs.push(baseRef.startsWith("origin/") ? `refs/remotes/${baseRef}` : baseRef,
        `refs/heads/${baseRef}`, `refs/remotes/origin/${baseRef}`);
    const [root, head, bases, trackedNames] = await Promise.all([
        git("rev-parse", "--show-toplevel"),
        git("rev-parse", "HEAD"),
        git("for-each-ref", "--sort=refname", "--format=%(refname) %(objectname)", "--", ...refs),
        git("ls-files", "--full-name", "--cached", "-z", "--",
            ...selfRepositoryMarkers.map((path) => `:(top,literal)${path}`)),
    ]);
    repoRoot = resolve(root.trimEnd());
    const tracked = new Set(trackedNames.split("\0"));
    const baseRefs = new Map(bases.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(" ")));
    const candidates = baseRef
        ? [baseRef, `refs/heads/${baseRef}`, `refs/remotes/${baseRef}`, `refs/remotes/origin/${baseRef}`]
        : refs;
    const base = /^[a-f0-9]{40,64}$/i.test(baseRef || "") ? baseRef
        : candidates.map((ref) => baseRefs.get(ref)).find(Boolean);
    let baseline = base;
    if (base) {
        try {
            baseline = (await git("merge-base", head.trim(), base)).trim();
        } catch (error) {
            if (error.code !== 1) throw error;
            // Unrelated histories use the selected base tree, like the analyzer.
        }
    }
    const revisions = new Set([head.trim(), ...(baseline ? [baseline] : [])]);
    const trees = await Promise.all([...revisions].map((ref) =>
        git("ls-tree", "-r", "--name-only", "-z", ref, "--", ...selfRepositoryMarkers)));
    for (const tree of trees) for (const path of tree.split("\0")) tracked.add(path);
    const defaults = selfRepositoryMarkers.every((path) => tracked.has(path))
        ? excludes.filter((pattern) => pattern !== ".github/extensions/agent-review") : excludes;
    const matchers = matchersFor(defaults);
    const pathspecs = pathspecsFor(defaults);
    const names = await git("ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard", "--", ":/", ...pathspecs);
    const hash = createHash("sha256").update(head).update(bases);
    const files = [...new Set(names.split("\0"))].filter((path) => path && !excluded(path, matchers)).sort();
    for (let offset = 0; offset < files.length; offset += 32) {
        signal?.throwIfAborted();
        const batch = files.slice(offset, offset + 32);
        const stamps = await Promise.all(batch.map((path) => fileStamp(join(repoRoot, ...path.split("/")))));
        stamps.forEach((stamp, index) => {
            if (stamp) hash.update(JSON.stringify([batch[index], ...stamp]));
        });
    }
    for (const path of inputFiles) {
        signal?.throwIfAborted();
        hash.update(JSON.stringify([path, await fileStamp(join(repoRoot, path))]));
    }
    return hash.digest("hex");
}
