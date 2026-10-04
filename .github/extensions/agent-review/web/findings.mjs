export function findingsForNode(model, node, findings) {
    const nodes = new Map(model.nodes.map((item) => [item.id, item]));
    return findings.filter((finding) => {
        const target = nodes.get(finding.node_id);
        return target && (node.id === target.id
            || (node.kind === "module" && target.module_id === node.id)
            || (node.kind === "component" && target.component_id === node.id));
    });
}

export function findingKey(finding) {
    return JSON.stringify([finding.id, [...(finding.evidence_ids || [])].sort(), [...(finding.related_findings || [])].sort()]);
}

export function isFindingClosed(finding, closedKeys) {
    return (finding.members || [finding]).every((item) => closedKeys.has(findingKey(item)));
}

export function orderFindings(findings, closedKeys) {
    return [...findings].sort((a, b) => Number(isFindingClosed(a, closedKeys)) - Number(isFindingClosed(b, closedKeys))
        || (b.impact_score || 0) - (a.impact_score || 0));
}
