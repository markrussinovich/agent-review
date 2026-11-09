import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const samples = dirname(fileURLToPath(import.meta.url));
const project = dirname(samples);
export const sampleNames = ["large-repo", "node-demo", "coverage-demo", "dotnet-demo", "cpp-demo"];

function inside(parent, child) {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export async function prepareSample(name, destination) {
    if (!sampleNames.includes(name)) throw new Error(`Unknown sample "${name}". Choose ${sampleNames.join(", ")}.`);
    if (!destination) throw new Error("A new destination directory is required.");
    const repo = resolve(destination);
    if (inside(project, repo)) throw new Error("Create samples outside the Agent Review checkout, not as nested repositories.");
    await mkdir(dirname(repo), { recursive: true });
    if (inside(await realpath(project), join(await realpath(dirname(repo)), basename(repo)))) {
        throw new Error("The destination resolves inside the Agent Review checkout.");
    }
    await mkdir(repo);
    const fixture = join(samples, name);
    const current = join(fixture, "current");
    const committed = name === "large-repo";
    const git = (...args) => execute("git", ["--no-pager", "-C", repo,
        "-c", `core.hooksPath=${join(repo, ".git", "disabled-hooks")}`,
        "-c", "commit.gpgsign=false", ...args], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const commit = (message) => git("commit", "-qm", message, "-m",
        "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>");
    await cp(committed ? current : join(fixture, "baseline"), repo, { recursive: true });
    if (committed) {
        await execute(process.execPath, [join(repo, "tools", "scaffold.mjs"), "--stage", "baseline"],
            { cwd: repo, timeout: 60_000 });
    } else {
        await copyFile(join(fixture, "README.md"), join(repo, "README.md"));
    }
    await copyFile(join(current, ".agent-review.json"), join(repo, ".agent-review.json"));
    await git("init", "--quiet", "--initial-branch=main", "--template=");
    await git("config", "user.name", "Agent Review sample");
    await git("config", "user.email", "sample@example.invalid");
    await git("config", "core.autocrlf", "input");
    await git("add", ".");
    await commit(`Passing ${name} baseline`);
    if (committed) await git("switch", "--quiet", "-c", "large-change");
    await cp(current, repo, { recursive: true });
    await copyFile(join(fixture, "README.md"), join(repo, "README.md"));
    if (committed) {
        await git("add", ".");
        await commit("Large route migration with two intentional boundary regressions");
    }
    return { repository: repo, mode: committed ? "commit" : "worktree",
        baseRef: committed ? "main" : "HEAD", currentRef: committed ? "large-change" : null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        if (process.argv.length !== 4) {
            throw new Error(`Usage: node test-repos\\prepare.mjs <${sampleNames.join("|")}> <new-directory>`);
        }
        const result = await prepareSample(process.argv[2], process.argv[3]);
        console.log(JSON.stringify(result, null, 2));
        console.log("No dependencies installed, tests executed, remotes configured, or extension settings changed.");
        console.log("Open this directory with Agent Review's Change repository control; see its README.md.");
    } catch (error) {
        console.error(error.message);
        console.error("Existing destinations are never overwritten. If setup failed partway through, inspect it and choose a new destination.");
        process.exitCode = 1;
    }
}
