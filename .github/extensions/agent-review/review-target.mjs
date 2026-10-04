import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

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
