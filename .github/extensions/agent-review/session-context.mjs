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
    }
    return paths;
}

function toolSummary(event) {
    const data = event.data || {};
    const description = data.arguments?.description;
    return truncate(description || data.toolName || data.mcpToolName || "Tool execution", 180);
}

export function buildSessionContext(events, repoRoot) {
    const timeline = [];
    const files = new Set();
    for (const event of events) {
        if (event.ephemeral) continue;
        if (event.type === "user.message") {
            timeline.push({
                id: `session-event:${event.id}`,
                event_id: event.id,
                role: "user",
                timestamp: event.timestamp,
                agent_id: event.agentId || null,
                summary: truncate(event.data?.content),
            });
        } else if (event.type === "assistant.message" && event.data?.content?.trim()) {
            timeline.push({
                id: `session-event:${event.id}`,
                event_id: event.id,
                role: "assistant",
                timestamp: event.timestamp,
                agent_id: event.agentId || null,
                summary: truncate(event.data.content),
            });
        } else if (event.type === "tool.execution_start") {
            collectPaths(event.data?.arguments, repoRoot, "", files);
            timeline.push({
                id: `session-event:${event.id}`,
                event_id: event.id,
                role: "tool",
                timestamp: event.timestamp,
                agent_id: event.agentId || null,
                tool_name: event.data?.toolName || event.data?.mcpToolName || "tool",
                summary: toolSummary(event),
            });
        }
    }
    const rootIntent = timeline
        .filter((item) => item.role === "user" && !item.agent_id)
        .slice(-12);
    return {
        provenance: "copilot_session_history",
        factual_status: "context_only",
        note: "Session history explains requested intent and agent activity; repository claims still require deterministic ReviewModel evidence.",
        intent: rootIntent,
        recent_activity: timeline.slice(-40),
        referenced_files: [...files].sort(),
        event_count: events.length,
        generated_at: new Date().toISOString(),
        error: null,
    };
}
