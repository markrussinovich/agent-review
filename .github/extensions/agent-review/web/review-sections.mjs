import { isTestPath } from "./languages.mjs";

// Sections describe source relationships, never the boundaries of model requests.
export function reviewSections(model, observations = []) {
    const changed = (model.changes || []).filter((change) => change.status !== "unchanged");
    const paths = new Set(changed.map((change) => change.path));
    const nodes = new Map((model.nodes || []).map((node) => [node.id, node]));
    const callables = (model.nodes || []).filter((node) => paths.has(node.path)
        && node.change !== "unchanged" && !isTestPath(node.path)
        && ["function", "method", "constructor", "destructor", "operator", "lambda", "class", "interface"].includes(node.kind));
    const changedIds = new Set(callables.map((node) => node.id));
    const incoming = new Map(), outgoing = new Map();
    const edges = (model.edges || []).filter((edge) => ["calls", "inherits", "imports"].includes(edge.type)
        && edge.evidence_ids?.some((id) => model.evidence?.[id]));
    for (const edge of edges) {
        const callers = incoming.get(edge.target) || [];
        callers.push(edge.source);
        incoming.set(edge.target, callers);
        const dependencies = outgoing.get(edge.source) || [];
        dependencies.push(edge.target);
        outgoing.set(edge.source, dependencies);
    }
    for (const node of callables) if (changedIds.has(node.parent_id)) {
        incoming.set(node.parent_id, [...incoming.get(node.parent_id) || [], node.id]);
        outgoing.set(node.id, [...outgoing.get(node.id) || [], node.parent_id]);
    }
    const ordered = [...callables].sort((a, b) => {
        const aDepends = (outgoing.get(a.id) || []).filter((id) => changedIds.has(id)).length;
        const bDepends = (outgoing.get(b.id) || []).filter((id) => changedIds.has(id)).length;
        return aDepends - bDepends || a.path.localeCompare(b.path) || (a.start_line || 0) - (b.start_line || 0);
    });
    const assigned = new Set(), sections = [];
    const owner = new Map();
    for (const seed of ordered) {
        if (assigned.has(seed.id)) continue;
        const members = [seed], pending = [seed.id], seen = new Set([seed.id]);
        assigned.add(seed.id);
        for (let position = 0; position < pending.length; position++) {
            for (const id of incoming.get(pending[position]) || []) {
                if (seen.has(id)) continue;
                seen.add(id);
                const caller = nodes.get(id);
                if (!caller || !changedIds.has(id) || assigned.has(id)) continue;
                assigned.add(id);
                members.push(caller);
                pending.push(id);
            }
        }
        const section = {
            id: `section:${seed.id}`, subject_id: seed.id,
            title: `Change ${seed.display_name || seed.name}`,
            kind: "behavior", ranges: members.map((node) => ({
                path: node.path, line: node.start_line || 1, end_line: node.end_line || node.start_line || 1,
                side: node.change === "removed" ? "base" : "current", symbol_id: node.id, name: node.name,
            })), depends_on: [], tests: [],
        };
        for (const member of members) {
            owner.set(member.id, section.id);
            for (const id of incoming.get(member.id) || []) {
                const test = nodes.get(id);
                if (test?.path && isTestPath(test.path) && !section.tests.some((item) => item.id === id)) section.tests.push(test);
            }
        }
        sections.push(section);
    }
    const consumed = new Set();
    for (const removed of sections.filter((section) => nodes.get(section.subject_id)?.change === "removed")) {
        const before = nodes.get(removed.subject_id);
        const replacement = sections.find((section) => {
            const after = nodes.get(section.subject_id);
            if (after?.change !== "added" || before.path !== after.path) return false;
            return [...String(model.source_files?.[before.path]?.diff || "")
                .matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
                .some((hunk) => before.start_line >= Number(hunk[1]) && before.start_line < Number(hunk[1]) + Number(hunk[2] ?? 1)
                    && after.start_line >= Number(hunk[3]) && after.start_line < Number(hunk[3]) + Number(hunk[4] ?? 1));
        });
        if (!replacement) continue;
        replacement.ranges.push(...removed.ranges);
        for (const range of removed.ranges) if (range.symbol_id) owner.set(range.symbol_id, replacement.id);
        for (const test of removed.tests) if (!replacement.tests.some((item) => item.id === test.id)) replacement.tests.push(test);
        replacement.grouping = "Removed and added callables share the same saved edit hunk; identity equivalence is not assumed";
        consumed.add(removed.id);
    }
    for (let index = sections.length - 1; index >= 0; index--) if (consumed.has(sections[index].id)) sections.splice(index, 1);
    const symbols = new Map((model.symbols || []).map((symbol) => [symbol.id, symbol]));
    const cohorts = new Map(), coalesced = [];
    for (const section of sections) {
        const symbol = symbols.get(section.subject_id);
        const dependencies = [...new Set(outgoing.get(section.subject_id) || [])].sort();
        const key = section.ranges.length === 1 && symbol?.normalized_ast_hash && dependencies.length
            ? JSON.stringify([symbol.kind, symbol.name, symbol.normalized_ast_hash, dependencies]) : null;
        const cohort = key ? cohorts.get(key) : null;
        if (cohort) {
            cohort.ranges.push(...section.ranges);
            for (const range of section.ranges) owner.set(range.symbol_id, cohort.id);
            for (const test of section.tests) if (!cohort.tests.some((item) => item.id === test.id)) cohort.tests.push(test);
            cohort.title = `Update ${symbol.name} across ${cohort.ranges.length} implementations`;
            cohort.grouping = "Identical analyzed implementation and shared source dependencies";
        } else {
            coalesced.push(section);
            if (key) cohorts.set(key, section);
        }
    }
    sections.splice(0, sections.length, ...coalesced);
    for (const section of sections) {
        const dependencies = new Set();
        for (const range of section.ranges) for (const id of outgoing.get(range.symbol_id) || []) {
            if (owner.has(id) && owner.get(id) !== section.id) dependencies.add(owner.get(id));
        }
        section.depends_on = [...dependencies];
        const matching = observations.filter((observation) => observation.citations?.some((citation) =>
            section.ranges.some((range) => range.path === citation.path && range.side === citation.side
                && citation.line >= range.line && citation.line <= range.end_line)));
        section.summary = matching[0]?.claim || "Review this changed contract and its source-linked consumers. Behavioral interpretation is not available yet.";
        section.summary_citations = matching[0]?.citations || [];
    }
    const assignedPaths = new Set(sections.flatMap((section) => section.ranges.map((range) => range.path)));
    const importsByPath = new Map();
    for (const edge of edges.filter((edge) => edge.type === "imports")) {
        const source = nodes.get(edge.source)?.path, target = nodes.get(edge.target)?.path;
        if (!source || !target || source === target) continue;
        for (const [path, other] of [[source, target], [target, source]]) {
            const relations = importsByPath.get(path) || [];
            relations.push({ other, evidence_ids: edge.evidence_ids });
            importsByPath.set(path, relations);
        }
    }
    const sectionsById = new Map(sections.map((section) => [section.id, section]));
    for (let pass = 0; pass < 2; pass++) {
        const ownersByPath = new Map();
        for (const section of sections) for (const range of section.ranges) {
            const owners = ownersByPath.get(range.path) || new Set();
            owners.add(section.id);
            ownersByPath.set(range.path, owners);
        }
        for (const change of changed) {
            if (assignedPaths.has(change.path)) continue;
            const related = new Set();
            const evidence = new Set();
            for (const relation of importsByPath.get(change.path) || []) {
                for (const id of ownersByPath.get(relation.other) || []) related.add(id);
                for (const id of relation.evidence_ids) evidence.add(id);
            }
            if (related.size !== 1) continue;
            const section = sectionsById.get([...related][0]);
            section.ranges.push({ path: change.path, line: 1, end_line: change.current_lines || change.baseline_lines || 1,
                side: change.status === "deleted" ? "base" : "current", relationship_evidence: [...evidence] });
            if (isTestPath(change.path) && !section.tests.some((test) => test.path === change.path)) {
                section.tests.push({ id: `file:${change.path}`, path: change.path, start_line: 1,
                    name: change.path, relationship: "module import, not execution" });
            }
            assignedPaths.add(change.path);
        }
    }
    for (const change of changed) {
        if (assignedPaths.has(change.path)) continue;
        const test = isTestPath(change.path);
        const linked = test && sections.find((section) => section.tests.some((item) => item.path === change.path));
        if (linked) {
            linked.ranges.push({ path: change.path, line: 1, end_line: change.current_lines || 1,
                side: change.status === "deleted" ? "base" : "current" });
            continue;
        }
        sections.push({ id: `section:file:${change.path}`, subject_id: `file:${change.path}`,
            title: `${test ? "Test changes" : /\.(?:md|txt)$/.test(change.path) ? "Documentation" : "Supporting change"}: ${change.path}`,
            kind: "supporting", summary: "No supported behavioral relationship established for this file; inspect it independently.",
            summary_citations: [], depends_on: [], tests: [],
            ranges: [{ path: change.path, line: 1, end_line: change.current_lines || change.baseline_lines || 1,
                side: change.status === "deleted" ? "base" : "current" }] });
    }
    const result = [], visiting = new Set(), visited = new Set();
    const byId = new Map(sections.map((section) => [section.id, section]));
    const visit = (section) => {
        if (visited.has(section.id)) return;
        if (visiting.has(section.id)) {
            section.cyclic = true;
            return;
        }
        visiting.add(section.id);
        for (const dependency of section.depends_on) if (byId.has(dependency)) visit(byId.get(dependency));
        visiting.delete(section.id);
        visited.add(section.id);
        result.push(section);
    };
    sections.forEach(visit);
    return result.map((section, index) => ({ ...section, number: index + 1 }));
}
