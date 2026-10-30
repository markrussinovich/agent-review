import { isTestPath } from "./web/languages.mjs";

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

function diffHunks(diff) {
    const hunks = [];
    for (const line of String(diff || "").split(/\r?\n/)) {
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (header) hunks.push({ base: Number(header[1]), baseCount: Number(header[2] ?? 1),
            current: Number(header[3]), currentCount: Number(header[4] ?? 1), header: line, lines: [] });
        else if (hunks.length && /^[ +\-]/.test(line)) hunks.at(-1).lines.push(line);
    }
    return hunks;
}

function projectLine(hunks, line, side, end) {
    const other = side === "current" ? "base" : "current";
    let offset = 0;
    for (const hunk of hunks) {
        if (line < hunk[side]) break;
        if (line >= hunk[side] + hunk[`${side}Count`]) {
            offset = hunk[other] + hunk[`${other}Count`] - hunk[side] - hunk[`${side}Count`];
            continue;
        }
        let base = hunk.base, current = hunk.current;
        for (let index = 0; index < hunk.lines.length;) {
            if (hunk.lines[index].startsWith(" ")) {
                if ((side === "current" ? current : base) === line) return side === "current" ? base : current;
                base++; current++; index++;
            } else {
                const from = { base, current };
                while (index < hunk.lines.length && !hunk.lines[index].startsWith(" ")) {
                    if (hunk.lines[index].startsWith("-")) base++;
                    else if (hunk.lines[index].startsWith("+")) current++;
                    index++;
                }
                if (line >= from[side] && line < (side === "current" ? current : base)) {
                    return Math.max(1, end ? (other === "base" ? base : current) - 1 : from[other]);
                }
            }
        }
    }
    return Math.max(1, line + offset);
}

function hunkRanges(hunks, source, side) {
    if (typeof source !== "string" || !source.length) return [];
    const lineCount = source.split(/\r?\n/).length;
    const ranges = [];
    for (const hunk of hunks) {
        const start = Math.max(1, hunk[side] - 5);
        const end = Math.min(lineCount, hunk[side] + Math.max(1, hunk[`${side}Count`]) - 1 + 5);
        const previous = ranges.at(-1);
        if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
        else if (start <= end) ranges.push([start, end]);
    }
    return ranges;
}

function changedLines(hunks, side) {
    const lines = [];
    for (const hunk of hunks) {
        let line = hunk[side];
        const prefix = side === "base" ? "-" : "+";
        for (const text of hunk.lines) {
            if (text.startsWith(prefix)) lines.push(line++);
            else if (text.startsWith(" ")) line++;
        }
    }
    return lines;
}

function excerpts(source, requested, budget, points = [], changes = []) {
    if (typeof source !== "string") return { available: false, ranges: [], omitted_ranges: [] };
    const lines = source.split(/\r?\n/);
    const wanted = new Set();
    for (const [start, end] of requested) {
        for (let line = Math.max(1, start); line <= Math.min(lines.length, end); line++) wanted.add(line);
    }
    const ordered = [...wanted].sort((a, b) => a - b);
    const chosen = new Set();
    const changed = new Set(changes.filter((line) => wanted.has(line)));
    const priority = new Set();
    for (const point of points) for (let line = point - 5; line <= point + 8; line++) if (wanted.has(line)) priority.add(line);
    let used = 0;
    for (const line of new Set([...changed, ...priority, ...ordered.slice(0, 16), ...ordered.slice(-16), ...ordered])) {
        const cost = bytes(`${line}: ${lines[line - 1]}\n`) + 12;
        if (used + cost > budget) continue;
        chosen.add(line);
        used += cost;
    }
    const ranges = [], omitted = [];
    for (const line of ordered) {
        const collection = chosen.has(line) ? ranges : omitted;
        let range = collection.at(-1);
        if (!range || range.end_line !== line - 1) {
            range = { start_line: line, end_line: line, ...(collection === ranges ? { excerpt: "" } : {}) };
            collection.push(range);
        }
        range.end_line = line;
        if (collection === ranges) range.excerpt += `${line}: ${lines[line - 1]}\n`;
    }
    return { available: true, complete: omitted.length === 0, requested_ranges: requested,
        source_lines: lines.length, ranges, omitted_ranges: omitted,
        changed_lines: { total: changed.size, included: [...changed].filter((line) => chosen.has(line)).length } };
}

export async function annotationCodeContext(model, context, sourceForPath) {
    const evidence = Object.values(context.evidence || {});
    const subject = context.subject || context.item || {};
    const path = subject.path || evidence.find((item) => item.path)?.path;
    if (!path) return null;
    const snapshot = await sourceForPath(path);
    const subjectSide = subject.change === "removed" || snapshot.current === null ? "base" : "current";
    const otherSide = subjectSide === "current" ? "base" : "current";
    const hunks = diffHunks(snapshot.diff);
    const fileScope = ["file", "module"].includes(subject.kind) || !subject.start_line;
    const changes = { base: changedLines(hunks, "base"), current: changedLines(hunks, "current") };
    const symbols = (model.nodes || []).filter((node) => node.path === path && node.start_line
        && ["function", "method", "constructor", "class"].includes(node.kind));
    const ranges = fileScope && hunks.length ? hunkRanges(hunks, snapshot[subjectSide], subjectSide)
        : subject.start_line ? [[subject.start_line, subject.end_line || subject.start_line + 40]]
        : symbols.filter((node) => node.change !== "unchanged").slice(0, 6)
            .map((node) => [node.start_line, node.end_line || node.start_line + 40]);
    if (!ranges.length && !(fileScope && hunks.length)) {
        const line = evidence.find((item) => item.path === path)?.line || 1;
        ranges.push([Math.max(1, line - 5), line + 99]);
    }
    const projected = fileScope && hunks.length ? hunkRanges(hunks, snapshot[otherSide], otherSide)
        : hunks.length || snapshot.current === snapshot.base
        ? ranges.map(([start, end]) => [projectLine(hunks, start, subjectSide, false),
            projectLine(hunks, end, subjectSide, true)]).filter(([start, end]) => end >= start) : [];
    const pointLines = evidence.filter((item) => item.path === path).map((item) => item.line);
    const result = {
        path, subject_side: subjectSide,
        [subjectSide]: excerpts(snapshot[subjectSide], ranges, 19_000, pointLines, changes[subjectSide]),
        [otherSide]: excerpts(snapshot[otherSide], projected, 13_000, [], changes[otherSide]),
        baseline_scope: subject.change === "added"
            ? "Prior edit context, not a claimed matching definition."
            : "Before/current ranges aligned using saved diff coordinates.",
        diff: "", diff_error: snapshot.diff_error || null, base_error: snapshot.base_error || null, usages: [], tests: [], declarations: [],
        evidence_limits: { omitted_diff_hunks: 0, omitted_related_symbols: 0,
            scope: fileScope && hunks.length ? "Changed file hunks with surrounding context." : "Selected source ranges.",
            note: "Omitted excerpts are available saved source, not absent files. Identical bounded excerpts do not establish that the file is unchanged. Static examples are not executed tests." },
    };
    if (!projected.length && typeof snapshot[otherSide] === "string" && !(fileScope && hunks.length)) {
        result.evidence_limits.alignment = "Saved opposite-side source exists but its selected range could not be aligned.";
    }
    const relevant = fileScope ? hunks : hunks.filter((hunk) => ranges.some(([start, end]) =>
        hunk[subjectSide] <= end && hunk[subjectSide] + Math.max(1, hunk[`${subjectSide}Count`]) - 1 >= start));
    for (const hunk of relevant) {
        const value = `${hunk.header}\n${hunk.lines.join("\n")}\n`;
        if (bytes(result.diff + value) <= 6000) result.diff += value;
        else result.evidence_limits.omitted_diff_hunks++;
    }
    result.evidence_limits.unrelated_diff_hunks = hunks.length - relevant.length;
    const nodes = new Map((model.nodes || []).map((node) => [node.id, node]));
    const related = [];
    for (const edge of context.related_edges || []) {
        const incoming = edge.target === subject.id;
        const node = nodes.get(incoming ? edge.source : edge.target);
        if (!node?.path || !node.start_line || !["calls", "imports", "inherits"].includes(edge.type)) continue;
        if (node.path === path && ranges.some(([start, end]) => node.start_line >= start && node.end_line <= end)) continue;
        if (related.some((entry) => entry.node.id === node.id)) continue;
        related.push({ node, edge, role: isTestPath(node.path) ? "related test" : incoming ? "consumer" : "dependency" });
    }
    const moduleId = subject.module_id || (model.nodes || []).find((node) => node.kind === "module" && node.path === path)?.id;
    for (const edge of model.edges || []) {
        const node = nodes.get(edge.target);
        if (edge.type !== "imports" || edge.source !== moduleId || !node?.path
            || related.some((entry) => entry.node.path === node.path && entry.role === "dependency")) continue;
        related.push({ node: { ...node, start_line: 1, end_line: 80 }, edge, role: "dependency" });
    }
    related.sort((a, b) => Number(Boolean(b.node.change && b.node.change !== "unchanged"))
        - Number(Boolean(a.node.change && a.node.change !== "unchanged")));
    const selected = [
        ...related.filter((entry) => entry.role === "consumer").slice(0, 4),
        ...related.filter((entry) => entry.role === "dependency").slice(0, 3),
        ...related.filter((entry) => entry.role === "related test").slice(0, 3),
    ];
    for (const entry of selected) {
        const { node, edge, role } = entry;
        const saved = await sourceForPath(node.path);
        const side = node.change === "removed" ? "base" : "current";
        const callsite = role !== "dependency" && (edge.evidence_ids || []).map((id) => model.evidence?.[id])
            .find((item) => item?.path === node.path)?.line;
        const center = callsite >= node.start_line && callsite <= node.end_line ? callsite : node.start_line;
        const from = role === "dependency" ? node.start_line : Math.max(node.start_line, center - 4);
        const to = role === "dependency" ? node.end_line : Math.min(node.end_line || from + 35, center + 35);
        const item = { name: node.name, path: node.path, side, change: node.change, role, relationship: edge.type,
            relationship_confidence: edge.confidence, ...excerpts(saved[side], [[from, to]], role === "dependency" ? 3500 : 1600) };
        const collection = role === "related test" ? result.tests : result.usages;
        collection.push(item);
        if (bytes(result) > 46_000) {
            collection.pop();
            result.evidence_limits.omitted_related_symbols++;
        }
    }
    result.evidence_limits.omitted_related_symbols += related.length - selected.length;
    const selectedText = result[subjectSide].ranges.map((range) => range.excerpt).join("\n");
    const fileLines = String(snapshot[subjectSide] || "").split(/\r?\n/);
    for (let index = 0; index < fileLines.length && result.declarations.length < 3; index++) {
        const declaration = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(fileLines[index]);
        if (!declaration || !new RegExp(`\\b${declaration[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(selectedText)
            || ranges.some(([start, end]) => index + 1 >= start && index + 1 <= end)) continue;
        const item = { path, side: subjectSide, name: declaration[1],
            relationship: "Referenced file-scope declaration; lexical association.",
            ...excerpts(snapshot[subjectSide], [[index + 1, index + 12]], 1800) };
        result.declarations.push(item);
        if (bytes(result) > 46_000) result.declarations.pop();
    }
    if (typeof subject.name === "string" && /^[A-Za-z_$][\w$]*$/.test(subject.name)) {
        const call = new RegExp(`\\b${subject.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`);
        for (const [testPath, saved] of Object.entries(model.source_files || {})) {
            if (result.tests.length >= 3) break;
            if (!isTestPath(testPath) || typeof saved.current !== "string"
                || !saved.current.includes(subject.name) || result.tests.some((item) => item.path === testPath)) continue;
            const line = saved.current.split(/\r?\n/).findIndex((text) => call.test(text)) + 1;
            if (!line) continue;
            const item = { path: testPath, side: "current", role: "related test",
                relationship: "Lexical call reference; linkage and execution are not established.",
                ...excerpts(saved.current, [[Math.max(1, line - 5), line + 25]], 1600) };
            result.tests.push(item);
            if (bytes(result) > 46_000) result.tests.pop();
        }
    }
    for (let attempt = 1; bytes(result) > 48_000 && attempt <= 8; attempt++) {
        result[subjectSide] = excerpts(snapshot[subjectSide], ranges, Math.floor(19_000 / 2 ** attempt), pointLines, changes[subjectSide]);
        result[otherSide] = excerpts(snapshot[otherSide], projected, Math.floor(13_000 / 2 ** attempt), [], changes[otherSide]);
    }
    if (bytes(result) > 48_000) throw new Error("The selected explanation evidence exceeds its bounded context limit.");
    return result;
}
