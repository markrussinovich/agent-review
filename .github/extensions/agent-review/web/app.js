import { renderGraph } from "/graph.js";
import { findingsForNode, findingKey, isFindingClosed, orderFindings } from "/findings.mjs";
import { resolveSymbolReference } from "/symbol-links.mjs";
import { packageEvidenceLinks } from "/package-presentation.mjs";
import { resolveSourceReference } from "/source-references.mjs";

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
    detailVisible: false,
    sourceHistory: { entries: [], index: -1, pending: -1 },
    appliedServerSelection: null,
    closedFindingKeys: new Set(),
    customOpenKeys: new Set(),
};
const elements = Object.fromEntries([
    "review-target-form", "review-mode", "review-ref", "review-apply", "review-target-label", "repository-identity", "review-more", "review-options-status", "review-picker-notice", "change-brief",
    "status", "refresh", "error", "analysis-progress", "progress-phase", "progress-message", "progress-percent",
    "progress-bar", "summary", "breadcrumbs", "attention", "attention-count", "packages", "rail-resize",
    "graph", "level-label", "graph-title", "zoom-out", "changed-only", "review-search", "detail-toggle", "detail", "detail-close", "source-panel", "source-title",
    "source-provenance", "source-annotation", "source-close", "source", "source-back", "source-forward",
    "session-history-panel", "session-history-title", "session-history-meta", "session-history-close", "session-transcript",
    "custom-analyses", "custom-results", "custom-manage", "prompt-manager", "prompt-manager-close",
    "prompt-manager-error", "prompt-library", "prompt-editor", "prompt-editor-title", "prompt-scope",
    "prompt-title", "prompt-text", "prompt-enabled", "prompt-save", "prompt-new",
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
        if (item.impact_score != null) {
            const priority = el("b", "impact-score", `Priority ${item.impact_score}/100`);
            priority.title = "Review priority based on change impact. This is not a vulnerability count or package security score.";
            heading.append(priority);
        }
        card.append(heading, el("span", "card-body", item.id?.startsWith("package:") ? `${item.change} · Version ${packageVersionText(item)}` : item.body || item.reason || item.change || ""));
        if (item.impact_factors?.length) card.append(el("small", "factor-line", item.impact_factors.join(" · ")));
        card.dataset.itemId = item.id;
        card.classList.toggle("is-selected", state.selected?.id === item.id);
        card.title = [item.title, item.body || item.reason].filter(Boolean).join("\n");
        card.addEventListener("click", () => openReviewItem(item));
        if (container === elements.attention) {
            const closed = isFindingClosed(item, state.closedFindingKeys);
            const wrapper = el("div", `queue-item${closed ? " is-closed" : ""}`);
            wrapper.dataset.itemId = item.id;
            const toggle = el("button", "queue-toggle", closed ? "Reopen" : "Close");
            toggle.type = "button";
            toggle.setAttribute("aria-label", `${closed ? "Reopen" : "Close"} ${item.title || item.name}`);
            toggle.addEventListener("click", () => toggleFinding(item));
            if (closed) heading.append(el("span", "closed-label", "Closed"));
            wrapper.append(card, toggle);
            container.append(wrapper);
        } else {
            container.append(card);
        }
    }
}

function loadClosedFindingKeys(model) {
    const meta = model.metadata || {};
    const key = `agent-review.closed:${JSON.stringify([meta.repo_root, meta.base_sha, meta.head_sha, state.payload.review_target?.mode])}`;
    if (state.closedFindingStorageKey === key) return;
    state.closedFindingStorageKey = key;
    state.queueError = null;
    try {
        const values = JSON.parse(localStorage.getItem(key) || "[]");
        if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new Error("Invalid saved finding state.");
        state.closedFindingKeys = new Set(values);
    } catch (error) {
        state.closedFindingKeys = new Set();
        state.queueError = `Unable to restore closed findings: ${error.message}`;
    }
}

function toggleFinding(item) {
    const keys = new Set(state.closedFindingKeys);
    const closed = isFindingClosed(item, keys);
    for (const member of item.members || [item]) {
        if (closed) keys.delete(findingKey(member));
        else keys.add(findingKey(member));
    }
    try {
        localStorage.setItem(state.closedFindingStorageKey, JSON.stringify([...keys]));
        state.closedFindingKeys = keys;
        state.queueError = null;
        render();
    } catch (error) {
        state.queueError = `Unable to save closed findings: ${error.message}`;
        showError(new Error(state.queueError));
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
        members: sizes,
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
    for (const node of byId.values()) {
        for (const finding of findingsForNode(model, node, findings).filter((item) => !isFindingClosed(item, state.closedFindingKeys))) {
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

function renderScopeFindings(model, parent, findings) {
    if (!parent) return;
    const scoped = findingsForNode(model, parent, findings);
    if (!scoped.length) return;
    const section = el("section", "scope-findings");
    section.setAttribute("aria-label", "Findings in this scope");
    const closedCount = scoped.filter((item) => isFindingClosed(item, state.closedFindingKeys)).length;
    section.append(el("h3", "", `${scoped.length - closedCount} active${closedCount ? ` · ${closedCount} closed` : ""} review findings in ${parent.name}`));
    const nodes = new Map(model.nodes.map((node) => [node.id, node]));
    for (const finding of scoped) {
        const target = nodes.get(finding.node_id);
        const row = el("button", "scope-finding");
        row.type = "button";
        row.dataset.findingId = finding.id;
        row.classList.toggle("is-closed", isFindingClosed(finding, state.closedFindingKeys));
        row.append(el("strong", "", finding.title || finding.type),
            el("span", "", target.id === parent.id ? `${parent.kind}-level` : target.display_name || target.name));
        row.addEventListener("click", () => selectItem(finding, true));
        section.append(row);
    }
    elements.graph.prepend(section);
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
    const content = el("strong", "");
    if (value instanceof Node) content.append(value);
    else content.textContent = String(value);
    row.append(el("span", "", label), content);
    return row;
}

function renderChangeBrief() {
    const panel = elements.change_brief;
    panel.replaceChildren();
    const model = state.payload?.model;
    const top = el("div", "detail-top");
    top.append(el("h2", "", "Change brief"));
    panel.append(top);
    if (!model) {
        panel.append(el("p", "detail-copy", "The brief appears when analysis completes."));
        return;
    }
    const summary = model.summary || {};
    const split = sourceTestChurn(model);
    const ratio = split.source ? split.tests / split.source : 0;
    const grid = el("div", "detail-grid");
    const fileCounts = el("span", "brief-file-counts");
    fileCounts.append(
        el("span", "change-added", `${summary.files_added || 0} added`),
        document.createTextNode(" · "),
        el("span", "change-modified", `${summary.files_modified || 0} modified`),
        document.createTextNode(" · "),
        el("span", "change-removed", `${summary.files_removed || 0} deleted`),
    );
    grid.append(
        field("Files", fileCounts),
        field("Source lines", split.source.toLocaleString()),
        field("Test lines", `${split.tests.toLocaleString()} (${ratio.toFixed(2)} per source line)`),
        field("Coverage", model.coverage?.available ? "measured" : "unknown"),
    );
    panel.append(grid);
    ensureBriefIntent(model);
    if (split.source > 50 && ratio < 0.15) {
        panel.append(el("p", "brief-warning", "Little or no test code changed relative to source."));
    }

    const annotation = state.payload?.annotations?.overview;
    const heading = el("div", "assessment-heading");
    heading.append(el("h3", "", "Copilot change summary"));
    if (annotation?.body) heading.append(copyButton(annotation.body, "Copy summary"));
    panel.append(heading);
    if (annotation?.body) {
        const body = el("div", "annotation-body brief-ai");
        markdownContext.intent = state.briefIntent || null;
        markdownContext.subject = null;
        renderMarkdown(body, annotation.body);
        const sections = [];
        let section = null;
        for (const child of [...body.children]) {
            if (child.tagName === "H2" || !section) {
                section = el("section", "brief-ai-section");
                sections.push(section);
            }
            section.append(child);
        }
        body.replaceChildren(...sections);
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
    if (state.briefIntent) {
        const origin = el("details", "brief-origin");
        origin.append(el("summary", "", "Originating prompt"), promptBlock(state.briefIntent));
        panel.append(origin);
    }
}

function renderEmptyDetail() {
    elements.detail.replaceChildren(el("p", "detail-copy", "Select a finding or code area to inspect its evidence."));
}

function ensureBriefIntent(model) {
    const complete = Boolean(state.payload?.session_context?.historical_search_complete);
    const key = `${state.summaryKey}|${complete}`;
    if (state.briefIntentKey === key) return;
    state.briefIntentKey = key;
    const top = (model.changes || [])
        .filter((change) => change.status !== "unchanged" && !isTestPath(change.path))
        .sort((a, b) => (b.lines_added + b.lines_removed) - (a.lines_added + a.lines_removed))[0];
    if (!top) return;
    api(`/api/attribution?path=${encodeURIComponent(top.path)}`)
        .then((result) => {
            if (state.briefIntentKey !== key) return;
            state.briefIntent = result.attribution?.[0] || null;
            renderChangeBrief();
        })
        .catch(() => {});
}

async function generateOverview() {
    if (state.overviewLoading) return;
    const key = state.summaryKey;
    state.overviewLoading = true;
    state.overviewError = null;
    renderChangeBrief();
    try {
        const result = await api("/api/overview", { method: "POST", body: "{}" });
        if (state.summaryKey === key) state.payload.annotations.overview = result.annotation;
    } catch (error) {
        if (state.summaryKey === key) state.overviewError = error.message;
    } finally {
        if (state.summaryKey === key) {
            state.overviewLoading = false;
            renderChangeBrief();
        }
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
    state.sourceTab = source.declaration_highlight?.side === "base" ? "base"
        : preferredTab || (source.diff ? "diff" : "current");
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

function promptBlock(attribution, useOriginal = true) {
    if (useOriginal && attribution.original_prompt) {
        attribution = { ...attribution, prompt: attribution.original_prompt, prompt_event_id: attribution.original_prompt_event_id };
    }
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
        note(state.attributionMessage || "No originating prompt found in this repository's Copilot sessions.");
        panel.title = "Only this repository's sessions are searched; historical reviews exclude activity after the selected commit.";
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
    if (primary.original_prompt && primary.original_prompt !== primary.prompt) {
        const latest = el("details", "brief-origin");
        latest.append(el("summary", "", "Latest file-specific request"), promptBlock(primary, false));
        panel.append(latest);
    }
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
            markdownContext.subject = null;
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
            const symbol = reference ? null : resolveSymbolReference(state.payload?.model, value, markdownContext.subject);
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
    return resolveSourceReference(value, state.payload?.model);
}

const markdownContext = { intent: null, subject: null };

function intentLink(label, attribution) {
    const button = el("button", "intent-link", label);
    button.type = "button";
    button.title = "Open the originating prompt in the session history";
    button.addEventListener("click", () => openSessionHistory(attribution.original_prompt_event_id
        ? { ...attribution, prompt_event_id: attribution.original_prompt_event_id } : attribution));
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
        const packageName = reference.packageName || (state.selected?.id?.startsWith("package:")
            && [...(state.selected.declared_current || []), ...(state.selected.declared_base || [])].some((item) => item.source === reference.path)
            ? state.selected.name : null);
        if (packageName) query.set("package", packageName);
        try {
            await loadSource(query.toString(), epoch, "current", "push");
        } catch (error) {
            if (epoch === state.selectionEpoch) showError(error);
        }
    });
    return button;
}

function appendTextWithSourceReferences(container, text) {
    const pattern = /((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:py|toml|txt|json|ya?ml|md|mjs|js|css|html)(?::\d+(?:-\d+)?(?:,\d+(?:-\d+)*)*)?)/g;
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
    markdownContext.subject = state.payload?.model?.nodes.find((node) => node.id === (item.node_id || item.id)) || null;
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
                const highlight = state.source.declaration_highlight;
                const highlightLine = highlight?.side === "base" ? oldLine : newLine;
                if (highlight && highlightLine >= highlight.line && highlightLine <= highlight.end_line
                    && (state.sourceTab === highlight.side || state.sourceTab === "diff")
                    && Number.isInteger(highlight.start_column) && Number.isInteger(highlight.end_column)) {
                    const code = row.querySelector("code");
                    const characters = [...code.textContent];
                    const from = highlightLine === highlight.line ? highlight.start_column : 0;
                    const to = highlightLine === highlight.end_line ? highlight.end_column : characters.length;
                    const token = el("mark", "package-reference-highlight",
                        characters.slice(from, to).join(""));
                    code.replaceChildren(document.createTextNode(characters.slice(0, from).join("")),
                        token, document.createTextNode(characters.slice(to).join("")));
                }
            }
        }
        focused.forEach((row, index) => {
            if (index === 0) row.classList.add("focus-start");
            if (index === focused.length - 1) row.classList.add("focus-end");
        });
        focused[0]?.scrollIntoView({ block: "center" });
    }
    const annotation = state.payload?.annotations?.[state.selected?.id];
    const selectedPath = state.selected?.path || state.payload?.model?.nodes?.find((node) =>
        node.id === (state.selected?.node_id || state.selected?.id))?.path;
    if (annotation && selectedPath === state.source.path) renderAnnotation(state.selected, annotation);
    else elements.source_annotation.classList.add("hidden");
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
    if (mode === "findings") return orderFindings(groupFindings(model.attention || []), state.closedFindingKeys);
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
        if (state.mode === "findings" && isFindingClosed(item, state.closedFindingKeys)) {
            row.classList.add("is-closed");
            row.append(el("span", "closed-label", "Closed"));
        }
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

function statTile(label, value, detail, tone = "", href = null) {
    const tile = el("div", `stat-tile${tone ? ` stat-${tone}` : ""}`);
    const heading = el("span", "stat-label");
    heading.append(href ? externalLink(label, href) : document.createTextNode(label));
    const number = el("strong", "stat-value");
    number.append(href && value != null ? externalLink(value, href) : document.createTextNode(value ?? "Unknown"));
    tile.append(heading, number);
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
            `Version ${packageVersionText(item)}`,
            declared?.source ? `declared in ${declared.source}` : null,
            declared?.group ? `${declared.group} dependency` : null,
        ].filter(Boolean).join(" · ")),
    );
    sections.push(header);
    const declaration = el("p", "package-declaration-note");
    declaration.append(document.createTextNode(`Reported because a dependency declaration was ${item.change} in `));
    if (declared?.source) declaration.append(sourceReferenceButton(declared.source, { path: declared.source, lines: [], packageName: item.name }));
    else declaration.append(document.createTextNode("the package manifest"));
    declaration.append(document.createTextNode(". Manifest changes are reviewed even when no Python import is found."));
    sections.push(declaration);

    if (item.change === "removed") {
        sections.push(el("p", "flash flash-attention", "This dependency was removed. Check that nothing in the repository still imports it."));
        host.replaceChildren(...sections);
        return;
    }

    if (risk) {
        const banner = el("div", `flash flash-${risk.level === "low" ? "success" : risk.level === "unknown" ? "neutral" : risk.level === "medium" ? "attention" : "danger"}`);
        banner.append(el("strong", "", `Dependency risk: ${risk.level}${risk.score != null ? ` · risk score ${risk.score}/100` : ""}`));
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
        markdownContext.subject = null;
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
        `Python import locations (${usage.length})`,
        usage.length ? usageList : el("p", "flash flash-attention", "No Python import was mapped to this declaration. This is a manifest change, not an observed import. Verify why the dependency is needed: it may support tooling, dynamic loading, use a different import name, or be unused."),
    ));

    if (assessment) {
        const indicators = assessment.indicators || {};
        const maintenance = indicators.maintenance || {};
        const vulns = indicators.known_vulnerabilities || [];
        const score = indicators.scorecard_score;
        const links = packageEvidenceLinks(item.name, assessment.version, indicators.repository_url);
        const tiles = el("div", "stat-grid");
        tiles.append(
            statTile("Known vulnerabilities", formatCount(indicators.vulnerability_count),
                indicators.vulnerability_history_count != null ? `${indicators.vulnerability_history_count} in release history` : null,
                indicators.vulnerability_count > 0 ? "danger" : indicators.vulnerability_count === 0 ? "success" : "", links.vulnerabilities),
            statTile("OpenSSF Scorecard", score != null ? `${score}/10` : null, score != null ? null : "No scorecard published",
                score == null ? "" : score >= 7 ? "success" : score >= 4 ? "attention" : "danger", links.scorecard),
            statTile("Maintenance", maintenance.status ? maintenance.status : null,
                `${maintenance.releases_last_12_months ?? 0} releases in 12 months${maintenance.latest_release_date ? ` · latest ${formatDate(maintenance.latest_release_date)}` : ""}`,
                maintenance.status === "active" ? "success" : maintenance.status === "stale" ? "attention" : maintenance.status === "dormant" ? "danger" : "", links.maintenance),
            statTile("Downloads (last month)", formatCount(indicators.recent_downloads), null, "", links.downloads),
            statTile("Reviewed version", assessment.version,
                `${indicators.release_age_days != null ? `${indicators.release_age_days} days old` : "age unknown"}${indicators.latest_version ? ` · latest ${indicators.latest_version}` : ""}${indicators.yanked ? " · YANKED" : ""}`,
                indicators.yanked ? "danger" : "", links.release),
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
            for (const check of weakChecks) {
                const row = el("li", "");
                row.append(externalLink(check.name, `https://github.com/ossf/scorecard/blob/main/docs/checks.md#${encodeURIComponent(check.name.toLowerCase())}`),
                    document.createTextNode(`: ${check.score}/10`));
                list.append(row);
            }
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
        const statuses = el("ul", "source-status evidence-sources");
        const sourceUrls = { pypi: links.registry, osv: links.vulnerabilities, osv_history: links.vulnerabilities,
            scorecard: links.scorecard, pypistats: links.downloads };
        for (const [name, source] of Object.entries(assessment.sources || {})) {
            const row = el("li", `source-${source.status}`);
            row.append(sourceUrls[name] ? externalLink(name, sourceUrls[name]) : document.createTextNode(name),
                document.createTextNode(`: ${source.status}${source.error ? ` — ${source.error}` : ""}`));
            statuses.append(row);
        }
        sections.push(statuses, el("p", "source-status", "Public lookups send only the package name/version and its public repository URL."));
    }
    host.replaceChildren(...sections);
}
function renderCustomAnalyses() {
    elements.custom_analyses.classList.toggle("hidden", !state.payload?.model || state.reviewPickerPending);
    const records = state.customPrompts || [];
    const children = [];
    const error = state.customLibraryError || state.payload?.custom_prompt_error;
    if (error) children.push(el("p", "error", error));
    for (const prompt of records.filter((record) => record.enabled)) {
        const key = `${prompt.scope}:${prompt.id}:${prompt.revision}`;
        const result = state.payload?.custom_analyses?.[key];
        const details = el("details", "custom-result");
        details.open = state.customOpenKeys.has(key);
        details.addEventListener("toggle", () => {
            if (!details.isConnected) return;
            if (details.open) state.customOpenKeys.add(key);
            else state.customOpenKeys.delete(key);
        });
        const summary = el("summary", "");
        summary.append(el("strong", "", prompt.title), el("span", `custom-status custom-${result?.status || "waiting"}`,
            !prompt.trusted ? "Approval required" : result?.status || "Waiting"));
        details.append(summary, el("p", "muted", `${prompt.scope === "global" ? "All repositories" : "This repository"} · Saved snapshot · AI-generated, verify claims`));
        if (result?.content) {
            markdownContext.subject = null;
            markdownContext.intent = null;
            const body = el("div", "annotation-body");
            renderMarkdown(body, result.content);
            details.append(body);
        }
        if (result?.error) details.append(el("p", "error", result.error));
        const rerun = el("button", "", result ? "Run again" : "Run now");
        rerun.type = "button";
        rerun.disabled = !prompt.trusted || state.payload.loading || ["queued", "running"].includes(result?.status);
        rerun.addEventListener("click", () => runCustomAnalyses({ scope: prompt.scope, id: prompt.id, force: true }));
        details.append(rerun);
        children.push(details);
    }
    if (!children.length) children.push(el("p", "muted custom-empty", records.length
        ? "All custom prompts are disabled." : "Add repository-specific or global checks with Manage prompts."));
    elements.custom_results.replaceChildren(...children);
}

async function loadCustomPrompts() {
    try {
        state.customPrompts = (await api("/api/custom-prompts")).prompts;
        state.customLibraryError = null;
        promptManagerError(null);
        renderPromptLibrary();
        renderCustomAnalyses();
    } catch (error) {
        state.customLibraryError = error.message;
        promptManagerError(error);
        renderCustomAnalyses();
    }
}

function promptManagerError(error) {
    elements.prompt_manager_error.textContent = error?.message || "";
    elements.prompt_manager_error.classList.toggle("hidden", !error);
}

function editCustomPrompt(prompt = null) {
    state.customEditing = prompt;
    elements.prompt_editor_title.textContent = prompt ? "Edit prompt" : "Add prompt";
    elements.prompt_scope.value = prompt?.scope || "repository";
    elements.prompt_scope.disabled = Boolean(prompt);
    elements.prompt_title.value = prompt?.title || "";
    elements.prompt_text.value = prompt?.prompt || "";
    elements.prompt_enabled.checked = prompt?.enabled ?? true;
    elements.prompt_save.textContent = elements.prompt_scope.value === "repository" ? "Save and approve" : "Save prompt";
}

function renderPromptLibrary() {
    const children = [];
    for (const prompt of state.customPrompts || []) {
        const row = el("div", "prompt-record");
        const copy = el("div", "");
        copy.append(el("strong", "", prompt.title), el("p", "muted", [
            prompt.scope === "global" ? "All repositories" : "This repository",
            prompt.enabled ? "Enabled" : "Disabled", prompt.trusted ? "Approved" : "Approval required",
        ].join(" · ")));
        const edit = el("button", "", prompt.trusted ? "Edit" : "Review / approve");
        edit.type = "button";
        edit.addEventListener("click", () => { editCustomPrompt(prompt); elements.prompt_text.focus(); });
        const remove = el("button", "", "Delete");
        remove.type = "button";
        remove.addEventListener("click", async () => {
            remove.disabled = true;
            try {
                await api("/api/custom-prompts", { method: "DELETE", body: JSON.stringify({ scope: prompt.scope, id: prompt.id }) });
                if (state.customEditing?.id === prompt.id && state.customEditing?.scope === prompt.scope) editCustomPrompt();
                await loadCustomPrompts();
            } catch (error) {
                promptManagerError(error);
                remove.disabled = false;
            }
        });
        row.append(copy, edit, remove);
        children.push(row);
    }
    elements.prompt_library.replaceChildren(...children);
}

async function runCustomAnalyses(input = {}) {
    try {
        await api("/api/custom-analyses", { method: "POST", body: JSON.stringify(input) });
        state.payload = await api("/api/state");
        state.customLibraryError = null;
        promptManagerError(null);
        renderCustomAnalyses();
    } catch (error) {
        state.customLibraryError = error.message;
        promptManagerError(error);
        renderCustomAnalyses();
    }
}

function render() {
    elements.review_target_label.textContent = state.payload?.review_target?.label || "Worktree";
    const targetKey = JSON.stringify(state.payload?.review_target || {});
    if (state.reviewTargetKey !== targetKey) {
        state.reviewTargetKey = targetKey;
        const target = state.payload?.review_target;
        state.reviewPickerPending = false;
        elements.review_mode.value = target?.mode || "worktree";
        loadReviewOptions({ selectedRef: target?.currentRef && target.mode === "commit" ? target.currentRef : target?.ref });
        resetReviewNavigation();
    }
    const payload = state.payload;
    const model = payload?.model;
    elements.repository_identity.textContent = model?.metadata?.repo_root
        ? `${model.metadata.repo_root} · ${state.reviewPickerPending ? "Choose a comparison" : `Base ${model.metadata.base_sha?.slice(0, 8) || "empty tree"}`}` : "";
    const progress = payload?.progress;
    elements.status.textContent = payload?.loading ? `Analyzing ${progress?.percent || 0}%`
        : model ? payload.restored_from_cache ? "Saved review" : "Analysis current" : "Waiting";
    elements.status.title = payload.loading ? progress?.message || "Analyzing repository"
        : payload.analyzed_at ? `Analyzed ${new Date(payload.analyzed_at).toLocaleString()}${payload.restored_from_cache ? ". Reanalyze to update." : ""}` : "";
    elements.status.classList.toggle("working", Boolean(payload?.loading));
    elements.refresh.disabled = Boolean(payload?.loading || state.reviewPickerPending);
    updateReviewApply();
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
    renderReviewPickerNotice();
    renderCustomAnalyses();
    if (state.reviewPickerPending) return;
    if (!model) {
        renderChangeBrief();
        return;
    }
    loadClosedFindingKeys(model);
    if (state.queueError) showError(new Error(state.queueError));
    if (!payload.loading) {
        const summaryKey = JSON.stringify([model.metadata?.repo_root, payload.review_generation, payload.review_target]);
        if (state.summaryKey !== summaryKey) {
            state.summaryKey = summaryKey;
            state.overviewLoading = false;
            state.overviewError = null;
            state.briefIntent = null;
            state.briefIntentKey = null;
            if (!payload.annotations?.overview) generateOverview();
        }
    }
    renderChangeBrief();
    renderSummary(model);
    renderBreadcrumbs();
    const groupedObservations = [
        ...groupFindings(model.attention || []),
        ...(payload.generated_observations || []),
    ].sort((a, b) => (b.impact_score || 0) - (a.impact_score || 0));
    const active = groupedObservations.filter((item) => !isFindingClosed(item, state.closedFindingKeys));
    const closed = groupedObservations.filter((item) => isFindingClosed(item, state.closedFindingKeys));
    elements.attention_count.textContent = String(active.length);
    elements.attention_count.title = `${active.length} active · ${closed.length} closed findings`;
    renderCards(elements.attention, [
        ...collapseSizeFindings(active, model),
        ...collapseSizeFindings(closed, model),
    ], "No deterministic attention findings.");
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
        renderScopeFindings(model, parent, groupedObservations);
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

function updateReviewApply() {
    elements.review_apply.disabled = Boolean(state.reviewSubmitting || state.payload?.loading || state.reviewOptionsLoading)
        || (elements.review_mode.value !== "worktree" && !elements.review_ref.value);
}

function resetReviewNavigation() {
    state.selectionEpoch += 1;
    state.customOpenKeys.clear();
    state.selected = null;
    state.source = null;
    state.stack = [];
    state.mode = "graph";
    state.appliedServerSelection = null;
    state.sourceHistory = { entries: [], index: -1, pending: -1 };
    state.packageData.clear();
    state.query = "";
    state.changedOnly = true;
    elements.changed_only.checked = true;
    state.sourceTab = "diff";
    elements.review_search.value = "";
    elements.source_panel.classList.add("hidden");
    elements.session_history_panel.classList.add("hidden");
    setDetailVisible(false);
    elements.graph.scrollTop = 0;
    document.querySelector(".rail").scrollTop = 0;
}

function renderReviewPickerNotice() {
    const pending = Boolean(state.reviewPickerPending);
    for (const element of [elements.change_brief, elements.summary, elements.breadcrumbs, document.querySelector(".workspace")]) {
        element.classList.toggle("hidden", pending);
    }
    elements.review_picker_notice.classList.toggle("hidden", !pending);
    if (pending) {
        elements.review_target_label.textContent = "Choose a review target";
        elements.status.textContent = "Choose review";
        elements.review_picker_notice.textContent = elements.review_mode.value === "worktree"
            ? "Open the worktree review. Its saved results will be restored if available."
            : `Select ${elements.review_mode.value === "pr" ? "a pull request" : "a commit"} and choose Open review. Previous results are saved; they are not shown as results for this new selection.`;
    }
}

async function loadReviewOptions({ append = false, selectedRef = null } = {}) {
    const epoch = (state.reviewOptionsEpoch || 0) + 1;
    state.reviewOptionsEpoch = epoch;
    const mode = elements.review_mode.value;
    const selected = selectedRef || (append ? elements.review_ref.value : null);
    elements.review_ref.classList.remove("hidden");
    elements.review_ref.required = mode !== "worktree";
    elements.review_more.classList.add("hidden");
    elements.review_options_status.textContent = "";
    state.reviewOptionsLoading = mode !== "worktree";
    if (!append) {
        state.reviewOptionsPage = -1;
        elements.review_ref.replaceChildren();
    }
    elements.review_ref.disabled = true;
    updateReviewApply();
    if (mode === "worktree") {
        elements.review_ref.append(el("option", "", "Working tree snapshot"));
        renderReviewPickerNotice();
        return;
    }
    const page = append ? state.reviewOptionsPage + 1 : 0;
    elements.review_options_status.textContent = `Loading ${mode === "commit" ? "commits" : "pull requests"}…`;
    try {
        const result = await api(`/api/review-targets?mode=${mode}&page=${page}`);
        if (epoch !== state.reviewOptionsEpoch) return;
        const existing = new Set([...elements.review_ref.options].map((option) => option.value));
        for (const item of result.items) {
            if (existing.has(item.ref)) continue;
            const date = item.date ? new Date(item.date).toLocaleDateString() : "";
            const prefix = mode === "commit" ? item.short_sha : `#${item.number} · ${item.status}`;
            const option = el("option", "", `${prefix} — ${item.title} · ${item.author || "Unknown author"} · ${date}`);
            option.value = item.ref;
            elements.review_ref.append(option);
        }
        const target = state.payload?.review_target;
        if (selected && ![...elements.review_ref.options].some((option) => option.value === selected)
            && target?.mode === mode && (selected === target.ref || selected === target.currentRef)) {
            const option = el("option", "", `${target.label} (current review)`);
            option.value = selected;
            elements.review_ref.prepend(option);
        }
        if (selected) elements.review_ref.value = selected;
        if (!elements.review_ref.value && elements.review_ref.options.length) elements.review_ref.selectedIndex = 0;
        state.reviewOptionsPage = page;
        state.reviewOptionsRetryAppend = null;
        elements.review_ref.disabled = !elements.review_ref.options.length;
        elements.review_more.textContent = "Load more";
        elements.review_more.classList.toggle("hidden", !result.has_more);
        elements.review_options_status.textContent = elements.review_ref.options.length
            ? `${elements.review_ref.options.length} ${mode === "commit" ? "commits" : "pull requests"}${result.repository ? ` · ${result.repository}` : ""}`
            : mode === "commit" ? "No commits found." : "No pull requests found for this repository.";
    } catch (error) {
        if (epoch !== state.reviewOptionsEpoch) return;
        state.reviewOptionsRetryAppend = append;
        elements.review_options_status.textContent = `Unable to load ${mode === "commit" ? "commits" : "pull requests"}: ${error.message}`;
        elements.review_more.textContent = "Retry list";
        elements.review_more.classList.remove("hidden");
        elements.review_ref.disabled = !elements.review_ref.options.length;
    } finally {
        if (epoch === state.reviewOptionsEpoch) {
            state.reviewOptionsLoading = false;
            updateReviewApply();
            renderReviewPickerNotice();
        }
    }
}

elements.review_mode.addEventListener("change", () => {
    state.reviewPickerPending = true;
    resetReviewNavigation();
    loadReviewOptions();
    render();
});
elements.review_ref.addEventListener("change", () => {
    state.reviewPickerPending = true;
    resetReviewNavigation();
    updateReviewApply();
    render();
});
elements.review_more.addEventListener("click", () => loadReviewOptions({ append: state.reviewOptionsRetryAppend ?? true }));
elements.review_target_form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (elements.review_apply.disabled) return;
    state.reviewSubmitting = true;
    updateReviewApply();
    try {
        await api("/api/review-target", {
            method: "POST",
            body: JSON.stringify({ mode: elements.review_mode.value, ref: elements.review_ref.value }),
        });
        state.reviewPickerPending = false;
        resetReviewNavigation();
        state.briefIntent = null;
        state.briefIntentKey = null;
        elements.source_panel.classList.add("hidden");
        elements.session_history_panel.classList.add("hidden");
        state.payload = await api("/api/state");
        elements.error.classList.add("hidden");
        render();
        window.scrollTo({ top: 0, behavior: "instant" });
    } catch (error) {
        showError(error);
    } finally {
        state.reviewSubmitting = false;
        updateReviewApply();
    }
});

elements.custom_manage.addEventListener("click", () => {
    promptManagerError(null);
    editCustomPrompt();
    elements.prompt_manager.showModal();
    loadCustomPrompts();
});
elements.prompt_manager_close.addEventListener("click", () => elements.prompt_manager.close());
elements.prompt_new.addEventListener("click", () => editCustomPrompt());
elements.prompt_scope.addEventListener("change", () => {
    elements.prompt_save.textContent = elements.prompt_scope.value === "repository" ? "Save and approve" : "Save prompt";
});
elements.prompt_editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.prompt_save.disabled = true;
    promptManagerError(null);
    try {
        await api("/api/custom-prompts", { method: "POST", body: JSON.stringify({
            scope: elements.prompt_scope.value, id: state.customEditing?.id,
            title: elements.prompt_title.value, prompt: elements.prompt_text.value,
            enabled: elements.prompt_enabled.checked,
        }) });
        editCustomPrompt();
        await loadCustomPrompts();
        runCustomAnalyses();
    } catch (error) {
        promptManagerError(error);
    } finally {
        elements.prompt_save.disabled = false;
    }
});

loadCustomPrompts();
api("/api/state").then((payload) => {
    state.payload = payload;
    render();
}).catch(showError);
function connectEvents() {
    const events = new EventSource("/events");
    events.addEventListener("state", (event) => {
        state.payload = JSON.parse(event.data);
        if (["connected", "refreshed"].includes(state.payload.type)) loadCustomPrompts();
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
