import { isTestPath } from "./languages.mjs";

const indexes = new WeakMap();
const relationshipTypes = new Set(["calls", "imports", "inherits", "uses_package"]);

// The analyzer can mark members "modified" when only their file or containing type changed. Impact shows a callable as
// changed only when its own lines changed or it was added/removed; packages, classes and modules keep the analyzer's flag.
const CALLABLE_KINDS = new Set(["function", "method", "constructor", "destructor", "operator", "lambda"]);
function effectiveChange(node, changedPaths) {
    if (node.change !== "modified" || !CALLABLE_KINDS.has(node.kind)) return node.change;
    if (node.path && !changedPaths.has(node.path)) return "unchanged";
    const metrics = node.metrics || {};
    const delta = metrics.lines_changed ?? ((metrics.lines_added ?? 0) + (metrics.lines_removed ?? 0));
    return metrics.lines_changed === undefined && metrics.lines_added === undefined && metrics.lines_removed === undefined
        ? node.change : delta > 0 ? "modified" : "unchanged";
}

function indexFor(model) {
    if (indexes.has(model)) return indexes.get(model);
    const changedPaths = new Set((model.changes || []).filter((change) => change.status !== "unchanged").map((change) => change.path));
    const nodes = new Map((model.nodes || []).map((node) => {
        const change = effectiveChange(node, changedPaths);
        return [node.id, change === node.change ? node : { ...node, change, analyzer_change: node.change }];
    }));
    for (const item of [...model.package_changes || [], ...model.package_dependencies || []]) {
        if (!item.id || nodes.has(item.id)) continue;
        nodes.set(item.id, { ...item, kind: "package", name: item.name, change: item.change || "unchanged",
            path: item.declared_current?.[0]?.source || item.declared_base?.[0]?.source });
    }
    const outgoing = new Map(), incoming = new Map();
    let unsupported = 0;
    for (const edge of model.edges || []) {
        if (!relationshipTypes.has(edge.type)) continue;
        if (!nodes.has(edge.source) || !nodes.has(edge.target)
            || !edge.evidence_ids?.some((id) => model.evidence?.[id])) {
            unsupported++;
            continue;
        }
        for (const [map, id] of [[outgoing, edge.source], [incoming, edge.target]]) {
            const edges = map.get(id) || [];
            edges.push(edge);
            map.set(id, edges);
        }
    }
    const findings = new Map((model.attention || []).map((item) => [item.id, item]));
    const index = { nodes, outgoing, incoming, unsupported, findings };
    indexes.set(model, index);
    return index;
}

export function impactSeeds(model, id) {
    const finding = indexFor(model).findings.get(id);
    const subjectId = finding?.node_id || finding?.package_id || id;
    const node = indexFor(model).nodes.get(subjectId);
    const evidence = model.evidence?.[id];
    if (evidence?.path) {
        const precise = (model.nodes || []).filter((item) => item.path === evidence.path && item.start_line <= evidence.line
            && item.end_line >= evidence.line && CALLABLE_KINDS.has(item.kind))
            .sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line))[0];
        return precise ? [precise.id] : impactSeeds(model, `file:${evidence.path}`);
    }
    const path = subjectId?.startsWith("file:") ? subjectId.slice(5) : node?.kind === "module" ? node.path : null;
    if (path) {
        const callables = (model.nodes || []).filter((item) => item.path === path
            && CALLABLE_KINDS.has(item.kind) && item.change !== "unchanged");
        return callables.length ? callables.map((item) => item.id) : node ? [node.id] : [];
    }
    return node ? [node.id] : [];
}

export function impactSlice(model, id, { depth = 1, direction = "both", maxNodes = 40 } = {}) {
    if (!Number.isInteger(depth) || depth < 1 || depth > 4
        || !["both", "consumers", "dependencies"].includes(direction)
        || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 200) {
        throw new Error("Invalid impact traversal limits.");
    }
    const index = indexFor(model);
    const seeds = impactSeeds(model, id);
    const baseFocus = seeds.some((seed) => index.nodes.get(seed)?.change === "removed");
    const selected = new Map(), edges = new Map(), paths = new Map();
    const omitted = new Set(), boundary = new Set();
    for (const seed of seeds) {
        if (selected.size >= maxNodes) { omitted.add(seed); continue; }
        selected.set(seed, { ...index.nodes.get(seed),
            impact_role: index.nodes.get(seed).change === "unchanged" ? "Selected focus" : "Changed focus" });
        paths.set(seed, []);
    }
    for (const mode of direction === "both" ? ["consumers", "dependencies"] : [direction]) {
        const visited = new Set(seeds);
        let frontier = seeds.filter((seed) => selected.has(seed));
        for (let hop = 0; hop < depth && frontier.length; hop++) {
            const next = [];
            for (const seed of frontier) {
                const relations = (mode === "consumers" ? index.incoming : index.outgoing).get(seed) || [];
                for (const edge of relations) {
                    if (edge.change === "removed" && !baseFocus) continue;
                    const neighborId = mode === "consumers" ? edge.source : edge.target;
                    if (visited.has(neighborId)) continue;
                    visited.add(neighborId);
                    if (!selected.has(neighborId) && selected.size >= maxNodes) { omitted.add(neighborId); continue; }
                    const node = index.nodes.get(neighborId);
                    const role = isTestPath(node.path) ? "Related test"
                        : mode === "consumers" ? "Potential consumer" : "Dependency";
                    if (!selected.has(neighborId)) {
                        selected.set(neighborId, { ...node, impact_role: role });
                        paths.set(neighborId, [...(paths.get(seed) || []), edge.id]);
                    }
                    edges.set(edge.id, edge);
                    next.push(neighborId);
                    if (hop === depth - 1) {
                        const further = (mode === "consumers" ? index.incoming : index.outgoing).get(neighborId) || [];
                        if (further.some((item) => (baseFocus || item.change !== "removed")
                            && !visited.has(mode === "consumers" ? item.source : item.target))) boundary.add(neighborId);
                    }
                }
            }
            frontier = next;
        }
    }
    const gaps = [];
    if (!seeds.length) gaps.push("Select a changed function, file, or finding to explore its impact.");
    else if (!edges.size) {
        const packageNode = [...selected.values()].find((node) => node.kind === "package");
        gaps.push(packageNode ? `No saved usage relationship was established for package ${packageNode.name}. This does not prove the dependency is unused.`
            : "No supported impact path was established for this selection. This does not prove there is no impact.");
    }
    if (omitted.size) gaps.push(`${omitted.size} encountered components are omitted by the ${maxNodes}-component view limit.`);
    if (boundary.size) gaps.push("Additional relationships exist beyond the current depth. Expand one step to inspect them.");
    if (index.unsupported) gaps.push(`${index.unsupported} repository relationships lack resolved endpoints or saved evidence and are not drawn.`);
    // Short edge sentences ("calls · export.py:285") name the relationship and where it is evidenced; dense graphs keep
    // them in tooltips so labels never pile up.
    const verbs = { calls: "calls", imports: "imports", inherits: "inherits", uses_package: "uses" };
    const labelled = [...edges.values()].map((edge) => {
        const evidence = (edge.evidence_ids || []).map((evidenceId) => model.evidence?.[evidenceId]).find((item) => item?.path);
        const where = evidence ? `${evidence.path.split("/").at(-1)}${evidence.line ? `:${evidence.line}` : ""}` : null;
        const sentence = `${edge.change === "removed" ? "formerly " : ""}${verbs[edge.type] || edge.type}${where ? ` · ${where}` : ""}`;
        return { ...edge, sentence, label: edges.size <= 16 ? sentence : null };
    });
    return { seed_ids: seeds, nodes: [...selected.values()], edges: labelled,
        paths: Object.fromEntries(paths), gaps, omitted: omitted.size, boundary: boundary.size,
        counts: Object.fromEntries(["Changed focus", "Selected focus", "Potential consumer", "Dependency", "Related test"]
            .map((role) => [role, [...selected.values()].filter((node) => node.impact_role === role).length])) };
}
