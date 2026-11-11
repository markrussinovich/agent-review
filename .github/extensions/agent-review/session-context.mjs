import { posix, win32 } from "node:path";

const MAX_TEXT = 900;
const PATH_KEYS = new Set(["path", "file", "filePath", "resourceUri", "cwd", "workspace"]);

function truncate(value, limit = MAX_TEXT) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function repositoryPath(value, repoRoot) {
    if (typeof value !== "string" || !value.trim()) return null;
    const root = repoRoot.replaceAll("\\", "/");
    const paths = /^(?:[A-Za-z]:\/|\/\/)/.test(root) ? win32 : posix;
    const normalized = value.replaceAll("\\", "/");
    // Drive-relative paths depend on process state, not the saved repository root.
    if (/^[A-Za-z]:(?!\/)/.test(normalized)) return null;
    if (paths === posix && /^(?:[A-Za-z]:|\/\/)/.test(normalized)) return null;
    const candidate = paths.resolve(root, normalized);
    const rel = paths.relative(root, candidate);
    if (rel === ".." || rel.startsWith(`..${paths.sep}`) || paths.isAbsolute(rel)) return null;
    return rel.replaceAll("\\", "/");
}

function collectPaths(value, repoRoot, key = "", paths = new Set()) {
    if (Array.isArray(value)) {
        for (const item of value) collectPaths(item, repoRoot, key, paths);
    } else if (value && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) collectPaths(child, repoRoot, childKey, paths);
    } else if (typeof value === "string") {
        if (
            PATH_KEYS.has(key)
            || (
                /\.(py|toml|txt|json|ya?ml|md|mjs|js|css|html)$/i.test(value.trim())
                && !/\s/.test(value.trim())
            )
        ) {
            const path = repositoryPath(value, repoRoot);
            if (path) paths.add(path);
        }
        const scanEmbeddedPaths = PATH_KEYS.has(key) || /command|script|description/i.test(key);
        for (const line of value.split(/\r?\n/)) {
            const explicit = /(?:\*{3}\s+(?:(?:Add|Update|Delete)\s+File:|Move to:)|^[+-]{3}\s+[ab]\/)\s*(.+)$/i.exec(line.trim());
            if (explicit) {
                const path = repositoryPath(explicit[1].trim(), repoRoot);
                if (path) paths.add(path);
            }
            if (scanEmbeddedPaths) {
                for (const match of line.matchAll(/(?:^|[\s"'`])([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\.(?:py|toml|txt|json|ya?ml|md|mjs|js|css|html))(?=$|[\s"'`,:])/gi)) {
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

function toolDetail(event, repoRoot) {
    const args = event.data?.arguments;
    if (!args || typeof args !== "object") return null;
    const patch = typeof args.patch === "string" ? args.patch : typeof args.input === "string" ? args.input : null;
    if (patch) {
        const edits = [...patch.matchAll(/\*{3}\s+(Add|Update|Delete)\s+File:\s*(.+)/g)]
            .map((match) => `${match[1].toLowerCase()} ${repositoryPath(match[2].trim(), repoRoot) || match[2].trim()}`);
        if (edits.length) return truncate(edits.join(", "), 200);
    }
    const target = [args.path, args.filePath, args.file].find((value) => typeof value === "string" && value.trim());
    const relativeTarget = target ? repositoryPath(target, repoRoot) || target : null;
    const query = [args.pattern, args.query].find((value) => typeof value === "string" && value.trim());
    if (query) return truncate(relativeTarget ? `${query} in ${relativeTarget}` : query, 200);
    if (relativeTarget) return truncate(relativeTarget, 200);
    if (typeof args.command === "string" && args.command.trim()) return truncate(args.command.split(/\r?\n/)[0], 200);
    return null;
}

function toolOperation(event) {
    const name = String(event.data?.toolName || event.data?.mcpToolName || "").toLowerCase();
    const summary = toolSummary(event).toLowerCase();
    if (/(?:^|[._-])(?:apply_patch|write_file|edit_file|create_file|delete_file|rename_file|move_file|write|edit)$/.test(name)) return "write";
    if (/view|read|rg|grep|glob|search|usage/.test(name)) return "read";
    if (/inspect|verify|check|test|analy[sz]e|list|show|find/.test(summary)) return "read";
    return "unknown";
}

function writtenPaths(event, repoRoot) {
    const args = event.data?.arguments || {};
    const patch = typeof args.patch === "string" ? args.patch : typeof args.input === "string" ? args.input : null;
    if (patch) return [...collectPaths({ patch }, repoRoot)].sort();
    return [...collectPaths(Object.fromEntries(Object.entries(args)
        .filter(([key]) => ["path", "file", "filePath", "resourceUri"].includes(key))), repoRoot)].sort();
}

export function isInternalAgentReviewPrompt(content) {
    const text = String(content || "");
    return text.startsWith("[Agent Review internal request")
        || text.startsWith("Write a concrete system-understanding annotation about")
        || text.startsWith("Write a concise system-oriented code-review annotation")
        || text.startsWith("Write a concise code-review annotation for")
        || text.startsWith("Explain the review implications of adding or using Python package")
        || /^\s*(?:[*_`>#-]+\s*)*(?:please\s+)?(?:open|reopen|recover|load)\b[\s\S]{0,160}\bAgent Review\b/i.test(text);
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
                written_files: toolOperation(event) === "write" ? writtenPaths(event, repoRoot) : [],
                summary: toolSummary(event),
                detail: toolDetail(event, repoRoot),
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

export function findSessionAttribution(sessionContext, path, { before = null, authoringOnly = false } = {}) {
    if (!sessionContext || !path) return [];
    const cutoff = before === null ? null : Date.parse(before);
    if (cutoff !== null && !Number.isFinite(cutoff)) throw new Error("Session attribution cutoff must be a valid timestamp.");
    const visibleTurn = (turn) => cutoff === null || Date.parse(turn.started_at) <= cutoff;
    const visibleActivity = (turn) => cutoff === null ? turn.agent_activity
        : turn.agent_activity.filter((item) => Date.parse(item.timestamp) <= cutoff);
    const normalized = path.replaceAll("\\", "/");
    const basename = normalized.split("/").pop()?.toLowerCase();
    const results = [];
    for (const turn of sessionContext.turns || []) {
        if (!visibleTurn(turn)) continue;
        const activity = visibleActivity(turn);
        const matchingActivity = activity.filter((item) => item.referenced_files?.includes(normalized));
        const exact = matchingActivity.length > 0;
        const writes = matchingActivity.filter((item) => item.operation === "write"
            && (item.written_files || item.referenced_files)?.includes(normalized)).length;
        const reads = matchingActivity.filter((item) => item.operation === "read").length;
        const mentioned = Boolean(basename && String(turn.prompt || "").toLowerCase().includes(basename));
        if (!exact && !mentioned) continue;
        if (authoringOnly && !writes) continue;
        const confidenceScore = writes ? 0.88 : exact ? 0.38 : 0.25;
        const original = writes ? (sessionContext.turns || [])
            .filter((candidate) => candidate.session_id === turn.session_id && visibleTurn(candidate)
                && visibleActivity(candidate).some((item) => item.operation === "write"
                    && (item.written_files || item.referenced_files)?.includes(normalized)))
            .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))[0] : null;
        results.push({
            turn_id: turn.id,
            session_id: turn.session_id || null,
            session_summary: turn.session_summary || null,
            prompt_event_id: turn.prompt_event_id,
            prompt: turn.prompt,
            original_prompt: original?.prompt || turn.prompt,
            original_prompt_event_id: original?.prompt_event_id || turn.prompt_event_id,
            original_started_at: original?.started_at || turn.started_at,
            started_at: turn.started_at,
            ended_at: turn.ended_at,
            confidence: confidenceScore >= 0.8 ? "likely" : "possible",
            confidence_score: confidenceScore,
            reason: writes
                ? `${normalized} was targeted by visible write/edit activity during this turn.`
                : exact
                    ? `${normalized} was referenced by visible tool activity; no file edit was observed.`
                    : `${basename} was mentioned in the prompt; no file edit was observed.`,
            write_activity_count: writes,
            read_activity_count: reads,
            review_intent: !writes,
            agent_activity: activity.slice(-12),
            referenced_files: [...new Set(activity.flatMap((item) => item.referenced_files || []))],
        });
    }
    const authoringCandidates = results.filter((item) => item.write_activity_count > 0);
    return (authoringCandidates.length ? authoringCandidates : results)
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
