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
    propagate: "Propagates error",
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

export function decisionText(entry, path = null, evidence = null) {
    const decision = entry.decision;
    const location = `${path ? `${path}:` : "line "}${decision.line}`;
    let text = `[${entry.status}] ${decisionSentence(decision)} (${location})`;
    if (entry.status === "changed" && entry.base) text += `; previously: ${decisionSentence(entry.base)} (base line ${entry.base.line})`;
    if (entry.moved) text += "; order changed relative to other code paths";
    if (entry.after) text += `; runs after: ${entry.after.label} (line ${entry.after.line})`;
    if (entry.before) text += `; before: ${entry.before.label} (line ${entry.before.line})`;
    if (evidence) text += `; test evidence: ${evidence.text}`;
    return text;
}

export function callableName(item) {
    const name = item.qualname || item.id || "callable";
    return item.language === "csharp" && item.target_framework ? `${name} [${item.target_framework}]` : name;
}

const testName = (id) => String(id).split("::").at(-1);

// Parametrized results (`test_x[case]`, including nested brackets like `test_x[[1, 2]]`) belong to the statically linked `test_x`.
export function baseTestId(id) {
    const text = String(id);
    if (!text.endsWith("]")) return text;
    let depth = 0;
    for (let index = text.length - 1; index >= 0; index--) {
        if (text[index] === "]") depth++;
        else if (text[index] === "[" && --depth === 0) return text.slice(0, index);
    }
    return text;
}

export function sameTest(traceId, linkedId) {
    const base = baseTestId(traceId);
    return base === linkedId || base.endsWith(`/${linkedId}`) || linkedId.endsWith(`/${base}`) || base.endsWith(`::${linkedId}`);
}

const OUTCOME_SEVERITY = ["passed", "skipped", "failed", "error"];

// Worst outcome across every parametrized case of a linked test.
export function linkedTestOutcome(run, linkedId) {
    let worst;
    for (const test of run?.tests || []) {
        if (!sameTest(test.id, linkedId)) continue;
        if (!worst || OUTCOME_SEVERITY.indexOf(test.outcome) > OUTCOME_SEVERITY.indexOf(worst)) worst = test.outcome;
    }
    return worst;
}

// Strongest available evidence for one code path: a linked test run beats static inference.
export function pathEvidence(item, entry, run) {
    if (entry.status === "removed") return null;
    const evidence = entry.evidence || { level: "none", tests: [] };
    const coverage = evidence.coverage ? ` · coverage report: ${evidence.coverage}` : "";
    const key = `${item.id}:${entry.decision.line}`;
    const current = (run?.status === "complete" || (run?.status === "running" && run.executed)) && !run.stale;
    const executed = current ? run.executed?.[key] : undefined;
    if (executed?.length) {
        const passing = executed.filter((test) => test.outcome === "passed");
        const shown = passing[0] || executed[0];
        const more = executed.length > 1 ? ` and ${executed.length - 1} more` : "";
        return passing.length
            ? { level: "confirmed", tone: "confirmed", text: `Confirmed: executed by \`${testName(shown.id)}\`${more} (passed)${coverage}` }
            : { level: "confirmed", tone: "failing", text: `Executed only by ${shown.outcome} test \`${testName(shown.id)}\`${more}${coverage}` };
    }
    const first = evidence.tests?.[0];
    let result;
    if (evidence.level === "asserted" && first) {
        const ambiguous = first.ambiguous ? ` — the same check matches ${countLabel(first.ambiguous, "path")}` : "";
        result = { level: "asserted", tone: "inferred", text: `Asserted (inferred): \`${testName(first.id)}\` checks \`${first.assertion?.text || first.match}\`${ambiguous}` };
    } else if (evidence.level === "exercised" && first) {
        result = { level: "exercised", tone: "inferred", text: `Called by \`${testName(first.id)}\`; this outcome is not asserted (inferred)` };
    } else if (evidence.level === "reachable" && first) {
        result = { level: "reachable", tone: "inferred", text: `Reached via \`${first.via}\` from \`${testName(first.id)}\` (inferred)` };
    } else if (evidence.level === "possible" && first) {
        result = { level: "possible", tone: "weak", text: `Name match only: \`${testName(first.id)}\` (inferred)` };
    } else {
        result = { level: "none", tone: "untested",
            text: evidence.limited ? "No test evidence in incomplete analysis" : "No test evidence" };
    }
    const ran = current ? run.ran?.[item.id] ?? (run.ran ? 0 : run.planned) : 0;
    if (Array.isArray(executed) && ran > 0) {
        result = { level: "not-executed", tone: "untested",
            text: `Not executed by the ${countLabel(ran, "linked test")} that ran · ${result.text}` };
    } else if (current && executed === null && ran > 0) {
        result = { ...result, text: `${result.text} · the run cannot confirm this path because its condition shares the proof line` };
    }
    const more = (evidence.tests?.length || 0) - 1 + (evidence.omitted_tests || 0);
    if (more > 0 && result.level !== "none" && result.level !== "not-executed") result.text += ` · ${more} more linked`;
    result.text += coverage;
    return result;
}

export const EVIDENCE_GROUPS = {
    confirmed: ["confirmed"],
    inferred: ["asserted", "exercised", "reachable", "possible"],
    untested: ["none", "not-executed"],
};

const testPath = (test) => test.path || String(test.id).split("::")[0];

// The slice of a decision map that belongs to one reading layer: its files' callables and the linked tests that reach
// them or are declared in its files. Every language adapter plans from this shape, so a layer can be verified alone.
export function scopeDecisionMap(map, paths) {
    if (!map || map.status !== "complete") return map;
    const inScope = new Set(paths);
    const callables = (map.callables || []).filter((item) => inScope.has(item.path));
    const ids = new Set(callables.map((item) => String(item.id)));
    const names = new Set(callables.map((item) => item.qualname));
    const reaches = (test) => test.callable_ids ? test.callable_ids.some((id) => ids.has(String(id)))
        : (test.callables || []).some((name) => names.has(name));
    const tests = (map.verification?.tests || []).filter((test) => reaches(test) || inScope.has(testPath(test)));
    // A multi-language map narrows to the languages this layer actually contains, so a one-language layer can run.
    const adapters = map.adapter_ids ? [...new Set([...callables, ...tests].map((item) => item.adapter_id).filter(Boolean))] : null;
    return { ...map, callables, verification: map.verification ? { ...map.verification, tests, omitted_tests: 0 } : map.verification,
        ...(adapters ? adapters.length === 1 ? { adapter_ids: undefined, adapter_id: adapters[0] } : { adapter_ids: adapters.length ? adapters : map.adapter_ids } : {}) };
}

// What a run says about one layer: how many of its linked tests ran, and their worst outcomes.
export function layerTestStatus(map, run, paths) {
    if (!map || map.status !== "complete") return { state: map?.status === "loading" ? "loading" : "unavailable", linked: 0 };
    const tests = (scopeDecisionMap(map, paths).verification?.tests || []).filter((test) => test.link !== "name-only");
    if (!tests.length) return { state: "none", linked: 0 };
    const counts = { passed: 0, failed: 0, error: 0, skipped: 0, not_run: 0 };
    const complete = run?.status === "complete" || run?.tests?.length || run?.history?.length;
    for (const test of tests) {
        const outcome = complete ? linkedTestOutcome(run, test.id) : undefined;
        counts[outcome && counts[outcome] !== undefined ? outcome : "not_run"]++;
    }
    const ran = tests.length - counts.not_run;
    const outcome = !ran ? "not-run" : counts.failed || counts.error ? "failing" : counts.not_run ? "partial" : counts.skipped ? "skipped" : "passed";
    const running = run?.status === "running" && (!run.scope || run.scope.paths?.some((path) => paths.includes(path)));
    // While this layer is being run again, the results recorded before the run stay available as `outcome`.
    return { state: running ? "running" : outcome, outcome, linked: tests.length, ran, counts, stale: Boolean(run?.stale && ran) };
}

// Combines a run with earlier results of the same snapshot, so verifying layer after layer accumulates evidence. Every
// earlier result of a test the new run planned is replaced, even when runners name results differently per run.
export function mergeTestRuns(previous, next, planned = []) {
    const rerun = (test) => planned.some((id) => sameTest(test.id, id));
    const tests = new Map((previous.tests || []).filter((test) => !rerun(test)).map((test) => [test.id, test]));
    for (const test of next.tests || []) tests.set(test.id, test);
    const list = [...tests.values()];
    return { ...next, tests: list, executed: { ...(previous.executed || {}), ...(next.executed || {}) },
        ran: { ...(previous.ran || {}), ...(next.ran || {}) },
        ...(next.path_evidence_limitation || previous.path_evidence_limitation
            ? { path_evidence_limitation: next.path_evidence_limitation || previous.path_evidence_limitation } : {}),
        counts: Object.fromEntries(["passed", "failed", "error", "skipped"].map((outcome) => [outcome, list.filter((test) => test.outcome === outcome).length])) };
}

export function evidenceCounts(map, run) {
    const counts = { confirmed: 0, inferred: 0, untested: 0 };
    for (const item of map?.callables || []) {
        for (const entry of item.entries || []) {
            const evidence = pathEvidence(item, entry, run);
            if (!evidence) continue;
            const group = Object.keys(EVIDENCE_GROUPS).find((key) => EVIDENCE_GROUPS[key].includes(evidence.level));
            counts[group] += 1;
        }
    }
    return counts;
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
    if (["function", "method", "property", "accessor", "constructor", "destructor", "operator", "lambda"].includes(subject.kind || subject.type)) {
        return map.callables.filter((item) => item.id === subject.id);
    }
    if (["class", "interface", "struct", "union", "enum", "trait", "record", "namespace", "type"].includes(subject.kind || subject.type)) {
        if (["csharp", "rust", "cpp"].includes(subject.language)) {
            const descendants = new Set([subject.id]);
            let size;
            do {
                size = descendants.size;
                for (const symbol of model?.symbols || []) {
                    if (descendants.has(symbol.parent_id)) descendants.add(symbol.id);
                }
            } while (descendants.size !== size);
            return map.callables.filter((item) => descendants.has(item.id));
        }
        const prefix = model?.symbols?.find((symbol) => symbol.id === subject.id)?.qualname;
        return prefix ? map.callables.filter((item) => item.path === path && item.qualname.startsWith(`${prefix}.`)) : [];
    }
    if (path && ["module", "file"].includes(subject.kind || subject.type)) {
        return map.callables.filter((item) => item.path === path);
    }
    return [];
}

export function decisionPromptContext(map, callables = map?.callables || [], { maxCallables = 25, maxEntries = 12, maxCharacters = 9000, run = null } = {}) {
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
            const text = decisionText(entry, null, map.verification ? pathEvidence(item, entry, run) : null);
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
            incomplete: Boolean(map.limited || map.incomplete || item.incomplete || item.truncated),
            changes: changes.length ? changes : [map.limited || map.incomplete || item.incomplete || item.truncated
                ? "partial code path model; no modelled changes" : item.change === "modified"
                ? "no code path changes (same exits, handlers, and wiring)" : "no exits, handlers, or wiring"],
            omitted_changes: Math.max(0, (item.entries?.length || 0) - changes.length) + (item.omitted_entries || 0),
        });
    }
    return {
        note: "Static extraction from saved source: exits, error handlers, and name-based wiring per changed callable, with governing conditions. 'only if' gates apply only when a value is present. It does not prove runtime reachability.",
        evidence_note: map.verification ? "Test evidence per path: 'Confirmed' means a linked test run executed that line; 'inferred' links come from static analysis of test calls and assertions and are not proof; 'Not executed' means the linked tests ran without reaching it; 'No test evidence' means no resolved test link in the analyzed subset; omitted or unresolved relationships remain unknown." : undefined,
        limited: Boolean(map.limited || map.incomplete || callables.some((item) => item.incomplete || item.truncated)) || omitted > 0,
        callables: items,
        omitted_callables: omitted,
    };
}
import { countLabel } from "./count-format.mjs";
