import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function listReviewTargets(repoRoot, { mode, page = 0 }, run = execute) {
    if (!Number.isInteger(page) || page < 0 || page > 10_000) throw new Error("Invalid review list page.");
    const invoke = async (command, args) => {
        const result = await run(command, args, { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
        return result.stdout;
    };
    const pageSize = 30;
    if (mode === "commit") {
        const output = await invoke("git", ["-C", repoRoot, "log", `-${pageSize + 1}`, `--skip=${page * pageSize}`,
            "--format=%H%x00%s%x00%an%x00%cI", "-z", "HEAD"]);
        const fields = output.split("\0");
        if (fields.at(-1) === "") fields.pop();
        const items = [];
        for (let index = 0; index < fields.length; index += 4) {
            const [ref, title, author, date] = fields.slice(index, index + 4);
            if (!/^[a-f0-9]{40,64}$/i.test(ref) || date === undefined) throw new Error("Git returned invalid commit list data.");
            items.push({ ref, title, author, date, short_sha: ref.slice(0, 7) });
        }
        return { items: items.slice(0, pageSize), has_more: items.length > pageSize, page };
    }
    if (mode === "pr") {
        let repository;
        try {
            repository = JSON.parse(await invoke("gh", ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
        } catch (error) {
            if (/none of the git remotes|no git remotes/i.test(error.stderr || error.message)) {
                throw new Error("No usable GitHub remote was found. Pull request review requires a GitHub remote matching the gh CLI's host configuration.");
            }
            throw error;
        }
        if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Unable to determine this repository's GitHub remote.");
        const records = JSON.parse(await invoke("gh", ["api",
            `repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=${pageSize}&page=${page + 1}`]));
        if (!Array.isArray(records)) throw new Error("GitHub returned invalid pull request list data.");
        const items = records.map((pr) => {
            if (!Number.isInteger(pr.number) || pr.number < 1
                || pr.html_url !== `https://github.com/${repository}/pull/${pr.number}`) {
                throw new Error("GitHub returned invalid pull request list data.");
            }
            return { ref: pr.html_url, number: pr.number, title: pr.title, author: pr.user?.login,
                date: pr.updated_at, status: pr.merged_at ? "merged" : pr.state };
        });
        return { items, has_more: items.length === pageSize, page, repository };
    }
    throw new Error("Choose Commit or Pull request to list review targets.");
}

export async function resolveReviewTarget(repoRoot, target, run = execute) {
    const invoke = async (command, args) => {
        const result = await run(command, args, { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
        return result.stdout.trim();
    };
    const git = (...args) => invoke("git", ["-C", repoRoot, ...args]);
    const commit = async (ref) => git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
    if (target.mode === "worktree") return { mode: "worktree", label: "Worktree", currentRef: null };
    if (target.mode === "commit") {
        if (!target.ref?.trim() || target.ref.startsWith("-")) throw new Error("Enter a commit SHA or Git revision.");
        const head = await commit(target.ref.trim());
        const parents = (await git("rev-list", "--parents", "-n", "1", head)).split(/\s+/).slice(1);
        const base = parents[0] || null;
        return { mode: "commit", ref: target.ref.trim(), currentRef: head, baseRef: base, label: `Commit ${head.slice(0, 7)}` };
    }
    if (target.mode === "pr") {
        const value = String(target.ref || "").trim();
        if (!/^[1-9]\d*$/.test(value) && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/.test(value)) {
            throw new Error("Enter a GitHub PR number or https://github.com/owner/repo/pull/number URL.");
        }
        const pr = JSON.parse(await invoke("gh", ["pr", "view", value, "--json", "number,title,url,baseRefOid,headRefOid"]));
        if (!/^[a-f0-9]{40}$/i.test(pr.baseRefOid) || !/^[a-f0-9]{40}$/i.test(pr.headRefOid)) {
            throw new Error("GitHub returned invalid PR commit IDs.");
        }
        const repository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/.exec(pr.url)?.[1];
        if (!repository) throw new Error("GitHub returned an invalid PR URL.");
        await git("fetch", "--no-tags", `https://github.com/${repository}.git`, pr.baseRefOid, `refs/pull/${pr.number}/head`);
        const base = await git("merge-base", pr.baseRefOid, pr.headRefOid);
        return { mode: "pr", ref: value, currentRef: pr.headRefOid, baseRef: base, label: `PR #${pr.number}: ${pr.title}`, url: pr.url };
    }
    throw new Error("Unknown review mode.");
}
