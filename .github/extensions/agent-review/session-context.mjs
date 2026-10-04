import { isAbsolute, relative, resolve } from "node:path";

const MAX_TEXT = 900;
const PATH_KEYS = new Set(["path", "file", "filePath", "resourceUri", "cwd", "workspace"]);

function truncate(value, limit = MAX_TEXT) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function repositoryPath(value, repoRoot) {
    if (typeof value !== "string" || !value.trim()) return null;
    const normalized = value.replaceAll("/", "\\");
    const candidate = isAbsolute(normalized) ? resolve(normalized) : resolve(repoRoot, normalized);
    const rel = relative(repoRoot, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.replaceAll("\\", "/");
}

function collectPaths(value, repoRoot, key = "", paths = new Set()) {
    if (Array.isArray(value)) {
        for (const item of value) collectPaths(item, repoRoot, key, paths);
    } else if (value && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) collectPaths(child, repoRoot, childKey, paths);
    } else if (typeof value === "string") {
        if (PATH_KEYS.has(key) || /\.(py|toml|txt|json|ya?ml|md|mjs|js|css|html)$/i.test(value)) {
            const path = repositoryPath(value, repoRoot);
            if (path) paths.add(path);
        }
        for (const line of value.split(/\r?\n/)) {
            const explicit = /(?:\*{3}\s+(?:Add|Update|Delete)\s+File:|^[+-]{3}\s+[ab]\/)\s*(.+)$/i.exec(line.trim());
            if (explicit) {
                const path = repositoryPath(explicit[1].trim(), repoRoot);
                if (path) paths.add(path);
            }
            for (const match of line.matchAll(/(?:^|[\s"'`])([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_. -]+)+\.(?:py|toml|txt|json|ya?ml|md|mjs|js|css|html))(?=$|[\s"'`,:])/gi)) {
                const path = repositoryPath(match[1], repoRoot);
                if (path) paths.add(path);
            }
        }
    }
    return paths;
}

function toolSummary(event) {
    const data = event.data || {};
    const description = data.arguments?.description;
    return truncate(description || data.toolName || data.mcpToolName || "Tool execution", 180);
}

function isInternalAgentReviewPrompt(content) {
    const text = String(content || "");
    return text.startsWith("[Agent Review internal request")
        || text.startsWith("Write a concrete system-understanding annotation about")
        || text.startsWith("Write a concise system-oriented code-review annotation")
        || text.startsWith("Explain the review implications of adding or using Python package");
}

export function buildSessionContext(events, repoRoot) {
    const timeline = [];
    const files = new Set();
    const turns = [];
    let currentTurn = null;
    let ignoringInternalTurn = false;
    for (const event of events) {
        if (event.ephemeral) continue;
        if (event.type === "user.message") {
            if (!event.agentId && isInternalAgentReviewPrompt(event.data?.content)) {
                currentTurn = null;
                ignoringInternalTurn = true;
                continue;
            }
            if (ignoringInternalTurn && event.agentId) continue;
            if (!event.agentId) ignoringInternalTurn = false;
            const entry = {
                id: `session-event:${event.id}`,
                event_id: event.id,
                role: "user",
                timestamp: event.timestamp,
                agent_id: event.agentId || null,
                summary: truncate(event.data?.content),
            };
            timeline.push(entry);
            if (!event.agentId) {
                if (currentTurn) currentTurn.ended_at = event.timestamp;
                currentTurn = {
                    id: `session-turn:${event.id}`,
                    prompt_event_id: event.id,
                    prompt: entry.summary,
                    started_at: event.timestamp,
                    ended_at: null,
                    referenced_files: [],
                    agent_activity: [],
                };
                turns.push(currentTurn);
            } else if (currentTurn) {
                currentTurn.agent_activity.push(entry);
            }
        } else if (event.type === "assistant.message" && event.data?.content?.trim()) {
            if (ignoringInternalTurn) continue;
            const entry = {
                id: `session-event:${event.id}`,
                event_id: event.id,
                role: "assistant",
                timestamp: event.timestamp,
                agent_id: event.agentId || null,
                summary: truncate(event.data.content),
            };
            timeline.push(entry);
            if (currentTurn) currentTurn.agent_activity.push(entry);
        } else if (event.type === "tool.execution_start") {
            if (ignoringInternalTurn) continue;
            const eventFiles = collectPaths(event.data?.arguments, repoRoot);
            for (const path of eventFiles) files.add(path);
            const entry = {
                id: `session-event:${event.id}`,
                event_id: event.id,
                role: "tool",
                timestamp: event.timestamp,
                agent_id: event.agentId || null,
                tool_name: event.data?.toolName || event.data?.mcpToolName || "tool",
                summary: toolSummary(event),
                referenced_files: [...eventFiles].sort(),
            };
            timeline.push(entry);
            if (currentTurn) {
                currentTurn.agent_activity.push(entry);
                currentTurn.referenced_files = [...new Set([
                    ...currentTurn.referenced_files,
                    ...entry.referenced_files,
                ])].sort();
            }
        }
    }
    if (currentTurn) currentTurn.ended_at = timeline.at(-1)?.timestamp || currentTurn.started_at;
    const rootIntent = timeline
        .filter((item) => item.role === "user" && !item.agent_id)
        .slice(-12);
    return {
        provenance: "copilot_session_history",
        factual_status: "context_only",
        note: "Session history explains requested intent and agent activity; repository claims still require deterministic ReviewModel evidence.",
        intent: rootIntent,
        recent_activity: timeline.slice(-40),
        turns: turns.slice(-30),
        referenced_files: [...files].sort(),
        event_count: events.length,
        generated_at: new Date().toISOString(),
        error: null,
    };
}

export function findSessionAttribution(sessionContext, path) {
    if (!sessionContext || !path) return [];
    const normalized = path.replaceAll("\\", "/");
    const basename = normalized.split("/").pop()?.toLowerCase();
    const results = [];
    for (const turn of sessionContext.turns || []) {
        const exact = turn.referenced_files.includes(normalized);
        const searchable = [
            turn.prompt,
            ...turn.agent_activity.map((item) => item.summary),
        ].join(" ").toLowerCase();
        const mentioned = Boolean(basename && searchable.includes(basename));
        if (!exact && !mentioned) continue;
        results.push({
            turn_id: turn.id,
            prompt_event_id: turn.prompt_event_id,
            prompt: turn.prompt,
            started_at: turn.started_at,
            ended_at: turn.ended_at,
            confidence: exact ? "likely" : "possible",
            confidence_score: exact ? 0.9 : 0.45,
            reason: exact
                ? `${normalized} was referenced by agent tool activity during this turn.`
                : `${basename} was mentioned in visible prompt or agent activity.`,
            agent_activity: turn.agent_activity.slice(-12),
            referenced_files: turn.referenced_files,
        });
    }
    return results
        .sort((a, b) => b.confidence_score - a.confidence_score || String(b.started_at).localeCompare(String(a.started_at)))
        .slice(0, 3);
}
