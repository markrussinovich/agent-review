const ACTIONS = {
    empty: "Returns no result",
    false: "Returns False",
    true: "Returns True",
    value: "Returns",
    raise: "Raises",
    reraise: "Re-raises",
    skip: "Skips iteration",
    stop: "Stops loop",
    handled: "Handles error and continues",
    wired: "Wires by name",
};

export const DECISION_STATUSES = ["added", "changed", "moved", "removed"];

export function decisionAction(decision) {
    const verb = ACTIONS[decision.outcome] || decision.outcome;
    const code = decision.outcome === "skip" || decision.outcome === "stop" || decision.outcome === "reraise"
        ? null : decision.value || null;
    return { verb, code, via: decision.via || null };
}

// Conditions in reading order: the decisive test first, then gates and scope.
export function decisionConditions(decision) {
    const parts = [];
    if (decision.on_error) parts.push({ label: "on", tone: "error", code: [decision.on_error] });
    if (decision.when?.length) {
        const label = decision.when_mode === "any" ? "when any of" : decision.when_mode === "all" ? "when all of" : "when";
        parts.push({ label, tone: "when", code: decision.when });
    }
    if (decision.only_if?.length) parts.push({ label: "only if", tone: "gate", code: decision.only_if });
    if (decision.context?.length) parts.push({ label: "within", tone: "scope", code: decision.context });
    if (decision.loop) parts.push({ label: "per", tone: "scope", code: [decision.loop] });
    if (decision.thresholds?.length) parts.push({ label: "threshold", tone: "threshold", code: decision.thresholds });
    return parts;
}

export function decisionSentence(decision) {
    const action = decisionAction(decision);
    let text = action.verb;
    if (action.code) text += ` \`${action.code}\``;
    if (action.via) text += ` via \`${action.via}\``;
    for (const part of decisionConditions(decision)) {
        const joiner = part.label === "when any of" ? " | " : " & ";
        text += ` ${part.label} \`${part.code.join(joiner)}\``;
    }
    return text;
}

export function decisionText(entry, path = null) {
    const decision = entry.decision;
    const location = `${path ? `${path}:` : "line "}${decision.line}`;
    let text = `[${entry.status}] ${decisionSentence(decision)} (${location})`;
    if (entry.status === "changed" && entry.base) text += `; previously: ${decisionSentence(entry.base)} (base line ${entry.base.line})`;
    if (entry.moved) text += "; order changed relative to other decisions";
    if (entry.after) text += `; runs after: ${entry.after.label} (line ${entry.after.line})`;
    if (entry.before) text += `; before: ${entry.before.label} (line ${entry.before.line})`;
    return text;
}

export function callableName(item) {
    return item.qualname || item.id || "callable";
}

export function changedCallables(map) {
    return (map?.callables || []).filter((item) => DECISION_STATUSES.some((status) => item.counts?.[status]));
}

export function decisionTotals(map) {
    const totals = { added: 0, removed: 0, changed: 0, moved: 0, gates: 0 };
    for (const item of map?.callables || []) {
        for (const status of DECISION_STATUSES) totals[status] += item.counts?.[status] || 0;
        totals.gates += (item.entries || []).filter((entry) => entry.status !== "removed" && entry.decision.only_if?.length).length;
    }
    totals.callables = changedCallables(map).length;
    totals.unchanged_callables = (map?.callables || []).length - totals.callables;
    return totals;
}

export function callablesForSubject(map, model, subject) {
    if (!map?.callables?.length || !subject) return [];
    const path = subject.path;
    if (["function", "method"].includes(subject.kind) || ["function", "method"].includes(subject.type)) {
        return map.callables.filter((item) => item.id === subject.id);
    }
    if (subject.kind === "class" || subject.type === "class") {
        const prefix = model?.symbols?.find((symbol) => symbol.id === subject.id)?.qualname;
        return prefix ? map.callables.filter((item) => item.path === path && item.qualname.startsWith(`${prefix}.`)) : [];
    }
    if (path && ["module", "file"].includes(subject.kind || subject.type)) {
        return map.callables.filter((item) => item.path === path);
    }
    return [];
}

export function decisionPromptContext(map, callables = map?.callables || [], { maxCallables = 25, maxEntries = 12, maxCharacters = 9000 } = {}) {
    if (!map || map.status !== "complete") {
        return map?.status === "error" ? { unavailable: map.error } : null;
    }
    let remaining = maxCharacters;
    const items = [];
    let omitted = 0;
    const ranked = [...callables].sort((a, b) =>
        DECISION_STATUSES.reduce((sum, status) => sum + (b.counts?.[status] || 0), 0)
        - DECISION_STATUSES.reduce((sum, status) => sum + (a.counts?.[status] || 0), 0));
    for (const item of ranked) {
        const changes = [];
        for (const entry of (item.entries || []).slice(0, maxEntries)) {
            const text = decisionText(entry);
            if (text.length > remaining) break;
            remaining -= text.length;
            changes.push(text);
        }
        if (items.length >= maxCallables || (!changes.length && item.entries?.length)) {
            omitted += 1;
            continue;
        }
        items.push({
            callable: callableName(item), path: item.path, change: item.change, line: item.line,
            decisions_before: item.decisions_base, decisions_after: item.decisions_current,
            changes: changes.length ? changes : [item.change === "modified"
                ? "no decision changes (same exits, handlers, and wiring)" : "no exits, handlers, or wiring"],
            omitted_changes: Math.max(0, (item.entries?.length || 0) - changes.length) + (item.omitted_entries || 0),
        });
    }
    return {
        note: "Static extraction from saved source: exits, error handlers, and name-based wiring per changed callable, with governing conditions. 'only if' gates apply only when a value is present. It does not prove runtime reachability.",
        limited: Boolean(map.limited) || omitted > 0,
        callables: items,
        omitted_callables: omitted,
    };
}
