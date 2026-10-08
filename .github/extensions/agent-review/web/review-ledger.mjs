export const REVIEW_DISPOSITIONS = [
    ["pending", "Not reviewed"],
    ["reviewed", "Reviewed"],
    ["follow-up", "Needs follow-up"],
    ["accepted", "Accepted risk"],
    ["false-positive", "False positive"],
];

const validDispositions = new Set(REVIEW_DISPOSITIONS.map(([value]) => value));
const completedDispositions = new Set(["reviewed", "accepted", "false-positive"]);

function hashText(hash, text) {
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function reviewSnapshotKey(model, target) {
    const meta = model?.metadata || {};
    let hash = 2166136261;
    const changes = [...(model?.changes || [])].sort((a, b) => a.path.localeCompare(b.path));
    for (const change of changes) {
        const source = model?.source_files?.[change.path] || {};
        hash = hashText(hash, `${change.path}\0${change.status}\0${source.base || ""}\0${source.current || ""}\0`);
    }
    return `agent-review.ledger:${JSON.stringify([
        meta.repo_root,
        meta.base_sha,
        meta.head_sha,
        target?.mode,
        target?.ref || null,
        hash.toString(16).padStart(8, "0"),
    ])}`;
}

export function parseReviewLedger(value) {
    const parsed = value ? JSON.parse(value) : {};
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Saved review ledger is not an object.");
    const entries = new Map();
    for (const [id, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== "object" || !validDispositions.has(entry.disposition)) {
            throw new Error(`Invalid review ledger entry for ${id}.`);
        }
        if (entry.note != null && typeof entry.note !== "string") throw new Error(`Invalid review note for ${id}.`);
        entries.set(id, {
            disposition: entry.disposition,
            note: entry.note || "",
            path: typeof entry.path === "string" ? entry.path : "",
            line: Number.isInteger(entry.line) ? entry.line : null,
            updated_at: typeof entry.updated_at === "string" ? entry.updated_at : null,
        });
    }
    return entries;
}

export function serializeReviewLedger(entries) {
    return JSON.stringify(Object.fromEntries(entries), null, 0);
}

export function reviewProgress(plan, entries) {
    let completed = 0;
    let followUp = 0;
    for (const item of plan) {
        const disposition = entries.get(item.id)?.disposition || "pending";
        if (completedDispositions.has(disposition)) completed += 1;
        if (disposition === "follow-up") followUp += 1;
    }
    return { completed, followUp, total: plan.length };
}

export function nextReviewItem(plan, entries) {
    return plan.find((item) => !entries.has(item.id) || entries.get(item.id).disposition === "pending")
        || plan.find((item) => entries.get(item.id)?.disposition === "follow-up")
        || null;
}

export function isReviewComplete(disposition) {
    return completedDispositions.has(disposition);
}
