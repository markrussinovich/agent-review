import { isTestPath } from "./languages.mjs";

const GENERIC_SEGMENTS = new Set(["src", "source", "sources", "lib", "app", "main", "java", "kotlin", "scala", "python", "js", "ts"]);
const CONTAINER_SEGMENTS = new Set(["packages", "modules", "apps", "libs", "crates", "projects", "plugins"]);
// Foundation-first tie-break when real dependency edges do not order two layers.
const TIERS = [
    [/^(models?|schemas?|types?|entities|data|domain|contracts?)$/i, 0, "Data model"],
    [/^(core|kernel|common|shared|base)$/i, 1, "Core"],
    [/^(utils?|utilities|helpers?|support)$/i, 2, "Utilities"],
    [/^(services?|adapters?|providers?|clients?|integrations?)$/i, 3, "Services"],
    [/^(api|routes?|controllers?|handlers?|server|backend|endpoints?|cli|commands?)$/i, 4, "Backend"],
    [/^(components?|ui|views?|pages?|screens?|web|web-ui|frontend|client|widgets?|templates?)$/i, 5, "User interface"],
];
const humanize = (value) => {
    const text = String(value || "").replace(/[-_]+/g, " ").trim();
    return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
};
const basename = (path) => path.split("/").at(-1);
const stem = (path) => basename(path).replace(/\.(?:test|spec)(?=\.)/i, "").replace(/^test_|_test(?=\.)/i, "").replace(/\.[^.]+$/, "").toLowerCase();
// Qualified symbols keep their last two segments so namespaces do not crowd the rail.
const shortSymbol = (name) => {
    const paren = name.indexOf("(");
    const head = paren >= 0 ? name.slice(0, paren) : name;
    const parts = head.split(".");
    return parts.length > 2 ? `${parts.slice(-2).join(".")}${paren >= 0 ? name.slice(paren) : ""}` : name;
};
const symbolName = (section) => shortSymbol(section.kind === "behavior" && section.title?.startsWith("Change ") ? section.title.slice(7) : section.title);

function areaParts(path) {
    const directories = path.split("/").slice(0, -1);
    const meaningful = directories.filter((segment) => !GENERIC_SEGMENTS.has(segment.toLowerCase()));
    if (!meaningful.length) return { component: "", sub: "", root: directories[0] || "" };
    const container = CONTAINER_SEGMENTS.has(meaningful[0].toLowerCase()) && meaningful.length > 1;
    const component = container ? `${meaningful[0]}/${meaningful[1]}` : meaningful[0];
    return { component, sub: meaningful[container ? 2 : 1] || "", root: directories[0] || "" };
}

function commonDirectory(paths) {
    if (!paths.length) return "";
    const split = paths.map((path) => path.split("/").slice(0, -1));
    const prefix = [];
    for (let index = 0; split.every((parts) => index < parts.length && parts[index] === split[0][index]); index++) prefix.push(split[0][index]);
    return prefix.length ? `${prefix.join("/")}/` : "";
}

function tierFor(area) {
    // Only the area's own last segment names a layer by tier; domain words (scheduling, refchecker) keep their name.
    const last = area.split("/").at(-1);
    const tier = TIERS.find(([pattern]) => pattern.test(last));
    if (tier) return { rank: tier[1], label: tier[2] };
    for (const segment of area.split("/").reverse()) {
        const outer = TIERS.find(([pattern]) => pattern.test(segment));
        if (outer) return { rank: outer[1], label: null };
    }
    return { rank: 3.5, label: null };
}

// Layers read a change as areas of code (foundations first), each file appearing once beside its tests and consumers.
export function workspaceNavigation(model, data) {
    const files = (model?.changes || []).filter((change) => change.status !== "unchanged");
    const byPath = new Map(files.map((file) => [file.path, file]));
    const sections = (data?.sections || []).filter((section) => section.ranges?.some((range) => byPath.has(range.path)));
    const behavior = sections.filter((section) => section.kind === "behavior");
    const groups = [];
    const groupBySection = new Map();
    const groupByPrimary = new Map();
    for (const section of behavior) {
        const cohort = /^Identical analyzed implementation/.test(section.grouping || "");
        const subject = section.ranges.find((range) => range.symbol_id === section.subject_id) || section.ranges[0];
        const primaries = cohort ? [...new Set(section.ranges.filter((range) => range.symbol_id && !isTestPath(range.path))
            .map((range) => range.path))].filter((path) => byPath.has(path)) : [subject.path].filter((path) => byPath.has(path));
        if (!primaries.length) continue;
        let group = !cohort && groupByPrimary.get(primaries[0]);
        if (!group) {
            group = { id: cohort ? section.id : `group:file:${primaries[0]}`, cohort, primaries, sections: [], files: [], roles: new Map(),
                related: [], order: section.number ?? groups.length };
            groups.push(group);
            if (!cohort) groupByPrimary.set(primaries[0], group);
        }
        group.sections.push(section);
        groupBySection.set(section.id, group);
    }
    const owner = new Map();
    const assign = (path, group, role) => {
        if (owner.has(path) || !byPath.has(path)) return;
        owner.set(path, group);
        group.files.push(byPath.get(path));
        group.roles.set(path, role);
    };
    const supporting = { id: "workspace:supporting", cohort: false, primaries: [], sections: [], files: [], roles: new Map(),
        related: [], order: Infinity, supporting: true };
    // Built bundles and minified files stay reviewable, but never lead or join the reading path.
    for (const file of files) if (file.generated) assign(file.path, supporting, "generated");
    for (const group of groups) for (const path of group.primaries) assign(path, group, "changed");
    for (const section of behavior) {
        const group = groupBySection.get(section.id);
        if (!group) continue;
        for (const test of section.tests || []) if (test.path) assign(test.path, group, "test");
        for (const range of section.ranges) {
            assign(range.path, group, isTestPath(range.path) ? "test" : range.symbol_id ? "consumer" : range.relationship_evidence ? "import-linked" : "related");
        }
    }
    const relations = data?.file_relations || [];
    // Attach tests by what they import or call in this change before falling back to name similarity.
    for (const file of files) {
        if (owner.has(file.path) || !isTestPath(file.path)) continue;
        const scores = new Map();
        for (const relation of relations) {
            const home = relation.from === file.path && owner.get(relation.to);
            if (!home) continue;
            const score = scores.get(home) || { count: 0, line: Infinity };
            score.count++;
            score.line = Math.min(score.line, relation.line || Infinity);
            scores.set(home, score);
        }
        const best = [...scores].sort((a, b) => b[1].count - a[1].count || a[1].line - b[1].line)[0];
        if (best) assign(file.path, best[0], "test");
    }
    const symbolGroups = groups.map((group) => ({ group, names: new Set([
        ...group.files.filter((file) => !isTestPath(file.path)).map((file) => stem(file.path)),
        ...group.sections.map((section) => symbolName(section).replace(/\(.*$/, "").split(".").at(-1).toLowerCase())]) }));
    for (const file of files) {
        if (owner.has(file.path)) continue;
        const name = stem(file.path).replace(/^test_?/, "");
        // Exact stem matches first; containment only for distinctive names to avoid accidental links.
        const match = isTestPath(file.path) && (symbolGroups.find(({ names }) => names.has(name) || names.has(name.split(".")[0]))
            || symbolGroups.find(({ names }) => [...names].some((candidate) => candidate.length >= 6 && name.includes(candidate))));
        if (match) assign(file.path, match.group, "name-matched test");
        else assign(file.path, supporting, isTestPath(file.path) ? "unlinked test" : "supporting");
    }
    for (const section of behavior) {
        const group = groupBySection.get(section.id);
        for (const path of new Set(section.ranges.map((range) => range.path))) {
            const home = owner.get(path);
            if (group && home && home !== group && !group.related.some((item) => item.path === path)) group.related.push({ path, group: home.id });
        }
    }
    const roleOrder = { changed: 0, consumer: 1, "import-linked": 2, related: 3, test: 4, "name-matched test": 5, "unlinked test": 6, supporting: 7, generated: 8 };
    const callable = new Set(["function", "method", "constructor", "destructor", "operator", "lambda", "class", "interface"]);
    const changedSymbols = (path) => (model?.nodes || [])
        .filter((node) => node.path === path && node.change && node.change !== "unchanged" && callable.has(node.kind))
        .sort((a, b) => ((b.metrics?.lines_added || 0) + (b.metrics?.lines_removed || 0)) - ((a.metrics?.lines_added || 0) + (a.metrics?.lines_removed || 0)))
        .map((node) => shortSymbol(node.display_name || node.name || ""));
    for (const group of [...groups, supporting]) {
        group.files.sort((a, b) => roleOrder[group.roles.get(a.path)] - roleOrder[group.roles.get(b.path)]);
        const members = new Set(group.files.map((file) => file.path));
        const ranges = group.sections.flatMap((section) => section.ranges).filter((range) => members.has(range.path));
        for (const file of group.files) if (!ranges.some((range) => range.path === file.path)) {
            ranges.push({ path: file.path, line: 1, end_line: file.current_lines || file.baseline_lines || 1,
                side: file.status === "deleted" || file.status === "removed" ? "base" : "current" });
        }
        const fromModel = group.primaries.length === 1 ? changedSymbols(group.primaries[0]) : [];
        const candidates = [...new Set(fromModel.length ? fromModel : group.sections.map(symbolName))].filter(Boolean);
        // "PDFProcessor, PDFProcessor.create_local_file_paper" reads as a repeat; keep the more specific member.
        const names = candidates.filter((name) => !candidates.some((other) => other !== name && other.startsWith(`${name.replace(/\(.*$/, "")}.`)));
        group.title = group.supporting ? (groups.length ? "Supporting files" : "Changed files")
            : group.cohort ? group.sections[0].title : basename(group.primaries[0]);
        group.subtitle = group.cohort || group.supporting ? "" : `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`;
        group.symbols = group.cohort || group.supporting ? [] : names;
        group.label = group.subtitle ? `${group.title} — ${group.subtitle}` : group.title;
        group.tree = Boolean(group.cohort || group.supporting);
        group.section = group.supporting ? null : { id: group.id, title: group.label, kind: "behavior", ranges,
            summary: group.sections[0]?.summary, subject_id: group.sections[0]?.subject_id };
    }
    const layered = groups.filter((group) => group.files.length);
    const layers = buildLayers(layered, relations, (path) => owner.get(path));
    if (supporting.files.length) {
        layers.push({ id: "layer:supporting", name: layered.length ? "Supporting files" : "Changed files",
            path: "", groups: [supporting], dependsOn: [], supporting: true });
    }
    let number = 0;
    for (const layer of layers) {
        layer.number = layer.supporting && layers.length > 1 ? null : ++number;
        for (const group of layer.groups) group.layer = layer.id;
        const symbols = layer.groups.flatMap((group) => group.cohort ? [group.title] : group.symbols || []);
        const fileCount = layer.groups.reduce((sum, group) => sum + group.files.length, 0);
        // Deterministic description shown until (or instead of) an AI intent line.
        layer.summary = layer.supporting ? `${fileCount} ${fileCount === 1 ? "file" : "files"} without a source relationship to the layers above`
            : symbols.length ? `Changes ${symbols.slice(0, 3).join(", ")}${symbols.length > 3 ? ` and ${symbols.length - 3} more` : ""}` : "";
    }
    for (const layer of layers) {
        layer.dependsOn = layer.dependsOn.map(({ id, example }) => {
            const target = layers.find((item) => item.id === id);
            return target && { number: target.number, name: target.name, example };
        }).filter(Boolean).sort((a, b) => a.number - b.number);
    }
    return { files, groups: layers.flatMap((layer) => layer.groups), layers };
}

function buildLayers(groups, relations, ownerOf) {
    if (!groups.length) return [];
    const groupArea = (group) => {
        const parts = group.primaries.map(areaParts);
        if (parts.every((part) => part.component === parts[0].component)) return parts[0];
        const segments = parts.map((part) => part.component.split("/"));
        const shared = [];
        for (let index = 0; segments.every((items) => items[index] && items[index] === segments[0][index]); index++) shared.push(segments[0][index]);
        return { component: shared.join("/"), sub: "", root: parts[0].root };
    };
    let areas = new Map();
    for (const group of groups) {
        const area = groupArea(group);
        group.area = area;
        const entry = areas.get(area.component) || { key: area.component, groups: [], root: area.root };
        entry.groups.push(group);
        areas.set(area.component, entry);
    }
    const fileCount = (entry) => entry.groups.reduce((sum, group) => sum + group.files.length, 0);
    // Split a large area into its sub-areas when each has real weight.
    for (const entry of [...areas.values()]) {
        const bySub = new Map();
        for (const group of entry.groups) bySub.set(group.area.sub, [...bySub.get(group.area.sub) || [], group]);
        const heavy = [...bySub.entries()].filter(([sub, items]) => sub && items.reduce((sum, group) => sum + group.files.length, 0) >= 2);
        if (fileCount(entry) <= 6 || heavy.length < 2) continue;
        areas.delete(entry.key);
        for (const [sub, items] of bySub) {
            const key = sub ? `${entry.key}/${sub}` : entry.key;
            areas.set(key, { key, groups: [...areas.get(key)?.groups || [], ...items], root: entry.root });
        }
    }
    // Merge small sibling areas so a few one-file areas do not each become a layer.
    if (areas.size > 3) {
        const byRoot = new Map();
        for (const entry of areas.values()) if (fileCount(entry) <= 2 && entry.root) byRoot.set(entry.root, [...byRoot.get(entry.root) || [], entry]);
        for (const [root, entries] of byRoot) {
            if (entries.length < 2) continue;
            for (const entry of entries) areas.delete(entry.key);
            areas.set(`merged:${root}`, { key: `merged:${root}`, merged: entries.map((entry) => entry.key), root,
                groups: entries.flatMap((entry) => entry.groups) });
        }
    }
    const entries = [...areas.values()];
    const entryOfGroup = new Map(entries.flatMap((entry) => entry.groups.map((group) => [group, entry])));
    const dependsOn = new Map(entries.map((entry) => [entry.key, new Map()]));
    const groupDepends = new Map(groups.map((group) => [group, new Set()]));
    for (const relation of relations) {
        const from = ownerOf(relation.from), to = ownerOf(relation.to);
        if (!from || !to || from === to || !entryOfGroup.has(from) || !entryOfGroup.has(to)) continue;
        // Tests depend on what they exercise but never order code areas.
        if (isTestPath(relation.from)) continue;
        groupDepends.get(from).add(to);
        const a = entryOfGroup.get(from), b = entryOfGroup.get(to);
        if (a !== b && !dependsOn.get(a.key).has(b.key)) {
            const tail = (path) => path.split("/").slice(-2).join("/");
            dependsOn.get(a.key).set(b.key, `${tail(relation.from)} ${relation.kind === "call" ? "calls" : "imports"} ${tail(relation.to)}`);
        }
    }
    for (const entry of entries) {
        const tier = tierFor(entry.merged ? entry.merged[0] : entry.key);
        entry.rank = tier.rank;
        entry.tier = tier.label;
        entry.first = Math.min(...entry.groups.map((group) => group.order));
        entry.groups = topological(entry.groups, (group) => [...groupDepends.get(group)].filter((other) => entry.groups.includes(other)),
            (a, b) => a.order - b.order);
    }
    // Keep connected stacks together (ordered by their earliest review group); foundations first within a stack.
    const cluster = new Map(entries.map((entry) => [entry.key, entry.key]));
    const find = (key) => cluster.get(key) === key ? key : find(cluster.get(key));
    for (const [key, targets] of dependsOn) for (const target of targets.keys()) cluster.set(find(key), find(target));
    const clusterFirst = new Map();
    for (const entry of entries) clusterFirst.set(find(entry.key), Math.min(clusterFirst.get(find(entry.key)) ?? Infinity, entry.first));
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    const ordered = topological(entries, (entry) => [...dependsOn.get(entry.key).keys()].map((key) => byKey.get(key)),
        (a, b) => clusterFirst.get(find(a.key)) - clusterFirst.get(find(b.key)) || a.rank - b.rank || a.first - b.first);
    const labels = ordered.map((entry) => entry.merged
        ? humanize(entry.merged.map((key) => key.split("/").at(-1)).slice(0, 3).join(", ")) + (entry.merged.length > 3 ? ` +${entry.merged.length - 3}` : "")
        : entry.tier || humanize(entry.key.split("/").at(-1)) || humanize(stem(entry.groups[0].primaries[0])));
    return ordered.map((entry, index) => {
        const duplicate = labels.filter((label) => label === labels[index]).length > 1;
        const component = entry.key.split("/").at(0);
        return { id: `layer:${entry.key || "root"}`, name: duplicate && !entry.merged ? `${labels[index]} · ${humanize(component)}` : labels[index],
            path: commonDirectory(entry.groups.flatMap((group) => group.primaries)) || "/", groups: entry.groups,
            dependsOn: [...dependsOn.get(entry.key)].map(([key, example]) => ({ id: `layer:${key || "root"}`, example })) };
    });
}

// Dependencies first; in a cycle, the item with the fewest unmet dependencies goes first; ties use the supplied order.
function topological(items, dependencies, compare) {
    const ordered = [];
    const remaining = new Set(items);
    const unmet = (item) => dependencies(item).filter((other) => remaining.has(other) && other !== item).length;
    while (remaining.size) {
        const candidates = [...remaining];
        const fewest = Math.min(...candidates.map(unmet));
        const next = candidates.filter((item) => unmet(item) === fewest).sort(compare)[0];
        ordered.push(next);
        remaining.delete(next);
    }
    return ordered;
}
export function groupForSource(navigation, source, preferred = null) {
    const owns = (group) => group.files.some((file) => file.path === source?.path);
    const existing = navigation.groups.find((group) => group.id === preferred && owns(group));
    const matches = (group) => owns(group) && (!group.section || group.section.ranges.some((range) => range.path === source?.path
        && range.side === (source.focus_side || "current") && source.start_line >= range.line && source.start_line <= range.end_line));
    if (Number.isInteger(source?.start_line) && source.start_line > 0) {
        // Every changed file has one owning group, so a line outside its symbol ranges still belongs there.
        return existing && matches(existing) ? existing : navigation.groups.find(matches) || existing || navigation.groups.find(owns) || null;
    }
    return existing || navigation.groups.find(owns) || null;
}

export function fileTree(files) {
    const root = { directories: new Map(), files: [] };
    for (const file of files) {
        const parts = file.path.split("/");
        let node = root, prefix = "";
        for (const part of parts.slice(0, -1)) {
            prefix = prefix ? `${prefix}/${part}` : part;
            if (!node.directories.has(part)) node.directories.set(part, { name: part, path: prefix, directories: new Map(), files: [] });
            node = node.directories.get(part);
        }
        node.files.push(file);
    }
    return root;
}

export function treeOrder(tree) {
    return [...[...tree.directories.values()].sort((a, b) => a.name.localeCompare(b.name)).flatMap(treeOrder), ...tree.files];
}

// Changed files and lines under a folder, including its subfolders.
export function treeTotals(tree) {
    const files = treeOrder(tree);
    return { files: files.length, added: files.reduce((sum, file) => sum + (file.lines_added || 0), 0),
        removed: files.reduce((sum, file) => sum + (file.lines_removed || 0), 0) };
}

// The order a reviewer sees in the rail: layers and groups top to bottom; file groups list the changed file, then its
// consumers and tests; cohort and supporting groups use their rendered folder tree.
export function reviewSequence(navigation, mode = "groups") {
    if (mode === "files") return treeOrder(fileTree(navigation.files)).map((file) => ({ path: file.path, group: null, file }));
    return navigation.groups.flatMap((group) => (group.tree === false ? group.files : treeOrder(fileTree(group.files)))
        .map((file) => ({ path: file.path, group: group.id, file })));
}
