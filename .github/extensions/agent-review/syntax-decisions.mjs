// Pair unchanged decisions first, then nearby outcomes with matching values or condition shapes.
export function compareDecisions(before = [], after = []) {
    const key = (entry) => JSON.stringify([entry.outcome, entry.value, entry.when, entry.context]);
    const remaining = before.map((decision, index) => ({ decision, index }));
    const entries = [], unmatched = [];
    after.forEach((decision, index) => {
        const previous = remaining.findIndex((entry) => key(entry.decision) === key(decision));
        if (previous < 0) unmatched.push({ decision, index });
        else {
            const old = remaining.splice(previous, 1)[0];
            entries.push({ status: old.index === index ? "unchanged" : "moved", decision, base: old.decision });
        }
    });
    const shape = (decision) => JSON.stringify([decision.when, decision.context]).replace(/-?\d+(?:\.\d+)?/g, "#");
    const pairs = [];
    for (const old of remaining) for (const next of unmatched) {
        if (old.decision.outcome !== next.decision.outcome) continue;
        const value = old.decision.value === next.decision.value;
        const condition = shape(old.decision) === shape(next.decision);
        if (value || condition) pairs.push({ old, next, score: 2 * Number(value) + Number(condition) });
    }
    pairs.sort((a, b) => b.score - a.score
        || Math.abs(a.old.index - a.next.index) - Math.abs(b.old.index - b.next.index));
    const usedOld = new Set(), usedNew = new Set();
    for (const { old, next } of pairs) {
        if (usedOld.has(old) || usedNew.has(next)) continue;
        usedOld.add(old); usedNew.add(next);
        entries.push({ status: "changed", decision: next.decision, base: old.decision });
    }
    entries.push(...unmatched.filter((entry) => !usedNew.has(entry)).map(({ decision }) => ({ status: "added", decision })));
    entries.push(...remaining.filter((entry) => !usedOld.has(entry)).map(({ decision }) => ({ status: "removed", decision })));
    return entries.sort((a, b) => a.decision.line - b.decision.line || a.decision.column - b.decision.column);
}
