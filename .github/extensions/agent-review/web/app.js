import { renderGraph } from "/graph.js";

const state = {
    payload: null,
    stack: [],
    mode: "graph",
    selected: null,
    source: null,
    sourceTab: "diff",
    packageData: new Map(),
    attribution: [],
    attributionStatus: "loading",
    attributionMessage: "",
    highlightedPromptEventId: null,
    selectionEpoch: 0,
    changedOnly: true,
    query: "",
    detailVisible: true,
    sourceHistory: { entries: [], index: -1, pending: -1 },
    appliedServerSelection: null,
};
const elements = Object.fromEntries([
    "status", "refresh", "error", "analysis-progress", "progress-phase", "progress-message", "progress-percent",
    "progress-bar", "summary", "breadcrumbs", "attention", "attention-count", "packages", "rail-resize",
    "graph", "level-label", "graph-title", "zoom-out", "changed-only", "review-search", "detail-toggle", "detail", "detail-close", "source-panel", "source-title",
    "source-provenance", "source-annotation", "source-close", "source", "source-back", "source-forward",
    "session-history-panel", "session-history-title", "session-history-meta", "session-history-close", "session-transcript",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function isTestPath(path) {
    return /(^|\/)(tests?|__tests__)\//i.test(path || "") || /(^|\/)test_[^/]+\.py$|_test\.py$/i.test(path || "");
}

function sourceTestChurn(model) {
    const totals = { source: 0, tests: 0 };
    for (const change of model.changes || []) {
        if (change.status === "unchanged") continue;
        totals[isTestPath(change.path) ? "tests" : "source"] += change.lines_added + change.lines_removed;
    }
    return totals;
}

function churnBar(fraction, kind) {
    const bar = el("i", `churn-bar churn-${kind}`);
    bar.style.width = `${Math.max(2, Math.round(fraction * 100))}%`;
    return bar;
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
        clearSelection();
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
        clearSelection();
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
    const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
    const changedEdges = model.edges
        .filter((edge) => edge.change === "added")
        .sort((a, b) => (b.count || 1) - (a.count || 1));
    const topEdge = changedEdges[0];
    const split = sourceTestChurn(model);
    const fileDetail = [
        `${summary.files_added || 0} added`,
        `${summary.files_modified || 0} modified`,
        `${summary.files_removed || 0} deleted`,
    ].join(" · ");
    const packageDetail = (model.package_changes || []).slice(0, 2).map((item) =>
        `${item.name} ${item.resolved_current || item.declared_current?.map((entry) => entry.specifier).filter(Boolean).join(", ") || item.change}`
    ).join(" · ") || "No dependency changes";
    elements.summary.replaceChildren(
        deltaMetric("Files", summary.files_added, summary.files_removed, fileDetail, "files"),
        deltaMetric("Lines", summary.lines_added, summary.lines_removed,
            `source ${split.source.toLocaleString()} · tests ${split.tests.toLocaleString()} lines changed`, "lines"),
        deltaMetric("Architecture edges", summary.new_arch_edges, summary.arch_edges_removed, topEdge
            ? `Largest: ${nodeById.get(topEdge.source)?.name || topEdge.source} → ${nodeById.get(topEdge.target)?.name || topEdge.target}`
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

function evidenceLabel(id) {
    const evidence = state.payload?.model?.evidence?.[id];
    if (!evidence) return id;
    const kind = String(evidence.kind || "evidence").replaceAll("_", " ");
    const location = evidence.path ? `${evidence.path}${evidence.line ? `:${evidence.line}` : ""}` : null;
    return location ? `${kind} · ${location}` : kind;
}

function evidenceButton(id) {
    const button = el("button", "evidence-link", evidenceLabel(id));
    button.type = "button";
    button.title = id;
    button.addEventListener("click", () => selectItem({ id, kind: "evidence" }, false));
    return button;
}

async function copyText(button, text) {
    const originalLabel = button.getAttribute("aria-label") || "Copy";
    try {
        let copied = false;
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                copied = true;
            } catch {
                // Sandboxed Canvas hosts can expose the API while denying clipboard permission.
            }
        }
        if (!copied) {
            const textarea = el("textarea", "");
            textarea.value = text;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.append(textarea);
            try {
                textarea.select();
                if (!document.execCommand("copy")) throw new Error("The browser rejected the copy command.");
            } finally {
                textarea.remove();
            }
        }
        button.textContent = "✓";
        button.setAttribute("aria-label", "Copied");
        button.title = "Copied";
        setTimeout(() => {
            button.textContent = "⧉";
            button.setAttribute("aria-label", originalLabel);
            button.title = originalLabel;
        }, 1500);
    } catch (error) {
        showError(new Error(`Unable to copy text: ${error.message}`));
    }
}

function copyButton(text, label = "Copy") {
    const button = el("button", "copy-button", "⧉");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", () => copyText(button, text));
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
        card.append(heading, el("span", "card-body", item.id?.startsWith("package:") ? `${item.change} · ${packageVersionText(item)}` : item.body || item.reason || item.change || ""));
        if (item.impact_factors?.length) card.append(el("small", "factor-line", item.impact_factors.join(" · ")));
        card.dataset.itemId = item.id;
        card.classList.toggle("is-selected", state.selected?.id === item.id);
        card.title = [item.title, item.body || item.reason].filter(Boolean).join("\n");
        card.addEventListener("click", () => openReviewItem(item));
        container.append(card);
    }
}

function markSelectedCards() {
    document.querySelectorAll(".review-card[data-item-id]").forEach((card) =>
        card.classList.toggle("is-selected", card.dataset.itemId === state.selected?.id));
}

function openReviewItem(item) {
    if (item.collect_mode) {
        state.mode = item.collect_mode;
        state.stack = [];
        clearSelection();
        state.query = "";
        elements.review_search.value = "";
        render();
    } else if (item.id?.startsWith("package:") || item.package_id) {
        const model = state.payload?.model;
        const target = (model?.package_changes || []).find((entry) => entry.id === (item.package_id || item.id));
        if (target) openPackage(target);
        else selectItem(item, false);
    } else {
        selectItem(item, false);
    }
}

function collapseSizeFindings(items, model) {
    const sizes = items.filter((item) => item.title === "Large implementation change");
    if (sizes.length < 3) return items;
    const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
    const label = (item) => {
        const node = nodeById.get(item.node_id);
        const lines = node?.metrics?.lines_changed ?? 0;
        return `${(node?.name || "unit").split(".").pop()} ${lines}`;
    };
    const shown = sizes.slice(0, 4).map(label).join(" · ");
    const group = {
        id: "group:size",
        title: `Large changes · ${sizes.length} areas`,
        body: `${shown}${sizes.length > 4 ? ` · +${sizes.length - 4} more` : ""}`,
        impact_score: sizes[0].impact_score,
        severity: sizes[0].severity,
        collect_mode: "lines",
    };
    const rest = items.filter((item) => !sizes.includes(item));
    const position = rest.findIndex((item) => (item.impact_score || 0) < (group.impact_score || 0));
    rest.splice(position === -1 ? rest.length : position, 0, group);
    return rest;
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
    clearSelection();
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
            clearSelection();
            render();
        });
        elements.breadcrumbs.append(button);
    }
}

function drillChildren(model, item) {
    const visible = (node) => !state.changedOnly || node.change !== "unchanged";
    if (item.kind === "component") {
        return model.nodes.filter((node) => node.kind === "module" && node.component_id === item.id && visible(node));
    }
    return model.nodes.filter((node) =>
        node.module_id === item.id && ["class", "function", "method"].includes(node.kind) && visible(node));
}

function maybeDrill(item) {
    if (item.kind === "component" || item.kind === "module") {
        const model = state.payload?.model;
        // A module with nothing to drill into (for example a package __init__ that only
        // re-exports names) opens its diff instead of an empty level.
        if (model && item.path && drillChildren(model, item).length === 0) {
            selectItem(item, true);
            return;
        }
        state.stack.push(item);
        clearSelection();
        render();
    } else {
        selectItem(item, true);
    }
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
function field(label, value) {
    if (value === undefined || value === null || value === "") return null;
    const row = el("div", "detail-row");
    row.append(el("span", "", label), el("strong", "", String(value)));
    return row;
}

function renderEmptyDetail() {
    const panel = elements.detail;
    panel.replaceChildren();
    const model = state.payload?.model;
    const top = el("div", "detail-top");
    top.append(el("p", "eyebrow", "CHANGE BRIEF"), el("h2", "", "Where to start"));
    panel.append(top);
    if (!model) {
        panel.append(el("p", "detail-copy", "The brief appears when analysis completes."));
        return;
    }
    const summary = model.summary || {};
    const split = sourceTestChurn(model);
    const ratio = split.source ? split.tests / split.source : 0;
    const grid = el("div", "detail-grid");
    grid.append(
        field("Files", `${summary.files_added || 0} added · ${summary.files_modified || 0} modified · ${summary.files_removed || 0} deleted`),
        field("Source lines", split.source.toLocaleString()),
        field("Test lines", `${split.tests.toLocaleString()} (${ratio.toFixed(2)} per source line)`),
        field("Coverage", model.coverage?.available ? "measured" : "unknown"),
    );
    panel.append(grid);
    ensureBriefIntent(model);
    if (state.briefIntent) {
        panel.append(el("h3", "", "Originating prompt"));
        const origin = el("div", "brief-origin");
        origin.append(promptBlock(state.briefIntent));
        panel.append(origin);
    }
    if (split.source > 50 && ratio < 0.15) {
        panel.append(el("p", "brief-warning", "Little or no test code changed relative to source."));
    }

    const findings = collapseSizeFindings(groupFindings(model.attention || []), model).slice(0, 4);
    if (findings.length) {
        panel.append(el("h3", "", "Highest-impact areas"));
        const list = el("div", "brief-list");
        for (const finding of findings) {
            const button = el("button", "brief-link");
            button.type = "button";
            button.append(el("b", "", String(finding.impact_score ?? "")), el("span", "", finding.title));
            button.title = finding.body || finding.reason || "";
            button.addEventListener("click", () => openReviewItem(finding));
            list.append(button);
        }
        panel.append(list);
    }

    const annotation = state.payload?.annotations?.overview;
    const heading = el("div", "assessment-heading");
    heading.append(el("h3", "", "Copilot change summary"));
    if (annotation?.body) heading.append(copyButton(annotation.body, "Copy summary"));
    panel.append(heading);
    if (annotation?.body) {
        const body = el("div", "annotation-body brief-ai");
        markdownContext.intent = state.briefIntent || null;
        renderMarkdown(body, annotation.body);
        panel.append(body);
    } else if (state.overviewLoading) {
        panel.append(el("p", "annotation-loading", "Copilot is summarizing the whole change…"));
    } else {
        if (state.overviewError) panel.append(el("p", "annotation-error", state.overviewError));
        const generate = el("button", "brief-generate", state.overviewError ? "Retry summary" : "Summarize this change");
        generate.type = "button";
        generate.addEventListener("click", generateOverview);
        panel.append(
            el("p", "muted", "A short narrative of what the change does and the order to review it in."),
            generate,
        );
    }
}

function ensureBriefIntent(model) {
    const complete = Boolean(state.payload?.session_context?.historical_search_complete);
    const key = `${model.metadata?.head_sha}|${complete}`;
    if (state.briefIntentKey === key) return;
    state.briefIntentKey = key;
    const top = (model.changes || [])
        .filter((change) => change.status !== "unchanged" && !isTestPath(change.path))
        .sort((a, b) => (b.lines_added + b.lines_removed) - (a.lines_added + a.lines_removed))[0];
    if (!top) return;
    api(`/api/attribution?path=${encodeURIComponent(top.path)}`)
        .then((result) => {
            state.briefIntent = result.attribution?.[0] || null;
            if (!state.selected) renderEmptyDetail();
        })
        .catch(() => {});
}

async function generateOverview() {
    state.overviewLoading = true;
    state.overviewError = null;
    if (!state.selected) renderEmptyDetail();
    try {
        await api("/api/overview", { method: "POST", body: "{}" });
    } catch (error) {
        state.overviewError = error.message;
    } finally {
        state.overviewLoading = false;
        if (!state.selected) renderEmptyDetail();
    }
}

function clearSelection() {
    state.selectionEpoch += 1;
    state.selected = null;
    markSelectedCards();
    renderEmptyDetail();
}

function setDetailVisible(visible) {
    state.detailVisible = visible;
    document.querySelector(".workspace").classList.toggle("detail-collapsed", !visible);
    elements.detail_toggle.textContent = visible ? "Hide details" : "Show details";
    elements.detail_toggle.setAttribute("aria-pressed", String(visible));
    scheduleResizeRender();
}

async function loadSource(query, epoch, preferredTab = null, nav = "reset") {
    const source = await api(`/api/source?${query}`);
    const attribution = await fetchAttribution(source.path);
    if (epoch !== state.selectionEpoch) return false;
    state.source = source;
    state.attribution = attribution;
    state.sourceTab = preferredTab || (source.diff ? "diff" : "current");
    recordSourceNavigation(nav, { query, tab: state.sourceTab, label: `${source.path}${source.start_line ? `:${source.start_line}` : ""}` });
    renderSource();
    return true;
}

function recordSourceNavigation(mode, entry) {
    const history = state.sourceHistory;
    if (mode === "replay") {
        history.index = history.pending;
        return;
    }
    if (mode === "push" && history.index >= 0) {
        if (history.entries[history.index].query === entry.query) return;
        history.entries.splice(history.index + 1);
        history.entries.push(entry);
        history.index = history.entries.length - 1;
        return;
    }
    history.entries = [entry];
    history.index = 0;
}

function renderSourceNavigation() {
    const history = state.sourceHistory;
    const back = history.entries[history.index - 1];
    const forward = history.entries[history.index + 1];
    elements.source_back.disabled = !back;
    elements.source_forward.disabled = !forward;
    elements.source_back.title = back ? `Back to ${back.label} (Alt+←)` : "Back (Alt+←)";
    elements.source_forward.title = forward ? `Forward to ${forward.label} (Alt+→)` : "Forward (Alt+→)";
}

async function navigateSource(delta) {
    const history = state.sourceHistory;
    const target = history.index + delta;
    const entry = history.entries[target];
    if (!entry) return;
    history.pending = target;
    const epoch = ++state.selectionEpoch;
    try {
        await loadSource(entry.query, epoch, entry.tab, "replay");
    } catch (error) {
        if (epoch === state.selectionEpoch) showError(error);
    }
}

async function fetchAttribution(path) {
    if (!path) return [];
    try {
        const provenance = await api(`/api/attribution?path=${encodeURIComponent(path)}`);
        state.attributionStatus = provenance.status || "matched";
        state.attributionMessage = provenance.message || "";
        return provenance.attribution || [];
    } catch (error) {
        if (error.status !== 404) throw error;
        state.attributionStatus = "no_match";
        state.attributionMessage = "No originating prompt was found.";
        return [];
    }
}

async function refreshAttribution() {
    if (!state.source?.path) {
        state.attribution = [];
        return;
    }
    state.attribution = await fetchAttribution(state.source.path);
}

async function selectFile(change) {
    const epoch = ++state.selectionEpoch;
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
        if (await loadSource(`path=${encodeURIComponent(change.path)}`, epoch)) {
            ensureAnnotation(state.selected, epoch);
        }
    } catch (error) {
        if (epoch === state.selectionEpoch) showError(error);
    }
}

async function selectItem(item, notify = true) {
    const epoch = ++state.selectionEpoch;
    state.selected = item;
    markSelectedCards();
    if (notify) state.appliedServerSelection = item.id;
    renderDetail(item);
    if (notify) api("/api/selection", {
        method: "POST",
        body: JSON.stringify({ id: item.id, kind: item.kind || item.type || "" }),
    }).catch(showError);
    if (item.path || item.start_line || item.kind === "evidence" || item.evidence_ids?.length) {
        try {
            await loadSource(`id=${encodeURIComponent(item.id)}`, epoch);
        } catch (error) {
            if (epoch !== state.selectionEpoch) return;
            state.source = null;
            elements.source_panel.classList.add("hidden");
            if (!String(error.message).includes("has no source location")) showError(error);
        }
    }
    if (epoch !== state.selectionEpoch) return;
    if (item.path || item.evidence_ids?.length || item.node_id || item.edge_id) {
        ensureAnnotation(item, epoch);
    } else {
        renderAnnotation(item, state.payload?.annotations?.[item.id] || null);
    }
}

function ensureAnnotation(item, epoch = state.selectionEpoch) {
    if (epoch !== state.selectionEpoch || state.selected?.id !== item.id) return;
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
        .then(({ annotation }) => {
            if (epoch === state.selectionEpoch && state.selected?.id === item.id) renderAnnotation(item, annotation);
        })
        .catch((error) => {
            if (epoch === state.selectionEpoch && state.selected?.id === item.id) renderAnnotation(item, { error: error.message });
        });
}

function promptBlock(attribution) {
    const fragment = document.createDocumentFragment();
    const prompt = el("p", "provenance-prompt clamped", attribution.prompt);
    fragment.append(prompt);
    const actions = el("div", "provenance-actions");
    if (attribution.prompt.length > 260) {
        const toggle = el("button", "link-button", "Show full prompt");
        toggle.type = "button";
        toggle.addEventListener("click", () => {
            const expanded = prompt.classList.toggle("clamped");
            toggle.textContent = expanded ? "Show full prompt" : "Collapse";
        });
        actions.append(toggle);
    }
    if (attribution.session_id) {
        const openHistory = el("button", "link-button", "Open session history →");
        openHistory.type = "button";
        openHistory.addEventListener("click", () => openSessionHistory(attribution));
        actions.append(openHistory);
    }
    fragment.append(actions);
    return fragment;
}

function renderProvenance() {
    const panel = elements.source_provenance;
    panel.replaceChildren();
    const note = (text, className = "provenance-none") => {
        panel.classList.remove("hidden");
        panel.classList.add("provenance-compact");
        panel.append(el("p", className, text));
    };
    panel.classList.remove("provenance-compact");
    if (!state.attribution.length && state.attributionStatus === "loading") {
        note(state.attributionMessage || "Searching same-repository Copilot sessions…");
        return;
    }
    if (!state.attribution.length && state.attributionStatus === "no_match") {
        note("No originating prompt found in this repository's Copilot sessions.");
        panel.title = "Only Copilot sessions belonging to this Git repository are searched.";
        return;
    }
    if (!state.attribution.length && state.attributionStatus === "error") {
        note(state.attributionMessage, "annotation-error");
        return;
    }
    if (!state.attribution.length) {
        panel.classList.add("hidden");
        return;
    }
    panel.classList.remove("hidden");
    panel.title = "Correlates visible prompts with file/tool activity. It does not expose hidden model reasoning or prove line-level authorship.";
    const primary = state.attribution[0];
    const heading = el("div", "provenance-heading");
    heading.append(
        el("strong", "", "Originating prompt"),
        el("b", `confidence confidence-${primary.confidence}`, `${primary.confidence} match`),
    );
    panel.append(heading, promptBlock(primary), el("p", "source-status", primary.reason));
}

async function openSessionHistory(attribution) {
    try {
        const history = await api(`/api/session-history?session_id=${encodeURIComponent(attribution.session_id)}`);
        state.highlightedPromptEventId = attribution.prompt_event_id;
        elements.session_history_title.textContent = history.summary || "Session transcript";
        elements.session_history_meta.textContent = [
            history.working_directory,
            `${history.timeline.length} visible events`,
        ].filter(Boolean).join(" · ");
        const fragment = document.createDocumentFragment();
        let highlighted = null;
        let tools = [];
        const flushTools = () => {
            if (!tools.length) return;
            const counts = new Map();
            for (const tool of tools) counts.set(tool.tool_name, (counts.get(tool.tool_name) || 0) + 1);
            const edits = tools.filter((tool) => tool.operation === "write").length;
            const group = el("details", "history-tools");
            group.append(el("summary", "", [
                `${tools.length} tool call${tools.length === 1 ? "" : "s"}`,
                edits ? `${edits} edit${edits === 1 ? "" : "s"}` : null,
                [...counts].map(([name, count]) => `${name}×${count}`).join(", "),
            ].filter(Boolean).join(" · ")));
            const list = el("ul", "");
            for (const tool of tools) {
                const item = el("li", tool.operation === "write" ? "tool-write" : "");
                const text = tool.detail || (tool.summary !== tool.tool_name ? tool.summary : "");
                item.append(el("strong", "", tool.tool_name), document.createTextNode(text ? ` ${text}` : ""));
                list.append(item);
            }
            group.append(list);
            fragment.append(group);
            tools = [];
        };
        for (const event of history.timeline) {
            if (event.role === "tool") {
                tools.push(event);
                continue;
            }
            flushTools();
            const row = el("article", `history-row history-${event.role}`);
            row.dataset.eventId = event.event_id;
            if (event.event_id === attribution.prompt_event_id) {
                row.classList.add("history-highlight");
                highlighted = row;
            }
            const heading = el("div", "history-row-heading");
            heading.append(
                el("strong", "", event.role === "user" ? "User prompt" : "Assistant"),
                el("time", "", event.timestamp ? new Date(event.timestamp).toLocaleString() : ""),
            );
            row.append(heading);
            const body = el("div", "history-row-body");
            renderMarkdown(body, event.summary);
            row.append(body);
            fragment.append(row);
        }
        flushTools();
        elements.session_transcript.replaceChildren(fragment);
        elements.session_history_panel.classList.remove("hidden");
        requestAnimationFrame(() => highlighted?.scrollIntoView({ block: "center" }));
    } catch (error) {
        showError(error);
    }
}

function appendInlineMarkdown(container, text) {
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > offset) appendTextWithSourceReferences(container, text.slice(offset, match.index));
        const token = match[0];
        if (token.startsWith("**")) {
            const label = token.slice(2, -2);
            const intent = markdownContext.intent;
            if (intent?.session_id && /^(Stated intent|Requested):?$/i.test(label.trim())) {
                container.append(intentLink(label, intent));
            } else {
                const strong = el("strong", "");
                appendInlineMarkdown(strong, label);
                container.append(strong);
            }
        } else {
            const value = token.slice(1, -1);
            const reference = parseSourceReference(value);
            const symbol = reference ? null : resolveSymbol(value);
            if (reference) {
                container.append(sourceReferenceButton(value, reference));
            } else if (symbol) {
                container.append(sourceReferenceButton(value, {
                    path: symbol.path,
                    lines: [symbol.start_line],
                }, `Open ${symbol.display_name || symbol.name} at ${symbol.path}:${symbol.start_line}`));
            } else {
                container.append(el("code", "inline-code", value));
            }
        }
        offset = match.index + token.length;
    }
    if (offset < text.length) appendTextWithSourceReferences(container, text.slice(offset));
}

function parseSourceReference(value) {
    const match = /^((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:py|toml|txt|json|ya?ml|md|mjs|js|css|html))(?::(\d+(?:,\d+)*))?$/.exec(value.trim());
    if (!match) return null;
    return {
        path: match[1].replaceAll("\\", "/"),
        lines: match[2] ? match[2].split(",").map(Number).filter(Number.isFinite) : [],
    };
}

const markdownContext = { intent: null };
let symbolIndex = { model: null, byName: new Map() };

function resolveSymbol(value) {
    const model = state.payload?.model;
    if (!model) return null;
    if (symbolIndex.model !== model) {
        const byName = new Map();
        for (const node of model.nodes) {
            if (!["class", "function", "method"].includes(node.kind) || !node.path || !node.start_line) continue;
            for (const key of new Set([node.display_name, node.name, node.qualified_name].filter(Boolean))) {
                if (!byName.has(key)) byName.set(key, []);
                byName.get(key).push(node);
            }
        }
        symbolIndex = { model, byName };
    }
    const key = value.trim().replace(/\(.*\)$/, "");
    const candidates = symbolIndex.byName.get(key) || [];
    if (candidates.length === 1) return candidates[0];
    const changed = candidates.filter((node) => node.change !== "unchanged");
    return changed.length === 1 ? changed[0] : null;
}

function intentLink(label, attribution) {
    const button = el("button", "intent-link", label);
    button.type = "button";
    button.title = "Open the originating prompt in the session history";
    button.addEventListener("click", () => openSessionHistory(attribution));
    return button;
}

function sourceReferenceButton(label, reference, title = null) {
    const button = el("button", "source-reference", label);
    button.type = "button";
    button.title = title || (reference.lines.length
        ? `Open ${reference.path} at line ${reference.lines.join(", ")}`
        : `Open ${reference.path}`);
    button.addEventListener("click", async () => {
        const epoch = ++state.selectionEpoch;
        const query = new URLSearchParams({ path: reference.path });
        if (reference.lines[0]) query.set("line", String(reference.lines[0]));
        try {
            await loadSource(query.toString(), epoch, "current", "push");
        } catch (error) {
            if (epoch === state.selectionEpoch) showError(error);
        }
    });
    return button;
}

function appendTextWithSourceReferences(container, text) {
    const pattern = /((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:py|toml|txt|json|ya?ml|md|mjs|js|css|html)(?::\d+(?:,\d+)*)?)/g;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > offset) container.append(document.createTextNode(text.slice(offset, match.index)));
        const reference = parseSourceReference(match[0]);
        container.append(reference ? sourceReferenceButton(match[0], reference) : document.createTextNode(match[0]));
        offset = match.index + match[0].length;
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

function extractRisk(body) {
    const match = /^\s*\*\*Risk:\s*(Low|Medium|High|Critical)\s*(?:—|–|-)\s*(.+?)\*\*\s*$/im.exec(body || "");
    if (!match) return null;
    return {
        level: match[1].toLowerCase(),
        reason: match[2].trim(),
        body: body.replace(match[0], "").replace(/\n{3,}/g, "\n\n"),
    };
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
    heading.append(
        el("span", "annotation-mark", "AI"),
        el("strong", "", item.title || item.name || "Review annotation"),
    );
    if (annotation?.body) heading.append(copyButton(annotation.body, "Copy explanation"));
    panel.append(heading);
    if (loading) {
        panel.append(el("p", "annotation-loading", "Copilot is grounding an explanation in the selected evidence…"));
        return;
    }
    if (annotation.error) {
        panel.append(el("p", "annotation-error", annotation.error));
        return;
    }
    const risk = extractRisk(annotation.body);
    if (risk) {
        const banner = el("div", `risk-banner risk-banner-${risk.level}`);
        banner.append(el("b", "", `${risk.level} risk`), el("span", "", risk.reason));
        panel.append(banner);
    }
    const body = el("div", "annotation-body");
    markdownContext.intent = state.attribution?.[0] || null;
    renderMarkdown(body, risk ? risk.body : annotation.body);
    panel.append(body);
    if (annotation.evidence_ids?.length) {
        const citations = el("details", "annotation-citations");
        citations.append(el("summary", "", `Evidence (${annotation.evidence_ids.length})`));
        const list = el("div", "evidence-list");
        list.append(...annotation.evidence_ids.map(evidenceButton));
        citations.append(list);
        panel.append(citations);
    }
}

function renderDetail(item) {
    setDetailVisible(true);
    const panel = elements.detail;
    panel.replaceChildren();
    const top = el("div", "detail-top");
    const back = el("button", "link-button detail-back", "← Change brief");
    back.type = "button";
    back.addEventListener("click", clearSelection);
    top.append(
        back,
        el("p", "eyebrow", String(item.kind || item.type || "EVIDENCE").replaceAll("_", " ").toUpperCase()),
        el("h2", "", item.display_name || item.name || item.title || item.id),
    );
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
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
        if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[3]);
            const wholeNewFile = oldLine === 0 && Number(hunk[2] ?? 1) === 0;
            if (!wholeNewFile) {
                const length = Number(hunk[4] ?? 1);
                const range = length > 1 ? `${newLine}–${newLine + length - 1}` : String(newLine);
                const context = hunk[5].trim();
                rows.push(codeRow("hunk", "", "", "", `Lines ${range}${context ? ` · ${context}` : ""}`));
            }
            index += 1;
            continue;
        }
        if (/^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode|\\ )/.test(line)) {
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
        focused.forEach((row, index) => {
            if (index === 0) row.classList.add("focus-start");
            if (index === focused.length - 1) row.classList.add("focus-end");
        });
        focused[0]?.scrollIntoView({ block: "center" });
    }
    const annotation = state.payload?.annotations?.[state.selected?.id];
    if (annotation) renderAnnotation(state.selected, annotation);
    renderProvenance();
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === state.sourceTab));
    renderSourceNavigation();
}

function collectionTitle(mode) {
    return {
        files: "Changed files", lines: "Lines changed by module", symbols: "Changed symbols",
        edges: "New relationships", packages: "Package changes", findings: "Ranked findings",
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
    if (mode === "packages") return model.package_changes || [];
    if (mode === "findings") return groupFindings(model.attention || []);
    return [];
}

function renderCollection(model) {
    if (state.mode === "packages") {
        renderPackageView(model);
        return;
    }
    const query = state.query.toLowerCase();
    const items = collectionItems(model, state.mode).filter((item) =>
        !query || `${item.title || ""} ${item.name || ""} ${item.path || ""} ${item.reason || ""}`.toLowerCase().includes(query)
    );
    const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
    const maxChurn = Math.max(1, ...items.map((item) => item.lines_added != null
        ? item.lines_added + item.lines_removed
        : item.metrics?.lines_changed || 0));
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
            subtitle = `+${item.lines_added} / −${item.lines_removed}${isTestPath(item.path) ? " · test code" : ""}`;
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
            title = item.title || item.display_name || item.name;
            subtitle = state.mode === "lines"
                ? `+${item.metrics?.lines_added || 0} / −${item.metrics?.lines_removed || 0}${isTestPath(item.path || "") || /^tests?\./.test(item.name || "") ? " · test code" : ""}`
                : item.reason || `${item.kind || item.change} · +${item.metrics?.lines_added || 0} / −${item.metrics?.lines_removed || 0}`;
            if (state.mode === "lines") {
                row.classList.add(
                    item.change === "added"
                        ? "file-added"
                        : item.change === "removed"
                            ? "file-removed"
                            : "file-modified",
                );
            }
            row.addEventListener("click", () => item.id?.startsWith("package:") ? selectPackage(item) : selectItem(item));
        }
        const copy = el("span", "collection-copy");
        copy.append(el("strong", "", title), el("small", "", subtitle));
        row.append(copy);
        const statusLabel = item.status || item.change;
        if (["files", "lines", "symbols"].includes(state.mode) && ["added", "modified", "removed", "deleted"].includes(statusLabel)) {
            row.append(el("span", `label label-${statusLabel === "deleted" ? "removed" : statusLabel} row-label`, statusLabel === "deleted" ? "removed" : statusLabel));
        }
        if (["files", "lines", "symbols"].includes(state.mode)) {
            const churn = item.lines_added != null
                ? item.lines_added + item.lines_removed
                : item.metrics?.lines_changed || 0;
            const kind = item.status || item.change;
            row.append(churnBar(churn / maxChurn, kind === "deleted" || kind === "removed" ? "removed" : kind === "added" ? "added" : "modified"));
            row.classList.add("has-bar");
        }
        row.append(el("span", "collection-arrow", "→"));
        list.append(row);
    }
    elements.graph.append(list);
}

function packageVersion(item) {
    const declarations = item.declared_current || [];
    const declared = declarations.map((entry) => entry.specifier).filter(Boolean).join(", ");
    return item.resolved_current || declared || "version unspecified";
}

function packageKey(item) {
    return `${item.name}@${packageVersion(item)}`;
}

function packageEntry(item) {
    const key = packageKey(item);
    if (!state.packageData.has(key)) state.packageData.set(key, {});
    return state.packageData.get(key);
}

function openPackage(item) {
    state.mode = "packages";
    state.stack = [];
    state.query = "";
    elements.review_search.value = "";
    state.selected = null;
    render();
    selectPackage(item);
}

function selectPackage(item) {
    state.selectionEpoch += 1;
    state.selected = item;
    markSelectedCards();
    document.querySelectorAll(".package-row").forEach((row) =>
        row.classList.toggle("is-selected", row.dataset.package === item.id));
    renderPackagePanel();
    if (item.change !== "removed") loadPackageData(item);
}

function loadPackageData(item) {
    const entry = packageEntry(item);
    const refresh = () => {
        if (state.selected?.id === item.id) renderPackagePanel();
    };
    const request = (explain) => api("/api/package-risk", {
        method: "POST",
        body: JSON.stringify({ name: item.name, version: item.resolved_current || null, explain }),
    });
    if (!entry.assessment && !entry.assessmentPromise) {
        entry.assessmentError = null;
        entry.assessmentPromise = request(false)
            .then((result) => {
                entry.assessment = result.assessment;
                if (result.explanation) entry.explanation = result.explanation;
            })
            .catch((error) => { entry.assessmentError = error.message; })
            .finally(() => { entry.assessmentPromise = null; refresh(); });
    }
    if (!entry.explanation && !entry.explainPromise) {
        entry.explainError = null;
        entry.explainPromise = request(true)
            .then((result) => {
                entry.assessment ??= result.assessment;
                entry.explanation = result.explanation;
            })
            .catch((error) => { entry.explainError = error.message; })
            .finally(() => { entry.explainPromise = null; refresh(); });
    }
}

function renderPackageView(model) {
    const changes = [...(model.package_changes || [])].sort((a, b) =>
        ["added", "modified", "removed"].indexOf(a.change) - ["added", "modified", "removed"].indexOf(b.change)
        || a.name.localeCompare(b.name));
    elements.graph.replaceChildren();
    if (!changes.length) {
        elements.graph.append(el("p", "collection-empty", "No packages were added, changed, or removed in this review."));
        return;
    }
    const view = el("div", "package-view");
    const list = el("div", "package-list");
    list.append(el("p", "package-list-heading", `${changes.length} package change${changes.length === 1 ? "" : "s"}`));
    for (const item of changes) {
        const row = el("button", `package-row${state.selected?.id === item.id ? " is-selected" : ""}`);
        row.type = "button";
        row.dataset.package = item.id;
        const heading = el("div", "package-row-heading");
        heading.append(el("strong", "", item.name), el("span", `label label-${item.change}`, item.change));
        const usage = item.usage_locations?.length || 0;
        row.append(
            heading,
            el("small", "", `${packageVersionText(item)}${item.change === "removed" ? "" : usage ? ` · used in ${usage} file${usage === 1 ? "" : "s"}` : " · no usages found"}`),
        );
        row.addEventListener("click", () => selectPackage(item));
        list.append(row);
    }
    const panel = el("div", "package-detail");
    panel.id = "package-detail";
    view.append(list, panel);
    elements.graph.append(view);
    const current = changes.find((item) => item.id === state.selected?.id);
    if (current) {
        renderPackagePanel();
    } else {
        selectPackage(changes[0]);
    }
}

function packageVersionText(item) {
    const base = (item.declared_base || []).map((entry) => entry.specifier).filter(Boolean).join(", ");
    const current = item.change === "removed" ? "" : packageVersion(item);
    if (item.change === "modified" && base) return `${base} → ${current}`;
    if (item.change === "removed") return base || "removed";
    return current;
}

function formatDate(value) {
    return value ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
}

function formatCount(value) {
    return Number.isFinite(value) ? value.toLocaleString() : null;
}

function statTile(label, value, detail, tone = "") {
    const tile = el("div", `stat-tile${tone ? ` stat-${tone}` : ""}`);
    tile.append(el("span", "stat-label", label), el("strong", "stat-value", value ?? "Unknown"));
    if (detail) tile.append(el("small", "", detail));
    return tile;
}

function externalLink(label, url) {
    const link = el("a", "external-link", label);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = url;
    return link;
}

function definitionRow(label, content) {
    if (content === null || content === undefined || content === "") return null;
    const row = el("div", "definition-row");
    row.append(el("dt", "", label));
    const value = el("dd", "");
    if (content instanceof Node) value.append(content);
    else value.textContent = String(content);
    row.append(value);
    return row;
}

function packageSection(title, ...children) {
    const section = el("section", "package-section");
    section.append(el("h3", "", title), ...children.filter(Boolean));
    return section;
}

function renderPackagePanel() {
    const host = document.getElementById("package-detail");
    if (!host) return;
    const item = state.selected;
    if (!item?.id?.startsWith("package:")) {
        host.replaceChildren(el("p", "muted", "Select a package to review it."));
        return;
    }
    const entry = packageEntry(item);
    const assessment = entry.assessment;
    const risk = assessment?.risk;
    const sections = [];

    const header = el("header", "package-header");
    const titleRow = el("div", "package-title-row");
    titleRow.append(el("h2", "", item.name), el("span", `label label-${item.change}`, item.change));
    const declared = (item.declared_current?.[0] || item.declared_base?.[0]);
    header.append(
        titleRow,
        el("p", "muted", [
            packageVersionText(item),
            declared?.source ? `declared in ${declared.source}` : null,
            declared?.group ? `${declared.group} dependency` : null,
        ].filter(Boolean).join(" · ")),
    );
    sections.push(header);

    if (item.change === "removed") {
        sections.push(el("p", "flash flash-attention", "This dependency was removed. Check that nothing in the repository still imports it."));
        host.replaceChildren(...sections);
        return;
    }

    if (risk) {
        const banner = el("div", `flash flash-${risk.level === "low" ? "success" : risk.level === "unknown" ? "neutral" : risk.level === "medium" ? "attention" : "danger"}`);
        banner.append(el("strong", "", `${risk.level} risk${risk.score != null ? ` · ${risk.score}/100` : ""}`));
        if (risk.reasons?.length) {
            const reasons = el("ul", "");
            reasons.append(...risk.reasons.map((reason) => el("li", "", reason)));
            banner.append(reasons);
        }
        sections.push(banner);
    } else if (entry.assessmentError) {
        sections.push(el("p", "flash flash-danger", entry.assessmentError));
    } else {
        sections.push(el("p", "flash flash-neutral", "Checking PyPI, OSV, OpenSSF Scorecard, and download statistics…"));
    }

    // Copilot explanation
    const why = el("div", "annotation-body");
    if (entry.explanation) {
        markdownContext.intent = null;
        renderMarkdown(why, entry.explanation);
    } else if (entry.explainError) {
        why.append(el("p", "annotation-error", entry.explainError));
        const retry = el("button", "link-button", "Retry");
        retry.type = "button";
        retry.addEventListener("click", () => {
            entry.explainError = null;
            loadPackageData(item);
            renderPackagePanel();
        });
        why.append(retry);
    } else {
        why.append(el("p", "annotation-loading", "Copilot is explaining why this package was added and what uses it…"));
    }
    const whyHeading = el("div", "package-section-heading");
    whyHeading.append(el("h3", "", "Copilot assessment"));
    if (entry.explanation) whyHeading.append(copyButton(entry.explanation, "Copy assessment"));
    const whySection = el("section", "package-section");
    whySection.append(whyHeading, why);
    sections.push(whySection);

    // Usage
    const usage = item.usage_locations || [];
    const usageList = el("ul", "usage-list");
    for (const location of usage) {
        const reference = parseSourceReference(location);
        const row = el("li", "");
        row.append(reference ? sourceReferenceButton(location, reference) : el("code", "inline-code", location));
        usageList.append(row);
    }
    sections.push(packageSection(
        `Used by (${usage.length})`,
        usage.length ? usageList : el("p", "flash flash-attention", "No import of this package was found in the repository. It may be unused or loaded dynamically."),
    ));

    if (assessment) {
        const indicators = assessment.indicators || {};
        const maintenance = indicators.maintenance || {};
        const vulns = indicators.known_vulnerabilities || [];
        const score = indicators.scorecard_score;
        const tiles = el("div", "stat-grid");
        tiles.append(
            statTile("Known vulnerabilities", formatCount(indicators.vulnerability_count),
                indicators.vulnerability_history_count != null ? `${indicators.vulnerability_history_count} in release history` : null,
                indicators.vulnerability_count > 0 ? "danger" : indicators.vulnerability_count === 0 ? "success" : ""),
            statTile("OpenSSF Scorecard", score != null ? `${score}/10` : null, score != null ? null : "No scorecard published",
                score == null ? "" : score >= 7 ? "success" : score >= 4 ? "attention" : "danger"),
            statTile("Maintenance", maintenance.status ? maintenance.status : null,
                `${maintenance.releases_last_12_months ?? 0} releases in 12 months${maintenance.latest_release_date ? ` · latest ${formatDate(maintenance.latest_release_date)}` : ""}`,
                maintenance.status === "active" ? "success" : maintenance.status === "stale" ? "attention" : maintenance.status === "dormant" ? "danger" : ""),
            statTile("Downloads (last month)", formatCount(indicators.recent_downloads), null),
            statTile("Installed version", assessment.version,
                `${indicators.release_age_days != null ? `${indicators.release_age_days} days old` : "age unknown"}${indicators.latest_version ? ` · latest ${indicators.latest_version}` : ""}${indicators.yanked ? " · YANKED" : ""}`,
                indicators.yanked ? "danger" : ""),
        );
        const scorecardParts = [tiles];
        if (vulns.length) {
            const list = el("ul", "vuln-list");
            for (const vulnerability of vulns.slice(0, 5)) {
                const row = el("li", "");
                const id = String(vulnerability.id || "");
                row.append(/^[A-Za-z0-9._-]{3,60}$/.test(id) ? externalLink(id, `https://osv.dev/vulnerability/${id}`) : document.createTextNode(id));
                row.append(document.createTextNode(` ${vulnerability.severity ? `· ${vulnerability.severity}` : ""}${vulnerability.summary ? ` · ${vulnerability.summary}` : ""}`));
                list.append(row);
            }
            scorecardParts.push(list);
        }
        const weakChecks = (indicators.scorecard_checks || [])
            .filter((check) => check.score != null && check.score >= 0 && check.score < 5)
            .sort((a, b) => a.score - b.score)
            .slice(0, 4);
        if (weakChecks.length) {
            const list = el("ul", "check-list");
            for (const check of weakChecks) list.append(el("li", "", `${check.name}: ${check.score}/10`));
            scorecardParts.push(el("p", "muted", "Weakest Scorecard checks"), list);
        }
        sections.push(packageSection("Security scorecard", ...scorecardParts));

        const provenance = indicators.provenance;
        if (provenance) {
            const list = el("dl", "definition-list");
            const repository = indicators.repository_url ? externalLink(indicators.repository_url.replace(/^https:\/\//, ""), indicators.repository_url) : null;
            const otherLinks = (provenance.links || []).filter((link) => link.url !== indicators.repository_url);
            const links = otherLinks.length ? el("span", "link-cluster") : null;
            otherLinks.forEach((link, index) => {
                if (index) links.append(document.createTextNode(" · "));
                links.append(externalLink(link.label, link.url));
            });
            for (const row of [
                definitionRow("Summary", provenance.summary),
                definitionRow("Author", provenance.author),
                definitionRow("Maintainer", provenance.maintainer),
                definitionRow("License", provenance.license),
                definitionRow("Source repository", repository),
                definitionRow("Registry", externalLink(provenance.pypi_url.replace(/^https:\/\//, ""), provenance.pypi_url)),
                definitionRow("Homepage", provenance.homepage ? externalLink(provenance.homepage.replace(/^https?:\/\//, ""), provenance.homepage) : null),
                definitionRow("Other links", links),
                definitionRow("First release", formatDate(provenance.first_release_date)),
                definitionRow("Releases", provenance.release_count ? String(provenance.release_count) : null),
                definitionRow("Requires Python", provenance.requires_python),
            ]) if (row) list.append(row);
            sections.push(packageSection("Provenance", list));
        }
        const statuses = Object.entries(assessment.sources || {})
            .map(([name, source]) => `${name}: ${source.status}`);
        sections.push(el("p", "source-status", `Public data: ${statuses.join(" · ")}. Only the package name and version are sent.`));
    }
    host.replaceChildren(...sections);
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
    renderCards(elements.attention, collapseSizeFindings(groupedObservations, model).slice(0, 12), "No deterministic attention findings.");
    if (groupedObservations.length > 12) {
        const viewAll = el("button", "view-all", `View all ${groupedObservations.length} ranked findings →`);
        viewAll.type = "button";
        viewAll.addEventListener("click", () => {
            state.mode = "findings";
            state.stack = [];
            clearSelection();
            render();
            elements.graph.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        elements.attention.append(viewAll);
    }
    renderCards(elements.packages, model.package_changes || [], "No package changes.");
    const hasPackageChanges = (model.package_changes || []).length > 0;
    elements.packages.classList.toggle("hidden", !hasPackageChanges);
    elements.packages.previousElementSibling?.classList.toggle("hidden", !hasPackageChanges);

    const parent = state.stack.at(-1);
    document.querySelector(".workspace").classList.toggle("package-mode", state.mode === "packages");
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
        elements.graph_title.textContent = "Changed module relationships";
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
    // Apply a server-side selection (an agent focus_item call) once; re-applying it on every render would override the user's own choice.
    if (payload.selection?.id && payload.selection.id !== state.appliedServerSelection && state.selected?.id !== payload.selection.id) {
        state.appliedServerSelection = payload.selection.id;
        const all = [...model.nodes, ...model.edges, ...(model.package_changes || []), ...(model.attention || []), ...(payload.generated_observations || [])];
        const selected = all.find((item) => item.id === payload.selection.id) || { id: payload.selection.id, kind: "evidence" };
        state.selected = selected;
        renderDetail(selected);
    }
    if (state.selected && payload.annotations?.[state.selected.id]) {
        renderAnnotation(state.selected, payload.annotations[state.selected.id]);
    }
    if (!state.selected) renderEmptyDetail();
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
        clearSelection();
        state.source = null;
        state.query = "";
        elements.review_search.value = "";
        elements.source_panel.classList.add("hidden");
        render();
    }
});
elements.changed_only.addEventListener("change", () => {
    state.changedOnly = elements.changed_only.checked;
    clearSelection();
    render();
});
elements.detail_close.addEventListener("click", () => setDetailVisible(false));
elements.detail_toggle.addEventListener("click", () => setDetailVisible(!state.detailVisible));
elements.review_search.addEventListener("input", () => {
    state.query = elements.review_search.value.trim();
    clearSelection();
    render();
});
window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.session_history_panel.classList.contains("hidden")) {
        elements.session_history_close.click();
        return;
    }
    if (event.key === "Escape" && !elements.source_panel.classList.contains("hidden")) {
        elements.source_close.click();
        return;
    }
    if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key) && !elements.source_panel.classList.contains("hidden")) {
        event.preventDefault();
        navigateSource(event.key === "ArrowLeft" ? -1 : 1);
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
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (state.payload?.model) render();
        }));
    }, 100);
}
function layoutSignature() {
    const graphRect = elements.graph.getBoundingClientRect();
    return [
        document.documentElement.clientWidth,
        document.documentElement.clientHeight,
        window.visualViewport?.width ?? window.innerWidth,
        window.visualViewport?.height ?? window.innerHeight,
        Math.round(graphRect.width),
        Math.round(graphRect.height),
    ].join(":");
}
let lastLayoutSignature = layoutSignature();
function detectHostResize() {
    const signature = layoutSignature();
    if (signature === lastLayoutSignature) return;
    lastLayoutSignature = signature;
    scheduleResizeRender();
}
window.addEventListener("resize", detectHostResize);
window.addEventListener("focus", detectHostResize);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) detectHostResize();
});
window.visualViewport?.addEventListener("resize", detectHostResize);
const resizeObserver = new ResizeObserver(detectHostResize);
resizeObserver.observe(document.documentElement);
resizeObserver.observe(document.body);
resizeObserver.observe(elements.graph);
setInterval(detectHostResize, 500);

let railResizeStart = null;
function setRailWidth(width) {
    const workspaceWidth = document.querySelector(".workspace")?.clientWidth || window.innerWidth;
    const maximum = Math.max(260, Math.min(520, workspaceWidth - 420));
    const value = Math.max(190, Math.min(maximum, width));
    document.documentElement.style.setProperty("--review-rail-width", `${value}px`);
    localStorage.setItem("agent-review:rail-width", String(value));
    scheduleResizeRender();
}
const savedRailWidth = Number(localStorage.getItem("agent-review:rail-width"));
if (Number.isFinite(savedRailWidth) && savedRailWidth > 0) setRailWidth(savedRailWidth);
elements.rail_resize.addEventListener("pointerdown", (event) => {
    const rail = document.querySelector(".rail");
    railResizeStart = { x: event.clientX, width: rail.getBoundingClientRect().width };
    elements.rail_resize.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-rail");
});
elements.rail_resize.addEventListener("pointermove", (event) => {
    if (!railResizeStart || !elements.rail_resize.hasPointerCapture(event.pointerId)) return;
    setRailWidth(railResizeStart.width + event.clientX - railResizeStart.x);
});
elements.rail_resize.addEventListener("pointerup", (event) => {
    railResizeStart = null;
    elements.rail_resize.releasePointerCapture(event.pointerId);
    document.body.classList.remove("resizing-rail");
});
elements.rail_resize.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const current = document.querySelector(".rail").getBoundingClientRect().width;
    setRailWidth(current + (event.key === "ArrowRight" ? 20 : -20));
});
elements.source_close.addEventListener("click", () => {
    state.selectionEpoch += 1;
    state.source = null;
    state.attribution = [];
    state.sourceHistory = { entries: [], index: -1, pending: -1 };
    elements.source_panel.classList.add("hidden");
});
elements.source_back.addEventListener("click", () => navigateSource(-1));
elements.source_forward.addEventListener("click", () => navigateSource(1));
window.addEventListener("mouseup", (event) => {
    if ((event.button !== 3 && event.button !== 4) || elements.source_panel.classList.contains("hidden")) return;
    event.preventDefault();
    navigateSource(event.button === 3 ? -1 : 1);
});
elements.session_history_close.addEventListener("click", () => {
    elements.session_history_panel.classList.add("hidden");
    elements.session_transcript.replaceChildren();
    state.highlightedPromptEventId = null;
});
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    state.sourceTab = tab.dataset.tab;
    const current = state.sourceHistory.entries[state.sourceHistory.index];
    if (current) current.tab = state.sourceTab;
    renderSource();
}));

api("/api/state").then((payload) => {
    state.payload = payload;
    render();
}).catch(showError);
function connectEvents() {
    const events = new EventSource("/events");
    events.addEventListener("state", (event) => {
        state.payload = JSON.parse(event.data);
        render();
        if (state.payload.type === "session-history" && state.source?.path) {
            const epoch = state.selectionEpoch;
            refreshAttribution().then(() => {
                if (epoch !== state.selectionEpoch) return;
                renderProvenance();
                const annotation = state.payload.annotations?.[state.selected?.id];
                if (annotation) renderAnnotation(state.selected, annotation);
            }).catch(showError);
        }
    });
    events.onerror = () => {
        elements.status.textContent = "Reconnecting…";
        elements.status.classList.add("working");
        // The host can restart the provider that serves this page; a replacement serves the
        // same URL, so keep retrying instead of leaving the page permanently stale.
        if (events.readyState === EventSource.CLOSED) {
            events.close();
            setTimeout(connectEvents, 2000);
        }
    };
}
connectEvents();
