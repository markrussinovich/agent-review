import { renderGraph } from "/graph.js";

const state = {
    payload: null,
    stack: [],
    mode: "graph",
    selected: null,
    source: null,
    sourceTab: "diff",
    packageRisk: new Map(),
    attribution: [],
    changedOnly: true,
    query: "",
};
const elements = Object.fromEntries([
    "status", "fullscreen", "refresh", "error", "analysis-progress", "progress-phase", "progress-message", "progress-percent",
    "progress-bar", "summary", "breadcrumbs", "attention", "attention-count", "packages", "session-intent",
    "graph", "level-label", "graph-title", "zoom-out", "changed-only", "review-search", "detail", "source-panel", "source-title",
    "source-provenance", "source-annotation", "source-close", "source",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const body = await response.json();
    if (!response.ok) {
        const error = new Error(body.error || `Request failed (${response.status})`);
        error.status = response.status;
        throw error;
    }
    return body;
}

function metric(label, value, detail, mode) {
    const card = el("button", "metric");
    const magnitude = Number(value) || 0;
    if (magnitude >= 100) card.classList.add("metric-major");
    else if (magnitude >= 20) card.classList.add("metric-medium");
    card.type = "button";
    card.append(el("strong", "", value ?? 0), el("span", "", label), el("small", "", detail));
    card.addEventListener("click", () => {
        state.mode = mode;
        state.stack = [];
        state.selected = null;
        state.query = "";
        elements.review_search.value = "";
        render();
        elements.graph.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return card;
}

function deltaMetric(label, added, removed, detail, mode) {
    const value = el("strong", "delta-value");
    value.append(el("span", "delta-add", `+${added ?? 0}`), el("span", "delta-separator", "/"), el("span", "delta-remove", `−${removed ?? 0}`));
    const card = el("button", "metric");
    const magnitude = Math.max(Number(added) || 0, Number(removed) || 0);
    if (magnitude >= 100) card.classList.add("metric-major");
    else if (magnitude >= 20) card.classList.add("metric-medium");
    card.type = "button";
    card.append(value, el("span", "", label), el("small", "", detail));
    card.addEventListener("click", () => {
        state.mode = mode;
        state.stack = [];
        state.selected = null;
        state.query = "";
        elements.review_search.value = "";
        render();
        elements.graph.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return card;
}

function renderSummary(model) {
    const summary = model.summary || {};
    const meta = model.metadata || {};
    const changedFiles = model.changes
        .filter((item) => item.status !== "unchanged")
        .sort((a, b) => (b.lines_added + b.lines_removed) - (a.lines_added + a.lines_removed));
    const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
    const changedEdges = model.edges
        .filter((edge) => edge.change === "added")
        .sort((a, b) => (b.count || 1) - (a.count || 1));
    const topFile = changedFiles[0];
    const topEdge = changedEdges[0];
    const packageDetail = (model.package_changes || []).slice(0, 2).map((item) =>
        `${item.name} ${item.resolved_current || item.declared_current?.map((entry) => entry.specifier).filter(Boolean).join(", ") || item.change}`
    ).join(" · ") || "No dependency changes";
    elements.summary.replaceChildren(
        deltaMetric("Files", summary.files_added, summary.files_removed, topFile
            ? `${topFile.path} · +${topFile.lines_added}/−${topFile.lines_removed}`
            : `${summary.files_modified} modified`, "files"),
        deltaMetric("Lines", summary.lines_added, summary.lines_removed, topFile
            ? `Modules ranked by change churn`
            : "No line changes", "lines"),
        deltaMetric("Architecture edges", summary.new_arch_edges, summary.arch_edges_removed, topEdge
            ? `${nodeById.get(topEdge.source)?.name || topEdge.source} → ${nodeById.get(topEdge.target)?.name || topEdge.target}`
            : "No relationship changes", "edges"),
        deltaMetric("Packages", summary.new_packages, summary.packages_removed, packageDetail, "packages"),
    );
    const qualityIssues = [];
    if (!model.coverage?.available) qualityIssues.push("Coverage data unavailable; uncovered changed logic cannot be assessed.");
    if (model.warnings?.length) qualityIssues.push(`${model.warnings.length} analyzer warning${model.warnings.length === 1 ? "" : "s"} require review.`);
    if (qualityIssues.length) {
        const quality = el("button", "quality-warning");
        quality.type = "button";
        quality.append(el("strong", "", "Analysis limitation"), el("span", "", qualityIssues.join(" ")));
        quality.addEventListener("click", () => {
            state.selected = {
                id: "analysis-quality", kind: "analysis", name: "Analysis limitations",
                reason: qualityIssues.join("\n"),
                impact_factors: model.warnings || [],
            };
            renderDetail(state.selected);
        });
        elements.summary.append(quality);
    }
    elements.summary.title = `${meta.base_ref || "base"} @ ${(meta.base_sha || "").slice(0, 8)} → ${(meta.head_sha || "").slice(0, 8)} · ${meta.python_loc || 0} Python LOC`;
}

function evidenceButton(id) {
    const button = el("button", "evidence-link", id);
    button.type = "button";
    button.addEventListener("click", () => selectItem({ id, kind: "evidence" }, false));
    return button;
}

function renderCards(container, items, emptyText) {
    container.replaceChildren();
    if (!items.length) {
        container.append(el("p", "muted", emptyText));
        return;
    }
    for (const item of items) {
        const card = el("button", `review-card severity-${item.severity || item.change || "info"}`);
        card.type = "button";
        const heading = el("div", "card-heading");
        heading.append(el("strong", "", item.title || item.name || item.id));
        if (item.impact_score != null) heading.append(el("b", "impact-score", String(item.impact_score)));
        card.append(heading, el("span", "", item.body || item.reason || packageVersion(item) || item.change || ""));
        if (item.impact_factors?.length) card.append(el("small", "factor-line", item.impact_factors.join(" · ")));
        card.append(el("i", "card-arrow", "→"));
        card.addEventListener("click", () => item.name && item.id?.startsWith("package:")
            ? selectPackage(item)
            : selectItem(item, false));
        container.append(card);
    }
}

function renderSessionContext(context) {
    const container = elements.session_intent;
    container.replaceChildren();
    if (context?.error) {
        container.append(el("p", "muted", context.error));
        return;
    }
    const intent = context?.intent || [];
    if (!intent.length) {
        container.append(el("p", "muted", "No session history is available."));
        return;
    }
    for (const item of intent.slice(-3).reverse()) {
        const card = el("article", "session-card");
        card.append(el("strong", "", item.summary));
        const time = item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
        card.append(el("span", "", `${time} · intent context`));
        container.append(card);
    }
    container.append(el("p", "provenance-note", "Intent context only; code claims require repository evidence."));
}

function childNodes(model) {
    const parent = state.stack.at(-1);
    if (!parent) return model.nodes.filter((node) => node.kind === "component");
    if (parent.kind === "component") return model.nodes.filter((node) => node.kind === "module" && node.component_id === parent.id);
    if (parent.kind === "module") return model.nodes.filter((node) => node.module_id === parent.id && ["class", "function", "method"].includes(node.kind));
    return [];
}

function aggregateEdges(model, visible) {
    const ids = new Set(visible.map((node) => node.id));
    const explicit = (model.aggregate_edges || model.edges || []).filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    return explicit.length ? explicit : model.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
}

function decoratedNodes(model, nodes, findings) {
    const byId = new Map(nodes.map((node) => [node.id, { ...node, _attention_count: 0, _attention_score: 0 }]));
    const allNodes = new Map(model.nodes.map((node) => [node.id, node]));
    for (const finding of findings) {
        const target = allNodes.get(finding.node_id);
        if (!target) continue;
        for (const node of byId.values()) {
            const applies = node.id === target.id
                || (node.kind === "module" && target.module_id === node.id)
                || (node.kind === "component" && target.component_id === node.id);
            if (!applies) continue;
            node._attention_count += 1;
            node._attention_score = Math.max(node._attention_score, finding.impact_score || 0);
            node._attention_severity = finding.severity || node._attention_severity;
        }
    }
    return [...byId.values()].sort((a, b) =>
        (b._attention_score || 0) - (a._attention_score || 0)
        || (b.metrics?.lines_changed || 0) - (a.metrics?.lines_changed || 0)
        || a.name.localeCompare(b.name)
    );
}

function groupFindings(items) {
    const groups = new Map();
    for (const item of items) {
        const key = item.node_id ? `node:${item.node_id}` : item.edge_id ? `edge:${item.edge_id}` : item.id;
        const existing = groups.get(key);
        if (!existing) {
            groups.set(key, { ...item, evidence_ids: [...(item.evidence_ids || [])], impact_factors: [...(item.impact_factors || [])], related_findings: [item.type] });
            continue;
        }
        existing.evidence_ids = [...new Set([...existing.evidence_ids, ...(item.evidence_ids || [])])];
        existing.impact_factors = [...new Set([...existing.impact_factors, ...(item.impact_factors || [])])];
        existing.related_findings = [...new Set([...existing.related_findings, item.type])];
        if ((item.impact_score || 0) > (existing.impact_score || 0)) {
            existing.type = item.type;
            existing.title = item.title;
            existing.reason = item.reason;
            existing.severity = item.severity;
            existing.impact_score = item.impact_score;
        }
    }
    return [...groups.values()].map((item) => {
        if (item.related_findings.length > 1) {
            item.reason = `${item.reason} Also flagged for ${item.related_findings.filter((type) => type !== item.type).join(", ").replaceAll("_", " ")}.`;
        }
        return item;
    }).sort((a, b) => (b.impact_score || 0) - (a.impact_score || 0));
}

function resetToGraph() {
    state.mode = "graph";
    state.stack = [];
    state.selected = null;
    state.query = "";
    elements.review_search.value = "";
    render();
}

function renderBreadcrumbs() {
    elements.breadcrumbs.replaceChildren();
    const root = el("button", "", "Architecture");
    root.type = "button";
    root.addEventListener("click", resetToGraph);
    elements.breadcrumbs.append(root);
    if (state.mode !== "graph") {
        elements.breadcrumbs.append(el("span", "", "›"), el("strong", "", collectionTitle(state.mode)));
        return;
    }
    for (const [index, item] of state.stack.entries()) {
        elements.breadcrumbs.append(el("span", "", "›"));
        const button = el("button", "", item.name || item.qualified_name);
        button.type = "button";
        button.addEventListener("click", () => {
            state.stack = state.stack.slice(0, index + 1);
            render();
        });
        elements.breadcrumbs.append(button);
    }
}

function maybeDrill(item) {
    if (item.kind === "component" || item.kind === "module") {
        state.stack.push(item);
        state.selected = null;
        render();
    } else {
        selectItem(item, true);
    }

    function selectAggregateEdge(edge, model) {
        const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
        const concrete = model.edges.filter((candidate) => edge.underlying_edge_ids?.includes(candidate.id));
        const representative = concrete.find((candidate) => candidate.change !== "unchanged") || concrete[0];
        const source = nodeById.get(edge.source)?.name || edge.source;
        const target = nodeById.get(edge.target)?.name || edge.target;
        if (!representative) {
            renderDetail({
                ...edge,
                kind: "edge",
                name: `${source} → ${target}`,
                reason: `${edge.added_count || 0} added and ${edge.removed_count || 0} removed ${edge.kind} relationships.`,
            });
            return;
        }
        selectItem({
            ...representative,
            kind: "edge",
            name: `${source} → ${target}`,
            added_count: edge.added_count,
            removed_count: edge.removed_count,
            underlying_edge_ids: edge.underlying_edge_ids,
            reason: `${edge.added_count || 0} added and ${edge.removed_count || 0} removed ${edge.kind} relationships. Showing representative source evidence.`,
        });
    }
}

function field(label, value) {
    if (value === undefined || value === null || value === "") return null;
    const row = el("div", "detail-row");
    row.append(el("span", "", label), el("strong", "", String(value)));
    return row;
}

async function loadSource(query) {
    state.source = await api(`/api/source?${query}`);
    try {
        const provenance = await api(`/api/attribution?path=${encodeURIComponent(state.source.path)}`);
        state.attribution = provenance.attribution || [];
    } catch (error) {
        if (error.status !== 404) throw error;
        state.attribution = [];
    }
    state.sourceTab = state.source.diff ? "diff" : "current";
    renderSource();
}

async function selectFile(change) {
    state.selected = {
        id: `file:${change.path}`, kind: "file", name: change.path, path: change.path,
        change: change.status, metrics: {
            lines_added: change.lines_added,
            lines_removed: change.lines_removed,
            lines_changed: change.lines_added + change.lines_removed,
        },
    };
    renderDetail(state.selected);
    try {
        await loadSource(`path=${encodeURIComponent(change.path)}`);
        ensureAnnotation(state.selected);
    } catch (error) {
        showError(error);
    }
}

async function selectItem(item, notify = true) {
    state.selected = item;
    renderDetail(item);
    if (notify) api("/api/selection", {
        method: "POST",
        body: JSON.stringify({ id: item.id, kind: item.kind || item.type || "" }),
    }).catch(showError);
    if (item.path || item.start_line || item.kind === "evidence" || item.evidence_ids?.length) {
        try {
            await loadSource(`id=${encodeURIComponent(item.id)}`);
        } catch (error) {
            state.source = null;
            elements.source_panel.classList.add("hidden");
            if (!String(error.message).includes("has no source location")) showError(error);
        }
    }
    if (item.path || item.evidence_ids?.length || item.node_id || item.edge_id) {
        ensureAnnotation(item);
    } else {
        renderAnnotation(item, state.payload?.annotations?.[item.id] || null);
    }
}

function ensureAnnotation(item) {
    const cached = state.payload?.annotations?.[item.id];
    if (cached) {
        renderAnnotation(item, cached);
        return;
    }
    renderAnnotation(item, null, true);
    api("/api/annotation", {
        method: "POST",
        body: JSON.stringify({ id: item.id, evidence_ids: item.evidence_ids || [] }),
    })
        .then(({ annotation }) => renderAnnotation(item, annotation))
        .catch((error) => renderAnnotation(item, { error: error.message }));
}

function renderProvenance() {
    const panel = elements.source_provenance;
    panel.replaceChildren();
    if (!state.attribution.length) {
        panel.classList.add("hidden");
        return;
    }
    panel.classList.remove("hidden");
    const primary = state.attribution[0];
    const heading = el("div", "provenance-heading");
    heading.append(
        el("span", "provenance-mark", "SESSION"),
        el("strong", "", "Likely originating prompt"),
        el("b", `confidence confidence-${primary.confidence}`, `${primary.confidence} match`),
    );
    panel.append(heading, el("p", "provenance-prompt", primary.prompt), el("p", "source-status", primary.reason));
    const activity = primary.agent_activity.filter((item) => item.role === "assistant" || item.role === "tool").slice(-5);
    if (activity.length) {
        const details = el("details", "provenance-activity");
        const summary = el("summary", "", `Visible agent activity (${activity.length})`);
        const list = el("ul", "");
        for (const item of activity) {
            const label = item.role === "tool" ? item.tool_name || "tool" : "assistant";
            const row = el("li", "");
            row.append(el("strong", "", `${label}: `), document.createTextNode(item.summary));
            list.append(row);
        }
        details.append(summary, list);
        panel.append(details);
    }
    panel.append(el("p", "provenance-disclaimer", "Correlation uses visible prompts and file/tool activity. It does not expose hidden model reasoning or prove line-level authorship."));
}

function appendInlineMarkdown(container, text) {
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > offset) container.append(document.createTextNode(text.slice(offset, match.index)));
        const token = match[0];
        if (token.startsWith("**")) {
            const strong = el("strong", "");
            appendInlineMarkdown(strong, token.slice(2, -2));
            container.append(strong);
        } else {
            container.append(el("code", "inline-code", token.slice(1, -1)));
        }
        offset = match.index + token.length;
    }
    if (offset < text.length) container.append(document.createTextNode(text.slice(offset)));
}

function renderMarkdown(container, markdown) {
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    let list = null;
    let paragraph = [];
    const flushParagraph = () => {
        if (!paragraph.length) return;
        const node = el("p", "");
        appendInlineMarkdown(node, paragraph.join(" "));
        container.append(node);
        paragraph = [];
    };
    const flushList = () => {
        list = null;
    };
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            flushParagraph();
            flushList();
            continue;
        }
        if (/^[-*]\s+/.test(line)) {
            flushParagraph();
            if (!list) {
                list = el("ul", "");
                container.append(list);
            }
            const item = el("li", "");
            appendInlineMarkdown(item, line.replace(/^[-*]\s+/, ""));
            list.append(item);
            continue;
        }
        if (/^#{1,3}\s+/.test(line)) {
            flushParagraph();
            flushList();
            const level = Math.min(3, line.match(/^#+/)[0].length);
            const heading = el(`h${level}`, "");
            appendInlineMarkdown(heading, line.replace(/^#{1,3}\s+/, ""));
            container.append(heading);
            continue;
        }
        flushList();
        paragraph.push(line);
    }
    flushParagraph();
}

function renderAnnotation(item, annotation, loading = false) {
    const panel = elements.source_annotation;
    panel.replaceChildren();
    if (!item || (!loading && !annotation)) {
        panel.classList.add("hidden");
        return;
    }
    panel.classList.remove("hidden");
    const heading = el("div", "annotation-heading");
    heading.append(el("span", "annotation-mark", "AI"), el("strong", "", item.title || item.name || "Review annotation"));
    panel.append(heading);
    if (loading) {
        panel.append(el("p", "annotation-loading", "Copilot is grounding an explanation in the selected evidence…"));
        return;
    }
    if (annotation.error) {
        panel.append(el("p", "annotation-error", annotation.error));
        return;
    }
    const body = el("div", "annotation-body");
    renderMarkdown(body, annotation.body);
    panel.append(body);
    if (annotation.evidence_ids?.length) {
        const citations = el("div", "annotation-citations");
        citations.append(...annotation.evidence_ids.map(evidenceButton));
        panel.append(citations);
    }
}

function renderDetail(item) {
    const panel = elements.detail;
    panel.replaceChildren();
    const top = el("div", "detail-top");
    top.append(el("p", "eyebrow", (item.kind || item.type || "EVIDENCE").toUpperCase()), el("h2", "", item.name || item.title || item.id));
    panel.append(top);
    const metrics = item.metrics || {};
    const fields = [
        field("Impact score", item.impact_score),
        field("Change", item.change),
        field("Path", item.path),
        field("Lines", item.start_line ? `${item.start_line}–${item.end_line || item.start_line}` : null),
        field("Line delta", metrics.lines_changed != null ? `+${metrics.lines_added || 0} / -${metrics.lines_removed || 0}` : null),
        field("Confidence", item.confidence),
        field("Relationships", item.count),
        field("Edges added", item.added_count),
        field("Edges removed", item.removed_count),
        field("Complexity", metrics.complexity_current),
        field("Complexity Δ", metrics.complexity_base != null ? `${metrics.complexity_base} → ${metrics.complexity_current}` : null),
        field("Coverage", metrics.coverage_percent != null ? `${metrics.coverage_percent}%` : null),
        field("Direct callers", metrics.direct_callers),
        field("90d churn", metrics.churn_lines_90d),
        field("Base signature", item.signatures?.base || item.signature_base),
        field("Current signature", item.signatures?.current || item.signature_current),
    ].filter(Boolean);
    const grid = el("div", "detail-grid");
    grid.append(...fields);
    panel.append(grid);
    if (item.body || item.reason || item.summary) panel.append(el("p", "detail-copy", item.body || item.reason || item.summary));
    if (item.impact_factors?.length) {
        const factors = el("div", "factor-chips");
        factors.append(...item.impact_factors.map((factor) => el("span", "", factor)));
        panel.append(factors);
    }
    const evidenceIds = item.evidence_ids || (item.kind === "evidence" ? [item.id] : []);
    if (evidenceIds.length) {
        panel.append(el("h3", "", "Evidence"));
        const evidence = el("div", "evidence-list");
        evidence.append(...evidenceIds.map(evidenceButton));
        panel.append(evidence);
    }
}

function codeRow(type, oldNumber, newNumber, prefix, content) {
    const row = el("div", `code-row diff-${type}`);
    if (oldNumber) row.dataset.oldLine = String(oldNumber);
    if (newNumber) row.dataset.newLine = String(newNumber);
    row.append(
        el("span", "line-number", oldNumber || ""),
        el("span", "line-number", newNumber || ""),
        el("span", "diff-prefix", prefix),
        el("code", "", content),
    );
    return row;
}

function parseDiff(text) {
    const rows = [];
    let oldLine = 0;
    let newLine = 0;
    const lines = String(text || "").split(/\r?\n/);
    for (let index = 0; index < lines.length;) {
        const line = lines[index];
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
        if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            rows.push(codeRow("hunk", "", "", "", line));
            index += 1;
            continue;
        }
        if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) {
            rows.push(codeRow("meta", "", "", "", line));
            index += 1;
            continue;
        }
        if (line.startsWith("-")) {
            const removed = [];
            while (lines[index]?.startsWith("-") && !lines[index].startsWith("---")) removed.push(lines[index++].slice(1));
            const added = [];
            while (lines[index]?.startsWith("+") && !lines[index].startsWith("+++")) added.push(lines[index++].slice(1));
            const replacement = added.length > 0;
            for (const content of removed) rows.push(codeRow(replacement ? "modified" : "delete", oldLine++, "", "−", content));
            for (const content of added) rows.push(codeRow("modified", "", newLine++, "+", content));
            continue;
        } else if (line.startsWith("+")) {
            rows.push(codeRow("add", "", newLine++, "+", line.slice(1)));
        } else if (line.startsWith(" ")) {
            rows.push(codeRow("context", oldLine++, newLine++, " ", line.slice(1)));
        } else if (line) {
            rows.push(codeRow("meta", "", "", "", line));
        }
        index += 1;
    }
    return rows;
}

function renderPlainSource(text) {
    return String(text ?? "").split(/\r?\n/).map((line, index) =>
        codeRow("context", "", index + 1, "", line)
    );
}

function renderSource() {
    if (!state.source) return;
    elements.source_panel.classList.remove("hidden");
    elements.source_title.textContent = `${state.source.path}${state.source.start_line ? `:${state.source.start_line}` : ""}`;
    const text = state.source[state.sourceTab];
    const rows = state.sourceTab === "diff" ? parseDiff(text) : renderPlainSource(text);
    elements.source.replaceChildren(...(rows.length ? rows : [el("p", "empty-code", "(not present in this snapshot)")]));
    const start = Number(state.source.start_line);
    const end = Number(state.source.end_line || state.source.start_line);
    if (Number.isFinite(start) && start > 0) {
        const focused = [];
        for (const row of rows) {
            const oldLine = Number(row.dataset?.oldLine);
            const newLine = Number(row.dataset?.newLine);
            const line = state.sourceTab === "base"
                ? oldLine
                : state.sourceTab === "current"
                    ? newLine
                    : (newLine || oldLine);
            if (Number.isFinite(line) && line >= start && line <= end) {
                row.classList.add("focus-line");
                focused.push(row);
            }
        }
        focused[0]?.scrollIntoView({ block: "center" });
    }
    const annotation = state.payload?.annotations?.[state.selected?.id];
    if (annotation) renderAnnotation(state.selected, annotation);
    renderProvenance();
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === state.sourceTab));
}

function collectionTitle(mode) {
    return {
        files: "Changed files", lines: "Lines changed by module", symbols: "Changed symbols",
        edges: "New relationships", packages: "Package dependencies", findings: "Ranked findings",
    }[mode] || "Review details";
}

function collectionItems(model, mode) {
    if (mode === "files") {
        const files = model.changes.filter((item) => item.status !== "unchanged");
        return files.sort((a, b) =>
            (b.lines_added + b.lines_removed) - (a.lines_added + a.lines_removed)
            || a.path.localeCompare(b.path)
        );
    }
    if (mode === "lines") return model.nodes
        .filter((node) => node.kind === "module" && node.change !== "unchanged")
        .sort((a, b) => (b.metrics?.lines_changed || 0) - (a.metrics?.lines_changed || 0));
    if (mode === "symbols") return model.nodes
        .filter((node) => ["class", "function", "method"].includes(node.kind) && node.change !== "unchanged")
        .sort((a, b) => (b.metrics?.lines_changed || 0) - (a.metrics?.lines_changed || 0));
    if (mode === "edges") return model.edges
        .filter((edge) => edge.change === "added")
        .sort((a, b) => (b.count || 1) - (a.count || 1));
    if (mode === "packages") return model.package_dependencies || [];
    if (mode === "findings") return groupFindings(model.attention || []);
    return [];
}

function renderCollection(model) {
    const query = state.query.toLowerCase();
    const items = collectionItems(model, state.mode).filter((item) =>
        !query || `${item.title || ""} ${item.name || ""} ${item.path || ""} ${item.reason || ""}`.toLowerCase().includes(query)
    );
    const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
    elements.graph.replaceChildren();
    const list = el("div", "collection-list");
    if (!items.length) {
        list.append(el("p", "collection-empty", `No ${collectionTitle(state.mode).toLowerCase()} to show.`));
    }
    for (const item of items) {
        const row = el("button", "collection-row");
        row.type = "button";
        let title;
        let subtitle;
        if (item.path && item.status) {
            title = item.path;
            subtitle = `${item.status} · +${item.lines_added} / -${item.lines_removed}`;
            const statusClass = item.status === "added"
                ? "file-added"
                : item.status === "deleted" || item.status === "removed"
                    ? "file-removed"
                    : "file-modified";
            row.classList.add(statusClass);
            row.addEventListener("click", () => selectFile(item));
        } else if (item.source && item.target) {
            title = `${nodeById.get(item.source)?.name || item.source} → ${nodeById.get(item.target)?.name || item.target}`;
            subtitle = `${item.type} · ${item.count || 1} relationship${item.count === 1 ? "" : "s"} · ${item.confidence}`;
            row.addEventListener("click", () => selectItem(item));
        } else if (item.id?.startsWith("package:")) {
            title = item.name;
            subtitle = `${item.change} · ${packageVersion(item)}${item.usage_locations?.length ? ` · used by ${item.usage_locations.length}` : " · no usage resolved"}`;
            row.addEventListener("click", () => selectPackage(item));
        } else {
            title = item.title || item.name;
            const historicalChurn = (item.metrics?.churn_additions_90d || 0) + (item.metrics?.churn_deletions_90d || 0);
            subtitle = state.mode === "lines"
                ? `Change churn ${item.metrics?.lines_changed || 0} · +${item.metrics?.lines_added || 0} / −${item.metrics?.lines_removed || 0} · 90d churn ${historicalChurn}`
                : item.reason || `${item.kind || item.change} · +${item.metrics?.lines_added || 0} / −${item.metrics?.lines_removed || 0}`;
            row.addEventListener("click", () => item.id?.startsWith("package:") ? selectPackage(item) : selectItem(item));
        }
        const copy = el("span", "collection-copy");
        copy.append(el("strong", "", title), el("small", "", subtitle));
        row.append(copy, el("span", "collection-arrow", "→"));
        list.append(row);
    }
    elements.graph.append(list);
}

function packageVersion(item) {
    const declarations = item.declared_current || [];
    const declared = declarations.map((entry) => entry.specifier).filter(Boolean).join(", ");
    return item.resolved_current || declared || "version unspecified";
}

async function selectPackage(item) {
    state.selected = item;
    renderDetail(item);
    const panel = elements.detail;
    const loading = el("div", "risk-panel");
    loading.append(el("p", "eyebrow", "PACKAGE INTELLIGENCE"), el("p", "muted", "Loading PyPI, OSV, popularity, and OpenSSF indicators…"));
    panel.append(loading);
    try {
        let result = state.packageRisk.get(item.name)
            || Object.values(state.payload?.package_risks || {}).find((candidate) =>
                candidate.assessment?.name === item.name
            );
        if (!result) {
            result = await api("/api/package-risk", {
                method: "POST",
                body: JSON.stringify({ name: item.name, version: item.resolved_current || null }),
            });
            state.packageRisk.set(item.name, result);
        }
        renderPackageRisk(panel, result);
    } catch (error) {
        loading.replaceWith(el("p", "annotation-error", error.message));
    }
}

function renderPackageRisk(panel, result) {
    panel.querySelector(".risk-panel")?.remove();
    const risk = result.assessment?.risk || {};
    const indicators = result.assessment?.indicators || {};
    const section = el("section", `risk-panel risk-${risk.level || "unknown"}`);
    const heading = el("div", "risk-heading");
    heading.append(el("p", "eyebrow", "PACKAGE INTELLIGENCE"), el("b", "risk-level", `${risk.level || "unknown"} risk${risk.score != null ? ` · ${risk.score}/100` : ""}`));
    section.append(heading);
    const grid = el("div", "risk-grid");
    grid.append(
        field("Version", result.assessment?.version || "unknown"),
        field("Known vulnerabilities", indicators.vulnerability_count ?? "unknown"),
        field("Vulnerability history", indicators.vulnerability_history_count ?? "unknown"),
        field("OpenSSF score", indicators.scorecard_score ?? "unknown"),
        field("Recent downloads", indicators.recent_downloads?.toLocaleString?.() ?? "unknown"),
        field("Latest release", indicators.latest_version || "unknown"),
        field("Repository", indicators.repository_url || "unknown"),
    );
    section.append(grid);
    if (risk.reasons?.length) {
        const reasons = el("ul", "risk-reasons");
        reasons.append(...risk.reasons.map((reason) => el("li", "", reason)));
        section.append(reasons);
    }
    if (result.explanation) {
        const explanation = el("div", "detail-copy markdown-body");
        renderMarkdown(explanation, result.explanation);
        section.append(el("h3", "", "Copilot assessment"), explanation);
    }
    const sourceLine = el("p", "source-status", Object.entries(result.assessment?.sources || {})
        .map(([name, source]) => `${name}: ${source.status}`)
        .join(" · "));
    section.append(sourceLine);
    panel.append(section);
}

function render() {
    const payload = state.payload;
    const model = payload?.model;
    const progress = payload?.progress;
    elements.status.textContent = payload?.loading
        ? `${progress?.message || "Analyzing…"} · ${progress?.percent || 0}%`
        : model ? "Analysis current" : "Waiting";
    elements.status.classList.toggle("working", Boolean(payload?.loading));
    elements.refresh.disabled = Boolean(payload?.loading);
    elements.error.classList.toggle("hidden", !payload?.error);
    elements.error.textContent = payload?.error || "";
    elements.analysis_progress.classList.toggle("hidden", !payload?.loading);
    if (payload?.loading) {
        const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
        elements.progress_phase.textContent = String(progress?.phase || "starting").replaceAll("_", " ").toUpperCase();
        elements.progress_message.textContent = progress?.message || "Analyzing repository";
        elements.progress_percent.textContent = `${percent}%`;
        elements.progress_bar.style.width = `${percent}%`;
        elements.analysis_progress.querySelector(".progress-track").setAttribute("aria-valuenow", String(percent));
    }
    if (!model) return;
    renderSummary(model);
    renderBreadcrumbs();
    const groupedObservations = [
        ...groupFindings(model.attention || []),
        ...(payload.generated_observations || []),
    ].sort((a, b) => (b.impact_score || 0) - (a.impact_score || 0));
    elements.attention_count.textContent = String(groupedObservations.length);
    renderCards(elements.attention, groupedObservations.slice(0, 12), "No deterministic attention findings.");
    if (groupedObservations.length > 12) {
        const viewAll = el("button", "view-all", `View all ${groupedObservations.length} ranked findings →`);
        viewAll.type = "button";
        viewAll.addEventListener("click", () => {
            state.mode = "findings";
            state.stack = [];
            render();
            elements.graph.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        elements.attention.append(viewAll);
    }
    renderSessionContext(payload.session_context);
    renderCards(elements.packages, model.package_dependencies || [], "No declared package dependencies.");

    const parent = state.stack.at(-1);
    elements.zoom_out.disabled = state.mode === "graph" && state.stack.length === 0;
    elements.zoom_out.title = state.mode !== "graph" ? "Back to architecture" : parent ? `Back from ${parent.name}` : "Already at architecture level";
    if (state.mode === "graph") {
        elements.level_label.textContent = parent ? (parent.kind === "component" ? "MODULES" : "SYMBOLS") : "ARCHITECTURE";
        elements.graph_title.textContent = parent ? parent.name : "Structural change map";
        const query = state.query.toLowerCase();
        const nodes = childNodes(model).filter((node) =>
            (!state.changedOnly || node.change !== "unchanged")
            && (!query || `${node.name} ${node.path || ""}`.toLowerCase().includes(query))
        );
        renderGraph(elements.graph, decoratedNodes(model, nodes, groupedObservations), aggregateEdges(model, nodes), maybeDrill);
    } else if (state.mode === "edges") {
        elements.level_label.textContent = "CHANGED RELATIONSHIPS";
        elements.graph_title.textContent = "Added and removed module edges";
        const query = state.query.toLowerCase();
        const changedEdges = (model.aggregate_edges || [])
            .filter((edge) => edge.level === "module" && (edge.added_count > 0 || edge.removed_count > 0))
            .map((edge) => ({
                ...edge,
                type: edge.kind,
                change: edge.added_count > 0 && edge.removed_count === 0
                    ? "added"
                    : edge.removed_count > 0 && edge.added_count === 0
                        ? "removed"
                        : "modified",
                count: Math.max(edge.count || 0, edge.added_count || 0, edge.removed_count || 0),
                evidence_ids: [],
            }));
        const nodeIds = new Set(changedEdges.flatMap((edge) => [edge.source, edge.target]));
        const nodes = model.nodes.filter((node) =>
            node.kind === "module"
            && nodeIds.has(node.id)
            && (!query || `${node.name} ${node.path || ""}`.toLowerCase().includes(query))
        );
        const visibleIds = new Set(nodes.map((node) => node.id));
        renderGraph(
            elements.graph,
            decoratedNodes(model, nodes, groupedObservations),
            changedEdges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
            (item) => item.level ? selectAggregateEdge(item, model) : maybeDrill(item),
        );
    } else {
        elements.level_label.textContent = "REVIEW INDEX";
        elements.graph_title.textContent = collectionTitle(state.mode);
        renderCollection(model);
    }
    if (payload.selection?.id && state.selected?.id !== payload.selection.id) {
        const all = [...model.nodes, ...model.edges, ...(model.package_changes || []), ...(model.attention || []), ...(payload.generated_observations || [])];
        const selected = all.find((item) => item.id === payload.selection.id) || { id: payload.selection.id, kind: "evidence" };
        state.selected = selected;
        renderDetail(selected);
    }
    if (state.selected && payload.annotations?.[state.selected.id]) {
        renderAnnotation(state.selected, payload.annotations[state.selected.id]);
    }
}

function showError(error) {
    elements.error.textContent = error.message;
    elements.error.classList.remove("hidden");
}

elements.refresh.addEventListener("click", async () => {
    try {
        await api("/api/refresh", { method: "POST" });
    } catch (error) {
        showError(error);
    }
});
elements.zoom_out.addEventListener("click", () => {
    if (state.mode !== "graph") {
        resetToGraph();
    } else if (state.stack.length) {
        state.stack.pop();
        state.selected = null;
        state.source = null;
        state.query = "";
        elements.review_search.value = "";
        elements.source_panel.classList.add("hidden");
        render();
    }
});
elements.changed_only.addEventListener("change", () => {
    state.changedOnly = elements.changed_only.checked;
    render();
});
elements.review_search.addEventListener("input", () => {
    state.query = elements.review_search.value.trim();
    render();
});
window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.source_panel.classList.contains("hidden")) {
        elements.source_close.click();
        return;
    }
    if (event.altKey && event.key === "ArrowLeft" && (state.stack.length || state.mode !== "graph")) {
        event.preventDefault();
        elements.zoom_out.click();
    }
});
let resizeTimer;
function scheduleResizeRender() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (state.payload?.model) render();
    }, 120);
}
window.addEventListener("resize", scheduleResizeRender);
let observedWidth = document.documentElement.clientWidth;
new ResizeObserver(() => {
    const width = document.documentElement.clientWidth;
    if (Math.abs(width - observedWidth) < 2) return;
    observedWidth = width;
    scheduleResizeRender();
}).observe(document.documentElement);

elements.fullscreen.addEventListener("click", async () => {
    try {
        if (document.fullscreenElement) {
            await document.exitFullscreen();
        } else {
            await document.documentElement.requestFullscreen();
        }
    } catch (error) {
        showError(new Error(`The Copilot host did not allow web fullscreen. Use the native Expand Canvas control. ${error.message}`));
    }
});
document.addEventListener("fullscreenchange", () => {
    elements.fullscreen.textContent = document.fullscreenElement ? "Exit full canvas" : "Full canvas";
    scheduleResizeRender();
});
elements.source_close.addEventListener("click", () => {
    state.source = null;
    state.attribution = [];
    elements.source_panel.classList.add("hidden");
});
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    state.sourceTab = tab.dataset.tab;
    renderSource();
}));

api("/api/state").then((payload) => {
    state.payload = payload;
    render();
}).catch(showError);
const events = new EventSource("/events");
events.addEventListener("state", (event) => {
    state.payload = JSON.parse(event.data);
    render();
});
events.onerror = () => {
    elements.status.textContent = "Reconnecting…";
};
