import { pathEvidence } from "./decision-map.mjs";

const evidenceGroup = (evidence) => evidence?.level === "confirmed"
    ? "confirmed"
    : ["asserted", "exercised", "reachable", "possible"].includes(evidence?.level)
        ? "inferred"
        : "untested";

function nodeChurn(node) {
    return node?.metrics?.lines_changed
        ?? ((node?.metrics?.lines_added || 0) + (node?.metrics?.lines_removed || 0));
}

function nodeCallers(node) {
    return (node?.metrics?.direct_callers || 0) + (node?.metrics?.transitive_callers || 0);
}

function scoreNode(node, staticScore, evidence) {
    const churn = nodeChurn(node);
    const callers = nodeCallers(node);
    const evidenceGap = Math.min(30, evidence.untested * 12 + evidence.inferred * 4);
    const churnWeight = Math.min(10, Math.ceil(Math.log2(churn + 1) * 2));
    const reachWeight = Math.min(12, callers * 3);
    return Math.min(100, (staticScore || 20) + evidenceGap + churnWeight + reachWeight);
}

function evidenceSummary(callable, run) {
    const summary = { confirmed: 0, inferred: 0, untested: 0, entries: [] };
    for (const entry of callable.entries || []) {
        const evidence = pathEvidence(callable, entry, run);
        if (!evidence) continue;
        const group = evidenceGroup(evidence);
        summary[group] += 1;
        summary.entries.push({ entry, evidence, group });
    }
    return summary;
}

function planReasons(node, evidence, findings) {
    const reasons = [];
    const callers = nodeCallers(node);
    const churn = nodeChurn(node);
    if (evidence.untested) reasons.push(`${evidence.untested} untested path${evidence.untested === 1 ? "" : "s"}`);
    if (evidence.inferred) reasons.push(`${evidence.inferred} inferred path${evidence.inferred === 1 ? "" : "s"}`);
    if (callers) reasons.push(`${callers} caller${callers === 1 ? "" : "s"}`);
    if (churn) reasons.push(`${churn} changed line${churn === 1 ? "" : "s"}`);
    for (const finding of findings) {
        if (finding.title && !reasons.includes(finding.title)) reasons.push(finding.title);
    }
    return reasons.slice(0, 4);
}

function preferredEntry(evidence) {
    return evidence.entries.find((item) => item.group === "untested")
        || evidence.entries.find((item) => item.group === "inferred")
        || evidence.entries[0]
        || null;
}

export function buildReviewPlan(model, decisionMap, testRun, findings = []) {
    if (!model) return [];
    const nodes = new Map((model.nodes || []).map((node) => [node.id, node]));
    const findingsByNode = new Map();
    const packageFindings = new Map();
    for (const finding of findings) {
        if (finding.node_id) {
            const items = findingsByNode.get(finding.node_id) || [];
            items.push(finding);
            findingsByNode.set(finding.node_id, items);
        }
        if (finding.package_id) packageFindings.set(finding.package_id, finding);
    }

    const units = [];
    const callableIds = new Set();
    for (const callable of decisionMap?.status === "complete" ? decisionMap.callables || [] : []) {
        const node = nodes.get(callable.id);
        if (!node) continue;
        callableIds.add(callable.id);
        const nodeFindings = findingsByNode.get(callable.id) || [];
        const evidence = evidenceSummary(callable, testRun);
        const staticScore = Math.max(0, ...nodeFindings.map((finding) => finding.impact_score || 0));
        units.push({
            id: `review:${callable.id}`,
            kind: "callable",
            title: callable.qualname || node.display_name || node.name || callable.id,
            path: callable.path || node.path,
            line: callable.line || node.start_line,
            score: scoreNode(node, staticScore, evidence),
            reasons: planReasons(node, evidence, nodeFindings),
            evidence,
            finding: nodeFindings[0] || null,
            node,
            callable,
            preferred: preferredEntry(evidence),
        });
    }

    for (const [nodeId, nodeFindings] of findingsByNode) {
        if (callableIds.has(nodeId)) continue;
        const node = nodes.get(nodeId);
        if (!node) continue;
        const staticScore = Math.max(0, ...nodeFindings.map((finding) => finding.impact_score || 0));
        const evidence = { confirmed: 0, inferred: 0, untested: 0, entries: [] };
        units.push({
            id: `review:${nodeId}`,
            kind: "node",
            title: node.display_name || node.name || nodeId,
            path: node.path,
            line: node.start_line,
            score: scoreNode(node, staticScore, evidence),
            reasons: planReasons(node, evidence, nodeFindings),
            evidence,
            finding: nodeFindings[0],
            node,
        });
    }

    for (const item of model.package_changes || []) {
        const finding = packageFindings.get(item.id);
        const score = finding?.impact_score || (item.change === "added" ? 45 : 35);
        const usageCount = item.usage_locations?.length || 0;
        units.push({
            id: `review:${item.id}`,
            kind: "package",
            title: item.name,
            path: item.declared_current?.[0]?.source || item.declared_base?.[0]?.source,
            score,
            reasons: [
                `${item.change} dependency`,
                usageCount ? `${usageCount} usage location${usageCount === 1 ? "" : "s"}` : "no resolved usage",
            ],
            evidence: { confirmed: 0, inferred: 0, untested: 0, entries: [] },
            finding: finding || null,
            package: item,
        });
    }

    return units.sort((a, b) => b.score - a.score
        || (b.evidence.untested - a.evidence.untested)
        || String(a.path || a.title).localeCompare(String(b.path || b.title)));
}
