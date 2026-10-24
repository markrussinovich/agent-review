import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const resource = "499b84ac-1321-427f-aa17-267ca6975798";
const shaPattern = /^[a-f0-9]{40}$/i;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const encode = encodeURIComponent;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function segment(value) {
    if (typeof value !== "string" || !value.trim() || value === "." || value === ".."
        || /[/\\?#\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid Azure DevOps URL path.");
    return value;
}

export function parseAdoUrl(value, { repository = false } = {}) {
    let input = String(value || "").trim();
    const ssh = /^(?:git|[\w.-]+)@(ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/(.+)$/i.exec(input);
    if (ssh) input = `ssh://git@${ssh[1]}/v3/${ssh[2]}`;
    let url;
    try { url = new URL(input); } catch { return null; }
    const host = url.hostname.toLowerCase();
    if (host !== "dev.azure.com" && !/^[\w-]+\.visualstudio\.com$/.test(host)
        && host !== "ssh.dev.azure.com" && host !== "vs-ssh.visualstudio.com") return null;
    if (/[\u0000-\u001f\u007f\\]/.test(input)
        || input.split("/").some((part) => /^(?:\.|%2e){1,2}$/i.test(part))) {
        throw new Error("Invalid Azure DevOps URL path.");
    }
    if (url.port || url.password || url.search || url.hash) throw new Error("Use an Azure DevOps URL without credentials, a port, query, or fragment.");
    let parts;
    try { parts = url.pathname.replace(/\/$/, "").split("/").slice(1).map((part) => segment(decodeURIComponent(part))); }
    catch { throw new Error("Invalid Azure DevOps URL path."); }
    if (url.protocol === "ssh:" && repository && ["ssh.dev.azure.com", "vs-ssh.visualstudio.com"].includes(host)) {
        if (parts.length !== 4 || parts[0] !== "v3" || !url.username) throw new Error("Invalid Azure DevOps SSH remote.");
        const [, organization, project, repo] = parts;
        if (!/^[\w-]+$/.test(organization)) throw new Error("Invalid Azure DevOps organization.");
        return { provider: "ado", organization, project, repository: repo, ssh: true };
    }
    if (url.protocol !== "https:" || ["ssh.dev.azure.com", "vs-ssh.visualstudio.com"].includes(host)) {
        throw new Error("Azure DevOps PRs require HTTPS; repository remotes may also use Azure DevOps SSH.");
    }
    const organization = host === "dev.azure.com" ? parts.shift() : host.split(".")[0];
    if (!organization || !/^[\w-]+$/.test(organization)) throw new Error("Invalid Azure DevOps organization.");
    if (parts[0] === "DefaultCollection" && host !== "dev.azure.com") parts.shift();
    if (url.username && (!repository || !same(decodeURIComponent(url.username), organization))) {
        throw new Error("Use an Azure DevOps URL without credentials.");
    }
    const [project, marker, repo, pull, number] = parts;
    if (marker !== "_git" || !project || !repo
        || (repository ? parts.length !== 3 : parts.length !== 5 || pull !== "pullrequest" || !/^[1-9]\d*$/.test(number))) {
        throw new Error("Enter an Azure DevOps PR URL: https://dev.azure.com/organization/project/_git/repository/pullrequest/number.");
    }
    if (!repository && !Number.isSafeInteger(Number(number))) throw new Error("Invalid Azure DevOps PR number.");
    return { provider: "ado", organization, project, repository: repo, ...(!repository ? { number: Number(number) } : {}) };
}

export function adoRepositoryUrl(repo) {
    return `https://dev.azure.com/${encode(repo.organization)}/${encode(repo.project)}/_git/${encode(repo.repository)}`;
}

export function adoGitUrl(repo, ssh = false) {
    return ssh ? `git@ssh.dev.azure.com:v3/${encode(repo.organization)}/${encode(repo.project)}/${encode(repo.repository)}`
        : adoRepositoryUrl(repo);
}

export const adoPrUrl = (repo) => `${adoRepositoryUrl(repo)}/pullrequest/${repo.number}`;
export const adoRepositoryLabel = (repo) => `${repo.organization}/${repo.project}/${repo.repository}`;

export async function azureAccessToken(run = execute) {
    try {
        // Only fixed arguments enter cmd.exe; PR URLs, names, bodies, and tokens never do.
        const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "az";
        const args = process.platform === "win32"
            ? ["/d", "/s", "/c", `az account get-access-token --resource ${resource} --output json --only-show-errors`]
            : ["account", "get-access-token", "--resource", resource, "--output", "json", "--only-show-errors"];
        const { stdout } = await run(command, args, { encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 256 * 1024 });
        const token = JSON.parse(stdout).accessToken;
        if (typeof token !== "string" || !token || /[\s\r\n]/.test(token)) throw new Error("Invalid token.");
        return token;
    } catch {
        throw new Error("Unable to obtain Azure DevOps authorization. Install Azure CLI and run az login in the organization's tenant, then retry. Git credentials are configured separately.");
    }
}

export function createAdoClient({ getToken = azureAccessToken, fetch: fetchApi = fetch } = {}) {
    let token;
    return async (repo, suffix = "", { method = "GET", body, query = {} } = {}) => {
        if (method !== "GET" || body !== undefined) throw new Error("Azure DevOps review access is read-only; publishing is unavailable.");
        const organization = segment(repo.organization);
        if (!/^[\w-]+$/.test(organization)) throw new Error("Invalid Azure DevOps organization.");
        const url = new URL(`https://dev.azure.com/${encode(organization)}/${repo.project ? `${encode(segment(repo.project))}/` : ""}_apis/git/repositories/${encode(segment(repo.repository))}${suffix}`);
        url.search = new URLSearchParams({ "api-version": "7.1", ...query }).toString();
        token ||= getToken();
        let response;
        try {
            response = await fetchApi(url, { method, redirect: "error", signal: AbortSignal.timeout(60_000),
                headers: { Authorization: `Bearer ${await token}`, Accept: "application/json" } });
        } catch {
            throw new Error("Azure DevOps request failed. Check your connection and az login authorization; no automatic retry was made.");
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Azure DevOps returned HTTP ${response.status}. ${
                response.status === 401 || response.status === 403 ? "Check az login, tenant, and repository read permissions."
                    : response.status === 404 ? "Check the organization, project, repository, and PR access." : "Retry the read later; no automatic retry was made."}`);
        }
        let length = 0;
        const chunks = [];
        for await (const chunk of response.body) {
            length += chunk.length;
            if (length > 8 * 1024 * 1024) throw new Error("Azure DevOps response exceeds the 8 MiB limit.");
            chunks.push(chunk);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new Error("Azure DevOps returned invalid JSON."); }
    };
}

function resolvedRepository(record, input) {
    if (!record || !uuidPattern.test(record.id) || !uuidPattern.test(record.project?.id)
        || typeof record.name !== "string" || typeof record.project.name !== "string") {
        throw new Error("Azure DevOps returned an invalid repository identity.");
    }
    const repo = { organization: input.organization, project: segment(record.project.name), repository: segment(record.name),
        projectId: record.project.id, repositoryId: record.id };
    if (input.repository && !same(input.repository, repo.repository) && !same(input.repository, repo.repositoryId)
        || input.project && !same(input.project, repo.project) && !same(input.project, repo.projectId)) {
        throw new Error("Azure DevOps returned a different repository than requested.");
    }
    return repo;
}

function listValue(result) {
    if (!Array.isArray(result?.value)) throw new Error("Azure DevOps returned an invalid list.");
    return result.value;
}

export async function getAdoPullRequest(input, client = createAdoClient()) {
    if (!Number.isSafeInteger(input.number) || input.number < 1) throw new Error("Invalid Azure DevOps PR number.");
    const pr = await client(input, `/pullRequests/${input.number}`);
    if (pr?.pullRequestId !== input.number || !["active", "completed", "abandoned"].includes(pr.status)) {
        throw new Error("Azure DevOps returned invalid PR metadata.");
    }
    const repo = resolvedRepository(pr.repository, input);
    return { pr, repo: { ...repo, number: input.number }, client };
}

export async function listAdoTargets(input, page, client = createAdoClient()) {
    const repo = resolvedRepository(await client(input), input);
    const records = listValue(await client(repo, "/pullRequests", {
        query: { "searchCriteria.status": "all", $skip: String(page * 30), $top: "31" },
    }));
    const items = records.slice(0, 30).map((pr) => {
        if (!Number.isSafeInteger(pr.pullRequestId) || pr.pullRequestId < 1 || !["active", "completed", "abandoned"].includes(pr.status)) {
            throw new Error("Azure DevOps returned invalid PR list data.");
        }
        if (pr.repository) resolvedRepository(pr.repository, repo);
        return { ref: adoPrUrl({ ...repo, number: pr.pullRequestId }), number: pr.pullRequestId,
            title: String(pr.title || ""), author: pr.createdBy?.displayName || "",
            date: pr.closedDate || pr.creationDate, date_kind: pr.closedDate ? "closed" : "created",
            status: pr.status, draft: Boolean(pr.isDraft) };
    });
    return { items, has_more: records.length > 30, page, provider: "ado", repository: adoRepositoryLabel(repo) };
}

export async function readAdoSnapshot(input, client = createAdoClient()) {
    const { pr, repo } = await getAdoPullRequest(input, client);
    if (!pr.supportsIterations || pr.hasMultipleMergeBases) throw new Error("This Azure DevOps PR has unsupported iterations or ambiguous merge bases.");
    const iterations = listValue(await client(repo, `/pullRequests/${repo.number}/iterations`));
    const latest = iterations.reduce((best, item) => Number.isSafeInteger(item.id) && item.id > (best?.id || 0) ? item : best, null);
    const head = latest?.sourceRefCommit?.commitId;
    let target = pr.lastMergeTargetCommit?.commitId || latest?.targetRefCommit?.commitId;
    if (!shaPattern.test(head || "") || (pr.status !== "active" && !shaPattern.test(target || "")) || !shaPattern.test(latest?.commonRefCommit?.commitId || "")
        || ![pr.sourceRefName, pr.targetRefName].every((ref) => typeof ref === "string" && ref.startsWith("refs/heads/") && !/[\s\u0000-\u001f]/.test(ref))) {
        throw new Error("Azure DevOps has not supplied a complete PR snapshot. Wait for the PR update to finish and retry.");
    }
    let sourceRepo = repo;
    if (pr.forkSource) {
        const id = pr.forkSource.repository?.id;
        if (!uuidPattern.test(id || "")) throw new Error("Azure DevOps returned invalid fork metadata.");
        sourceRepo = resolvedRepository(await client({ organization: repo.organization, repository: id }), {
            organization: repo.organization, repository: id,
        });
    }
    if (pr.status === "active") {
        // Target branches can advance without a source iteration or a refreshed merge evaluation.
        for (const [repository, ref, expected] of [[sourceRepo, pr.sourceRefName, head], [repo, pr.targetRefName, null]]) {
            const refs = listValue(await client(repository, "/refs", { query: { filter: ref.slice(5) } }));
            const current = refs.find((item) => item.name === ref)?.objectId;
            if (!shaPattern.test(current || "") || (expected && current !== expected)) {
                throw new Error("The PR branches changed or its iteration is still updating. Refresh the PR list and open the review again.");
            }
            if (!expected) target = current;
        }
    }
    return { pr, repo, sourceRepo, head, target, iteration: latest.id,
        fingerprint: JSON.stringify([repo.organization.toLowerCase(), repo.projectId, repo.repositoryId, repo.number,
            sourceRepo.repositoryId, pr.sourceRefName, pr.targetRefName, latest.id, head, target]) };
}

export async function resolveAdoTarget(repoRoot, input, git, { client = createAdoClient(), remote } = {}) {
    const snapshot = await readAdoSnapshot(input, client);
    const { pr, repo, sourceRepo, head, target, iteration, fingerprint } = snapshot;
    const fetchObject = (repository, sha) => git("fetch", "--no-tags", "--no-recurse-submodules", "--",
        adoGitUrl(repository, Boolean(remote?.ssh)), sha);
    await fetchObject(repo, target);
    await fetchObject(sourceRepo, head);
    const bases = (await git("merge-base", "--all", target, head)).trim().split(/\s+/);
    if (bases.length !== 1 || !shaPattern.test(bases[0])) throw new Error("The ADO PR does not have a single available merge base.");
    const base = bases[0];
    const commits = (await git("log", "-n30", "--format=%H%x00%s%x00%b%x1e", `${base}..${head}`))
        .split("\x1e").map((record) => record.trim()).filter(Boolean);
    let budget = 8000;
    const intent = { kind: "pr", number: repo.number, title: String(pr.title || ""), author: pr.createdBy?.displayName || "",
        body: String(pr.description || "").slice(0, 8000), commits: commits.map((record) => {
            const [sha, subject = "", body = ""] = record.split("\0");
            const bounded = body.trim().slice(0, budget);
            budget -= bounded.length;
            return { sha, subject, body: bounded };
        }) };
    return { mode: "pr", provider: "ado", ref: adoPrUrl(repo), url: adoPrUrl(repo), currentRef: head, baseRef: base,
        label: `ADO PR #${repo.number}: ${intent.title}`, repository: repo, sourceRepository: sourceRepo,
        targetRef: target, sourceBranch: pr.sourceRefName, targetBranch: pr.targetRefName,
        iteration, fingerprint, status: pr.status, draft: Boolean(pr.isDraft), intent };
}
