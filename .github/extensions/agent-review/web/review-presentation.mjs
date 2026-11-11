import { baseTestId, callablesForSubject, evidenceCounts, pathEvidence } from "./decision-map.mjs";
import { summarizeAnalysisWarnings } from "./analysis-limitations.mjs";
import { impactSlice } from "./impact-model.mjs";
import { countLabel } from "./count-format.mjs";

export function internalReviewPresentation(review) {
    const incomplete = review.status !== "complete";
    const coverage = review.coverage;
    const phase = review.status === "running" ? "Review in progress"
        : review.status === "cancelled" ? "Review stopped"
        : review.status === "error" ? "Review failed" : "Partial review";
    return {
        notice: incomplete ? `${phase} — ${coverage
            ? `analyzed ${coverage.completed_files} of ${coverage.total_files} changed files and ${coverage.completed_units} of ${coverage.total_units} evidence units. `
            : ""}Results incomplete; unreviewed evidence or unresolved gaps may hide additional findings. This is not a clean bill of health.` : "",
        empty: incomplete ? "No supported findings so far." : "No supported findings.",
    };
}

export function reviewSignal(item) {
    if (item.verification === "supported") return { label: "AI-supported concern", kind: "ai" };
    if (item.kind === "evidence") return { label: "Saved evidence", kind: "evidence" };
    if (item.id?.startsWith("attention:") || item.related_findings || item.collect_mode) {
        return { label: "Review priority", kind: "priority" };
    }
    return { label: "Review observation", kind: "observation" };
}

export function reviewItemEvidence(model, item, decisionMap = null, run = null) {
    const subject = (model.nodes || []).find((node) => node.id === (item.node_id || item.id));
    const citations = (item.evidence_ids || []).map((id) => model.evidence?.[id])
        .filter((evidence) => evidence?.path && Number.isInteger(evidence.line) && evidence.line > 0);
    const callable = decisionMap?.callables?.find((callable) => callable.id === subject?.id);
    const counts = { confirmed: 0, failing: 0, inferred: 0, unknown: 0 };
    for (const entry of callable?.entries || []) {
        const evidence = pathEvidence(callable, entry, run);
        if (evidence?.level === "confirmed") {
            counts.confirmed++;
            if (evidence.tone === "failing") counts.failing++;
        } else if (["asserted", "exercised", "reachable", "possible"].includes(evidence?.level)) counts.inferred++;
        else counts.unknown++;
    }
    return { subject, citations, counts };
}

export function conciseReviewText(value, limit = 240) {
    const text = String(value ?? "").trim();
    if (text.length <= limit) return text;
    const end = text.lastIndexOf(" ", limit);
    return `${text.slice(0, end > limit / 2 ? end : limit)}…`;
}

export function reviewContext(model, { path, selected, decisionMap, run, annotation } = {}) {
    const subject = model.nodes?.find((node) => node.id === (selected?.node_id || selected?.id) && node.path === path)
        || { id: `file:${path}`, kind: "file", path };
    const packageId = selected?.package_id || selected?.id;
    const seed = model.package_changes?.some((item) => item.id === packageId) ? packageId : subject.id;
    const impact = impactSlice(model, seed);
    const callables = callablesForSubject(decisionMap, model, subject);
    const counts = evidenceCounts({ callables }, run);
    const coverage = model.coverage?.available && model.coverage.changed_lines?.[path];
    const verification = [];
    if (run?.status === "complete" || (run?.status === "running" && run.tests?.length)) {
        const outcomes = ["passed", "failed", "error", "skipped"].filter((key) => run.counts?.[key])
            .map((key) => `${run.counts[key]} ${key}`).join(", ");
        const distinct = new Set((run.tests || []).map((test) => baseTestId(test.id))).size;
        const cases = (run.tests || []).length > distinct ? ` across ${countLabel(distinct, "linked test")} (results count each parametrized case)` : "";
        verification.push(`Repository linked-test results: ${outcomes || "no outcomes recorded"}${cases}${run.stale ? " (stale)" : ""}${
            run.status === "running" ? "; another run is in progress" : ""}. Run outcomes alone do not prove this path executed.`);
    } else verification.push(run?.status === "running" ? "Linked tests are running; no completed result yet."
        : run?.status === "error" ? `Linked-test run failed: ${run.error || "inspect the test output."}`
        : run?.status === "cancelled" ? "Linked-test run was cancelled." : "No linked-test run is recorded for this review.");
    if (counts.confirmed) verification.push(`${countLabel(counts.confirmed, "code path")} with named-test execution evidence; inspect outcomes below.`);
    if (counts.inferred) verification.push(`${countLabel(counts.inferred, "code path")} with static test associations, not execution proof.`);
    if (coverage?.total > 0) verification.push(`Current-side aggregate coverage: ${coverage.covered}/${coverage.total} changed executable lines. Not named-test or per-path proof.`);
    const gaps = [];
    if (counts.untested) gaps.push(`${countLabel(counts.untested, "code path")} without linked-test evidence; inspect the changed conditions.`);
    if (!callables.length) gaps.push("Per-path test evidence is unavailable for this selection.");
    if (run?.stale) gaps.push("The recorded test run predates worktree changes; rerun before relying on its results.");
    if (decisionMap?.status === "error") gaps.push(`Code-path analysis failed: ${decisionMap.error}`);
    // Name what affects this file; repository-wide unlinked library calls are summarized on the Overview, not counted here.
    const notes = summarizeAnalysisWarnings(model.warnings || []);
    const unlinkedHere = notes.byPath.get(path) || 0;
    if (unlinkedHere) gaps.push(`Static analysis could not link ${countLabel(unlinkedHere, "call or import", "calls or imports")} in this file to saved source, usually external libraries; impact through them is unknown.`);
    if (notes.other.length) gaps.push(`${countLabel(notes.other.length, "saved analyzer limitation")} in the change overview.`);
    if (annotation?.source_scope?.current_complete === false || annotation?.source_scope?.base_complete === false
        || annotation?.source_scope?.limits?.omitted_diff_hunks || annotation?.source_scope?.limits?.omitted_related_symbols) {
        gaps.push("The AI explanation used bounded excerpts; ask for a deeper walkthrough to retrieve more saved source.");
    }
    if (impact.gaps.length) gaps.push(impact.gaps[0]);
    const change = model.changes?.find((file) => file.path === path);
    return { change, impact, verification, gaps };
}

export function annotationSections(markdown) {
    const preamble = [], sections = [];
    let current = null, fenced = false;
    for (const line of String(markdown).split(/\r?\n/)) {
        if (/^\s*```/.test(line)) fenced = !fenced;
        const heading = !fenced && /^##[ \t]+(.+)$/.exec(line);
        if (heading) {
            current = { title: heading[1].trim(), lines: [] };
            sections.push(current);
        }
        (current ? current.lines : preamble).push(line);
    }
    return { preamble: preamble.join("\n"), sections: sections.map(({ title, lines }) => ({ title, text: lines.join("\n") })) };
}

export function overviewBlurb(markdown, { full = false } = {}) {
    const section = annotationSections(markdown).sections.find((section) => /^summary$/i.test(section.title));
    if (!section) return "";
    const lines = section.text.split(/\r?\n/).slice(1).map((line) => line.replace(/^[-*]\s+/, "").trim())
        .filter((line) => line && !/no (?:session |originating )?intent (?:was )?supplied/i.test(line));
    return full ? lines.join(" ") : conciseReviewText(lines.slice(0, 2).join(" "), 360);
}

export function reviewCommands(model) {
    const items = [];
    const nodes = new Map((model.nodes || []).map((node) => [node.id, node]));
    for (const finding of model.attention || []) {
        const node = nodes.get(finding.node_id);
        const subject = node?.display_name || node?.name;
        items.push({ ...finding, path: node?.path, title: subject ? `${finding.title}: ${subject}` : finding.title,
            label: reviewSignal(finding).label, rank: 0 });
    }
    for (const change of model.changes || []) if (change.status !== "unchanged") {
        items.push({ id: `file:${change.path}`, kind: "file", title: change.path, path: change.path, label: "Changed file", rank: 1 });
    }
    for (const node of model.nodes || []) if (node.path && ["function", "method", "constructor", "destructor",
        "operator", "lambda", "class", "interface"].includes(node.kind)) {
        const title = node.display_name || node.name;
        // Minified or anonymous symbols have no searchable name.
        if (!/[\p{L}\p{N}_$]/u.test(title || "")) continue;
        items.push({ ...node, title, label: `${node.kind} · ${node.change}`, rank: node.change && node.change !== "unchanged" ? 2 : 3 });
    }
    return items;
}
