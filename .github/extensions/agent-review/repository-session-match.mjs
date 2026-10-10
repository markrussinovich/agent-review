import { normalize, resolve, sep } from "node:path";

function normalizedPath(value) {
    return normalize(resolve(String(value || ""))).toLowerCase();
}

export function canonicalRepositoryRemote(value) {
    let remote = String(value || "").trim();
    if (!remote) return null;
    remote = remote.replace(/^git@([^:]+):/, "ssh://git@$1/");
    try {
        const parsed = new URL(remote);
        return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/i, "").toLowerCase()}`;
    } catch {
        return remote.replaceAll("\\", "/").replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
    }
}

export function sessionMatchesRepository(metadata, repositoryRoots) {
    const candidate = metadata?.context?.gitRoot || metadata?.context?.workingDirectory;
    if (!candidate) return false;
    const path = normalizedPath(candidate);
    return repositoryRoots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

async function repositoryRemotes(path, run) {
    try {
        const { stdout } = await run("git", ["-C", path, "remote", "-v"], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 5_000,
        });
        return new Set(stdout.split(/\r?\n/)
            .map((line) => canonicalRepositoryRemote(line.trim().split(/\s+/)[1]))
            .filter(Boolean));
    } catch {
        return new Set();
    }
}

export async function sessionMatchesRepositoryOrRemote(
    metadata, repositoryRoots, repositoryRemoteIds, run,
) {
    if (sessionMatchesRepository(metadata, repositoryRoots)) return true;
    const candidate = metadata?.context?.gitRoot || metadata?.context?.workingDirectory;
    if (!candidate || !repositoryRemoteIds.size) return false;
    const candidateRemotes = await repositoryRemotes(candidate, run);
    return [...candidateRemotes].some((remote) => repositoryRemoteIds.has(remote));
}

export { normalizedPath, repositoryRemotes };
