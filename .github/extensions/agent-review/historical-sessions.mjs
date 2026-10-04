import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

import { buildSessionContext } from "./session-context.mjs";

const execFileAsync = promisify(execFile);

function normalizedPath(value) {
    return normalize(resolve(String(value || ""))).toLowerCase();
}

export function sessionMatchesRepository(metadata, repositoryRoots) {
    const candidate = metadata?.context?.gitRoot || metadata?.context?.workingDirectory;
    if (!candidate) return false;
    const path = normalizedPath(candidate);
    return repositoryRoots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

function isUsefulSession(metadata, currentSessionId, repositoryRoots) {
    if (!metadata?.sessionId || metadata.sessionId === currentSessionId) return false;
    const directory = String(metadata.context?.workingDirectory || "").replaceAll("\\", "/").toLowerCase();
    if (directory.endsWith("/canvas-catalog-probe")) return false;
    return sessionMatchesRepository(metadata, repositoryRoots);
}

export async function managedCopilotPath() {
    if (basename(process.execPath).toLowerCase() === "copilot.exe") return process.execPath;
    const root = join(process.env.LOCALAPPDATA || "", "github-copilot-sdk", "cli");
    const versions = await readdir(root, { withFileTypes: true });
    const candidates = versions
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (!candidates.length) throw new Error(`No app-managed Copilot CLI was found under ${root}.`);
    return join(root, candidates[0], "copilot.exe");
}

async function repositoryWorktreeRoots(repoRoot) {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
        windowsHide: true,
    });
    const roots = stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => normalizedPath(line.slice("worktree ".length)));
    roots.push(normalizedPath(repoRoot));
    return [...new Set(roots)];
}

export async function loadHistoricalSessionContexts(repoRoot, currentSessionId, options = {}) {
    const limit = Number.isInteger(options.limit) ? options.limit : 6;
    const cliPath = options.cliPath || await managedCopilotPath();
    const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({
            path: cliPath,
            args: ["--server", "--stdio", "--no-auto-update"],
        }),
        workingDirectory: repoRoot,
        logLevel: "error",
    });
    const contexts = [];
    const failures = [];
    try {
        await client.start();
        const repositoryRoots = await repositoryWorktreeRoots(repoRoot);
        const sessions = (await client.listSessions())
            .filter((metadata) => isUsefulSession(metadata, currentSessionId, repositoryRoots))
            .sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime())
            .slice(0, limit);
        for (const metadata of sessions) {
            let historical;
            try {
                historical = await client.resumeSession(metadata.sessionId, {});
                const context = buildSessionContext(await historical.getEvents(), repoRoot);
                context.session_id = metadata.sessionId;
                context.session_summary = metadata.summary || "Untitled session";
                context.working_directory = metadata.context?.workingDirectory || null;
                for (const turn of context.turns) {
                    turn.session_id = metadata.sessionId;
                    turn.session_summary = context.session_summary;
                }
                contexts.push(context);
            } catch (error) {
                failures.push({ session_id: metadata.sessionId, error: error.message });
            } finally {
                if (historical) await historical.disconnect();
            }
        }
    } finally {
        await client.stop();
    }
    return { contexts, failures };
}
