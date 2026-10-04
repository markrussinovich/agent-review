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
        const scanEmbeddedPaths = PATH_KEYS.has(key) || /command|script|description/i.test(key);
        for (const line of value.split(/\r?\n/)) {
            const explicit = /(?:\*{3}\s+(?:Add|Update|Delete)\s+File:|^[+-]{3}\s+[ab]\/)\s*(.+)$/i.exec(line.trim());
            if (explicit) {
                const path = repositoryPath(explicit[1].trim(), repoRoot);
                if (path) paths.add(path);
            }
            if (scanEmbeddedPaths) {
                for (const match of line.matchAll(/(?:^|[\s"'`])([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_. -]+)+\.(?:py|toml|txt|json|ya?ml|md|mjs|js|css|html))(?=$|[\s"'`,:])/gi)) {
                    const path = repositoryPath(match[1], repoRoot);
                    if (path) paths.add(path);
                }
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

function toolOperation(event) {
    const name = String(event.data?.toolName || event.data?.mcpToolName || "").toLowerCase();
    const summary = toolSummary(event).toLowerCase();
    if (/apply_patch|write|edit|rename|create|delete/.test(name)) return "write";
    if (/view|read|rg|grep|glob|search|usage/.test(name)) return "read";
    if (/inspect|verify|check|test|analy[sz]e|list|show|find/.test(summary)) return "read";
    if (/create|write|update|modify|apply|generate|implement/.test(summary)) return "write";
    return "unknown";
}

function promptIntentScore(prompt) {
    const text = String(prompt || "").toLowerCase();
    let score = 0;
    if (/\b(create|add|implement|build|generate|write|introduce|replace|remove|refactor|optimi[sz]e|fix)\b/.test(text)) score += 0.18;
    if (/\b(review|inspect|explain|why is|copy button|map.*prompt|canvas|highlight)\b/.test(text)) score -= 0.16;
    return score;
}

function isInternalAgentReviewPrompt(content) {
    const text = String(content || "");
    return text.startsWith("[Agent Review internal request")
        || text.startsWith("Write a concrete system-understanding annotation about")
        || text.startsWith("Write a concise system-oriented code-review annotation")
        || text.startsWith("Write a concise code-review annotation for")
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
                operation: toolOperation(event),
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
        timeline,
        turns,
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
        const matchingActivity = turn.agent_activity.filter((item) => item.referenced_files?.includes(normalized));
        const exact = matchingActivity.length > 0;
        const writes = matchingActivity.filter((item) => item.operation === "write").length;
        const reads = matchingActivity.filter((item) => item.operation === "read").length;
        const searchable = [
            turn.prompt,
            ...turn.agent_activity.map((item) => item.summary),
        ].join(" ").toLowerCase();
        const mentioned = Boolean(basename && searchable.includes(basename));
        if (!exact && !mentioned) continue;
        const confidenceScore = Math.max(0.1, Math.min(
            1,
            (writes ? 0.88 : exact ? 0.65 : 0.38) + promptIntentScore(turn.prompt),
        ));
        results.push({
            turn_id: turn.id,
            session_id: turn.session_id || null,
            session_summary: turn.session_summary || null,
            prompt_event_id: turn.prompt_event_id,
            prompt: turn.prompt,
            started_at: turn.started_at,
            ended_at: turn.ended_at,
            confidence: confidenceScore >= 0.8 ? "likely" : "possible",
            confidence_score: confidenceScore,
            reason: writes
                ? `${normalized} was targeted by visible write/edit activity during this turn.`
                : exact
                    ? `${normalized} was referenced by visible read/inspection activity during this turn.`
                : `${basename} was mentioned in visible prompt or agent activity.`,
            write_activity_count: writes,
            read_activity_count: reads,
            agent_activity: turn.agent_activity.slice(-12),
            referenced_files: turn.referenced_files,
        });
    }
    return results
        .sort((a, b) => b.confidence_score - a.confidence_score || String(b.started_at).localeCompare(String(a.started_at)))
        .slice(0, 3);
}

export function mergeSessionContexts(contexts) {
    const valid = contexts.filter(Boolean);
    const turns = valid
        .flatMap((context) => context.turns || [])
        .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    const intent = valid
        .flatMap((context) => context.intent || [])
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
        .slice(-20);
    const recentActivity = valid
        .flatMap((context) => context.recent_activity || [])
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
        .slice(-80);
    return {
        provenance: "copilot_session_history",
        factual_status: "context_only",
        note: "Attribution correlates visible prompts and file/tool activity across sessions; it does not expose hidden reasoning or prove authorship.",
        intent,
        recent_activity: recentActivity,
        turns,
        referenced_files: [...new Set(valid.flatMap((context) => context.referenced_files || []))].sort(),
        event_count: valid.reduce((total, context) => total + Number(context.event_count || 0), 0),
        session_count: valid.length,
        generated_at: new Date().toISOString(),
        error: null,
    };
}
