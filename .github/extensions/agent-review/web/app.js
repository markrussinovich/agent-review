import { renderGraph, resizeGraph } from "/graph.js";
import { findingsForNode, findingKey, groupFindings, isFindingClosed, orderFindings } from "/findings.mjs";
import { resolveSymbolReference } from "/symbol-links.mjs";
import { packageEvidenceLinks } from "/package-presentation.mjs";
import { resolveSourceReference } from "/source-references.mjs";
import { unchangedDiffContext, diffSegments } from "/diff-context.mjs";
import { impactSlice } from "/impact-model.mjs";
import { ItemDiscussionPane } from "/item-discussion-ui.mjs";
import { aiPlaceholder as activityPlaceholder } from "/ai-activity.mjs";
import { parseReviewLocation, reviewLocation } from "/review-location.mjs";
import { annotationSections, conciseReviewText, overviewBlurb, reviewCommands, reviewContext, reviewItemEvidence, reviewSignal } from "/review-presentation.mjs";
import { isReviewSymbol, isTestPath, languageForPath } from "/languages.mjs";
import { ConnectionFeedback } from "/connection-feedback.mjs";
import { describeAnalysisWarning, summarizeAnalysisWarnings, unlinkedSentence } from "/analysis-limitations.mjs";
import { buildReviewPlan, concernPriorities } from "/review-plan.mjs";
import { fileTree, groupForSource, reviewSequence, treeTotals, workspaceNavigation } from "/review-workspace.mjs";
import { countLabel, plural } from "/count-format.mjs";
import {
    REVIEW_DISPOSITIONS, concernTriage, effectiveDisposition, fileReviewId, fileReviewProgress, isConcernSetAside, isReviewComplete, nextFileReview, parseReviewLedger, reviewProgress,
    reviewSnapshotKey, serializeReviewLedger,
} from "/review-ledger.mjs";
import {
    callableName, callablesForSubject, changedCallables, decisionAction, decisionConditions, decisionSentence, decisionTotals,
    EVIDENCE_GROUPS, baseTestId, evidenceCounts, layerTestStatus, linkedTestOutcome, pathEvidence, scopeDecisionMap,
} from "/decision-map.mjs";

const state = {
    payload: null,
    connectionLost: false,
    eventSource: null,
    reconnectTimer: null,
    stack: [],
    mode: "walkthrough",
    areaGroup: null,
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
    impact: null,
    closedFindingKeys: new Set(),
    reviewLedger: new Map(),
    customOpenKeys: new Set(),
    reviewPage: "overview",
    navigationMode: "groups",
    navigationQuery: "",
    readingPane: "code",
    exploring: false,
    fileReviewDrafts: new Map(),
    annotationRequests: new Map(),
};
const elements = Object.fromEntries([
    "source-coverage", "source-position", "diff-layout", "source-strip", "source-strip-toggle", "source-strip-body", "overview-layers", "overview-stats", "overview-limitation",
    "review-target-form", "review-mode", "review-ref", "review-target-label", "repository-identity", "review-list-refresh", "review-more", "review-options-status", "review-picker-notice", "clean-review", "change-brief",
    "review-overview", "review-background", "overview-title", "overview-description", "overview-progress", "overview-scope", "overview-start", "overview-files",
    "review-workflow", "workflow-overview", "workflow-review", "workflow-finish", "review-finish", "workspace-target", "workspace-freshness", "workspace-find", "workspace-nav-toggle",
    "workspace-return-source", "review-navigation", "workspace-groups", "workspace-files", "workspace-search", "workspace-count",
    "workspace-nav-list", "workspace-code", "workspace-context", "workspace-group-label", "workspace-group-retry", "workspace-prefetch", "overview-prefetch",
    "workspace-discuss", "workspace-comment", "source-review-context", "source-origin",
    "explore-priorities", "explore-concerns", "explore-groups", "explore-architecture", "explore-paths", "explore-packages",
    "review-progress-status", "review-progress-retry", "review-progress-backup", "file-review-form", "file-review-label",
    "file-review-disposition", "file-review-note", "file-review-save", "file-review-next", "file-review-status", "file-review-retry",
    "group-review-dialog", "group-review-title", "group-review-scope", "group-review-error", "group-review-confirm", "group-review-cancel",
    "review-handoff", "handoff-close", "handoff-status", "handoff-error", "handoff-refresh", "handoff-markdown",
    "handoff-markdown-save", "handoff-state-save", "handoff-state-preview", "handoff-import-file", "handoff-import-preview",
    "handoff-import-confirm", "handoff-import-error", "handoff-provider", "handoff-provider-section", "handoff-verdict", "handoff-confirm-text", "handoff-provider-status", "handoff-provider-error", "handoff-confirm", "handoff-submit", "handoff-summary",
    "status", "refresh", "cancel-analysis", "analysis-cancelled", "source-context-notice", "connection-notice", "reconnect", "worktree-notice", "worktree-notice-text", "worktree-overview", "error", "analysis-progress", "progress-phase", "progress-message", "progress-percent",
    "progress-bar", "summary", "breadcrumbs", "attention", "attention-count", "packages", "rail-resize", "workspace-nav-resize", "source-side-resize", "impact-view", "source-impact",
    "show-evidence", "show-discussion", "item-discussion", "sections-view", "source-section",
    "source-focus", "source-location", "review-command-open", "review-command-palette", "review-command-close", "review-command-query", "review-command-count", "review-command-results",
    "graph", "level-label", "graph-title", "zoom-out", "changed-only", "review-search", "detail-toggle", "detail", "detail-close", "source-panel", "source-title",
    "source-provenance", "source-decisions", "source-annotation", "source-risk", "source-close", "source", "source-ruler", "source-back", "source-forward",
    "session-history-panel", "session-history-title", "session-history-meta", "session-history-close", "session-transcript",
    "custom-analyses", "custom-results", "custom-manage", "prompt-manager", "prompt-manager-close",
    "change-repository", "repository-picker", "repository-picker-close", "repository-picker-error",
    "repository-picker-form", "repository-path", "repository-open",
    "prompt-manager-error", "prompt-library", "prompt-editor", "prompt-editor-title", "prompt-scope",
    "prompt-title", "prompt-text", "prompt-enabled", "prompt-save", "prompt-new",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));
const connectionFeedback = new ConnectionFeedback({
    onChange: (phase) => {
        state.connectionLost = phase !== "connected";
        renderConnectionNotice();
        renderReviewOverview();
        renderWorkspaceShell();
    },
});
const discussionPane = new ItemDiscussionPane(elements.item_discussion, {
    api, notify: showError, latest: () => state.payload?.discussion_update,
    renderContent: (container, text) => renderMarkdown(container, text, { sourceReferences: false }),
    viewedLocation: viewedSourceLocation,
    sourceLink: (citation) => sourceReferenceButton(
        `${citation.path}:${citation.line}${citation.side === "base" ? " (base)" : ""}`,
        { path: citation.path, lines: [citation.line], side: citation.side }),
});

function renderWorkspaceShell() {
    const ready = Boolean(state.payload?.model && !state.reviewPickerPending && !state.reviewSubmitting);
    const reviewing = ready && state.reviewPage === "review";
    document.body.classList.toggle("review-ready", ready);
    // Code paths is offered only when this review has code-path data to show (loading, complete or a reported failure).
    elements.explore_paths.classList.toggle("hidden", !state.payload?.decision_map);
    elements.review_workflow.classList.toggle("hidden", !ready);
    document.body.classList.toggle("reviewing", reviewing);
    document.body.classList.toggle("reading-source", reviewing && !elements.source_panel.classList.contains("hidden"));
    document.body.classList.toggle("workspace-exploring", Boolean(state.exploring));
    elements.source_section.textContent = "Layer";
    elements.source_section.title = reviewing && !state.exploring ? "Show this file's layer in the reading path" : "Show this code's section within its layer";
    document.body.dataset.readingPane = state.readingPane;
    elements.workflow_overview.setAttribute("aria-current", state.reviewPage === "overview" ? "page" : "false");
    elements.workflow_review.setAttribute("aria-current", reviewing ? "page" : "false");
    elements.workflow_finish.setAttribute("aria-current", state.reviewPage === "finish" ? "page" : "false");
    document.body.classList.toggle("finishing-review", ready && state.reviewPage === "finish");
    elements.review_finish.classList.toggle("hidden", !ready || state.reviewPage !== "finish");
    elements.workflow_review.disabled = !ready || isEmptyReview(state.payload);
    const meta = state.payload?.model?.metadata;
    elements.workspace_target.textContent = meta ? `${meta.repo_root?.split(/[\\/]/).at(-1) || "Repository"} · ${
        state.payload.review_target?.label || "Saved target"} · Base ${meta.base_sha?.slice(0, 8) || "empty"}` : "";
    elements.workspace_target.title = meta?.repo_root || "";
    elements.workspace_target.title = meta?.repo_root || "";
    const narrow = matchMedia("(max-width: 900px)").matches;
    const drawer = reviewing && narrow && state.navigationOpen;
    elements.review_navigation.classList.toggle("hidden", !reviewing || Boolean(state.sourceFocused) || (narrow && !drawer));
    elements.workspace_nav_toggle.setAttribute("aria-expanded", String(Boolean(drawer)));
    elements.source_panel.inert = Boolean(drawer);
    document.querySelector(".workspace").inert = Boolean(drawer);
    for (const notice of [elements.error, elements.connection_notice, elements.worktree_notice]) notice.inert = Boolean(drawer);
    elements.workspace_return_source.classList.toggle("hidden", !reviewing || !state.workspaceReturn
        || !elements.source_panel.classList.contains("hidden"));
    elements.workspace_code.setAttribute("aria-pressed", String(state.readingPane === "code"));
    elements.workspace_context.setAttribute("aria-pressed", String(state.readingPane !== "code"));
    if (ready) {
        const height = Math.ceil(elements.review_workflow.getBoundingClientRect().height);
        document.documentElement.style.setProperty("--workflow-height", `${height}px`);
        let top = height;
        if (reviewing) for (const notice of [elements.error, elements.connection_notice, elements.worktree_notice]) {
            if (notice.classList.contains("hidden")) continue;
            notice.style.top = `${top}px`;
            top += Math.ceil(notice.getBoundingClientRect().height) + 6;
        }
        document.documentElement.style.setProperty("--workspace-top", `${top}px`);
    }
}
function sourceScrollPosition() {
    if (state.source && elements.source.clientHeight) {
        state.source.scrollPosition = { top: elements.source.scrollTop, left: elements.source.scrollLeft };
    }
    return state.source?.scrollPosition || { top: 0, left: 0 };
}

function rememberWorkspaceSource() {
    if (!state.source || elements.source_panel.classList.contains("hidden")) return;
    state.workspaceReturn = {
        generation: state.payload.review_generation, source: state.source, selected: state.source.reviewItem || state.selected, tab: state.sourceTab,
        history: { ...state.sourceHistory, entries: [...state.sourceHistory.entries] },
        attribution: state.attribution, attributionStatus: state.attributionStatus, attributionMessage: state.attributionMessage,
        scroll: { ...sourceScrollPosition(),
            side: elements.source_panel.querySelector(".source-side").scrollTop },
        discussion: state.discussionMode, pane: state.readingPane, cursor: viewedSourceLocation(),
        group: state.activeReviewGroup, query: state.navigationQuery,
    };
}

async function returnWorkspaceSource({ code = false } = {}) {
    const saved = state.workspaceReturn;
    if (!saved || saved.generation !== state.payload.review_generation) {
        showError(new Error("The previous source belongs to another review snapshot."));
        return;
    }
    state.reviewPage = "review";
    state.exploring = false;
    state.mode = "walkthrough";
    state.source = saved.source;
    state.selected = saved.selected;
    state.sourceTab = saved.tab;
    state.sourceHistory = { ...saved.history, entries: [...saved.history.entries] };
    state.attribution = saved.attribution;
    state.attributionStatus = saved.attributionStatus;
    state.attributionMessage = saved.attributionMessage;
    state.activeReviewGroup = saved.group;
    state.readingPane = code ? "code" : saved.pane || "code";
    state.navigationQuery = saved.query;
    elements.workspace_search.value = saved.query || "";
    state.selectionEpoch++;
    setDiscussionMode(!code && Boolean(saved.discussion));
    render();
    if (await renderSource()) {
        if (state.selected && state.annotationRequests.has(`${state.payload.review_generation}:${state.selected.id}`)) {
            ensureAnnotation(state.selected);
        }
        elements.source.scrollTop = saved.scroll.top;
        elements.source.scrollLeft = saved.scroll.left;
        elements.source_panel.querySelector(".source-side").scrollTop = saved.scroll.side;
        if (!code && saved.discussion && saved.selected) await discussionPane.open(saved.selected, state.payload.review_generation);
        if (state.readingPane === "code") elements.source.focus({ preventScroll: true });
        else if (!saved.discussion) elements.show_evidence.focus({ preventScroll: true });
    }
}

elements.workflow_overview.addEventListener("click", () => {
    state.selectionEpoch++;
    sourceRenderVersion++;
    rememberWorkspaceSource();
    setSourceFocus(false);
    state.reviewPage = "overview";
    state.navigationOpen = false;
    elements.source_panel.classList.add("hidden");
    render();
    flushReviewCursor();
    elements.overview_start.focus({ preventScroll: true });
});
elements.workflow_review.addEventListener("click", () => {
    if (state.reviewPage === "review" && !state.exploring) return;
    if (state.workspaceReturn) returnWorkspaceSource().catch(showError);
    else elements.overview_start.click();
});
elements.workflow_finish.addEventListener("click", () => openFinishReview());
elements.workspace_return_source.addEventListener("click", () => returnWorkspaceSource({ code: true }).catch(showError));
elements.workspace_find.addEventListener("click", openReviewCommands);
elements.workspace_nav_toggle.addEventListener("click", () => {
    state.navigationOpen = !state.navigationOpen;
    renderWorkspaceShell();
    if (state.navigationOpen) elements.workspace_search.focus();
});
for (const [button, mode] of [[elements.workspace_groups, "groups"], [elements.workspace_files, "files"]]) {
    button.addEventListener("click", () => { state.navigationMode = mode; state.navigationKey = null; renderWorkspaceNavigation(); });
}
elements.workspace_search.addEventListener("input", () => {
    state.navigationQuery = elements.workspace_search.value;
    renderWorkspaceNavigation();
});
elements.workspace_group_retry.addEventListener("click", () => {
    state.sectionError = null;
    state.navigationKey = null;
    renderWorkspaceNavigation();
});
document.querySelector(".workspace-explore").addEventListener("toggle", (event) => {
    if (event.target.open && state.navigationOpen) {
        state.navigationOpen = false;
        renderWorkspaceShell();
    }
});
{
    const explore = document.querySelector(".workspace-explore");
    document.addEventListener("pointerdown", (event) => {
        if (explore.open && !explore.contains(event.target)) explore.open = false;
    }, true);
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !explore.open) return;
        explore.open = false;
        if (explore.contains(document.activeElement)) explore.querySelector("summary")?.focus();
        event.stopPropagation();
    }, true);
    document.addEventListener("focusin", (event) => {
        if (explore.open && !explore.contains(event.target)) explore.open = false;
    });
}
for (const [button, mode] of [[elements.explore_priorities, "walkthrough"], [elements.explore_concerns, "findings"], [elements.explore_groups, "sections"], [elements.explore_architecture, "graph"],
    [elements.explore_paths, "decisions"], [elements.explore_packages, "packages"]]) {
    button.addEventListener("click", () => {
        rememberWorkspaceSource();
        setSourceFocus(false);
        state.reviewPage = "review";
        state.exploring = true;
        state.mode = mode;
        state.stack = [];
        state.source = null;
        elements.source_panel.classList.add("hidden");
        button.closest("details").open = false;
        render();
    });
}
for (const [button, pane] of [[elements.workspace_code, "code"], [elements.workspace_context, "context"]]) {
    button.addEventListener("click", () => {
        const scroll = sourceScrollPosition();
        state.readingPane = pane;
        renderWorkspaceShell();
        if (pane === "code") {
            elements.source.scrollTop = scroll.top;
            elements.source.scrollLeft = scroll.left;
        }
    });
}

const reviewStateLabel = (value) => Object.fromEntries(REVIEW_DISPOSITIONS)[value] || value;

// One grounded AI intent line per layer; the deterministic summary stays visible until it arrives or if it fails.
function ensureLayerSummaries() {
    const generation = state.payload?.review_generation;
    if (!state.payload || state.payload.annotations?.layers?.titles || state.layerSummaryRequested === generation) return;
    state.layerSummaryRequested = generation;
    state.layerSummaryError = null;
    state.layerSummaryLoading = true;
    api("/api/layer-summaries", { method: "POST", body: "{}" }).then((result) => {
        if (state.payload?.review_generation !== generation) return;
        state.payload.annotations = { ...(state.payload.annotations || {}), layers: result.annotation };
    }, (error) => {
        if (state.payload?.review_generation === generation) state.layerSummaryError = error.message;
    }).finally(() => {
        if (state.payload?.review_generation !== generation) return;
        state.layerSummaryLoading = false;
        state.navigationKey = null;
        renderWorkspaceNavigation();
        renderReviewOverview();
    });
}

function layerSummaryStatus(container, layer, key) {
    if (layer.supporting) return;
    if (state.layerSummaryLoading && !state.payload.annotations?.layers?.titles) {
        container.append(aiPlaceholder(key, "Copilot is writing layer titles and summaries...", 1));
    } else if (state.layerSummaryError) {
        const error = el("span", "layer-summary-error muted", `AI layer summary unavailable: ${state.layerSummaryError}`);
        container.append(error);
    }
}

// Long file names wrap at dots, dashes and underscores before ever breaking inside a word.
function breakableName(text) {
    const fragment = document.createDocumentFragment();
    for (const part of String(text).split(/(?<=[._-])/)) fragment.append(document.createTextNode(part), document.createElement("wbr"));
    return fragment;
}

function bulkReviewLink(entry, text) {
    const mark = el("button", "link-button", text);
    mark.type = "button";
    mark.addEventListener("click", () => {
        state.bulkReviewGroup = entry;
        elements.group_review_error.classList.add("hidden");
        elements.group_review_title.textContent = `Mark ${entry.files.length} files reviewed`;
        elements.group_review_scope.textContent = `${entry.title}. This includes every changed file in this group, not just files matching the current filter. Existing notes are kept.`;
        elements.group_review_confirm.disabled = !state.progressReady || savingDecision();
        elements.group_review_dialog.showModal();
    });
    return mark;
}

function renderWorkspaceNavigation() {
    if (!state.payload?.model || state.reviewPage !== "review") return;
    const data = ensureSectionData();
    const navigation = workspaceNavigation(state.payload.model, data);
    state.workspaceNavigation = navigation;
    const location = state.pendingSource || state.source || state.workspaceReturn?.source;
    const group = groupForSource(navigation, location, state.activeReviewGroup);
    if (group) state.activeReviewGroup = group.id;
    const changedFile = location && navigation.files.some((file) => file.path === location.path);
    const layer = group && navigation.layers.find((item) => item.id === group.layer);
    const groupLabel = group?.label || group?.title;
    // When the open file is a test or consumer listed under another file's group, name the open file first.
    const primaryPath = group?.primaries?.[0];
    const attachedRole = group && !group.cohort && location?.path && primaryPath && !group.primaries.includes(location.path)
        && group.roles?.get?.(location.path);
    const openLabel = attachedRole ? `${location.path.split("/").at(-1)} — ${attachedRole === "test" ? "test" : attachedRole === "consumer" ? "consumer" : "related file"} of ${primaryPath.split("/").at(-1)}` : null;
    elements.workspace_group_label.textContent = group ? `${layer
        ? `${layerLabel(layer)}${(openLabel || groupLabel) === layer.name ? "" : " › "}` : ""}${openLabel || (groupLabel === layer?.name ? "" : groupLabel)}`
        : (changedFile ? "Changed file · this line is outside its grouped change ranges"
            : state.source ? "Related source outside the changed-file groups" : "Choose a group or file");
    const query = state.navigationQuery.toLowerCase().trim();
    if (data) ensureLayerSummaries();
    const key = `${state.payload.review_generation}:${state.sectionDataKey}:${state.navigationMode}:${query}:${state.payload.annotations?.layers?.generated_at || ""}:${state.layerSummaryLoading}:${state.layerSummaryError}`;
    elements.workspace_groups.setAttribute("aria-pressed", String(state.navigationMode === "groups"));
    elements.workspace_files.setAttribute("aria-pressed", String(state.navigationMode === "files"));
    const storyLayers = navigation.layers.filter((item) => !item.supporting).length;
    elements.workspace_count.textContent = `${countLabel(navigation.files.length, "changed file")} · ${
        data ? countLabel(storyLayers || navigation.layers.length, "layer") : state.sectionError ? "Grouping unavailable; files remain accessible" : "Grouping saved changes…"}`;
    elements.workspace_group_retry.classList.toggle("hidden", !state.sectionError);
    if (state.navigationKey !== key) {
        state.navigationKey = key;
        const list = elements.workspace_nav_list;
        list.replaceChildren();
        const appendTree = (container, tree, owner) => {
            for (const directory of [...tree.directories.values()].sort((a, b) => a.name.localeCompare(b.name))) {
                const details = el("details", "workspace-folder");
                details.dataset.prefix = directory.path;
                // A collapsed folder still says how much changed inside it.
                const totals = treeTotals(directory);
                const summary = el("summary", "", directory.name);
                const meta = el("span", "workspace-folder-meta", `${countLabel(totals.files, "file")} · +${totals.added.toLocaleString()} −${totals.removed.toLocaleString()}`);
                summary.title = `${directory.path}: ${countLabel(totals.files, "changed file")}, ${totals.added.toLocaleString()} added and ${totals.removed.toLocaleString()} removed lines`;
                summary.prepend(meta);
                details.append(summary);
                appendTree(details, directory, owner);
                if (query) details.open = true;
                container.append(details);
            }
            for (const file of tree.files) {
                const button = el("button", "workspace-file", file.path.split("/").at(-1));
                button.type = "button";
                button.dataset.path = file.path;
                button.dataset.group = owner?.id || "";
                button.title = file.path;
                if (state.navigationMode === "files") {
                    const layer = layerOf(navigation, { path: file.path });
                    const meta = el("span", "workspace-file-meta");
                    meta.append(el("span", "workspace-file-delta", `+${file.lines_added || 0} −${file.lines_removed || 0}`));
                    if (layer) {
                        const chip = layerMarker(layer, "layer-chip layer-chip-inline");
                        chip.title = layerLabel(layer);
                        meta.append(chip);
                    }
                    button.append(meta);
                    button.dataset.delta = `${file.lines_added || 0} added, ${file.lines_removed || 0} removed lines`;
                    button.title = `${file.path} · +${file.lines_added || 0} −${file.lines_removed || 0}${layer ? ` · ${layerLabel(layer)}` : ""}`;
                }
                button.addEventListener("click", () => openWorkspaceFile(file, owner).catch(showError));
                container.append(button);
            }
        };
        if (state.navigationMode === "files") {
            appendTree(list, fileTree(navigation.files.filter((file) => !query || file.path.toLowerCase().includes(query))), null);
        } else for (const layer of navigation.layers) {
            const layerGroups = layer.groups.map((entry) => {
                const matches = !query || `${entry.label} ${layer.name} ${layerTitle(layer)}`.toLowerCase().includes(query);
                return { entry, files: entry.files.filter((file) => matches || file.path.toLowerCase().includes(query)) };
            }).filter(({ files }) => files.length);
            if (!layerGroups.length) continue;
            const section = el("details", "workspace-layer");
            section.open = true;
            section.dataset.layer = layer.id;
            const heading = el("summary", "workspace-layer-heading");
            heading.title = "Expand or collapse this layer's files";
            const name = el("span", "workspace-layer-name");
            const title = layerTitle(layer);
            const openTitle = el("button", "workspace-layer-open", "Review layer");
            openTitle.type = "button";
            openTitle.title = `Open ${layerLabel(layer)} at its next unreviewed file`;
            openTitle.setAttribute("aria-label", `Review layer: ${layerLabel(layer)}`);
            openTitle.addEventListener("click", (event) => {
                event.preventDefault();
                section.open = true;
                openLayer(navigation, layer);
            });
            name.append(layerMarker(layer, "workspace-layer-number"),
                titleWithBadge(title, title !== layer.name, "AI-written step title; the area name is shown below"));
            const meta = el("span", "workspace-layer-meta");
            if (title !== layer.name) meta.append(el("span", "", layer.name));
            if (layer.path && layer.path !== "/" && !layer.supporting) meta.append(el("code", "", layer.path));
            if (layer.number && layer.number > 1 && !layer.dependsOn.length) {
                const independent = el("span", "layer-independent", "independent");
                independent.title = "No changed file in this layer imports or calls an earlier layer; it can be read in any order.";
                meta.append(independent);
            }
            for (const dependency of layer.dependsOn) {
                meta.append(el("span", "workspace-layer-depends", `builds on ${dependencyLabel(navigation, dependency)} — ${dependency.example}`));
            }
            const progress = el("span", "workspace-layer-progress muted");
            progress.dataset.layerProgress = layer.id;
            const tests = el("span", "workspace-layer-tests");
            tests.dataset.layerTests = layer.id;
            const intent = state.payload.annotations?.layers?.intents?.[layer.id];
            let intentLine = null;
            if (intent) {
                intentLine = el("span", "workspace-layer-intent");
                intentLine.append(el("span", "workspace-layer-ai", "AI"), document.createTextNode(intent));
                intentLine.title = `${intent}\n\nAI interpretation of this layer's saved diff. Verify in the code.`;
            } else if (layer.summary) intentLine = el("span", "workspace-layer-intent workspace-layer-fallback", layer.summary);
            heading.append(name, progress, tests, ...(intentLine ? [intentLine] : []), meta);
            const actions = el("div", "workspace-layer-actions");
            actions.append(openTitle);
            layerSummaryStatus(actions, layer, `layer:${layer.id}`);
            section.append(heading, actions);
            for (const { entry, files } of layerGroups) {
                if (entry.supporting) {
                    const tree = el("div", "workspace-supporting");
                    tree.dataset.group = entry.id;
                    appendTree(tree, fileTree(files), entry);
                    tree.append(bulkReviewLink(entry, "Review all supporting files…"));
                    section.append(tree);
                    continue;
                }
                if (entry.tree) {
                    const details = el("details", "workspace-group");
                    details.dataset.group = entry.id;
                    const summary = el("summary", "");
                    summary.append(el("strong", "", entry.title));
                    summary.title = "Expand or collapse this group's files";
                    const open = el("button", "workspace-group-open", "Review group");
                    open.type = "button";
                    open.title = entry.section?.summary || entry.title;
                    open.addEventListener("click", (event) => {
                        event.preventDefault();
                        details.open = true;
                        const first = entry.section?.ranges.find((range) => files.some((file) => file.path === range.path));
                        openWorkspaceFile(files.find((file) => file.path === first?.path) || files[0], entry).catch(showError);
                    });
                    const count = el("span", "muted", String(files.length));
                    count.dataset.groupProgress = entry.id;
                    if (layer.groups.length > 1) summary.append(count);
                    details.append(summary, open);
                    appendTree(details, fileTree(files), entry);
                    details.append(bulkReviewLink(entry, "Review all group files…"));
                    if (query) details.open = true;
                    section.append(details);
                    continue;
                }
                const block = el("div", "workspace-file-group");
                block.dataset.group = entry.id;
                for (const file of files) {
                    const role = entry.roles.get(file.path);
                    const primary = role === "changed";
                    const button = el("button", `workspace-file${primary ? " workspace-primary" : " workspace-attached"}`);
                    button.type = "button";
                    button.dataset.path = file.path;
                    button.dataset.group = entry.id;
                    button.dataset.role = role;
                    if (primary && entry.subtitle && file.path === entry.primaries[0]) button.dataset.symbols = entry.subtitle;
                    button.title = file.path;
                    const label = el("span", "workspace-file-name");
                    label.append(breakableName(file.path.split("/").at(-1)));
                    button.append(label);
                    if (primary && entry.subtitle && file.path === entry.primaries[0]) {
                        const symbols = el("span", "workspace-file-symbols");
                        symbols.append(breakableName(entry.subtitle));
                        button.append(symbols);
                    }
                    if (!primary) button.append(el("span", "workspace-role", role));
                    button.addEventListener("click", () => openWorkspaceFile(file, entry).catch(showError));
                    block.append(button);
                }
                if (entry.related.length) {
                    const related = el("span", "workspace-related muted", "Also changes ");
                    entry.related.slice(0, 3).forEach((item, index) => {
                        const target = navigation.groups.find((group) => group.id === item.group);
                        const link = el("button", "link-button", item.path.split("/").at(-1));
                        link.type = "button";
                        link.title = `Open ${item.path}, listed with its own file`;
                        link.addEventListener("click", () => {
                            const file = target?.files.find((candidate) => candidate.path === item.path);
                            if (file) openWorkspaceFile(file, target).catch(showError);
                        });
                        related.append(...(index ? [document.createTextNode(", ")] : []), link);
                    });
                    if (entry.related.length > 3) related.append(document.createTextNode(` +${entry.related.length - 3}`));
                    related.append(document.createTextNode(" (listed with its own file)"));
                    block.append(related);
                }
                section.append(block);
            }
            list.append(section);
        }
        if (!list.childElementCount) list.append(el("p", "muted", "No changed files match this filter."));
    }
    for (const button of elements.workspace_nav_list.querySelectorAll(".workspace-file")) {
        const selected = button.dataset.path === location?.path
            && (state.navigationMode === "files" || button.dataset.group === state.activeReviewGroup);
        button.classList.toggle("is-selected", selected);
        if (selected) {
            button.setAttribute("aria-current", "location");
            for (let parent = button.parentElement; parent && parent !== elements.workspace_nav_list; parent = parent.parentElement) {
                if (parent.tagName === "DETAILS") parent.open = true;
            }
        } else button.removeAttribute("aria-current");
        const disposition = state.reviewLedger.get(fileReviewId(button.dataset.path))?.disposition || "pending";
        button.dataset.reviewState = disposition;
        button.setAttribute("aria-label", `${button.dataset.path}${button.dataset.role && button.dataset.role !== "changed" ? `, ${button.dataset.role}` : ""}${
            button.dataset.symbols ? `, changes ${button.dataset.symbols}` : ""}${button.dataset.delta ? `, ${button.dataset.delta}` : ""} · ${reviewStateLabel(disposition)}`);
    }
    const reviewedIn = (files) => files.filter((file) => state.reviewLedger.get(fileReviewId(file.path))?.disposition === "reviewed").length;
    for (const count of elements.workspace_nav_list.querySelectorAll("[data-group-progress]")) {
        const entry = navigation.groups.find((group) => group.id === count.dataset.groupProgress);
        if (entry) count.textContent = `${reviewedIn(entry.files)}/${entry.files.length}`;
    }
    for (const count of elements.workspace_nav_list.querySelectorAll("[data-layer-progress]")) {
        const entry = navigation.layers.find((layer) => layer.id === count.dataset.layerProgress);
        const files = entry?.groups.flatMap((group) => group.files) || [];
        count.textContent = `${reviewedIn(files)}/${files.length}`;
        count.title = `${reviewedIn(files)} of ${countLabel(files.length, "file")} in this layer marked reviewed`;
    }
    for (const slot of elements.workspace_nav_list.querySelectorAll("[data-layer-tests]")) {
        const entry = navigation.layers.find((layer) => layer.id === slot.dataset.layerTests);
        const chip = entry && layerTestChip(entry);
        slot.replaceChildren(...(chip ? [chip] : []));
    }
}

async function openWorkspaceFile(file, group = null) {
    state.reviewPage = "review";
    state.exploring = false;
    state.readingPane = "code";
    state.navigationOpen = false;
    state.activeReviewGroup = group?.id || null;
    state.navigationCursor = { path: file.path, group: group?.id || null };
    state.mode = "walkthrough";
    // Show the destination immediately; slow source loads must not look like ignored key presses.
    const pending = { path: file.path };
    state.pendingSource = pending;
    elements.source_title.textContent = `${file.path} · loading…`;
    renderSourcePosition(file.path);
    elements.source.setAttribute("aria-busy", "true");
    renderWorkspaceNavigation();
    renderFileReview();
    const range = group?.section?.ranges.find((range) => range.path === file.path && range.side !== "base")
        || group?.section?.ranges.find((range) => range.path === file.path);
    const node = range?.symbol_id && state.payload.model.nodes.find((node) => node.id === range.symbol_id);
    try {
        if (node) await selectItem(node, false);
        // Generated bundles are not sent to Copilot; every other file gets its explanation.
        else await selectFile(file, !file.generated);
    } finally {
        if (state.pendingSource === pending) {
            state.pendingSource = null;
            renderFileReview();
            if (state.source?.path !== file.path) {
                elements.source.removeAttribute("aria-busy");
                elements.source_title.textContent = state.source
                    ? `${state.source.path}${state.source.start_line ? `:${state.source.start_line}` : ""}` : "";
                renderWorkspaceNavigation();
            }
        }
    }
    if (state.navigationCursor?.path !== file.path) return;
    renderWorkspaceShell();
    if (state.source) elements.source.focus({ preventScroll: true });
}

function setDiscussionMode(active) {
    sourceScrollPosition();
    state.discussionMode = active;
    elements.source_panel.querySelector(".source-side").classList.toggle("discussion-mode", active);
    elements.show_evidence.setAttribute("aria-pressed", String(!active));
    elements.show_discussion.setAttribute("aria-pressed", String(active));
    if (!active) {
        discussionPane.hide();
        elements.source_panel.querySelector(".source-side").scrollTop = 0;
    }
    if (active) state.readingPane = "context";
    renderWorkspaceShell();
}

function renderSectionEvidence() {
    const section = state.sectionData?.sections.find((section) => section.id === state.selected?.id);
    if (!section || !state.source) return false;
    const panel = elements.source_annotation;
    panel.replaceChildren(el("h3", "", section.title),
        el("p", "muted", section.summary_citations.length ? "Section-level AI interpretation; verify the cited source." : "Source-derived section context, not a defect finding."),
        el("p", "", section.summary),
        el("p", "muted", `Viewed source: ${state.source.path}:${state.source.start_line || 1}. The section contains ${countLabel(section.ranges.length, "source range")}.`));
    for (const citation of section.summary_citations) panel.append(sourceReferenceButton(
        `${citation.path}:${citation.line}`, { path: citation.path, lines: [citation.line], side: citation.side }));
    panel.classList.remove("hidden");
    return true;
}

function rememberSourceReturnFocus() {
    const active = document.activeElement;
    if (!active || active === document.body || elements.source_panel.contains(active)
        || active.closest("#detail, dialog")) return;
    state.sourceReturnFocus = active;
    state.sourceOriginItemId = active.closest("[data-item-id]")?.dataset.itemId || state.selected?.id || null;
}

function setSourceFocus(active) {
    if (active && (!state.source || elements.source_focus.disabled)) {
        showError(new Error("Open a saved source range before focusing code."));
        return;
    }
    state.sourceFocused = active;
    document.body.classList.toggle("review-source-focus", active);
    elements.source_focus.setAttribute("aria-pressed", String(active));
    elements.source_focus.textContent = active ? "Exit focus" : "Focus code";
    elements.source_focus.title = active ? "Exit focus mode (F or Esc)" : "Hide the rail and context; keep Mark & next (F)";
    if (active) state.readingPane = "code";
    renderWorkspaceShell();
}

elements.source_focus.addEventListener("click", () => setSourceFocus(!state.sourceFocused));

const commandCatalogs = new WeakMap();
function focusedReviewItem() {
    if (!state.payload?.model) return null;
    const active = document.activeElement;
    const changedFile = active.closest?.(".workspace-file")?.dataset.path;
    if (changedFile) return { id: `file:${changedFile}`, kind: "file", path: changedFile, name: changedFile };
    const sectionId = active.closest?.(".section-card")?.dataset.sectionId;
    const section = state.sectionData?.sections.find((section) => section.id === sectionId);
    if (section) return { id: section.id, kind: "section", title: section.title, path: section.ranges[0].path };
    const id = active.closest?.("[data-item-id]")?.dataset.itemId || active.closest?.("[data-node-id]")?.dataset.nodeId;
    if (id) return [...state.payload.model.nodes, ...state.payload.model.attention || [],
        ...state.payload.model.package_changes || [], ...state.payload.model.package_dependencies || [],
        ...state.payload.generated_observations || []].find((item) => item.id === id) || state.selected;
    return state.selected || (state.source ? { id: `file:${state.source.path}`, kind: "file", path: state.source.path, name: state.source.path } : null);
}

function viewedSourceLocation() {
    if (!state.source || elements.source_panel.classList.contains("hidden")) return null;
    const selection = window.getSelection();
    const selected = !selection?.isCollapsed && selection?.anchorNode?.parentElement?.closest(".code-row");
    const box = elements.source.getBoundingClientRect();
    const focus = elements.source.querySelector(".focus-start");
    const focusBox = focus?.getBoundingClientRect();
    const focused = focusBox && focusBox.bottom > Math.max(0, box.top)
        && focusBox.top < Math.min(innerHeight, box.bottom) ? focus : null;
    const probe = document.elementFromPoint(Math.min(innerWidth - 8, box.left + 80),
        Math.max(8, Math.min(innerHeight - 8, box.top + 12)))?.closest(".code-row, .split-pair");
    // In split diffs the probe can land on an empty filler; use the line beside it.
    const visible = probe?.classList.contains("split-pair") ? probe.querySelector(".code-row.diff-add, .code-row") : probe;
    const row = selected && elements.source.contains(selected) ? selected : focused || visible;
    if (!row && state.source.viewedLocationTab === state.sourceTab && state.source.viewedLocation) {
        return state.source.viewedLocation;
    }
    const preferredSide = state.source.focus_side || "current";
    const side = state.sourceTab === "base" ? "base" : state.sourceTab === "current" ? "current"
        : row?.dataset[preferredSide === "base" ? "oldLine" : "newLine"] ? preferredSide
        : row?.dataset.newLine ? "current" : row?.dataset.oldLine ? "base" : preferredSide;
    const line = Number(row?.dataset[side === "base" ? "oldLine" : "newLine"])
        || Number(row?.dataset.gap?.split("-")[0]) || Number(state.source.start_line) || 1;
    if (typeof state.source[side] !== "string") return null;
    state.source.viewedLocation = { path: state.source.path, line, side };
    state.source.viewedLocationTab = state.sourceTab;
    return state.source.viewedLocation;
}

function renderReviewCommands() {
    const model = state.payload?.model;
    if (!model) return;
    if (!commandCatalogs.has(model)) commandCatalogs.set(model, reviewCommands(model));
    const query = elements.review_command_query.value.trim().toLowerCase();
    const prefix = (item) => Number(item.title.toLowerCase().startsWith(query));
    // Typed searches still keep the change set ahead of unchanged repository symbols.
    const matches = commandCatalogs.get(model).filter((item) => query
        ? `${item.title} ${item.path || ""} ${item.reason || ""}`.toLowerCase().includes(query) : item.rank < 3)
        .sort((a, b) => Number(a.rank >= 3) - Number(b.rank >= 3) || prefix(b) - prefix(a)
            || a.rank - b.rank || a.title.localeCompare(b.title));
    elements.review_command_count.textContent = query
        ? `Showing ${Math.min(30, matches.length)} of ${matches.length.toLocaleString()} matching review items · Enter opens the first`
        : `Showing ${Math.min(30, matches.length)} of ${matches.length.toLocaleString()} concerns and changed items · type to search all symbols`;
    const rows = [];
    for (const item of matches.slice(0, 30)) {
        const row = el("li", "");
        const open = el("button", "");
        open.type = "button";
        open.append(el("strong", "", item.title), el("small", "muted", `${item.label} · ${item.path || "Saved review evidence"}`));
        open.addEventListener("click", async () => {
            elements.review_command_palette.close();
            state.sourceReturnFocus = elements.review_command_open;
            try {
                if (item.kind === "file") await selectFile(model.changes.find((change) => `file:${change.path}` === item.id), false);
                else await selectItem(item, false, false);
                if (state.selected?.id === item.id && state.source) elements.source.focus({ preventScroll: true });
            } catch (error) { showError(error); }
        });
        open.addEventListener("keydown", (event) => {
            if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
            event.preventDefault();
            const buttons = [...elements.review_command_results.querySelectorAll("button")];
            const next = buttons.indexOf(open) + (event.key === "ArrowDown" ? 1 : -1);
            (buttons[next] || elements.review_command_query).focus();
        });
        row.append(open);
        rows.push(row);
    }
    if (!rows.length) rows.push(el("li", "muted", "No files, symbols, or findings match this query."));
    elements.review_command_results.replaceChildren(...rows);
}

function openReviewCommands() {
    if (!state.payload?.model) {
        showError(new Error("Wait for the saved review to load before searching it."));
        return;
    }
    state.commandReturnFocus = document.activeElement === document.body
        ? state.reviewPage === "review" ? elements.workspace_find : elements.review_command_open : document.activeElement;
    elements.review_command_query.value = "";
    renderReviewCommands();
    if (!elements.review_command_palette.open) elements.review_command_palette.showModal();
    elements.review_command_query.focus();
}

elements.review_command_open.addEventListener("click", openReviewCommands);
elements.review_command_close.addEventListener("click", () => elements.review_command_palette.close());
elements.review_command_palette.addEventListener("close", () => {
    if (state.commandReturnFocus?.isConnected) state.commandReturnFocus.focus({ preventScroll: true });
});
elements.review_command_palette.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    elements.review_command_palette.close();
});
elements.review_command_query.addEventListener("input", renderReviewCommands);
elements.review_command_query.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        elements.review_command_results.querySelector("button")?.click();
        return;
    }
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...elements.review_command_results.querySelectorAll("button")];
    (event.key === "ArrowDown" ? buttons[0] : buttons.at(-1))?.focus();
});

elements.source_location.addEventListener("click", async () => {
    if (!state.source || elements.source_location.disabled) return;
    try {
        const viewed = viewedSourceLocation();
        if (!viewed) throw new Error("This snapshot side has no source location to copy.");
        const snapshot = state.reviewLedgerStorageKey || reviewSnapshotKey(state.payload.model, state.payload.review_target);
        const link = reviewLocation(location.href, { snapshot, item: state.selected?.id,
            ...viewed, tab: state.sourceTab });
        await navigator.clipboard.writeText(link);
        elements.source_location.textContent = "Location copied";
        setTimeout(() => { elements.source_location.textContent = "Copy location"; }, 1500);
    } catch (error) { showError(new Error(`Unable to copy review location: ${error.message}`)); }
});

async function applyReviewLocation() {
    if (!state.payload?.model || state.payload.loading || !location.hash) return;
    const generation = state.payload.review_generation;
    const key = `${generation}:${location.hash}`;
    if (state.appliedReviewLocation === key) return;
    state.appliedReviewLocation = key;
    try {
        const target = parseReviewLocation(location.hash);
        if (!target) return;
        const snapshot = state.reviewLedgerStorageKey || reviewSnapshotKey(state.payload.model, state.payload.review_target);
        if (target.snapshot !== snapshot) throw new Error("This local link belongs to another source snapshot. Select the original saved target before reopening it; newer code was not substituted.");
        if (!Object.hasOwn(state.payload.model.source_files || {}, target.path)) throw new Error("The linked path is not available in this saved snapshot.");
        let item = [...state.payload.model.nodes, ...state.payload.model.attention || [], ...state.payload.model.package_changes || []]
            .find((item) => item.id === target.item);
        if (target.item?.startsWith("section:")) {
            const data = await api("/api/review-sections");
            if (state.payload.review_generation !== generation) return;
            const section = data.sections.find((section) => section.id === target.item);
            if (!section) throw new Error("The linked section is not available in this review.");
            state.sectionData = data;
            item = { id: section.id, kind: "section", title: section.title, path: target.path };
        }
        if (!item && target.item && !target.item.startsWith("file:")) {
            if (state.payload.model.evidence?.[target.item]) item = { id: target.item, kind: "evidence", path: target.path };
            else throw new Error("The linked review item is not available in this analysis.");
        }
        setDiscussionMode(false);
        state.selected = item || { id: `file:${target.path}`, kind: "file", name: target.path, path: target.path };
        state.sourceReturnFocus = elements.review_command_open;
        markSelectedCards();
        if (state.selected.kind === "file") {
            renderEmptyDetail();
            setDetailVisible(false);
        } else renderDetail(state.selected);
        const epoch = ++state.selectionEpoch;
        const query = new URLSearchParams({ path: target.path, line: String(target.line), side: target.side });
        if (await loadSource(query.toString(), epoch, target.tab)) elements.source.focus({ preventScroll: true });
    } catch (error) {
        if (state.payload.review_generation === generation) {
            if (!elements.source_panel.classList.contains("hidden")) elements.source_close.click();
            showError(error);
            elements.error.tabIndex = -1;
            elements.error.focus({ preventScroll: true });
            elements.error.scrollIntoView({ block: "center" });
        }
    }
}

window.addEventListener("hashchange", () => {
    state.appliedReviewLocation = null;
    applyReviewLocation().catch(showError);
});

async function discussItem(item = state.selected) {
    state.reviewPage = "review";
    setSourceFocus(false);
    rememberSourceReturnFocus();
    if (!item?.id) {
        showError(new Error("Select a review item or source range to discuss."));
        return;
    }
    if (state.selected?.id !== item.id || !state.source) await selectItem(item, false, false);
    if (state.selected?.id !== item.id) return;
    const names = new Map((state.payload?.model?.nodes || []).map((node) => [node.id, node.name]));
    const dependency = [...state.payload?.model?.package_changes || [], ...state.payload?.model?.package_dependencies || []]
        .find((dependency) => dependency.id === (item.package_id || item.id));
    const title = dependency ? `${dependency.name} · ${packageVersionText(dependency)} — ${item.title || "Dependency"}`
        : item.title || item.name || (item.source
        ? `${names.get(item.source) || item.source} ${item.type} ${names.get(item.target) || item.target}` : item.id);
    elements.source_panel.classList.toggle("no-source", !state.source);
    if (!state.source) {
        elements.source_title.textContent = title;
        elements.source.replaceChildren(el("p", "muted", "This item has no direct source range. Discussion uses its saved relationship evidence."));
        elements.source_ruler.classList.add("hidden");
        elements.source_context_notice.classList.add("hidden");
        for (const panel of [elements.source_provenance, elements.source_annotation, elements.source_decisions, elements.source_risk,
            elements.source_review_context, elements.source_origin, elements.file_review_form, elements.source_coverage]) {
            panel.classList.add("hidden");
        }
        elements.source_panel.classList.remove("hidden");
        renderWorkspaceNavigation();
        renderWorkspaceShell();
    }
    viewedSourceLocation();
    setDiscussionMode(true);
    renderWorkspaceNavigation();
    renderWorkspaceShell();
    await discussionPane.open({ ...item, title }, state.payload?.review_generation);
}

elements.show_evidence.addEventListener("click", () => setDiscussionMode(false));
elements.show_discussion.addEventListener("click", () => discussItem().catch(showError));
elements.workspace_discuss.addEventListener("click", () => discussItem().catch(showError));
elements.workspace_comment.addEventListener("click", () => commentOnCurrentLine());

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

const pendingAi = new Set();
const revealedAt = new Map();
const REVEAL_MS = 450;

// Shimmering placeholder in the shape of the content that will replace it.
function aiPlaceholder(key, label, lines = 3) {
    pendingAi.add(key);
    return activityPlaceholder(label, lines);
}

// Animate a result in only when it replaces a placeholder the reader saw. Server updates
// rebuild the view, so a reveal resumes where it left off instead of restarting or vanishing.
function revealOnce(node, key) {
    if (pendingAi.delete(key)) revealedAt.set(key, performance.now());
    const started = revealedAt.get(key);
    if (started === undefined) return node;
    const elapsed = performance.now() - started;
    if (elapsed >= REVEAL_MS) {
        revealedAt.delete(key);
        return node;
    }
    node.classList.add("ai-reveal");
    node.style.animationDelay = `-${Math.round(elapsed)}ms`;
    return node;
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
    let response;
    const retryStartupRead = (options.method || "GET").toUpperCase() === "GET" && !connectionFeedback.hasConnected;
    const deadline = performance.now() + 2500;
    let retryDelay = 150;
    for (;;) {
        try {
            response = await fetch(path, {
                ...options,
                headers: { "Content-Type": "application/json", ...(options.headers || {}) },
            });
            break;
        } catch (cause) {
            markDisconnected();
            if (retryStartupRead && performance.now() + retryDelay < deadline) {
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
                retryDelay = Math.min(750, retryDelay * 2);
                continue;
            }
            const error = new Error("Connection to Agent Review was interrupted.", { cause });
            error.code = "connection_lost";
            throw error;
        }
    }
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
        rememberWorkspaceSource();
        state.reviewPage = "review";
        state.exploring = true;
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

function deltaMetric(label, added, removed, detail, mode, modified = null) {
    const value = el("strong", "delta-value");
    const addedValue = el("span", "delta-add", `+${added ?? 0}`);
    addedValue.title = "Added";
    value.append(addedValue, el("span", "delta-separator", "/"));
    if (modified !== null) {
        const modifiedValue = el("span", "delta-modified", `~${modified}`);
        modifiedValue.title = "Modified";
        value.append(modifiedValue, el("span", "delta-separator", "/"));
    }
    const removedValue = el("span", "delta-remove", `−${removed ?? 0}`);
    removedValue.title = "Deleted";
    value.append(removedValue);
    const card = el("button", "metric");
    const magnitude = Math.max(Number(added) || 0, Number(removed) || 0, Number(modified) || 0);
    if (magnitude >= 100) card.classList.add("metric-major");
    else if (magnitude >= 20) card.classList.add("metric-medium");
    if (magnitude === 0) {
        card.classList.add("metric-empty");
        card.title = "No changes";
    }
    card.type = "button";
    card.append(value, el("span", "", label), el("small", "", detail));
    card.addEventListener("click", () => {
        rememberWorkspaceSource();
        state.reviewPage = "review";
        state.exploring = true;
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
    // Match the module-level count and the Architecture edges view this tile opens.
    const topEdge = (summary.new_arch_edges || summary.arch_edges_removed) ? (model.aggregate_edges || [])
        .filter((edge) => edge.level === "module" && (edge.added_count > 0 || edge.removed_count > 0))
        .sort((a, b) => (b.added_count + b.removed_count) - (a.added_count + a.removed_count))[0] : null;
    const moduleName = (id) => {
        const node = nodeById.get(id);
        return node?.language === "csharp" && node.path ? node.path.split(/[\\/]/).pop() : String(node?.name || id).split(".").pop();
    };
    const split = sourceTestChurn(model);
    const fileDetail = [
        `${summary.files_added || 0} added`,
        `${summary.files_modified || 0} modified`,
        `${summary.files_removed || 0} deleted`,
    ].join(" · ");
    const packageDetail = (model.package_changes || []).slice(0, 2).map((item) =>
        `${item.name} ${item.resolved_current || item.declared_current?.map((entry) => entry.specifier).filter(Boolean).join(", ") || item.change}`
    ).join(" · ") || "No dependency changes";
    elements.summary.replaceChildren(...[
        deltaMetric("Files", summary.files_added, summary.files_removed, fileDetail, "files", summary.files_modified || 0),
        deltaMetric("Lines", summary.lines_added, summary.lines_removed,
            `source ${countLabel(split.source, "line")} · tests ${countLabel(split.tests, "line")} changed`, "lines"),
        state.payload?.decision_map ? decisionMetric(state.payload.decision_map) : null,
        deltaMetric("Architecture edges", summary.new_arch_edges, summary.arch_edges_removed, topEdge
            ? `Largest: ${moduleName(topEdge.source)} → ${moduleName(topEdge.target)}`
            : "No module relationship changes", "edges"),
        deltaMetric("Packages", summary.new_packages, summary.packages_removed, packageDetail, "packages", summary.packages_modified || 0),
    ].filter(Boolean));
    const edges = (summary.new_arch_edges || 0) + (summary.arch_edges_removed || 0);
    const packages = (summary.new_packages || 0) + (summary.packages_removed || 0) + (summary.packages_modified || 0);
    elements.overview_stats.textContent = [
        `+${(summary.lines_added || 0).toLocaleString()} −${(summary.lines_removed || 0).toLocaleString()} lines`,
        edges ? `${countLabel(edges, "architecture edge")} changed` : "no architecture changes",
        packages ? `${countLabel(packages, "package change")}` : "no package changes",
    ].join(" · ");
    const qualityIssues = [];
    const historical = ["commit", "pr"].includes(state.payload?.review_target?.mode);
    // Count every analyzer note so the Overview, Evidence and the handoff agree.
    const warnings = model.warnings || [];
    const coverageOptions = [];
    if (meta.node_loc !== undefined) coverageOptions.push("source-matched LCOV/Istanbul JSON");
    if (meta.go_loc !== undefined) coverageOptions.push("a Go coverprofile with coverage.sources.json hashes");
    if (meta.rust_loc !== undefined) coverageOptions.push("LCOV plus rust-coverage.json with the exact revision and SHA-256 source hashes");
    if (meta.python_loc || !coverageOptions.length) coverageOptions.push("Python coverage.json/coverage.xml");
    if (meta.csharp_loc !== undefined) coverageOptions.push("saved Coverlet Cobertura XML");
    const coveragePrerequisite = `Provide ${coverageOptions.join(" or ")}`;
    if (!model.coverage?.available) qualityIssues.push(historical
        ? "Coverage is unavailable for this historical snapshot. Working-tree coverage reports are not applied to commit or PR reviews."
        : `No usable coverage report for this worktree snapshot. ${coveragePrerequisite}, then Reanalyze.`);
    const notes = summarizeAnalysisWarnings(warnings);
    if (notes.other.length) qualityIssues.push(
        `${countLabel(notes.other.length, "static-analysis note")} ${plural(notes.other.length, "describes", "describe")} what could not be verified.`);
    if (notes.unlinked) qualityIssues.push(unlinkedSentence(notes));
    elements.overview_limitation.replaceChildren();
    elements.overview_limitation.classList.toggle("hidden", !qualityIssues.length);
    if (qualityIssues.length) {
        const title = !model.coverage?.available && !warnings.length ? "Coverage unavailable" : "Analysis limitation";
        const openLimitations = () => {
            state.selected = {
                id: "analysis-quality", kind: "analysis", name: "Analysis limitations",
                reason: qualityIssues.join("\n"),
                analysis_warnings: notes.ordered,
            };
            // The detail pane lives in the workspace; open it there so the limitation is visible in one click.
            if (state.reviewPage !== "review" || !state.exploring) {
                rememberWorkspaceSource();
                state.reviewPage = "review";
                state.exploring = true;
                state.mode = "findings";
                state.stack = [];
                elements.source_panel.classList.add("hidden");
                render();
            }
            setDetailVisible(true);
            renderDetail(state.selected);
            elements.detail.tabIndex = -1;
            elements.detail.focus({ preventScroll: true });
        };
        const details = el("button", "link-button", "Details");
        details.type = "button";
        details.addEventListener("click", openLimitations);
        elements.overview_limitation.append(el("strong", "", title), el("span", "", qualityIssues.join(" ")), details);
    }
    elements.summary.title = `${meta.base_ref || "base"} @ ${(meta.base_sha || "").slice(0, 8)} → ${(meta.head_sha || "").slice(0, 8)} · ${meta.python_loc || 0} Python LOC${meta.node_loc !== undefined ? ` · ${meta.node_loc} JavaScript/TypeScript LOC` : ""}${meta.csharp_loc != null ? ` · ${meta.csharp_loc} C# LOC` : ""}${meta.go_loc != null ? ` · ${meta.go_loc} Go LOC` : ""}${meta.rust_loc != null ? ` · ${meta.rust_loc} Rust LOC` : ""}`;
}

function evidenceLabel(id) {
    const evidence = state.payload?.model?.evidence?.[id];
    if (!evidence) return id;
    const kind = String(evidence.kind || "evidence").replaceAll("_", " ");
    const location = evidence.path ? `${evidence.path}${evidence.line ? `:${evidence.line}` : ""}` : null;
    return location ? `${kind} · ${location}` : kind;
}

function evidenceButton(id) {
    const button = el("button", "evidence-link");
    // Long paths wrap at separators rather than inside a file name or line number.
    for (const part of String(evidenceLabel(id)).split(/(?<=[/._\- ])/)) button.append(document.createTextNode(part), document.createElement("wbr"));
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
        const signal = reviewSignal(item);
        if (container === elements.attention) card.classList.add(`signal-${signal.kind}`);
        card.type = "button";
        const heading = el("div", "card-heading");
        heading.append(el("strong", "", item.title || item.name || item.id));
        if (container === elements.attention) heading.append(el("span", "signal-label", signal.label));
        const priorityValue = item.impact_score != null || item.node_id || item.package_id ? concernPriority(item) : null;
        if (priorityValue != null) {
            const priority = el("b", "impact-score", `Static priority ${priorityValue}/100`);
            priority.title = "Deterministic static priority (not an AI judgement or a security score). Concerns in the focused queue also weigh churn, caller reach and test evidence; others use the analyzer's impact score. The same number appears on the code strip, Attention and the handoff.";
            heading.append(priority);
        }
        card.append(heading, el("span", "card-body", conciseReviewText(item.id?.startsWith("package:") ? `${item.change} · Version ${packageVersionText(item)}` : item.body || item.reason || item.change || "")));
        if (container === elements.attention) {
            const evidence = reviewItemEvidence(state.payload.model, item, state.payload.decision_map, state.payload.test_run);
            card.append(el("small", "factor-line", countLabel(evidence.citations.length, "saved source citation")));
            if (evidence.counts.confirmed) card.append(el("small", "factor-line",
                `${evidence.counts.confirmed} paths executed by linked tests${evidence.counts.failing ? ` (${evidence.counts.failing} reached by failing tests)` : ""}`));
            else if (evidence.counts.inferred) card.append(el("small", "factor-line",
                `${countLabel(evidence.counts.inferred, "path")} with inferred test links; execution not established`));
        }
        if (item.impact_factors?.length) card.append(el("small", "factor-line", item.impact_factors.join(" · ")));
        card.dataset.itemId = item.id;
        card.classList.toggle("is-selected", state.selected?.id === item.id || state.areaGroup?.id === item.id);
        card.title = [item.title, item.body || item.reason].filter(Boolean).join("\n");
        card.addEventListener("click", () => openReviewItem(item));
        if (container === elements.attention) {
            const hidden = isFindingClosed(item, state.closedFindingKeys);
            const triage = concernTriage(item, state.reviewLedger);
            const closed = hidden || isConcernSetAside(item, state.reviewLedger);
            const wrapper = el("div", `queue-item${closed ? " is-closed" : ""}`);
            wrapper.dataset.itemId = item.id;
            const layer = layerOf(layeredNavigation(), { path: concernPath(item) });
            if (layer) {
                wrapper.dataset.layer = layer.id;
                const chip = layerMarker(layer, "layer-chip layer-chip-inline");
                chip.title = layerLabel(layer);
                heading.prepend(chip);
            }
            const toggle = el("button", "queue-toggle", hidden ? "Reopen" : "Close");
            toggle.type = "button";
            toggle.setAttribute("aria-label", `${hidden ? "Reopen" : "Close"} ${item.title || item.name}`);
            toggle.addEventListener("click", () => toggleFinding(item));
            if (hidden) heading.append(el("span", "closed-label", "Closed"));
            else if (triage) heading.append(el("span", "closed-label", reviewStateLabel(triage)));
            // Set-aside concerns are already closed by their triage; change the triage to reopen them.
            wrapper.append(card, ...(closed && !hidden ? [] : [toggle]));
            const impact = el("button", "link-button", "Impact");
            impact.type = "button";
            impact.setAttribute("aria-label", `Show impact of ${item.title || item.name}`);
            impact.addEventListener("click", () => openImpact(item));
            if (!item.collect_mode) wrapper.append(impact);
            if (!item.collect_mode) {
                const ask = el("button", "link-button", "Ask");
                ask.type = "button";
                ask.setAttribute("aria-label", `Ask about ${item.title || item.name}`);
                ask.addEventListener("click", () => discussItem(item).catch(showError));
                wrapper.append(ask);
            }
            container.append(wrapper);
        } else {
            container.append(card);
        }
    }
    if (container === elements.attention) groupConcernsByLayer(container);
}

// One priority per concern everywhere (cards, strip, Attention, detail, handoff); cached per review state.
function concernPriority(finding) {
    const payload = state.payload;
    const model = payload?.model;
    if (!model) return finding.impact_score ?? null;
    const key = `${payload.review_generation}:${payload.decision_map?.status || ""}:${payload.test_run?.finished_at || ""}:${payload.test_run?.status || ""}:${(payload.generated_observations || []).length}`;
    if (state.priorityKey !== key) {
        state.priorityKey = key;
        state.priorityOf = concernPriorities(buildReviewPlan(model, payload.decision_map, payload.test_run,
            [...groupFindings(model.attention || []), ...(payload.generated_observations || [])]));
    }
    return state.priorityOf(finding);
}

// Hidden in this browser, or triaged as an accepted risk or false positive.
const concernClosed = (item) => isFindingClosed(item, state.closedFindingKeys) || isConcernSetAside(item, state.reviewLedger);

function concernPath(item) {
    const model = state.payload?.model;
    if (item.path) return item.path;
    if (state.nodePathModel !== model) {
        state.nodePathModel = model;
        state.nodePaths = new Map((model?.nodes || []).map((entry) => [entry.id, entry.path]));
    }
    const nodePath = item.node_id && state.nodePaths.get(item.node_id);
    if (nodePath) return nodePath;
    const pkg = (model?.package_changes || []).find((entry) => entry.id === (item.package_id || item.id));
    return pkg && (pkg.declared_current?.[0]?.source || pkg.declared_base?.[0]?.source) || null;
}

// Concerns read in reading-path layer order, keeping their impact order within each layer.
function groupConcernsByLayer(container) {
    const navigation = layeredNavigation();
    if (!navigation) return;
    const items = [...container.querySelectorAll(":scope > .queue-item")];
    const order = new Map(navigation.layers.map((layer, index) => [layer.id, index]));
    const rank = (item) => item.dataset.layer ? order.get(item.dataset.layer) : Infinity;
    const sorted = items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index);
    let current;
    for (const { item } of sorted) {
        const layer = item.dataset.layer || "";
        if (layer !== current) {
            current = layer;
            const match = navigation.layers.find((entry) => entry.id === layer);
            container.append(el("h3", "review-plan-layer", match ? layerLabel(match) : "Outside the reading path"));
        }
        container.append(item);
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

function loadReviewLedger(model, { force = false } = {}) {
    const key = reviewSnapshotKey(model, state.payload?.review_target);
    if (state.reviewLedgerStorageKey === key && !force) return;
    const previous = state.reviewLedgerStorageKey;
    state.reviewLedgerStorageKey = key;
    state.reviewLedgerError = null;
    if (previous !== key) {
        try {
            state.reviewLedger = parseReviewLedger(localStorage.getItem(key));
            state.progressLegacyCopy = localStorage.getItem(`${key}:unmigrated`) || null;
        } catch (error) {
            state.reviewLedger = new Map();
            state.reviewLedgerError = `Unable to restore browser review progress: ${error.message}`;
        }
    }
    state.progressLoading = true;
    state.progressReady = false;
    state.progressError = null;
    renderFileReview();
    const local = serializeReviewLedger(state.reviewLedger);
    api("/api/review-progress").then(async (record) => {
        if (state.reviewLedgerStorageKey !== key) return;
        if (record.snapshot !== key) throw new Error("Saved progress returned a different source snapshot.");
        if (!record.revision && state.reviewLedger.size) {
            record = await api("/api/review-progress", { method: "POST",
                body: JSON.stringify({ snapshot: key, revision: 0, entries: JSON.parse(local), cursor: record.cursor }) });
        } else if (record.revision && local !== "{}" && local !== JSON.stringify(record.entries)) {
            state.progressLegacyCopy = local;
            try { localStorage.setItem(`${key}:unmigrated`, local); }
            catch (error) { state.reviewLedgerError = `Browser progress differs from the saved copy; export it before closing: ${error.message}`; }
        }
        if (state.reviewLedgerStorageKey !== key) return;
        state.reviewLedger = parseReviewLedger(JSON.stringify(record.entries));
        state.progressRevision = record.revision;
        state.progressDurable = record.durable;
        state.savedReviewCursor = record.cursor;
        state.progressReady = true;
        state.progressLoading = false;
        render();
        renderFileReview();
    }).catch((error) => {
        if (state.reviewLedgerStorageKey !== key) return;
        state.progressLoading = false;
        state.progressError = error.message;
        renderReviewOverview();
        renderFileReview();
    });
}

function cacheReviewLedger() {
    try {
        localStorage.setItem(state.reviewLedgerStorageKey, serializeReviewLedger(state.reviewLedger));
        state.reviewLedgerError = null;
    } catch (error) {
        state.reviewLedgerError = `Session progress is saved, but its browser cache could not be updated: ${error.message}`;
        showError(new Error(state.reviewLedgerError));
        return false;
    }
    return true;
}

// A saved cursor may only name an item that belongs to the file it points at; otherwise resuming would mix two places.
function cursorItemId(item, path) {
    const id = item?.id;
    if (!id || (item.path && item.path !== path) || (id.startsWith("file:") && id !== `file:${path}`)) return null;
    return id;
}

function currentReviewCursor() {
    const source = state.source || state.workspaceReturn?.source;
    if (!source?.path) return state.savedReviewCursor || null;
    const viewed = viewedSourceLocation() || state.workspaceReturn?.cursor;
    return { path: source.path, line: viewed?.line || Number(source.start_line) || 1,
        side: viewed?.side || source.focus_side || (source.current === null ? "base" : "current"),
        tab: state.source ? state.sourceTab : state.workspaceReturn.tab,
        item_id: cursorItemId(source.reviewItem || state.selected || state.workspaceReturn?.selected, source.path), group: state.activeReviewGroup || null };
}

// Where the reader actually is: the source they just left (not yet autosaved) before the last saved position.
function liveReviewCursor() {
    const saved = state.workspaceReturn;
    if (saved?.generation !== state.payload?.review_generation || !saved.source?.path) return state.savedReviewCursor || null;
    const source = saved.source;
    return { path: source.path, line: saved.cursor?.line || Number(source.start_line) || 1,
        side: saved.cursor?.side || source.focus_side || (source.current === null ? "base" : "current"),
        tab: saved.tab, item_id: cursorItemId(saved.selected, source.path), group: saved.group || null, live: true };
}

// Leaving Review saves the reading point immediately so labels, Finish and a reload all agree.
function flushReviewCursor() {
    clearTimeout(state.cursorSaveTimer);
    const cursor = liveReviewCursor();
    if (!cursor?.live || !state.progressReady || state.progressSaving) return;
    const { live, ...stored } = cursor;
    if (JSON.stringify(stored) === JSON.stringify(state.savedReviewCursor)) return;
    persistReviewEntries(new Map(state.reviewLedger), stored, { quiet: true }).then((saved) => { if (saved) renderReviewOverview(); });
}

// Only decision saves show "Saving…" and lock the footer; reading-position saves happen silently in the background.
function savingDecision() {
    return state.progressSaving && !state.progressSavingBackground;
}

async function persistReviewEntries(entries, cursor = currentReviewCursor(), { quiet = false, background = false } = {}) {
    // A background reading-position save never blocks a decision: wait for it to finish, then save the decision.
    if (!background && state.progressSaving && state.progressSavingBackground) await state.progressSavePromise?.catch(() => {});
    if (!state.progressReady || state.progressSaving) {
        if (background) return false;
        showError(new Error(state.progressSaving ? "Wait for the current review decision to save." : "Reload saved progress before recording a decision."));
        return false;
    }
    const key = state.reviewLedgerStorageKey;
    state.progressSaving = true;
    state.progressSavingBackground = background;
    let settle;
    state.progressSavePromise = new Promise((resolve) => { settle = resolve; });
    state.progressError = null;
    if (!background) renderFileReview();
    const save = (revision, values) => api("/api/review-progress", { method: "POST",
        body: JSON.stringify({ snapshot: key, revision, entries: Object.fromEntries(values), cursor }) });
    try {
        let record;
        try { record = await save(state.progressRevision, entries); }
        catch (error) {
            if (error.status !== 409) throw error;
            // Another tab saved (often only a reading position). Rebase this change if it touched none of the same records.
            const latest = await api("/api/review-progress");
            if (latest.snapshot !== key) throw error;
            const base = state.reviewLedger;
            const changed = new Set([...entries.keys(), ...base.keys()].filter((id) => JSON.stringify(entries.get(id)) !== JSON.stringify(base.get(id))));
            if ([...changed].some((id) => JSON.stringify(latest.entries[id]) !== JSON.stringify(base.get(id)))) throw error;
            const merged = new Map(Object.entries(latest.entries));
            for (const id of changed) entries.has(id) ? merged.set(id, entries.get(id)) : merged.delete(id);
            record = await save(latest.revision, merged);
        }
        if (state.reviewLedgerStorageKey !== key) return false;
        state.reviewLedger = parseReviewLedger(JSON.stringify(record.entries));
        state.progressRevision = record.revision;
        state.progressDurable = record.durable;
        state.savedReviewCursor = record.cursor;
        if (record.github_viewed) {
            state.githubViewed = record.github_viewed;
            if (state.prReview?.viewed && !record.github_viewed.message) {
                for (const [id, entry] of Object.entries(record.entries)) {
                    if (id.startsWith("review-file:")) state.prReview.viewed[id.slice(12)] = entry.disposition === "reviewed";
                }
            }
        } else state.githubViewed = null;
        cacheReviewLedger();
        if (!quiet) render();
        return true;
    } catch (error) {
        if (state.reviewLedgerStorageKey === key) {
            state.progressError = error.message;
            if (!quiet) showError(error);
        }
        return false;
    } finally {
        if (state.reviewLedgerStorageKey === key) {
            state.progressSaving = false;
            state.progressSavingBackground = false;
        }
        settle();
        renderFileReview();
    }
}

async function setReviewDisposition(item, disposition, note = "") {
    const record = {
        disposition,
        note: note.trim(),
        path: state.source?.path || item.path || "",
        line: Number(state.source?.start_line) || item.line || null,
        updated_at: new Date().toISOString(),
    };
    const entries = new Map(state.reviewLedger);
    if (disposition === "pending" && !record.note) entries.delete(item.id);
    else entries.set(item.id, record);
    if (await persistReviewEntries(entries) && state.source) renderSourceRisk();
}

elements.review_progress_retry.addEventListener("click", () => loadReviewLedger(state.payload.model, { force: true }));
elements.file_review_retry.addEventListener("click", () => loadReviewLedger(state.payload.model, { force: true }));
elements.review_progress_backup.addEventListener("click", () => {
    const blob = new Blob([state.progressLegacyCopy || "{}"], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "previous-browser-review-progress.json";
    link.click();
    URL.revokeObjectURL(link.href);
});

function fileReviewQueue() {
    const cached = state.sectionData && !state.payload?.loading ? layeredNavigation() : null;
    return reviewSequence(cached || workspaceNavigation(state.payload?.model, state.sectionData), state.navigationMode);
}

// Review groups load asynchronously; choosing a file before they arrive would treat every file as supporting.
async function readySectionData() {
    if (ensureSectionData()) return;
    await state.sectionPromise;
}

async function nextFileFromRail(current = null) {
    await readySectionData();
    return nextFileReview(fileReviewQueue(), state.reviewLedger, current);
}

function uniqueReviewFiles() {
    return [...new Map(fileReviewQueue().map((entry) => [entry.path, entry])).values()];
}

async function openFileReview(entry) {
    if (!entry) { openFinishReview(); return; }
    const navigation = workspaceNavigation(state.payload.model, state.sectionData);
    const group = navigation.groups.find((item) => item.id === entry.group)
        || navigation.groups.find((item) => item.files.some((file) => file.path === entry.path));
    const priority = !group?.section && overviewPlan().find((item) => item.path === entry.path);
    if (priority) { openReviewPlanItem(priority); return; }
    await openWorkspaceFile(entry.file || entry, group);
}

async function openOverviewDestination(destination) {
    if (destination?.resume?.live && state.workspaceReturn?.source?.path === destination.path) await returnWorkspaceSource({ code: true });
    else if (destination?.resume) await resumeReviewCursor(destination.resume);
    else await openFileReview(destination?.entry || null);
}

async function resumeReviewCursor(cursor) {
    const model = state.payload?.model;
    if (!cursor || !Object.hasOwn(model.source_files || {}, cursor.path)) throw new Error("The saved reading point is unavailable in this snapshot.");
    let item = [...model.nodes, ...model.edges || [], ...model.package_changes || [], ...model.package_dependencies || [],
        ...model.attention || [], ...(state.payload.generated_observations || [])].find((item) => item.id === cursor.item_id);
    if (!item && cursor.item_id?.startsWith("section:")) {
        const data = await api("/api/review-sections");
        if (state.payload.model !== model) throw new Error("The review changed while restoring the saved group.");
        const section = data.sections.find((section) => section.id === cursor.item_id);
        if (section) item = { id: section.id, kind: "section", title: section.title, path: cursor.path };
    }
    if (!item && model.evidence?.[cursor.item_id]) item = { id: cursor.item_id, kind: "evidence", path: cursor.path };
    // An unknown or mismatched item never blocks resuming: the saved path and line are the reading point.
    if (item?.path && item.path !== cursor.path) item = null;
    state.selected = item || { id: `file:${cursor.path}`, kind: "file", path: cursor.path, name: cursor.path };
    state.reviewPage = "review";
    state.exploring = false;
    state.mode = "walkthrough";
    state.activeReviewGroup = cursor.group;
    const loaded = await openSourceReference({ path: cursor.path, lines: [cursor.line], side: cursor.side },
        { focus: true, tab: cursor.tab, nav: "reset" });
    const generated = model.changes.find((file) => file.path === cursor.path)?.generated;
    if (loaded && !generated && !["section", "package"].includes(state.selected?.kind)) ensureAnnotation(state.selected);
}

// Where this file sits and how big it is: "+56 −8 · file 2 of 3 in 2. Apply verified export corrections".
function renderSourcePosition(path) {
    const change = state.payload?.model?.changes?.find((item) => item.path === path && item.status !== "unchanged");
    const navigation = change && layeredNavigation();
    const layer = navigation && layerOf(navigation, { path });
    const parts = [];
    if (change) parts.push(`+${(change.lines_added || 0).toLocaleString()} −${(change.lines_removed || 0).toLocaleString()}`);
    if (layer) {
        const groups = new Set(layer.groups.map((group) => group.id));
        const files = [...new Set(reviewSequence(navigation).filter((entry) => groups.has(entry.group)).map((entry) => entry.path))];
        const index = files.indexOf(path);
        if (index >= 0) parts.push(`file ${index + 1} of ${files.length} in ${layerLabel(layer)}`);
    }
    if (!change) parts.push("related source, outside the change");
    elements.source_position.textContent = parts.join(" · ");
    elements.source_position.title = parts.join(" · ");
}

// The file "Mark … & next" will open, so the button can name its target.
// The next reading-path entry after the open file, assuming the open file is marked as decided.
function nextReviewEntry() {
    const source = state.source;
    if (!source) return null;
    const disposition = elements.file_review_disposition.value === "pending" ? "reviewed" : elements.file_review_disposition.value;
    const entries = new Map(state.reviewLedger);
    entries.set(fileReviewId(source.path), { disposition, path: source.path });
    const next = nextFileReview(fileReviewQueue(), entries,
        { path: source.path, group: state.navigationMode === "files" ? null : state.activeReviewGroup || null });
    return next && next.path !== source.path ? next : null;
}

function nextFileLabel() {
    return nextReviewEntry()?.path || null;
}

// Which explanation Agent Review shows when a reading-path entry opens: its first changed symbol, a priority's callable
// or finding, or else the whole file. Mirrors openFileReview and openWorkspaceFile.
function annotationIdForEntry(entry) {
    const model = state.payload?.model;
    // Which item opens depends on the reading-path groups; guessing before they load would prefetch the wrong one.
    if (!model || !entry?.path || !state.sectionData) return null;
    const file = entry.file || model.changes.find((change) => change.path === entry.path);
    if (!file || file.generated) return null;
    // Resuming a saved reading point reopens the exact item that was selected.
    if (entry.resume) {
        const id = entry.resume.item_id;
        if (id?.startsWith("section:") || id?.startsWith("package:")) return null;
        const known = id && [...model.nodes, ...(model.edges || []), ...(model.attention || []),
            ...(state.payload.generated_observations || [])]
            .some((item) => item.id === id && (!item.path || item.path === entry.path));
        if (id && model.evidence?.[id]) return id;
        return known ? id : `file:${entry.path}`;
    }
    const navigation = workspaceNavigation(model, state.sectionData);
    const group = navigation.groups.find((item) => item.id === entry.group)
        || navigation.groups.find((item) => item.files.some((candidate) => candidate.path === entry.path));
    if (!group?.section) {
        const priority = overviewPlan().find((item) => item.path === entry.path);
        if (priority) return priority.kind === "package" ? null
            : priority.kind === "callable" && priority.preferred ? priority.callable.id : (priority.finding || priority.node)?.id || null;
    }
    const range = group?.section?.ranges.find((item) => item.path === entry.path && item.side !== "base")
        || group?.section?.ranges.find((item) => item.path === entry.path);
    const node = range?.symbol_id && model.nodes.find((item) => item.id === range.symbol_id);
    return node ? node.id : `file:${entry.path}`;
}

function requestAnnotation(item) {
    const generation = state.payload.review_generation;
    const key = `${generation}:${item.id}`;
    const cached = state.payload.annotations?.[item.id];
    if (cached) return Promise.resolve(cached);
    if (state.annotationRequests.has(key)) return state.annotationRequests.get(key);
    const promise = api("/api/annotation", { method: "POST",
        body: JSON.stringify({ id: item.id, evidence_ids: item.evidence_ids || [] }) })
        .then(({ annotation }) => {
            if (state.payload?.review_generation === generation) {
                state.payload.annotations ||= {};
                state.payload.annotations[item.id] = annotation;
            }
            return annotation;
        }).finally(() => {
            if (state.annotationRequests.get(key) === promise) state.annotationRequests.delete(key);
        });
    state.annotationRequests.set(key, promise);
    return promise;
}

function renderPrefetchStatus() {
    const status = state.prefetchStatus;
    for (const panel of [elements.overview_prefetch, elements.workspace_prefetch]) {
        panel.replaceChildren();
        panel.classList.toggle("hidden", !status);
        if (!status) continue;
        if (status.error) panel.append(el("p", "muted", `Could not prepare ${status.path.split("/").at(-1)}. Open the file to retry. ${status.error}`));
        else panel.append(activityPlaceholder(`Preparing next explanation: ${status.path.split("/").at(-1)}`, 1));
    }
}

// Share the request with a click that arrives before prefetch finishes; retain the result even after navigating away.
function prefetchAnnotation(entry) {
    const id = annotationIdForEntry(entry);
    const payload = state.payload;
    if (!id || payload?.annotations?.[id] || payload?.loading) return;
    state.prefetchedAnnotations ||= new Set();
    const key = `${payload.review_generation}:${id}`;
    if (state.prefetchedAnnotations.has(key)) return;
    state.prefetchedAnnotations.add(key);
    const status = { id, path: entry.path };
    state.prefetchStatus = status;
    renderPrefetchStatus();
    requestAnnotation({ id }).then(() => {
        if (state.prefetchStatus === status) state.prefetchStatus = null;
    }, (error) => {
        if (state.prefetchStatus === status) status.error = error.message;
    }).finally(() => {
        if (state.payload?.review_generation === payload.review_generation) renderPrefetchStatus();
    });
}

// Prefetch the next item shortly after a file settles, so the open file's own explanation goes first and skimming
// through files quickly does not start a generation for each one.
function schedulePrefetchNext() {
    clearTimeout(state.prefetchTimer);
    const path = state.source?.path;
    if (!path || state.reviewPage !== "review") return;
    state.prefetchTimer = setTimeout(() => {
        if (state.source?.path !== path || state.reviewPage !== "review") return;
        // Still opening: check again once the file has settled.
        if (state.pendingSource) { schedulePrefetchNext(); return; }
        prefetchAnnotation(nextReviewEntry());
    }, 1200);
}

function renderFileReview() {
    const source = state.source;
    const changed = source && state.payload?.model?.changes?.some((file) => file.path === source.path && file.status !== "unchanged");
    elements.file_review_form.classList.toggle("hidden", !changed);
    if (!changed) return;
    const key = `${state.reviewLedgerStorageKey}:${source.path}`;
    const record = state.fileReviewDrafts.get(key) || state.reviewLedger.get(fileReviewId(source.path)) || { disposition: "pending", note: "" };
    elements.file_review_label.textContent = `Decision · ${source.path.split("/").at(-1)}`;
    elements.file_review_label.title = `Whole-file review · ${source.path}`;
    if (elements.file_review_form.dataset.key !== key || !state.fileReviewDrafts.has(key)) {
        elements.file_review_form.dataset.key = key;
        elements.file_review_disposition.value = record.disposition;
        elements.file_review_note.value = record.note || "";
    }
    // A decision can only apply to a file whose source has finished loading.
    const disabled = !state.progressReady || savingDecision() || Boolean(state.pendingSource) || Boolean(state.advancing);
    for (const element of [elements.file_review_disposition, elements.file_review_note, elements.file_review_save, elements.file_review_next]) element.disabled = Boolean(disabled);
    const verb = elements.file_review_disposition.value === "pending" ? "Mark reviewed"
        : elements.file_review_disposition.value === "follow-up" ? "Save follow-up" : "Save";
    const target = state.pendingSource || !state.sectionData ? undefined : nextFileLabel();
    elements.file_review_next.textContent = target === undefined ? `${verb} & next`
        : target ? `${verb} & next: ${target.split("/").at(-1)}` : `${verb} & finish`;
    elements.file_review_next.title = target ? `Then opens ${target} (M)` : target === null ? "Then opens the review summary (M)" : "Save and open the next file (M)";
    elements.file_review_status.textContent = state.progressError ? `Not saved: ${state.progressError}`
        : state.progressLoading ? "Restoring session progress…" : savingDecision() ? "Saving…"
            : state.fileReviewDrafts.has(key) ? "Unsaved whole-file decision"
            : state.progressDurable ? "Saved" : "Memory-only progress";
    // On a pull request, report whether GitHub's "Viewed" checkbox followed the last decision on this file.
    const viewedSync = state.githubViewed;
    if (viewedSync && (viewedSync.paths || []).includes(state.source?.path) && !state.progressError && !savingDecision() && !state.fileReviewDrafts.has(key)) {
        elements.file_review_status.textContent = viewedSync.message ? `Saved · ${viewedSync.message}` : "Saved · Viewed on GitHub updated";
    }
    elements.file_review_status.title = state.progressDurable ? "Progress is saved in this session workspace" : "Progress is memory-only until this provider closes";
    elements.file_review_status.dataset.quiet = String(!state.progressError && !state.progressLoading && !savingDecision()
        && !state.fileReviewDrafts.has(key) && Boolean(state.progressDurable));
    elements.file_review_retry.classList.toggle("hidden", !state.progressError);
}

function keepFileDraft() {
    if (!state.source) return;
    state.fileReviewDrafts.set(`${state.reviewLedgerStorageKey}:${state.source.path}`, {
        disposition: elements.file_review_disposition.value, note: elements.file_review_note.value,
    });
    renderFileReview();
}
elements.file_review_disposition.addEventListener("change", keepFileDraft);
elements.file_review_note.addEventListener("input", keepFileDraft);
async function saveCurrentFile(advance) {
    const source = state.source;
    if (!source || state.pendingSource || state.advancing) return;
    const path = source.path;
    const key = `${state.reviewLedgerStorageKey}:${path}`;
    const disposition = advance && elements.file_review_disposition.value === "pending" ? "reviewed" : elements.file_review_disposition.value;
    const entries = new Map(state.reviewLedger);
    entries.set(fileReviewId(path), { disposition, note: elements.file_review_note.value.trim(), path,
        line: currentReviewCursor()?.line || 1, updated_at: new Date().toISOString() });
    // One Mark & next at a time: the next file must have opened and stayed on screen briefly before it can be marked.
    if (advance) state.advancing = true;
    try {
        if (!await persistReviewEntries(entries)) return;
        state.fileReviewDrafts.delete(key);
        elements.file_review_form.dataset.key = "";
        renderFileReview();
        if (advance) {
            const next = await nextFileFromRail(
                { path, group: state.navigationMode === "files" ? null : state.activeReviewGroup || null });
            if (!next || (next.path === path && disposition !== "pending")) openFinishReview();
            else await openFileReview(next);
        }
    } finally {
        if (advance) setTimeout(() => { state.advancing = false; renderFileReview(); }, 350);
    }
}
elements.file_review_save.addEventListener("click", () => saveCurrentFile(false).catch(showError));
elements.file_review_form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveCurrentFile(true).catch(showError);
});
elements.group_review_cancel.addEventListener("click", () => elements.group_review_dialog.close());
elements.group_review_confirm.addEventListener("click", async () => {
    const group = state.bulkReviewGroup;
    if (!group) return;
    elements.group_review_confirm.disabled = true;
    const entries = new Map(state.reviewLedger);
    const updated = new Date().toISOString();
    for (const file of group.files) {
        const previous = entries.get(fileReviewId(file.path));
        entries.set(fileReviewId(file.path), { disposition: "reviewed", path: file.path,
            note: previous?.note || "", line: previous?.line || 1, updated_at: updated });
    }
    if (await persistReviewEntries(entries)) elements.group_review_dialog.close();
    else {
        elements.group_review_confirm.disabled = false;
        elements.group_review_error.textContent = state.progressError || "Unable to save these file decisions.";
        elements.group_review_error.classList.remove("hidden");
    }
});

function openFinishReview() {
    state.selectionEpoch++;
    sourceRenderVersion++;
    rememberWorkspaceSource();
    setSourceFocus(false);
    state.reviewPage = "finish";
    state.navigationOpen = false;
    elements.source_panel.classList.add("hidden");
    render();
    flushReviewCursor();
    elements.review_finish.focus({ preventScroll: true });
}

function renderFinishReview() {
    const model = state.payload?.model;
    if (!model || state.reviewPage !== "finish") return;
    const progress = fileReviewProgress(model, state.reviewLedger);
    const panel = elements.review_finish;
    panel.replaceChildren(el("p", "eyebrow", "HUMAN REVIEW SUMMARY"),
        el("h2", "", progress.pending || progress.followUp ? "Review has remaining work" : "Changed files marked reviewed"),
        el("p", "", `${progress.reviewed} of ${countLabel(progress.total, "changed file")} reviewed · ${progress.pending} not reviewed · ${progress.followUp} need follow-up`),
        el("p", "muted", "Human review decisions do not prove correctness, resolve concerns, complete AI analysis or establish test coverage."));
    const navigation = layeredNavigation();
    const next = overviewDestination();
    if (next) {
        const layer = layerOf(navigation, next);
        const button = el("button", "review-next", `Continue at ${layer ? `${layerLabel(layer)} › ` : ""}${next.path.split("/").at(-1)}${next.line ? `:${next.line}` : ""}`);
        button.type = "button";
        button.title = `Opens ${next.path}`;
        button.addEventListener("click", () => openOverviewDestination(next).catch(showError));
        panel.append(button);
    }
    if (navigation?.layers.length) {
        const layers = el("ol", "overview-layers finish-layers");
        layers.setAttribute("aria-label", "Progress by layer");
        for (const layer of navigation.layers) {
            const progress = layerProgress(layer);
            const row = el("button", `overview-layer${layer.supporting ? " is-supporting" : ""}`);
            row.type = "button";
            const name = layerHeading(layer, { path: false });
            const progressCell = el("span", "overview-layer-progress", `${progress.reviewed}/${progress.total} reviewed`);
            const tests = layerTestChip(layer);
            if (tests) progressCell.append(tests);
            row.append(layerMarker(layer, "overview-layer-number"), name, progressCell);
            row.addEventListener("click", () => openLayer(navigation, layer));
            const item = el("li", "");
            item.append(row);
            layers.append(item);
        }
        panel.append(layers);
    }
    const legacy = [...state.reviewLedger].filter(([id, entry]) => !id.startsWith("review-file:") && entry.disposition !== "pending");
    const triagedFollowUp = legacy.filter(([, entry]) => entry.disposition === "follow-up").length;
    if (legacy.length) panel.append(el("p", "muted", `${countLabel(legacy.length, "concern")} triaged${
        triagedFollowUp ? ` (${triagedFollowUp} ${plural(triagedFollowUp, "needs", "need")} follow-up)` : ""}. Triage explains a concern but does not mark files reviewed.`));
    const findings = groupFindings(model.attention || []);
    const activeCount = findings.filter((item) => !concernClosed(item)).length;
    const setAside = findings.filter((item) => !isFindingClosed(item, state.closedFindingKeys) && isConcernSetAside(item, state.reviewLedger)).length;
    panel.append(el("p", "", `${countLabel(activeCount, "active concern")} ${plural(activeCount, "remains", "remain")}${
        setAside ? ` · ${countLabel(setAside, "concern")} set aside as accepted risk or false positive` : ""}.`));
    const tests = state.payload.test_run;
    const distinctTests = new Set((tests?.tests || []).map((test) => baseTestId(test.id))).size;
    const caseNote = (tests?.tests || []).length > distinctTests ? ` (results across ${countLabel(distinctTests, "linked test")}; each parametrized case is a result)` : "";
    panel.append(el("p", "muted", tests?.tests?.length && ["complete", "running"].includes(tests.status)
        ? `Linked-test results so far: ${tests.counts?.passed || 0} passed, ${(tests.counts?.failed || 0) + (tests.counts?.error || 0)} failed${
            tests.counts?.skipped ? `, ${tests.counts.skipped} skipped` : ""}${caseNote}${
            tests.status === "running" ? "; a run is in progress" : ""}. Each layer's outcome is shown beside it. This is separate from human review.`
        : tests?.status === "complete"
            ? `Linked-test run completed: ${tests.counts?.passed || 0} passed, ${tests.counts?.failed || 0} failed. This is separate from human review.`
            : "No completed linked-test run is recorded for this view. Coverage and AI analysis retain their own evidence limits."));
    const list = el("div", "finish-files");
    const fileButton = (file, group) => {
        const record = state.reviewLedger.get(fileReviewId(file.path));
        const button = el("button", "workspace-file", `${reviewStateLabel(record?.disposition || "pending")} · ${file.path}${record?.note ? ` — ${record.note}` : ""}`);
        button.type = "button";
        button.addEventListener("click", () => openFileReview(group ? { path: file.path, group: group.id, file } : file).catch(showError));
        return button;
    };
    if (navigation) {
        for (const layer of navigation.layers) {
            list.append(el("h4", "finish-layer-heading", layerLabel(layer)));
            for (const group of layer.groups) for (const file of group.files) list.append(fileButton(file, group));
        }
    } else for (const file of uniqueReviewFiles()) list.append(fileButton(file, null));
    const details = el("details", "");
    details.append(el("summary", "", "All file decisions"), list);
    panel.append(details);
    const pr = state.prReview;
    const drafted = pr?.drafts?.comments?.length || 0;
    if (pr?.available) {
        const files = (model.changes || []).filter((file) => file.status !== "unchanged");
        const viewed = files.filter((file) => pr.viewed?.[file.path]).length;
        panel.append(el("p", "", `Pull request: ${countLabel(drafted, "draft line comment")} ready to post · ${viewed} of ${countLabel(files.length, "file")} marked Viewed on GitHub${
            pr.threads?.length ? ` · ${countLabel(pr.threads.filter((thread) => !thread.reply_to).length, "existing thread")}` : ""}.`));
        if (pr.github_error) panel.append(el("p", "error", pr.github_error));
        if (pr.head_matches === false) panel.append(el("p", "error", `The pull request has newer commits (${String(pr.head || "").slice(0, 7)}) than this review. Re-open it in Agent Review before posting; nothing can be posted from this snapshot.`));
    } else if (drafted) panel.append(el("p", "muted", `${countLabel(drafted, "line comment")} drafted; they are included in the handoff summary.`));
    const handoff = el("button", next ? "review-next review-secondary" : "review-next", pr?.available ? "Review & submit to pull request" : "Preview / export handoff");
    handoff.type = "button";
    handoff.disabled = !state.progressReady || savingDecision();
    handoff.addEventListener("click", () => openReviewHandoff());
    panel.append(handoff);
}

function handoffError(error, panel = elements.handoff_error) {
    panel.textContent = error.message;
    panel.classList.remove("hidden");
    panel.tabIndex = -1;
    panel.focus({ preventScroll: true });
    panel.scrollIntoView({ block: "nearest" });
}

async function openReviewHandoff() {
    const epoch = state.handoffEpoch = (state.handoffEpoch || 0) + 1;
    state.handoff = null;
    state.handoffImport = null;
    elements.handoff_error.classList.add("hidden");
    elements.handoff_import_error.classList.add("hidden");
    elements.handoff_provider_error.classList.add("hidden");
    elements.handoff_provider_status.textContent = "";
    elements.handoff_status.textContent = "Preparing the saved-snapshot preview…";
    elements.handoff_markdown.value = "";
    elements.handoff_state_preview.textContent = "";
    elements.handoff_import_file.value = "";
    elements.handoff_import_preview.textContent = "";
    elements.handoff_confirm.checked = false;
    for (const control of [elements.handoff_confirm, elements.handoff_submit, elements.handoff_import_confirm,
        elements.handoff_markdown_save, elements.handoff_state_save]) control.disabled = true;
    if (!elements.review_handoff.open) elements.review_handoff.showModal();
    try {
        clearTimeout(state.cursorSaveTimer);
        if (state.source && JSON.stringify(currentReviewCursor()) !== JSON.stringify(state.savedReviewCursor)) {
            if (!await persistReviewEntries(new Map(state.reviewLedger), currentReviewCursor(), { quiet: true })) {
                throw new Error(state.progressError || "Save the current reading point before exporting.");
            }
        }
        const preview = await api("/api/review-handoff/preview", { method: "POST", body: "{}" });
        if (epoch !== state.handoffEpoch || !elements.review_handoff.open) return;
        state.handoff = preview;
        elements.handoff_markdown.value = preview.markdown;
        elements.handoff_markdown.setSelectionRange(0, 0);
        elements.handoff_markdown.scrollTop = 0;
        elements.handoff_state_preview.textContent = JSON.stringify(preview.artifact, null, 2);
        elements.handoff_status.textContent = `Saved ${preview.artifact.repository} · ${preview.artifact.target.mode} · Head ${preview.artifact.target.head}. ${
            preview.provider.pending ? "A previous provider submission is still awaiting a receipt; a second submission is disabled." : "This preview has not submitted a review."}`;
        elements.handoff_markdown_save.disabled = false;
        elements.handoff_state_save.disabled = false;
        elements.handoff_provider.replaceChildren();
        // Only a GitHub pull request can receive a review; other targets export locally.
        elements.handoff_provider_section.classList.toggle("hidden", !preview.provider.url && !preview.provider.pending);
        if (preview.provider.url) {
            const link = el("a", "", preview.provider.url);
            link.href = preview.provider.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            elements.handoff_provider.append("Destination: ", link, ` · Commit ${String(preview.provider.commit || "").slice(0, 12)} · ${
                countLabel(preview.provider.comments || 0, "line comment")} ${preview.provider.available ? "will be posted with this summary. Uses the gh CLI's existing authorization." : "drafted."}`);
        }
        elements.handoff_summary.disabled = !preview.provider.available;
        elements.handoff_verdict.disabled = !preview.provider.available;
        // GitHub does not allow approving or requesting changes on your own pull request.
        for (const input of elements.handoff_verdict.querySelectorAll("input")) {
            const blocked = input.value !== "COMMENT" && preview.provider.own;
            input.disabled = blocked;
            input.closest("label").title = blocked ? "GitHub does not allow approving or requesting changes on your own pull request." : "";
            if (blocked && input.checked) elements.handoff_verdict.querySelector("input[value='COMMENT']").checked = true;
        }
        renderHandoffConsent();
        elements.handoff_provider_status.textContent = preview.provider.available
            ? `No review has been sent from this preview.${preview.provider.own ? " This is your own pull request, so only Comment is available." : ""}` : preview.provider.reason;
        elements.handoff_confirm.disabled = !preview.provider.available;
    } catch (error) {
        if (epoch === state.handoffEpoch && elements.review_handoff.open) {
            elements.handoff_status.textContent = "Preview not prepared. No export or submission occurred.";
            handoffError(error);
        }
    }
}
elements.handoff_close.addEventListener("click", () => elements.review_handoff.close());
elements.handoff_refresh.addEventListener("click", () => openReviewHandoff());
elements.review_handoff.addEventListener("close", () => { state.handoffEpoch++; });
function downloadHandoff(value, type, name) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([value], { type }));
    link.download = name;
    link.click();
    URL.revokeObjectURL(link.href);
}
elements.handoff_markdown_save.addEventListener("click", () => {
    if (!state.handoff) { handoffError(new Error("Prepare a handoff preview first.")); return; }
    downloadHandoff(state.handoff.markdown, "text/markdown", "agent-review-summary.md");
});
elements.handoff_state_save.addEventListener("click", () => {
    if (!state.handoff) { handoffError(new Error("Prepare a handoff preview first.")); return; }
    downloadHandoff(JSON.stringify(state.handoff.artifact, null, 2), "application/json", "agent-review-state.json");
});
elements.handoff_import_file.addEventListener("change", async () => {
    elements.handoff_error.classList.add("hidden");
    elements.handoff_import_error.classList.add("hidden");
    elements.handoff_import_preview.textContent = "Checking selected decision state…";
    elements.handoff_import_confirm.disabled = true;
    state.handoffImport = null;
    const sequence = state.handoffImportEpoch = (state.handoffImportEpoch || 0) + 1;
    const file = elements.handoff_import_file.files[0];
    if (!file) { elements.handoff_import_preview.textContent = "No import file selected."; return; }
    const epoch = state.handoffEpoch;
    try {
        if (file.size > 1024 * 1024) throw new Error("Choose an Agent Review state JSON up to 1 MiB.");
        const artifact = JSON.parse(await file.text());
        const current = await api("/api/review-progress");
        const preview = await api("/api/review-handoff/import", { method: "POST",
            body: JSON.stringify({ artifact, revision: current.revision, confirm: false }) });
        if (epoch !== state.handoffEpoch || sequence !== state.handoffImportEpoch || !elements.review_handoff.open) return;
        state.handoffImport = { artifact, revision: preview.revision };
        elements.handoff_import_preview.textContent = `${preview.repository}: ${countLabel(preview.records, "record")} · ${
            preview.changes ? `${countLabel(preview.changes, "decision")} would change` : "nothing would change"} · ${preview.message}`;
        elements.handoff_import_confirm.disabled = !preview.changes;
    } catch (error) {
        if (epoch === state.handoffEpoch && sequence === state.handoffImportEpoch && elements.review_handoff.open) {
            elements.handoff_import_preview.textContent = "Import not ready. Nothing was imported.";
            handoffError(error, elements.handoff_import_error);
        }
    }
});
elements.handoff_import_confirm.addEventListener("click", async () => {
    elements.handoff_import_confirm.disabled = true;
    elements.handoff_error.classList.add("hidden");
    elements.handoff_import_error.classList.add("hidden");
    try {
        if (!state.handoffImport) throw new Error("Preview an exact matching state file before confirming import.");
        const result = await api("/api/review-handoff/import", { method: "POST",
            body: JSON.stringify({ ...state.handoffImport, confirm: true }) });
        state.handoffImport = null;
        if (result.unchanged) {
            elements.handoff_import_preview.textContent = "No decisions changed; nothing was saved.";
            return;
        }
        elements.handoff_import_preview.textContent = `${countLabel(result.changes || 0, "decision")} imported and saved in this session workspace.`;
        loadReviewLedger(state.payload.model, { force: true });
        state.handoff = null;
        elements.handoff_markdown_save.disabled = true;
        elements.handoff_state_save.disabled = true;
        elements.handoff_submit.disabled = true;
        elements.handoff_confirm.disabled = true;
        elements.handoff_confirm.checked = false;
        elements.handoff_status.textContent = "Progress changed. Refresh the handoff preview before exporting or submitting.";
    } catch (error) {
        elements.handoff_import_preview.textContent = "Import failed. No decisions were overwritten.";
        handoffError(error, elements.handoff_import_error);
    }
});
elements.handoff_confirm.addEventListener("change", () => {
    elements.handoff_submit.disabled = !state.handoff?.provider.available || !elements.handoff_confirm.checked;
});
const VERDICT_LABELS = { COMMENT: "comment", APPROVE: "approval", REQUEST_CHANGES: "request for changes" };
const VERDICT_ARTICLES = { COMMENT: "a comment", APPROVE: "an approval", REQUEST_CHANGES: "a request for changes" };
const handoffVerdict = () => elements.handoff_verdict.querySelector("input:checked")?.value || "COMMENT";
// Consent names the exact verdict; changing the verdict requires confirming again.
function renderHandoffConsent() {
    const verdict = handoffVerdict();
    const comments = state.handoff?.provider?.comments || 0;
    elements.handoff_confirm_text.textContent = `I reviewed this summary${comments ? ` and ${countLabel(comments, "line comment")}` : ""} and choose to post ${comments ? "them" : "it"} as ${
        VERDICT_ARTICLES[verdict]} under my GitHub identity.`;
    elements.handoff_submit.textContent = { COMMENT: "Submit comment", APPROVE: "Submit approval", REQUEST_CHANGES: "Request changes" }[verdict];
    elements.handoff_submit.classList.toggle("handoff-danger", verdict === "REQUEST_CHANGES");
    elements.handoff_submit.classList.toggle("handoff-primary", verdict !== "REQUEST_CHANGES");
}
elements.handoff_verdict.addEventListener("change", () => {
    elements.handoff_confirm.checked = false;
    elements.handoff_submit.disabled = true;
    renderHandoffConsent();
});
function handoffProviderStatus(message) {
    elements.handoff_status.textContent = message;
    elements.handoff_provider_status.textContent = message;
    elements.handoff_provider_status.focus({ preventScroll: true });
    elements.handoff_provider_status.scrollIntoView({ block: "nearest" });
}
elements.handoff_submit.addEventListener("click", async () => {
    const epoch = state.handoffEpoch;
    elements.handoff_submit.disabled = true;
    elements.handoff_confirm.disabled = true;
    elements.handoff_refresh.disabled = true;
    elements.handoff_error.classList.add("hidden");
    elements.handoff_provider_error.classList.add("hidden");
    const verdict = handoffVerdict();
    handoffProviderStatus(`Submitting the ${VERDICT_LABELS[verdict]}. Waiting for GitHub's receipt; do not submit again.`);
    try {
        const receipt = await api("/api/review-handoff/submit", { method: "POST",
            body: JSON.stringify({ token: state.handoff?.token, confirm: elements.handoff_confirm.checked, event: verdict, summary: elements.handoff_summary.value }) });
        if (epoch === state.handoffEpoch) {
            // The preview is consumed: the destination line no longer promises a pending post.
            const destination = elements.handoff_provider.querySelector("a");
            elements.handoff_provider.replaceChildren(...(destination ? ["Destination: ", destination] : []),
                ` · Commit ${String(receipt.commit || "").slice(0, 12)} · review posted.`);
            elements.handoff_confirm.checked = false;
            elements.handoff_summary.value = "";
            handoffProviderStatus(`Posted ${VERDICT_LABELS[verdict]} on commit ${String(receipt.commit || "").slice(0, 12)}${
                receipt.comments ? ` with ${countLabel(receipt.comments, "line comment")}` : ""}.${receipt.drafts_warning ? ` ${receipt.drafts_warning}` : ""}`);
            if (receipt.url) {
                const link = el("a", "", "Open the review on GitHub");
                link.href = receipt.url;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                elements.handoff_provider_status.append(" ", link);
            }
            loadPrReview({ force: true });
        }
    } catch (error) {
        if (epoch === state.handoffEpoch) {
            handoffProviderStatus("No submission receipt. Read the error and check the PR before preparing another submission.");
            handoffError(error, elements.handoff_provider_error);
        }
    } finally { elements.handoff_refresh.disabled = false; }
});

function queueReviewCursor() {
    clearTimeout(state.cursorSaveTimer);
    if (!state.progressReady || !state.source) return;
    const snapshot = state.reviewLedgerStorageKey;
    state.cursorSaveTimer = setTimeout(() => {
        if (snapshot !== state.reviewLedgerStorageKey || state.progressSaving || !state.source) return;
        const cursor = currentReviewCursor();
        if (JSON.stringify(cursor) === JSON.stringify(state.savedReviewCursor)) return;
        persistReviewEntries(new Map(state.reviewLedger), cursor, { quiet: true, background: true });
    }, 800);
}
elements.source.addEventListener("scroll", () => { sourceScrollPosition(); queueReviewCursor(); }, { passive: true });

function markSelectedCards() {
    document.querySelectorAll(".review-card[data-item-id]").forEach((card) =>
        card.classList.toggle("is-selected", card.dataset.itemId === state.selected?.id));
}

function openImpact(item = state.selected) {
    rememberWorkspaceSource();
    setSourceFocus(false);
    state.reviewPage = "review";
    state.exploring = true;
    setDiscussionMode(false);
    const model = state.payload?.model;
    if (!model) {
        showError(new Error("Wait for the saved review to load before opening impact."));
        return;
    }
    if (item?.kind === "section") {
        const section = state.sectionData?.sections.find((section) => section.id === item.id);
        item = section ? { id: section.subject_id } : { id: `file:${item.path}` };
    }
    const seed = item?.node_id || item?.package_id || item?.target
        || item?.evidence_ids?.find((id) => model.evidence?.[id]?.path) || item?.id
        || model.attention?.find((finding) => finding.node_id)?.node_id
        || model.nodes.find((node) => node.change !== "unchanged" && ["function", "method"].includes(node.kind))?.id;
    state.impact = { seed, depth: 1, direction: "both", pendingFocus: true };
    state.mode = "impact";
    state.selected = null;
    renderEmptyDetail();
    setDetailVisible(false);
    state.source = null;
    state.selectionEpoch++;
    elements.source_panel.classList.add("hidden");
    render();
}

function focusImpactNode(id = state.impact?.seed) {
    const nodes = [...elements.graph.querySelectorAll(".impact-graph .node")];
    const node = nodes.find((node) => node.dataset.nodeId === id) || nodes[0];
    node?.scrollIntoView({ block: "nearest" });
    node?.focus({ preventScroll: true });
}

function renderImpact(model, focus = null) {
    const options = state.impact || {};
    const slice = impactSlice(model, options.seed, { depth: options.depth || 1, direction: options.direction || "both" });
    elements.graph.replaceChildren();
    const controls = el("div", "impact-toolbar");
    controls.append(el("p", "muted", "Static evidence, not proof of a defect. Arrows retain their dependency direction: caller → callee."));
    const counts = el("p", "impact-counts", Object.entries(slice.counts).map(([role, count]) => `${role}: ${count}`).join(" · "));
    const direction = el("select", "");
    direction.setAttribute("aria-label", "Impact relationships");
    for (const [value, label] of [["both", "Consumers and dependencies"], ["consumers", "Consumers"], ["dependencies", "Dependencies"]]) {
        const option = el("option", "", label);
        option.value = value;
        option.selected = value === (options.direction || "both");
        direction.append(option);
    }
    direction.addEventListener("change", () => { state.impact.direction = direction.value; renderImpact(model, "direction"); });
    const expand = el("button", "btn", `Expand one step (${options.depth || 1}/4)`);
    expand.type = "button";
    expand.disabled = options.depth >= 4 || !slice.boundary;
    expand.addEventListener("click", () => { state.impact.depth++; renderImpact(model, "expand"); });
    controls.append(counts, direction, expand);
    const seedNode = model.nodes.find((node) => node.id === options.seed);
    const direct = seedNode?.metrics?.direct_callers || 0;
    const callers = direct + (seedNode?.metrics?.transitive_callers || 0);
    const drawnConsumers = slice.counts?.["Potential consumer"] || 0;
    if (callers > drawnConsumers) {
        controls.append(el("p", "muted", `Saved analysis records ${countLabel(callers, "caller")} of ${seedNode.name} (${direct.toLocaleString()} direct); this view draws ${
            countLabel(drawnConsumers, "potential consumer")} at depth ${options.depth || 1}. Caller counts include every recorded call path; the view draws each consumer once and bounds its size.`));
    }
    for (const gap of slice.gaps) controls.append(el("p", "muted", gap));
    const graph = el("div", "impact-graph");
    elements.graph.append(controls, graph);
    renderGraph(graph, slice.nodes, slice.edges, (item) => {
        if (state.selected?.id !== item.id) setDiscussionMode(false);
        state.selected = item;
        renderDetail(item);
        setDetailVisible(true);
        const evidence = el("section", "impact-evidence");
        evidence.append(el("h3", "", item.impact_role || "Relationship evidence"));
        const path = slice.paths[item.id]?.length ? slice.paths[item.id]
            : item.source ? [item.id] : slice.edges.filter((edge) => edge.source === item.id || edge.target === item.id).map((edge) => edge.id);
        const related = path.map((id) => slice.edges.find((edge) => edge.id === id)).filter(Boolean);
        for (const edge of related) {
            const source = model.nodes.find((node) => node.id === edge.source);
            const target = model.nodes.find((node) => node.id === edge.target);
            evidence.append(el("p", "", `${source?.name || edge.source} ${edge.change === "removed" ? `formerly ${edge.type} (base snapshot)` : edge.type} ${target?.name || edge.target} · relationship confidence: ${edge.confidence || "not reported"}`));
            for (const id of edge.evidence_ids || []) if (model.evidence?.[id]) evidence.append(evidenceButton(id));
        }
        const actions = el("div", "impact-actions");
        if (item.path) {
            const open = el("button", "btn", "Open source");
            open.type = "button";
            open.addEventListener("click", () => {
                state.sourceReturnFocus = [...elements.graph.querySelectorAll(".impact-graph .node")]
                    .find((node) => node.dataset.nodeId === item.id);
                selectItem(item, false);
            });
            actions.append(open);
        }
        const ask = el("button", "btn", "Ask about this");
        ask.type = "button";
        ask.addEventListener("click", () => discussItem(item).catch(showError));
        actions.append(ask);
        evidence.append(actions);
        if (item.impact_role === "Related test") evidence.append(el("p", "muted", "Static test relationship. Execution of this affected behavior is not established by this graph."));
        elements.detail.append(evidence);
    }, { viewport: true, focusId: options.seed,
        emptyText: `No saved static relationships were found for ${model.nodes.find((node) => node.id === options.seed)?.name
            || String(options.seed || "this item").replace(/^file:/, "")}. Non-code files and isolated changes have no impact graph.` });
    if (focus === "direction" || (focus === "expand" && expand.disabled)) direction.focus({ preventScroll: true });
    else if (focus === "expand") expand.focus({ preventScroll: true });
    else if (options.pendingFocus) {
        options.pendingFocus = false;
        focusImpactNode();
    }
}

elements.impact_view.addEventListener("click", () => {
    if (state.mode === "impact") { state.mode = "graph"; render(); }
    else openImpact();
});
elements.source_impact.addEventListener("click", () => {
    if (state.selected?.id?.startsWith("package:") || state.selected?.package_id) {
        openImpact(state.selected);
        return;
    }
    const source = state.source;
    const symbol = state.payload?.model?.nodes.filter((node) => node.path === source?.path
        && node.start_line <= source.start_line && node.end_line >= source.start_line
        && ["function", "method", "constructor"].includes(node.kind))
        .sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line))[0];
    openImpact(symbol || { id: `file:${source?.path}` });
});

function openSections(location = null) {
    if (!state.payload?.model) {
        showError(new Error("Wait for the saved review to load before opening sections."));
        return;
    }
    if (state.reviewPage === "review" && !state.exploring) {
        state.navigationMode = "groups";
        state.navigationKey = null;
        state.navigationQuery = "";
        elements.workspace_search.value = "";
        state.navigationOpen = true;
        renderWorkspaceNavigation();
        renderWorkspaceShell();
        // Reveal the file's layer in the rail: expand it, bring it into view and briefly mark it.
        const group = state.workspaceNavigation?.groups.find((item) => item.id === state.activeReviewGroup)
            || state.workspaceNavigation?.groups.find((item) => item.files.some((file) => file.path === state.source?.path));
        const layer = group && [...elements.workspace_nav_list.querySelectorAll(".workspace-layer")]
            .find((item) => item.dataset.layer === group.layer);
        if (!layer) return;
        layer.open = true;
        layer.scrollIntoView({ block: "start" });
        layer.classList.remove("is-revealed");
        void layer.offsetWidth;
        layer.classList.add("is-revealed");
        setTimeout(() => layer.classList.remove("is-revealed"), 1800);
        const current = [...layer.querySelectorAll(".workspace-file")].find((file) => file.getAttribute("aria-current") === "location");
        (current || layer.querySelector("summary")).focus({ preventScroll: true });
        return;
    }
    state.sectionFocus = location;
    state.mode = "sections";
    state.query = "";
    elements.review_search.value = "";
    setDiscussionMode(false);
    state.source = null;
    state.selected = null;
    state.selectionEpoch++;
    elements.source_panel.classList.add("hidden");
    renderEmptyDetail();
    setDetailVisible(false);
    render();
}

function sectionSourceButton(section, range, label = null) {
    const button = sourceReferenceButton(label || `${range.path}:${range.line}${range.side === "base" ? " (base)" : ""}`,
        { path: range.path, lines: [range.line], side: range.side });
    button.addEventListener("click", () => {
        if (state.selected?.id !== section.id) setDiscussionMode(false);
        state.selected = { id: section.id, kind: "section", title: section.title, path: range.path };
        state.sourceReturnFocus = button;
    });
    return button;
}

function ensureSectionData() {
    const key = `${state.payload.review_generation}:${state.payload.rule_check?.completed_at || ""}`;
    if (state.sectionDataKey === key) return state.sectionData;
    if (state.payload.loading) return null;
    if (state.sectionDataKey !== key) {
        if (state.sectionLoadingKey !== key && state.sectionError?.key !== key) {
            state.sectionLoadingKey = key;
            state.sectionPromise = api("/api/review-sections").then((data) => {
                if (state.sectionLoadingKey !== key) return;
                state.sectionData = data;
                state.sectionDataKey = key;
                state.sectionLoadingKey = null;
                render();
            }, (error) => {
                if (state.sectionLoadingKey !== key) return;
                state.sectionError = { key, message: error.message };
                state.sectionLoadingKey = null;
                if (state.mode === "sections" || state.reviewPage === "review") render();
            });
        }
    }
    return null;
}

function renderSections(model) {
    const key = `${state.payload.review_generation}:${state.payload.rule_check?.completed_at || ""}`;
    elements.graph.replaceChildren();
    const data = ensureSectionData();
    if (!data) {
        if (state.sectionError?.key === key) {
            const retry = el("button", "btn", "Retry sections");
            retry.type = "button";
            retry.addEventListener("click", () => { state.sectionError = null; render(); });
            elements.graph.append(el("p", "error", state.sectionError.message), retry);
        } else elements.graph.append(el("p", "muted", "Building source-derived review sections…"));
        return;
    }
    const behavior = data.sections.filter((section) => section.kind === "behavior");
    const supporting = data.sections.filter((section) => section.kind !== "behavior");
    const sectionFiles = (section) => [...new Set(section.ranges.map((range) => range.path))];
    const filesReviewed = (section) => sectionFiles(section).filter((path) => state.reviewLedger.get(fileReviewId(path))?.disposition === "reviewed").length;
    const reviewed = behavior.filter((section) => filesReviewed(section) === sectionFiles(section).length).length;
    const list = el("div", "review-sections");
    list.append(el("p", "", `${countLabel(behavior.length, "behavior section")} · ${countLabel(data.represented_files, "changed file")} represented · ${countLabel(reviewed, "section")} with every file reviewed`),
        el("p", "muted", `These are the analyzer's source-linked sections, shown inside the reading-path layers. Progress comes from whole-file decisions in the Review rail. AI analysis: ${data.analysis_status}. ${data.note}`));
    const focusLocation = state.sectionFocus;
    const focusedSection = focusLocation && (data.sections.find((section) => section.ranges.some((range) =>
        range.path === focusLocation.path && range.side === focusLocation.side
        && focusLocation.line >= range.line && focusLocation.line <= range.end_line))
        || data.sections.find((section) => section.ranges.some((range) => range.path === focusLocation.path)));
    if (focusLocation && !focusedSection) list.append(el("p", "muted",
        "This source location has no changed section owner. Sections describe changed code, not every related dependency."));
    const query = state.query.toLowerCase();
    const matches = (section) => !query || `${section.title} ${section.summary} ${section.ranges.map((range) => range.path).join(" ")}`.toLowerCase().includes(query);
    const navigation = layeredNavigation();
    const layerIndex = new Map((navigation?.layers || []).map((layer, index) => [layer.id, index]));
    const sectionLayer = (section) => {
        const votes = new Map();
        for (const range of section.ranges) {
            const layer = layerOf(navigation, { path: range.path });
            if (layer) votes.set(layer, (votes.get(layer) || 0) + 1);
        }
        return [...votes].sort((a, b) => b[1] - a[1] || layerIndex.get(a[0].id) - layerIndex.get(b[0].id))[0]?.[0] || null;
    };
    const ordered = behavior.filter(matches).map((section) => ({ section, layer: sectionLayer(section) }))
        .sort((a, b) => (a.layer ? layerIndex.get(a.layer.id) : Infinity) - (b.layer ? layerIndex.get(b.layer.id) : Infinity)
            || a.section.number - b.section.number);
    const titles = new Map(data.sections.map((section) => [section.id, section.title]));
    let focused = null;
    let currentLayer;
    for (const { section, layer } of ordered) {
        if (navigation && layer !== currentLayer) {
            currentLayer = layer;
            list.append(el("h3", "review-plan-layer", layer ? `Sections in ${layerLabel(layer)}` : "Sections outside the reading path"));
        }
        const shownRanges = query && section.ranges.some((range) => range.path.toLowerCase().includes(query))
            ? section.ranges.filter((range) => range.path.toLowerCase().includes(query)) : section.ranges;
        const details = el("details", "section-card");
        details.dataset.sectionId = section.id;
        const requested = section.id === focusedSection?.id;
        details.open = requested || state.openSectionKeys?.has(section.id);
        details.addEventListener("toggle", () => {
            if (!details.isConnected) return;
            state.openSectionKeys ||= new Set();
            if (details.open) state.openSectionKeys.add(section.id);
            else state.openSectionKeys.delete(section.id);
        });
        const summary = el("summary", "");
        if (layer) {
            const chip = layerMarker(layer, "layer-chip layer-chip-inline");
            chip.title = layerLabel(layer);
            summary.append(chip);
        }
        summary.append(document.createTextNode(section.title));
        details.append(summary, el("p", "muted", section.grouping || "Source-linked changed contract and consumers"),
            el("p", "", section.summary));
        if (section.summary_citations.length) {
            details.append(el("p", "muted", "AI interpretation; verify against the cited source."));
            for (const citation of section.summary_citations) details.append(sectionSourceButton(section,
                { path: citation.path, line: citation.line, side: citation.side }));
        }
        for (const dependency of section.depends_on) {
            const link = el("button", "link-button", `Depends on: ${titles.get(dependency) || "another section"}`);
            link.type = "button";
            link.addEventListener("click", () => {
                const target = [...elements.graph.querySelectorAll(".section-card")].find((node) => node.dataset.sectionId === dependency);
                if (!target) return;
                target.open = true;
                target.scrollIntoView({ block: "nearest" });
                target.querySelector("summary").focus();
            });
            details.append(link);
        }
        if (section.cyclic) details.append(el("p", "muted", "A dependency cycle prevents a strict reading order."));
        const actions = el("div", "section-actions");
        actions.append(sectionSourceButton(section, shownRanges[0], "Open first range"));
        const ask = el("button", "", "Ask about section");
        ask.type = "button";
        ask.addEventListener("click", () => {
            state.sourceReturnFocus = ask;
            discussItem({ id: section.id, kind: "section", title: section.title, path: section.ranges[0].path }).catch(showError);
        });
        const progress = el("span", "muted", `${filesReviewed(section)} of ${countLabel(sectionFiles(section).length, "file")} reviewed`);
        actions.append(ask, progress);
        details.append(actions);
        const ranges = el("details", "section-ranges");
        ranges.open = state.openSectionRangeKeys?.has(section.id) || false;
        ranges.append(el("summary", "", `${countLabel(shownRanges.length, "source range")}${shownRanges.length < section.ranges.length ? ` of ${section.ranges.length} matching filter` : ""}`));
        ranges.addEventListener("toggle", () => {
            if (!ranges.isConnected) return;
            state.openSectionRangeKeys ||= new Set();
            if (ranges.open) state.openSectionRangeKeys.add(section.id);
            else state.openSectionRangeKeys.delete(section.id);
            if (!ranges.open || ranges.dataset.loaded) return;
            ranges.dataset.loaded = "true";
            const entries = el("ul", "");
            for (const range of shownRanges) {
                const row = el("li", "");
                row.append(sectionSourceButton(section, range));
                entries.append(row);
            }
            ranges.append(entries);
        });
        details.append(ranges);
        const tests = el("details", "");
        tests.append(el("summary", "", `${countLabel(section.tests.length, "related test")} (static links)`));
        tests.addEventListener("toggle", () => {
            if (!tests.isConnected) return;
            if (!tests.open || tests.dataset.loaded) return;
            tests.dataset.loaded = "true";
            tests.append(el("p", "muted", "A source relationship is not proof that the changed behavior executed."));
            for (const test of section.tests) tests.append(sectionSourceButton(section,
                { path: test.path, line: test.start_line || 1, side: "current" }));
        });
        details.append(tests);
        list.append(details);
        if (requested) focused = summary;
    }
    const other = supporting.filter(matches);
    if (other.length) {
        const details = el("details", "section-card supporting-sections");
        details.append(el("summary", "", `${countLabel(other.length, "supporting file")} without an analyzer section`),
            el("p", "muted", "These files remain in scope. The Review rail may still attach some of them to a file by an import or call found in this change, or by a matching test name."));
        details.addEventListener("toggle", () => {
            if (!details.isConnected) return;
            if (!details.open || details.dataset.loaded) return;
            details.dataset.loaded = "true";
            const entries = el("ul", "");
            let target = null;
            for (const section of other) {
                const row = el("li", "");
                const range = section.ranges[0];
                const open = sectionSourceButton(section, range);
                if (model.source_files?.[range.path]?.binary) {
                    open.disabled = true;
                    open.title = "Binary file: no saved text view is available.";
                }
                row.append(open);
                entries.append(row);
                if (focusLocation?.path === range.path) target = open;
            }
            details.append(entries);
            target?.scrollIntoView({ block: "nearest" });
            target?.focus({ preventScroll: true });
        });
        if (other.some((section) => section.id === focusedSection?.id)) details.open = true;
        list.append(details);
    }
    if (!behavior.some(matches) && !other.length) list.append(el("p", "muted", "No sections match this filter."));
    elements.graph.append(list);
    focused?.scrollIntoView({ block: "nearest" });
    focused?.focus({ preventScroll: true });
    state.sectionFocus = null;
}

elements.sections_view.addEventListener("click", () => {
    if (state.mode === "sections") { state.mode = "walkthrough"; render(); }
    else openSections();
});
elements.source_section.addEventListener("click", () => {
    if (state.source) openSections({ path: state.source.path, line: Number(state.source.start_line) || 1,
        side: state.source.focus_side || "current" });
});

function openReviewItem(item) {
    if (item.collect_mode) {
        state.mode = item.collect_mode;
        state.stack = [];
        clearSelection();
        state.areaGroup = item.members ? item : null;
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
    // A grouped card carries its highest member priority, matching the handoff's grouped line.
    const top = Math.max(...sizes.map((item) => concernPriority(item) ?? -1));
    const group = {
        id: "group:size",
        title: `Large changes · ${countLabel(sizes.length, "area")}`,
        body: `${shown}${sizes.length > 4 ? ` · +${sizes.length - 4} more` : ""}`,
        impact_score: top >= 0 ? top : null,
        severity: sizes[0].severity,
        collect_mode: "areas",
        members: sizes,
    };
    const rest = items.filter((item) => !sizes.includes(item));
    const position = rest.findIndex((item) => (concernPriority(item) ?? 0) < (group.impact_score ?? 0));
    rest.splice(position === -1 ? rest.length : position, 0, group);
    return rest;
}

function childNodes(model) {
    const parent = state.stack.at(-1);
    if (!parent) return model.nodes.filter((node) => node.kind === "component");
    if (parent.kind === "component") return model.nodes.filter((node) => node.kind === "module" && node.component_id === parent.id);
    if (parent.kind === "module") return model.nodes.filter((node) => node.module_id === parent.id && isReviewSymbol(node));
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
    const activeCount = scoped.length - closedCount;
    section.append(el("h3", "", `${countLabel(activeCount, "active review finding")}${
        closedCount ? ` · ${countLabel(closedCount, "closed review finding")}` : ""} in ${parent.name}`));
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

function resetToGraph() {
    state.mode = "graph";
    state.stack = [];
    clearSelection();
    state.query = "";
    elements.review_search.value = "";
    render();
}

function resetToWalkthrough() {
    state.mode = "walkthrough";
    state.stack = [];
    clearSelection();
    state.query = "";
    elements.review_search.value = "";
    render();
}

function renderBreadcrumbs() {
    elements.breadcrumbs.replaceChildren();
    // The plan/architecture trail belongs to Explore; the Overview has a single reading path.
    elements.breadcrumbs.classList.toggle("hidden", state.reviewPage === "overview" || state.reviewPage === "finish");
    const plan = el("button", "", "Attention");
    plan.type = "button";
    plan.addEventListener("click", resetToWalkthrough);
    elements.breadcrumbs.append(plan);
    if (state.mode === "walkthrough") return;
    const root = el("button", "", "Architecture");
    root.type = "button";
    root.addEventListener("click", resetToGraph);
    elements.breadcrumbs.append(el("span", "", "›"), root);
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
        node.module_id === item.id && isReviewSymbol(node) && visible(node));
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
            reason: `${edge.kind}: ${countLabel(edge.added_count || 0, "relationship")} added and ${
                countLabel(edge.removed_count || 0, "relationship")} removed.`,
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
        reason: `${edge.kind}: ${countLabel(edge.added_count || 0, "relationship")} added and ${
            countLabel(edge.removed_count || 0, "relationship")} removed. Showing representative source evidence.`,
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

function overviewPlan() {
    const model = state.payload?.model;
    return model ? buildReviewPlan(model, state.payload.decision_map, state.payload.test_run,
        [...groupFindings(model.attention || []), ...(state.payload.generated_observations || [])]) : [];
}

// One layered model shared by the rail, Overview and Finish so names and order always agree.
function layeredNavigation() {
    const model = state.payload?.model;
    const data = model && !state.payload.loading ? ensureSectionData() : null;
    if (!data) return null;
    const key = `${state.payload.review_generation}:${state.sectionDataKey}`;
    if (state.layeredNavigationKey !== key) {
        state.layeredNavigation = workspaceNavigation(model, data);
        state.layeredNavigationKey = key;
    }
    return state.layeredNavigation;
}

function layerOf(navigation, entry) {
    if (!navigation || !entry) return null;
    if (!navigation.layerByPath) {
        navigation.layerByPath = new Map();
        for (const layer of navigation.layers) for (const group of layer.groups) for (const file of group.files) {
            if (!navigation.layerByPath.has(file.path)) navigation.layerByPath.set(file.path, layer);
        }
    }
    // Each changed file lives in exactly one layer, so its path is authoritative; a saved group may predate the current layering.
    const byPath = entry.path && navigation.layerByPath.get(entry.path);
    if (byPath) return byPath;
    const group = entry.group && navigation.groups.find((item) => item.id === entry.group);
    return group ? navigation.layers.find((layer) => layer.id === group.layer) || null : null;
}

// AI step titles name what the reader does in a layer; the deterministic area name stays as the subtitle and fallback.
const layerTitle = (layer) => layer ? state.payload?.annotations?.layers?.titles?.[layer.id] || layer.name : "";
const layerLabel = (layer) => layer ? `${layer.number ? `${layer.number}. ` : ""}${layerTitle(layer)}` : "";

// Numbered layers show their step number in a circle. Supporting files are outside the reading order, so they show a
// folder (GitHub's file-directory octicon) instead of an empty-looking circle.
function layerMarker(layer, className) {
    if (layer?.number) return el("span", className, String(layer.number));
    const marker = el("span", `${className} is-unnumbered`);
    marker.title = "Supporting files: outside the numbered reading order";
    marker.setAttribute("aria-label", "Supporting files");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75ZM1.5 2.75a.25.25 0 0 1 .25-.25H5a.25.25 0 0 1 .2.1l.9 1.2c.33.44.85.7 1.4.7h6.75a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V2.75Z");
    svg.append(path);
    marker.append(svg);
    return marker;
}

function dependencyLabel(navigation, dependency) {
    const layer = navigation?.layers.find((item) => item.number === dependency.number);
    return layer ? layerLabel(layer) : `${dependency.number}. ${dependency.name}`;
}

// The AI badge stays attached to the title's last word, so wrapping never makes the area name look AI-written.
function titleWithBadge(title, isAi, hint) {
    const strong = el("strong", "");
    if (!isAi) { strong.textContent = title; return strong; }
    const words = title.split(" ");
    const tail = el("span", "title-tail", words.pop());
    const badge = el("span", "workspace-layer-ai", "AI");
    badge.title = hint;
    tail.append(" ", badge);
    strong.append(words.length ? `${words.join(" ")} ` : "", tail);
    return strong;
}

function layerHeading(layer, { path = true } = {}) {
    const name = el("span", "layer-title");
    const title = layerTitle(layer);
    name.append(titleWithBadge(title, title !== layer.name, "AI-written step title; the area name is shown beside it"));
    const area = [title !== layer.name ? layer.name : null, path && layer.path && layer.path !== "/" && !layer.supporting ? layer.path : null].filter(Boolean);
    if (area.length) name.append(el("span", "layer-area muted", area.join(" · ")));
    if (layer.number && layer.number > 1 && !layer.dependsOn.length) {
        const independent = el("span", "layer-independent", "independent");
        independent.title = "No changed file in this layer imports or calls an earlier layer; it can be read in any order.";
        name.append(independent);
    }
    return name;
}

function layerProgress(layer) {
    const files = layer.groups.flatMap((group) => group.files);
    return { reviewed: files.filter((file) => state.reviewLedger.get(fileReviewId(file.path))?.disposition === "reviewed").length, total: files.length };
}

function openLayer(navigation, layer) {
    const ids = new Set(layer.groups.map((group) => group.id));
    const entries = reviewSequence(navigation).filter((entry) => ids.has(entry.group));
    openFileReview(nextFileReview(entries, state.reviewLedger) || entries[0]).catch(showError);
}

function renderOverviewLayers(navigation) {
    const list = elements.overview_layers;
    list.replaceChildren();
    if (!navigation) {
        list.append(el("li", "overview-layer-detail muted", state.sectionError ? "Grouping is unavailable; every changed file is still reachable from Review."
            : "Ordering the change into layers…"));
        return;
    }
    const plan = overviewPlan();
    for (const layer of navigation.layers) {
        const paths = new Set(layer.groups.flatMap((group) => group.files.map((file) => file.path)));
        const progress = layerProgress(layer);
        const row = el("button", `overview-layer${layer.supporting ? " is-supporting" : ""}`);
        row.type = "button";
        const name = layerHeading(layer);
        row.append(layerMarker(layer, "overview-layer-number"), name,
            el("span", "overview-layer-progress", `${progress.reviewed}/${progress.total} reviewed`));
        const intent = state.payload.annotations?.layers?.intents?.[layer.id];
        const details = [];
        const top = plan.filter((item) => item.path && paths.has(item.path)).sort((a, b) => b.score - a.score)[0];
        if (layer.dependsOn.length) details.push(`builds on ${layer.dependsOn.map((dependency) => dependencyLabel(navigation, dependency)).join(", ")}`);
        if (top) {
            const title = top.title.replace(/^(?:[\w$]+\.)+(?=[\w$]+\.[\w$]+(?:\(|$))/, "").replace(/\(.{24,}\)$/, "(…)");
            details.push(`top priority: ${title}${top.kind === "package" && top.reasons?.[0] ? ` (${top.reasons[0]})` : ""}`);
        }
        const detail = el("span", "overview-layer-detail");
        if (intent) detail.append(el("span", "workspace-layer-ai", "AI"), document.createTextNode(intent));
        else if (layer.summary) detail.append(document.createTextNode(layer.summary));
        if (details.length) detail.append(document.createTextNode(`${intent || layer.summary ? " · " : ""}${details.join(" · ")}`));
        row.append(detail);
        layerSummaryStatus(row, layer, `overview-layer:${layer.id}`);
        row.setAttribute("aria-label", `${layerLabel(layer)}: ${progress.reviewed} of ${progress.total} files reviewed. ${intent || layer.summary || ""}`);
        row.addEventListener("click", () => openLayer(navigation, layer));
        const item = el("li", "");
        item.append(row);
        list.append(item);
    }
}

// Exactly where Start/Continue goes: the saved reading point if its file is still unreviewed, else the next rail file.
function overviewDestination() {
    const saved = liveReviewCursor();
    const model = state.payload?.model;
    const changed = saved && model?.changes.some((file) => file.path === saved.path && file.status !== "unchanged");
    if (changed && (state.reviewLedger.get(fileReviewId(saved.path))?.disposition || "pending") === "pending") {
        return { path: saved.path, line: saved.line > 1 ? saved.line : null, group: saved.group, resume: saved };
    }
    const next = nextFileReview(fileReviewQueue(), state.reviewLedger);
    return next ? { path: next.path, group: next.group, entry: next } : null;
}

function renderReviewOverview() {
    const payload = state.payload;
    const model = payload?.model;
    const hidden = !model || state.reviewPickerPending || state.reviewSubmitting || isEmptyReview(payload);
    elements.review_overview.classList.toggle("hidden", Boolean(hidden));
    if (hidden) return;
    const target = payload.review_target;
    const progress = fileReviewProgress(model, state.reviewLedger);
    const next = nextFileReview(fileReviewQueue(), state.reviewLedger);
    const changed = (model.changes || []).filter((change) => change.status !== "unchanged").length;
    elements.overview_title.textContent = target?.intent?.subject || target?.intent?.title
        || (target?.mode === "worktree" ? "Review your uncommitted changes" : target?.label || "Review this change");
    const overviewBody = payload.annotations?.overview?.body;
    // Once the summary is on screen, Copilot starts on the first item the reader will open.
    if ((overviewBody || state.overviewError) && state.reviewPage === "overview" && state.progressReady) {
        const destination = overviewDestination();
        if (destination) prefetchAnnotation(destination.resume ? destination : destination.entry || destination);
    }
    const blurb = overviewBlurb(overviewBody);
    const fullBlurb = overviewBlurb(overviewBody, { full: true });
    elements.overview_description.replaceChildren();
    if (blurb) {
        elements.overview_description.append(el("p", "overview-copy-label muted", "AI change overview · verify against source"));
        markdownContext.intent = state.briefIntent || null;
        markdownContext.subject = null;
        const expandable = fullBlurb.length > blurb.length;
        const expanded = expandable && state.overviewExpandedKey === overviewBody;
        const text = el("div", "overview-copy");
        renderMarkdown(text, expanded ? fullBlurb : blurb);
        elements.overview_description.append(text);
        if (expandable) {
            const toggle = el("button", "link-button overview-more", expanded ? "Show less" : "Show more");
            toggle.type = "button";
            toggle.setAttribute("aria-expanded", String(expanded));
            toggle.addEventListener("click", () => {
                state.overviewExpandedKey = expanded ? null : overviewBody;
                renderReviewOverview();
                elements.overview_description.querySelector(".overview-more")?.focus({ preventScroll: true });
            });
            (text.lastElementChild || text).append(document.createTextNode(" "), toggle);
        }
    } else if (state.overviewLoading) {
        elements.overview_description.append(aiPlaceholder("overview", "Copilot is preparing the overview. You can start reviewing the saved code now.", 3));
    } else {
        elements.overview_description.append(el("p", "", state.overviewError
            ? "The AI overview is unavailable. You can review the saved code now, or open change details to retry."
            : "Review the saved changes and available evidence. Open change details for intent, metrics and AI summary status."));
    }
    if (payload.annotations?.overview?.refining) elements.overview_description.append(
        aiPlaceholder("overview-refine", "Copilot is refining this overview with deeper review evidence...", 2));
    elements.overview_progress.textContent = `${progress.reviewed} of ${countLabel(changed, "changed file")} reviewed${
        progress.followUp ? ` · ${countLabel(progress.followUp, "follow-up")}` : ""}`;
    elements.overview_scope.textContent = "";
    elements.overview_scope.classList.add("hidden");
    elements.overview_start.textContent = next
        ? state.savedReviewCursor || [...state.reviewLedger.values()].some((entry) => entry.disposition !== "pending") ? "Continue review" : "Start review"
        : "Review summary";
    elements.overview_start.title = next ? `Next changed file: ${next.path}` : "Review saved decisions and remaining concerns";
    const navigation = layeredNavigation();
    if (navigation) ensureLayerSummaries();
    renderOverviewLayers(navigation);
    const destination = overviewDestination();
    if (destination && navigation) {
        const layer = layerOf(navigation, destination);
        const verb = elements.overview_start.textContent === "Continue review" ? "Continue" : "Start review";
        elements.overview_start.textContent = `${verb} · ${layer ? `${layerLabel(layer)} › ` : ""}${destination.path.split("/").at(-1)}${destination.line ? `:${destination.line}` : ""}`;
        elements.overview_start.title = `Opens ${destination.path}${destination.line ? ` at line ${destination.line}` : ""}`;
    }
    const disabled = Boolean(payload.loading || payload.cancelled || state.connectionLost || state.progressLoading);
    elements.overview_start.disabled = disabled;
    elements.overview_files.disabled = disabled;
    elements.overview_files.textContent = `Browse all ${countLabel(changed, "file")}`;
    elements.review_progress_status.textContent = state.progressLoading ? "Restoring session progress…"
        : state.progressError ? `Progress unavailable: ${state.progressError}`
            : state.progressReady && !state.progressDurable ? "This provider retains progress only in memory." : "";
    elements.review_progress_retry.classList.toggle("hidden", !state.progressError);
    elements.review_progress_backup.classList.toggle("hidden", !state.progressLegacyCopy);
}

function browseReviewFiles() {
    rememberWorkspaceSource();
    state.source = null;
    elements.source_panel.classList.add("hidden");
    state.reviewPage = "review";
    state.navigationMode = "files";
    state.navigationOpen = matchMedia("(max-width: 900px)").matches;
    state.exploring = false;
    state.mode = "files";
    state.stack = [];
    state.query = "";
    elements.review_search.value = "";
    render();
    elements.graph.scrollIntoView({ block: "start" });
    elements.graph.tabIndex = -1;
    elements.graph.focus({ preventScroll: true });
}

elements.overview_start.addEventListener("click", async () => {
    try {
        await readySectionData();
        const destination = overviewDestination();
        await openOverviewDestination(destination);
    } catch (error) { showError(error); }
});
elements.overview_files.addEventListener("click", browseReviewFiles);

// The layer a piece of AI text refers to: an exact changed path, then a unique changed basename, then the longest changed symbol name.
function textLayer(navigation, text) {
    const model = state.payload?.model;
    if (!navigation || !model) return null;
    const changed = model.changes.filter((file) => file.status !== "unchanged").map((file) => file.path);
    let path = changed.filter((candidate) => text.includes(candidate)).sort((a, b) => b.length - a.length)[0];
    if (!path) {
        const byName = changed.filter((candidate) => new RegExp(`(^|[^\\w.-])${candidate.split("/").at(-1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(text));
        if (byName.length === 1) path = byName[0];
    }
    if (!path) {
        const changedSet = new Set(changed);
        path = model.nodes.filter((node) => node.change && node.change !== "unchanged" && changedSet.has(node.path)
            && node.name?.length >= 4 && new RegExp(`\\b${node.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text))
            .sort((a, b) => b.name.length - a.name.length)[0]?.path;
    }
    return path ? layerOf(navigation, { path }) : null;
}

// The AI brief's "Review order" is a lens over the layered reading path, not a competing order.
function alignFocusPoints(body) {
    const heading = [...body.querySelectorAll("h2")].find((item) => /review order/i.test(item.textContent));
    if (!heading) return;
    heading.textContent = "Focus points";
    const navigation = layeredNavigation();
    const note = el("p", "muted brief-focus-note", navigation
        ? "AI suggestions, sorted by reading-path layer. Verify in code; Review follows the layers."
        : "AI suggestions. Verify in code; Review follows the reading path.");
    heading.after(note);
    if (!navigation) return;
    const index = new Map(navigation.layers.map((layer, position) => [layer.id, position]));
    for (const list of heading.parentElement.querySelectorAll("ul, ol")) {
        const items = [...list.children].map((item, position) => ({ item, position, layer: textLayer(navigation, item.textContent) }));
        items.sort((a, b) => (a.layer ? index.get(a.layer.id) : Infinity) - (b.layer ? index.get(b.layer.id) : Infinity) || a.position - b.position);
        for (const { item, layer } of items) {
            if (layer) {
                const chip = layerMarker(layer, "layer-chip layer-chip-inline");
                chip.title = layerLabel(layer);
                chip.setAttribute("aria-label", `Layer ${layerLabel(layer)}`);
                item.prepend(chip);
            }
            list.append(item);
        }
        if (list.tagName === "OL") {
            const replacement = el("ul", list.className);
            replacement.append(...list.children);
            list.replaceWith(replacement);
        }
    }
}

function renderChangeBrief() {
    renderReviewOverview();
    const panel = elements.change_brief;
    panel.replaceChildren();
    const model = state.payload?.model;
    const target = state.payload?.review_target;
    const intent = target?.intent;
    if (model) ensureBriefIntent(model);
    const top = el("div", "detail-top");
    top.append(el("h2", "review-heading", intent?.subject || intent?.title
        || (target?.mode === "worktree" || !target ? "Uncommitted changes" : target.label || "Selected review")));
    if (intent) {
        const messageLabel = intent.kind === "pr" ? "Pull request description" : "Commit message";
        top.append(el("p", "commit-meta", messageLabel));
        const preview = String(intent.body || "").trim().split(/\r?\n\s*\r?\n/)[0];
        if (preview) top.append(el("p", "commit-preview", preview));
        const message = el("details", "brief-origin brief-commit");
        const key = `${target.mode}:${target.currentRef}`;
        message.open = state.commitMessageOpenKey === key;
        message.addEventListener("toggle", () => {
            if (message.isConnected) state.commitMessageOpenKey = message.open ? key : null;
        });
        message.append(el("summary", "", intent.kind === "pr" ? "Full description and commits" : "Full commit message"));
        const meta = intent.kind === "pr"
            ? [`#${intent.number}`, intent.author, countLabel(intent.commits?.length || 0, "commit")]
            : [intent.sha?.slice(0, 7), intent.author, intent.date ? new Date(intent.date).toLocaleString() : null];
        message.append(el("p", "commit-meta", meta.filter(Boolean).join(" · ")));
        if (intent.body) message.append(el("pre", "commit-body", intent.body));
        else message.append(el("p", "muted commit-meta", "No message body."));
        if (intent.commits?.length) {
            const list = el("ul", "commit-list");
            for (const commit of intent.commits) {
                const item = el("li", "");
                item.append(el("code", "", commit.sha.slice(0, 7)), document.createTextNode(` ${commit.subject}`));
                if (commit.body) item.title = commit.body;
                list.append(item);
            }
            message.append(list);
        }
        top.append(message);
    }
    if (state.briefIntent) {
        const attribution = state.briefIntent;
        const prompt = attribution.original_prompt || attribution.prompt || "";
        const origin = el("section", "brief-prompt");
        origin.append(el("p", "commit-meta", "Originating prompt"),
            el("p", "commit-preview prompt-preview", prompt));
        const full = el("details", "brief-origin full-originating-prompt");
        const key = JSON.stringify([state.payload?.review_generation, attribution.session_id,
            attribution.original_prompt_event_id || attribution.prompt_event_id, prompt]);
        full.open = state.originatingPromptOpenKey === key;
        full.addEventListener("toggle", () => {
            if (full.isConnected) state.originatingPromptOpenKey = full.open ? key : null;
        });
        full.append(el("summary", "", "Full originating prompt"), promptBlock(attribution, true, true));
        origin.append(full);
        top.append(origin);
    }
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
    if (split.source > 50 && ratio < 0.15) {
        panel.append(el("p", "muted", "Test/source churn is descriptive, not coverage evidence. Inspect linked paths and saved test execution results."));
    }

    const annotation = state.payload?.annotations?.overview;
    const heading = el("div", "assessment-heading");
    heading.append(el("h3", "", "Copilot change summary"));
    if (annotation?.body) heading.append(copyButton(annotation.body, "Copy summary"));
    panel.append(heading);
    if (annotation?.body && (annotation.refining || annotation.basis || annotation.refine_error)) {
        const status = el("p", `muted brief-ai-status${annotation.refining ? " is-refining" : ""}`,
            annotation.refining ? "Quick summary from the saved code. Copilot is refining it with a deeper review of the change; it updates here when ready."
                : annotation.refine_error ? `Quick summary from the saved code. Refining it with a deeper review failed: ${annotation.refine_error}`
                : annotation.basis === "review" ? "Written from a deeper review of the change (the repository-rules and behavior pass)."
                : "Written from the saved code.");
        status.setAttribute("role", "status");
        panel.append(status);
        if (annotation.refining) panel.append(aiPlaceholder("overview-refine", "Copilot is refining the change summary...", 2));
    }
    if (annotation?.body) {
        const body = revealOnce(el("div", "annotation-body brief-ai"), "overview");
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
        alignFocusPoints(body);
        panel.append(body);
    } else if (state.overviewLoading) {
        panel.append(aiPlaceholder("overview", "Copilot is summarizing the whole change…", 4));
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
    const rules = renderRuleCheck();
    if (rules) panel.append(rules);
}

// Line ranges of a rule file that a check's text cites, merged and in file order.
function ruleCitations(content, path) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ranges = [];
    for (const match of String(content || "").matchAll(new RegExp(`(?:^|[^\\w./-])${escaped}:(\\d+(?:\\s*[-–]\\s*\\d+)?(?:\\s*,\\s*\\d+(?:\\s*[-–]\\s*\\d+)?)*)`, "g"))) {
        for (const part of match[1].split(",")) {
            const [from, to = from] = part.split(/[-–]/).map((value) => Number(value.trim()));
            if (Number.isInteger(from) && from > 0) ranges.push([Math.min(from, to), Math.max(from, to)]);
        }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
        else merged.push([...range]);
    }
    return merged;
}

async function openRuleFile(path, ranges, side = "current") {
    const epoch = ++state.selectionEpoch;
    try {
        await loadSource(`path=${encodeURIComponent(path)}&side=${side}`, epoch, side, "reset", { highlights: ranges });
    } catch (error) {
        if (epoch === state.selectionEpoch) showError(error);
    }
}

// Built-in check of the repository's own rule files, shown in the brief rather than among the user's prompts.
function appendInternalReview(container, review, scope, resume) {
    if (!review?.coverage) return;
    const coverage = review.coverage;
    const progress = el("p", "muted", `${countLabel(coverage.completed_files, "changed file")} analyzed of ${coverage.total_files}` +
        ` · ${countLabel(coverage.completed_units, "evidence unit")} analyzed of ${coverage.total_units}` +
        ` · ${coverage.supplied_units || 0} supplied` +
        ` · ${review.requests ?? coverage.requests ?? 0} model requests this run` +
        (coverage.phase ? ` · ${coverage.phase}` : ""));
    progress.setAttribute("role", "status");
    container.append(progress);
    const actions = el("div", "action-row");
    if (review.status === "running") {
        container.append(aiPlaceholder(`review:${scope}`, "Copilot is reviewing the saved change...", 2));
        const cancel = el("button", "", "Stop AI review");
        cancel.type = "button";
        cancel.addEventListener("click", async () => {
            cancel.disabled = true;
            try { await api("/api/internal-reviews/cancel", { method: "POST", body: JSON.stringify({ scope }) }); }
            catch (error) { cancel.disabled = false; showError(error); }
        });
        actions.append(cancel);
    } else if (["partial", "cancelled"].includes(review.status) && (coverage.completed_units < coverage.total_units
        || review.unresolved_findings?.length || review.pending_context_requests)) {
        const proceed = el("button", "", "Continue review");
        proceed.type = "button";
        proceed.addEventListener("click", async () => {
            proceed.disabled = true;
            try { await resume(); }
            catch (error) { proceed.disabled = false; showError(error); }
        });
        actions.append(proceed);
    }
    if (actions.childNodes.length) container.append(actions);
    if (review.findings?.length > 8) {
        const all = el("details", "");
        all.append(el("summary", "", `All ${review.findings.length} findings`));
        const list = el("ul", "");
        for (const finding of review.findings) {
            const item = el("li", "");
            item.append(el("strong", "", `${finding.severity}: ${finding.title}`), document.createTextNode(` ${finding.detail} `));
            for (const citation of finding.citations) {
                const open = el("button", "link-button", `${citation.path}:${citation.line}${citation.side === "base" ? " (base)" : ""}`);
                open.type = "button";
                open.addEventListener("click", () => openRuleFile(citation.path, [[citation.line]], citation.side));
                item.append(open, document.createTextNode(" "));
            }
            list.append(item);
        }
        all.append(list);
        container.append(all);
    }
    if (review.gaps?.length) {
        const gaps = el("details", "");
        gaps.append(el("summary", "", countLabel(review.gaps.length, "evidence gap")));
        const list = el("ul", "");
        for (const gap of review.gaps) list.append(el("li", "", `${gap.path ? `${gap.path}: ` : ""}${gap.reason}`));
        gaps.append(list);
        container.append(gaps);
    }
    if (review.unresolved_findings?.length) {
        const candidates = el("details", "");
        candidates.append(el("summary", "", `${countLabel(review.unresolved_findings.length, "candidate")} requiring verification`));
        const list = el("ul", "");
        for (const finding of review.unresolved_findings) {
            const item = el("li", "", `${finding.title}: ${finding.detail} `);
            for (const citation of finding.citations) item.append(sourceReferenceButton(
                `${citation.path}:${citation.line}${citation.side === "base" ? " (base)" : ""}`,
                { path: citation.path, lines: [citation.line], side: citation.side }), document.createTextNode(" "));
            list.append(item);
        }
        candidates.append(list);
        container.append(candidates);
    }
}

function renderInternalReviewBody(container, review) {
    container.append(el("h3", "", "Findings"));
    if (!review.findings?.length) {
        container.append(el("p", "", review.status === "complete"
            ? "No supported findings." : "No supported findings in the completed analysis."));
        return;
    }
    const list = el("ul", "");
    for (const finding of review.findings.slice(0, 8)) {
        const item = el("li", "");
        item.append(el("strong", "", `${finding.severity}: ${finding.title}`), document.createTextNode(" "));
        item.append(document.createTextNode(finding.detail.length > 320 ? `${finding.detail.slice(0, 319)}… ` : `${finding.detail} `));
        for (const citation of finding.citations.slice(0, 4)) item.append(sourceReferenceButton(
            `${citation.path}:${citation.line}${citation.side === "base" ? " (base)" : ""}`,
            { path: citation.path, lines: [citation.line], side: citation.side }), document.createTextNode(" "));
        if (finding.detail.length > 320 || finding.citations.length > 4) {
            const full = el("details", "");
            full.append(el("summary", "", "Full evidence"), el("p", "", finding.detail));
            for (const citation of finding.citations) full.append(sourceReferenceButton(
                `${citation.path}:${citation.line}${citation.side === "base" ? " (base)" : ""}`,
                { path: citation.path, lines: [citation.line], side: citation.side }), document.createTextNode(" "));
            item.append(full);
        }
        list.append(item);
    }
    container.append(list);
}

function renderRuleCheck() {
    const rules = state.payload?.rule_check;
    if (!rules?.sources?.length) return null;
    const details = el("details", "brief-origin rule-check");
    details.open = state.ruleCheckOpen !== false;
    details.addEventListener("toggle", () => { if (details.isConnected) state.ruleCheckOpen = details.open; });
    const summary = el("summary", "");
    summary.append(document.createTextNode(`Repository rules · ${rules.sources.length > 3 ? countLabel(rules.sources.length, "instruction file") : rules.sources.map((source) => source.path).join(", ")}`),
        el("span", `custom-status custom-${rules.status}`, rules.status === "unavailable" ? "AI unavailable" : rules.status));
    details.append(summary);
    const sources = el("p", "muted rule-sources");
    rules.sources.forEach((source, index) => {
        if (index) sources.append(document.createTextNode("; "));
        const ranges = ruleCitations(rules.content, source.path);
        const open = el("button", "link-button rule-source-link", source.path);
        open.type = "button";
        open.title = ranges.length
            ? `Open ${source.path} with ${countLabel(ranges.length, "cited section")} highlighted`
            : `Open ${source.path}`;
        open.addEventListener("click", () => openRuleFile(source.path, ranges));
        sources.append(open, document.createTextNode(` applies to ${countLabel(source.applicable_count, "changed file")}${
            source.changed_in_review ? " and was edited in this change" : ""}${source.truncated ? " (truncated)" : ""}${
            ranges.length ? ` · ${countLabel(ranges.length, "cited section")}` : ""}`));
    });
    sources.append(document.createTextNode(". Copilot checks the change against these rules; verify its claims."));
    details.append(sources);
    appendInternalReview(details, rules, "rules", () => api("/api/rule-check", {
        method: "POST", body: JSON.stringify({ force: false }),
    }));
    if (rules.status === "running" && !rules.coverage) details.append(aiPlaceholder("rule-check", "Copilot is checking the change against the repository rules…", 3));
    if (rules.content) {
        markdownContext.subject = null;
        markdownContext.intent = null;
        const body = revealOnce(el("div", "annotation-body"), "rule-check");
        if (rules.coverage) renderInternalReviewBody(body, rules);
        else renderMarkdown(body, rules.content);
        details.append(body);
    }
    if (rules.error) {
        details.append(el("p", "error", rules.error));
        const retry = el("button", "btn", "Run again");
        retry.type = "button";
        retry.addEventListener("click", async () => {
            retry.disabled = true;
            try { await api("/api/rule-check", { method: "POST", body: JSON.stringify({ force: true }) }); }
            catch (error) { retry.disabled = false; showError(error); }
        });
        details.append(retry);
    }
    return details;
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
    state.areaGroup = null;
    markSelectedCards();
    renderEmptyDetail();
}

function setDetailVisible(visible) {
    state.detailVisible = visible;
    document.querySelector(".workspace").classList.toggle("detail-collapsed", !visible);
    elements.detail_toggle.textContent = visible ? "Hide details" : "Show details";
    elements.detail_toggle.setAttribute("aria-pressed", String(visible));
    detectHostResize();
}

async function loadSource(query, epoch, preferredTab = null, nav = "reset", extras = {}) {
    const source = await api(`/api/source?${query}`);
    if (epoch !== state.selectionEpoch) return false;
    const attribution = await fetchAttribution(source.path, epoch);
    if (epoch !== state.selectionEpoch) return false;
    state.source = { ...source, ...extras, reviewItem: state.selected };
    state.readingPane = "code";
    state.attribution = attribution;
    state.sourceTab = source.declaration_highlight?.side === "base" ? "base"
        : preferredTab || (source.diff ? "diff" : "current");
    recordSourceNavigation(nav, { query, extras, tab: state.sourceTab, label: `${source.path}${source.start_line ? `:${source.start_line}` : ""}` });
    if (!await renderSource() || epoch !== state.selectionEpoch) return false;
    if (state.clientError) {
        state.clientError = null;
        if (!state.payload?.error) elements.error.classList.add("hidden");
    }
    const side = elements.source_panel.querySelector(".source-side");
    side.scrollTop = 0;
    side.scrollLeft = 0;
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
        await loadSource(entry.query, epoch, entry.tab, "replay", entry.extras || {});
    } catch (error) {
        if (epoch === state.selectionEpoch) showError(error);
    }
}

async function fetchAttribution(path, epoch = state.selectionEpoch) {
    if (!path) return [];
    try {
        const provenance = await api(`/api/attribution?path=${encodeURIComponent(path)}`);
        if (epoch === state.selectionEpoch) {
            state.attributionStatus = provenance.status || "matched";
            state.attributionMessage = provenance.message || "";
        }
        return provenance.attribution || [];
    } catch (error) {
        if (error.status !== 404) throw error;
        if (epoch === state.selectionEpoch) {
            state.attributionStatus = "no_match";
            state.attributionMessage = "No originating prompt was found.";
        }
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

async function selectFile(change, annotate = true) {
    rememberSourceReturnFocus();
    setDiscussionMode(false);
    const epoch = ++state.selectionEpoch;
    state.selected = {
        id: `file:${change.path}`, kind: "file", name: change.path, path: change.path,
        change: change.status, metrics: {
            lines_added: change.lines_added,
            lines_removed: change.lines_removed,
            lines_changed: change.lines_added + change.lines_removed,
        },
    };
    // A file's path, status, and line counts are already visible in the list and source title.
    renderEmptyDetail();
    setDetailVisible(false);
    try {
        if (await loadSource(`path=${encodeURIComponent(change.path)}`, epoch)) {
            if (annotate) ensureAnnotation(state.selected, epoch);
        }
    } catch (error) {
        if (epoch === state.selectionEpoch) showError(error);
    }
}

// True while the user has not moved on from the control that opened an async load, even if a re-render replaced that control.
function focusStillAtOpener(opener) {
    const active = document.activeElement;
    if (active === opener || !active || active === document.body) return true;
    if (opener?.isConnected !== false) return false;
    return active.tagName === opener.tagName && active.className === opener.className
        && (opener.dataset.reviewId ? active.dataset.reviewId === opener.dataset.reviewId : active.textContent === opener.textContent);
}

async function selectItem(item, notify = true, annotate = true) {
    const sourceOpener = document.activeElement;
    const keepSourceFocus = elements.source_panel.contains(sourceOpener);
    rememberSourceReturnFocus();
    if (state.selected?.id !== item.id) setDiscussionMode(false);
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
    } else {
        state.source = null;
        elements.source_panel.classList.add("hidden");
    }
    if (epoch !== state.selectionEpoch) return;
    if (keepSourceFocus || focusStillAtOpener(sourceOpener)) {
        const target = elements.source_panel.classList.contains("hidden") ? state.sourceReturnFocus : elements.source;
        target?.focus({ preventScroll: true });
    }
    if (annotate && (item.path || item.evidence_ids?.length || item.node_id || item.edge_id)) {
        ensureAnnotation(item, epoch);
    } else {
        renderAnnotation(item, state.payload?.annotations?.[item.id] || null);
    }
}

function ensureAnnotation(item, epoch = state.selectionEpoch) {
    if (epoch !== state.selectionEpoch || state.selected?.id !== item.id) return;
    const generation = state.payload.review_generation;
    const cached = state.payload?.annotations?.[item.id];
    if (cached) {
        if (state.prefetchStatus?.id === item.id) {
            state.prefetchStatus = null;
            renderPrefetchStatus();
        }
        renderAnnotation(item, cached);
        return;
    }
    renderAnnotation(item, null, true);
    requestAnnotation(item)
        .then((annotation) => {
            if (state.payload?.review_generation === generation && epoch === state.selectionEpoch && state.selected?.id === item.id) {
                renderAnnotation(item, annotation);
            }
            if (state.payload?.review_generation === generation && state.prefetchStatus?.id === item.id) {
                state.prefetchStatus = null;
                renderPrefetchStatus();
            }
        })
        .catch((error) => {
            if (state.payload?.review_generation === generation && epoch === state.selectionEpoch
                && state.selected?.id === item.id) renderAnnotation(item, { error: error.message });
        });
}

function promptBlock(attribution, useOriginal = true, expanded = false) {
    if (useOriginal && attribution.original_prompt) {
        attribution = { ...attribution, prompt: attribution.original_prompt, prompt_event_id: attribution.original_prompt_event_id };
    }
    const fragment = document.createDocumentFragment();
    const prompt = el("p", expanded ? "provenance-prompt" : "provenance-prompt clamped", attribution.prompt);
    fragment.append(prompt);
    const actions = el("div", "provenance-actions");
    if (!expanded && attribution.prompt.length > 260) {
        const toggle = el("button", "link-button", "Show full prompt");
        toggle.type = "button";
        toggle.addEventListener("click", () => {
            const expanded = prompt.classList.toggle("clamped");
            toggle.textContent = expanded ? "Show full prompt" : "Collapse";
        });
        actions.append(toggle);
    }
    if (attribution.session_id) {
        const openHistory = el("button", "link-button", "Open session history");
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
    elements.source_origin.classList.toggle("hidden", !state.attribution.length && !state.attributionStatus);
    if (state.attributionStatus === "error") elements.source_origin.open = true;
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
            countLabel(history.timeline.length, "visible event"),
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
                countLabel(tools.length, "tool call"),
                edits ? countLabel(edits, "edit") : null,
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

function appendInlineMarkdown(container, text, options = {}) {
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > offset) {
            if (options.sourceReferences === false) container.append(document.createTextNode(text.slice(offset, match.index)));
            else appendTextWithSourceReferences(container, text.slice(offset, match.index));
        }
        const token = match[0];
        if (token.startsWith("**")) {
            const label = token.slice(2, -2);
            const intent = markdownContext.intent;
            if (options.sourceReferences !== false && intent?.session_id && /^(Stated intent|Requested):?$/i.test(label.trim())) {
                container.append(intentLink(label, intent));
            } else {
                const strong = el("strong", "");
                appendInlineMarkdown(strong, label, options);
                container.append(strong);
            }
        } else {
            const value = token.slice(1, -1);
            const reference = options.sourceReferences === false ? null : parseSourceReference(value);
            const symbol = options.sourceReferences === false || reference ? null : resolveSymbolReference(state.payload?.model, value, markdownContext.subject);
            if (reference) {
                container.append(sourceReferenceButton(sourceReferenceLabel(reference), reference));
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
    if (offset < text.length) {
        if (options.sourceReferences === false) container.append(document.createTextNode(text.slice(offset)));
        else appendTextWithSourceReferences(container, text.slice(offset));
    }
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

// Links show the repository-relative path and lines, whatever form the text used (absolute, backslashes, bare name).
function sourceReferenceLabel(reference) {
    const ranges = [];
    for (const line of reference.lines || []) {
        const last = ranges.at(-1);
        if (last && line === last[1] + 1) last[1] = line;
        else ranges.push([line, line]);
    }
    return `${reference.path}${ranges.length ? `:${ranges.map(([from, to]) => from === to ? from : `${from}-${to}`).join(",")}` : ""}`;
}

function sourceReferenceButton(label, reference, title = null) {
    const button = el("button", "source-reference", label);
    button.type = "button";
    button.title = title || (reference.lines.length
        ? `Open ${reference.path} at line ${reference.lines.join(", ")}`
        : `Open ${reference.path}`);
    button.addEventListener("click", () => openSourceReference(reference).catch(showError));
    return button;
}

async function openSourceReference(reference, { focus = false, tab = reference.side || "current", nav = "push" } = {}) {
    rememberSourceReturnFocus();
    const epoch = ++state.selectionEpoch;
    const query = new URLSearchParams({ path: reference.path });
    if (reference.lines[0]) query.set("line", String(reference.lines[0]));
    if (reference.side) query.set("side", reference.side);
    const packageName = reference.packageName || (state.selected?.id?.startsWith("package:")
        && [...(state.selected.declared_current || []), ...(state.selected.declared_base || [])].some((item) => item.source === reference.path)
        ? state.selected.name : null);
    if (packageName) {
        query.set("package", packageName);
        if (state.selected?.ecosystem) query.set("ecosystem", state.selected.ecosystem);
    }
    try {
        const loaded = await loadSource(query.toString(), epoch, tab, nav);
        if (loaded && focus) elements.source.focus({ preventScroll: true });
        return loaded;
    } catch (error) {
        if (epoch === state.selectionEpoch) throw error;
        return false;
    }
}

function appendTextWithSourceReferences(container, text) {
    const pattern = /((?:[A-Za-z]:[\\/])?(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:csproj|cs|slnx?|props|targets|py|toml|txt|json|ya?ml|md|[cm]?[jt]sx?|css|html)(?![A-Za-z0-9_])(?::\d+(?:-\d+)?(?:,\d+(?:-\d+)*)*)?)/g;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > offset) container.append(document.createTextNode(text.slice(offset, match.index)));
        const reference = parseSourceReference(match[0]);
        container.append(reference ? sourceReferenceButton(sourceReferenceLabel(reference), reference) : document.createTextNode(match[0]));
        offset = match.index + match[0].length;
    }
    if (offset < text.length) container.append(document.createTextNode(text.slice(offset)));
}

function renderMarkdown(container, markdown, options = {}) {
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    let list = null;
    let paragraph = [];
    let fenced = null;
    const flushParagraph = () => {
        if (!paragraph.length) return;
        const node = el("p", "");
        appendInlineMarkdown(node, paragraph.join(" "), options);
        container.append(node);
        paragraph = [];
    };
    const flushList = () => {
        list = null;
    };
    const tableCells = (line) => line.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
    const tableSeparator = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;
    for (let index = 0; index < lines.length; index++) {
        const rawLine = lines[index];
        const line = rawLine.trim();
        if (line.startsWith("```")) {
            flushParagraph();
            flushList();
            if (fenced === null) fenced = [];
            else {
                const pre = el("pre", "");
                pre.append(el("code", "", fenced.join("\n")));
                container.append(pre);
                fenced = null;
            }
            continue;
        }
        if (fenced !== null) { fenced.push(rawLine); continue; }
        if (!line) {
            flushParagraph();
            if (fenced !== null) {
                const pre = el("pre", "");
                pre.append(el("code", "", fenced.join("\n")));
                container.append(pre);
            }
            flushList();
            continue;
        }
        if (line.startsWith("|") && tableSeparator.test(lines[index + 1]?.trim() || "")) {
            flushParagraph();
            flushList();
            const header = tableCells(line);
            const wrap = el("div", "markdown-table-wrap");
            const table = el("table", "markdown-table");
            const head = el("tr", "");
            for (const cell of header) {
                const th = el("th", "");
                appendInlineMarkdown(th, cell, options);
                head.append(th);
            }
            const thead = el("thead", "");
            thead.append(head);
            const tbody = el("tbody", "");
            index += 2;
            for (; index < lines.length && lines[index].trim().startsWith("|"); index++) {
                const row = el("tr", "");
                const cells = tableCells(lines[index].trim());
                for (let column = 0; column < header.length; column++) {
                    const td = el("td", "");
                    appendInlineMarkdown(td, cells[column] || "", options);
                    row.append(td);
                }
                tbody.append(row);
            }
            index--;
            table.append(thead, tbody);
            wrap.append(table);
            container.append(wrap);
            continue;
        }
        const listItem = /^(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
        if (listItem) {
            flushParagraph();
            const tag = /^\d/.test(line) ? "ol" : "ul";
            if (!list || list.tagName.toLowerCase() !== tag) {
                list = el(tag, "");
                if (tag === "ol") {
                    const start = Number(/^\d+/.exec(line)[0]);
                    if (Number.isSafeInteger(start) && start <= 2147483647) list.start = start;
                }
                container.append(list);
            }
            const item = el("li", "");
            appendInlineMarkdown(item, listItem[1], options);
            list.append(item);
            continue;
        }
        if (/^#{1,3}\s+/.test(line)) {
            flushParagraph();
            flushList();
            const level = Math.min(3, line.match(/^#+/)[0].length);
            const heading = el(`h${level}`, "");
            appendInlineMarkdown(heading, line.replace(/^#{1,3}\s+/, ""), options);
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
    renderReviewContext();
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
        panel.append(aiPlaceholder(`annotation:${item.id}`, "Copilot is grounding an explanation in the selected evidence…", 5));
        return;
    }
    if (annotation.error) {
        panel.append(el("p", "annotation-error", annotation.error));
        return;
    }
    const risk = extractRisk(annotation.body);
    if (risk) {
        const banner = el("div", `risk-banner risk-banner-${risk.level}`);
        const reason = el("span", "");
        appendInlineMarkdown(reason, risk.reason, { sourceReferences: false });
        banner.append(el("b", "", `AI assessment: ${risk.level} risk`), reason);
        panel.append(banner);
    }
    const body = revealOnce(el("div", "annotation-body"), `annotation:${item.id}`);
    markdownContext.intent = state.attribution?.[0] || null;
    markdownContext.subject = state.payload?.model?.nodes.find((node) => node.id === (item.node_id || item.id)) || null;
    const markdown = risk ? risk.body : annotation.body;
    const { preamble, sections } = annotationSections(markdown);
    const primary = sections.find((section) => /what changed|behavior|summary|findings/i.test(section.title)) || sections[0];
    if (primary && sections.length > 1) {
        renderMarkdown(body, primary.text);
        const more = el("details", "annotation-more");
        more.append(el("summary", "", "Full explanation"));
        const full = el("div", "");
        renderMarkdown(full, [preamble, ...sections.filter((section) => section !== primary).map((section) => section.text)].join("\n"));
        more.append(full);
        body.append(more);
    } else renderMarkdown(body, markdown);
    panel.append(body);
    const deepen = el("button", "link-button annotation-deepen", "Ask for a deeper walkthrough");
    deepen.type = "button";
    deepen.addEventListener("click", async () => {
        try {
            await discussItem(item);
            if (discussionPane.item?.id !== item.id || state.selected?.id !== item.id) return;
            discussionPane.prefill(state.source?.path?.toLowerCase().endsWith(".md")
                ? "Explain the before/after obligations, evidence requirements, required stops, permissions and exceptions. Show how this document reaches an agent, cite both saved versions, and distinguish interpretation from observed behavior."
                : "Walk through this change step by step: explain before/after control flow, precedence and fallbacks, a concrete input/output example, affected consumers, and what the saved tests do or do not establish. Cite the saved code.");
        } catch (error) { showError(error); }
    });
    panel.append(deepen);
    if (annotation.evidence_ids?.length) {
        const citations = el("details", "annotation-citations");
        citations.append(el("summary", "", `Evidence (${annotation.evidence_ids.length})`));
        const list = el("div", "evidence-list");
        list.append(...annotation.evidence_ids.map(evidenceButton));
        citations.append(list);
        panel.append(citations);
    }
}

const ANALYSIS_NOTE_PAGE = 200;

function analysisWarningList(warnings) {
    const list = el("ul", "analysis-warning-list");
    let shown = 0;
    // Large repositories can carry tens of thousands of notes; render them in pages so opening the list stays instant.
    const appendPage = () => {
        list.querySelector(".analysis-warning-more")?.remove();
        const end = Math.min(warnings.length, shown + ANALYSIS_NOTE_PAGE);
        for (const warning of warnings.slice(shown, end)) list.append(analysisWarningItem(warning));
        shown = end;
        if (shown < warnings.length) {
            const more = el("li", "analysis-warning-more");
            const button = el("button", "link-button", `Show ${Math.min(ANALYSIS_NOTE_PAGE, warnings.length - shown).toLocaleString()} more of ${(warnings.length - shown).toLocaleString()} remaining notes`);
            button.type = "button";
            button.addEventListener("click", () => {
                const first = shown;
                appendPage();
                list.children[first]?.focus({ preventScroll: false });
            });
            more.append(button);
            list.append(more);
        }
    };
    appendPage();
    return list;
}

function analysisWarningItem(warning) {
    const note = describeAnalysisWarning(warning, state.payload?.model);
    const row = el("li", "analysis-warning-item");
    const heading = el("div", "analysis-warning-heading");
    heading.append(el("strong", "", note.kind));
    if (note.subject) heading.append(el("code", "inline-code", note.subject));
    if (note.snapshot) heading.append(el("span", "muted", note.snapshot));
    if (note.framework) heading.append(el("span", "muted", note.framework));
    row.append(heading);
    if (note.reference) row.append(sourceReferenceButton(
        `${note.reference.path}${note.reference.lines[0] ? `:${note.reference.lines[0]}` : ""}`, note.reference));
    row.append(el("p", "analysis-warning-explanation", note.explanation || note.message));
    if (note.explanation) {
        const details = el("details", "analysis-warning-raw");
        details.append(el("summary", "", "Analyzer detail"), el("p", "", note.raw));
        row.append(details);
    }
    row.tabIndex = -1;
    return row;
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
        field("Static priority", item.impact_score != null || item.node_id || item.package_id ? concernPriority(item) : null),
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
    if (item.analysis_warnings?.length) {
        panel.append(el("p", "analysis-warning-intro",
            "These are limits of the static analysis, not confirmed code defects. Missing graph links do not mean calls or imports fail at runtime."));
        panel.append(analysisWarningList(item.analysis_warnings));
    }
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

const coverageLineCache = new WeakMap();

// Current-side line coverage from the supplied run, keyed by repository path.
function coverageLines(path) {
    const model = state.payload?.model;
    if (!path || !model?.coverage?.available) return null;
    let byPath = coverageLineCache.get(model);
    if (!byPath) {
        byPath = new Map((model.coverage.files || []).map((file) => {
            const covered = new Set(file.covered_lines || []);
            const missing = file.missing_lines || (file.executable_lines || []).filter((line) => !covered.has(line));
            return [file.path, new Map([...[...covered].map((line) => [line, "covered"]), ...missing.map((line) => [line, "uncovered"])])];
        }));
        coverageLineCache.set(model, byPath);
    }
    return byPath.get(path) || null;
}

function renderSourceCoverage() {
    const panel = elements.source_coverage;
    const path = state.source?.path;
    const lines = coverageLines(path);
    const changed = state.payload?.model?.coverage?.changed_lines?.[path];
    state.sourceStripCoverage = null;
    if (!lines?.size || state.sourceTab === "base") { panel.classList.add("hidden"); renderSourceStrip(); return; }
    state.sourceStripCoverage = changed?.total ? { covered: changed.covered, total: changed.total } : { supplied: true };
    panel.replaceChildren(
        el("strong", "", "Line coverage"),
        el("span", "coverage-key coverage-key-covered", "executed"),
        el("span", "coverage-key coverage-key-uncovered", "not executed"),
        el("span", "muted", changed?.total
            ? `${changed.covered} of ${countLabel(changed.total, "changed executable line")} executed${changed.uncovered_lines?.length
                ? ` · not executed: ${changed.uncovered_lines.slice(0, 12).join(", ")}${changed.uncovered_lines.length > 12 ? "…" : ""}` : ""} · supplied run, current side; not proof of named tests.`
            : "Supplied run, current side; not proof of named tests."));
    panel.classList.remove("hidden");
    renderSourceStrip();
}

// One line above the code summarizes the concern, its static priority, triage and coverage; the full cards expand below it.
function renderSourceStrip() {
    const risk = !elements.source_risk.classList.contains("hidden") ? state.sourceStripRisk : null;
    const coverage = state.sourceStripCoverage;
    const show = Boolean(state.source && (risk || coverage));
    elements.source_strip.classList.toggle("hidden", !show);
    if (!show) return;
    const open = Boolean(state.sourceStripOpen);
    const toggle = elements.source_strip_toggle;
    toggle.replaceChildren();
    toggle.setAttribute("aria-expanded", String(open));
    elements.source_strip_body.classList.toggle("hidden", !open);
    const parts = [];
    if (risk) {
        toggle.append(el("strong", "source-strip-title", risk.title));
        parts.push(el("span", "source-strip-score", `Static priority ${risk.score}/100`));
        if (risk.reason) parts.push(el("span", "source-strip-reason", risk.reason));
        if (risk.triage) parts.push(el("span", "source-strip-triage", `Triage: ${risk.triage}`));
    }
    if (coverage) {
        const summary = el("span", "source-strip-coverage");
        if (coverage.total) {
            summary.append(el("span", "coverage-key coverage-key-covered", `${coverage.covered}`),
                document.createTextNode(` of ${countLabel(coverage.total, "changed line")} executed`));
            if (coverage.total > coverage.covered) summary.append(document.createTextNode(" · "),
                el("span", "coverage-key coverage-key-uncovered", `${coverage.total - coverage.covered} not executed`));
        } else summary.append(el("span", "coverage-key coverage-key-covered", "line coverage supplied"));
        parts.push(summary);
    }
    for (const part of parts) {
        if (toggle.childNodes.length) toggle.append(el("span", "source-strip-sep", "·"));
        toggle.append(part);
    }
    toggle.append(el("span", "source-strip-more", open ? "Hide details" : risk ? "Details & triage" : "Legend"));
}

function codeRow(type, oldNumber, newNumber, prefix, content) {
    const row = el("div", `code-row diff-${type}`);
    if (oldNumber) row.dataset.oldLine = String(oldNumber);
    if (newNumber) row.dataset.newLine = String(newNumber);
    // Split diffs show unchanged context on both sides; the right copy is presentational and mirrors this text.
    if (splitRendering && type === "context") row.dataset.mirror = content;
    const coverage = newNumber ? coverageLines(state.source?.path)?.get(Number(newNumber)) : null;
    const current = el("span", "line-number", newNumber || "");
    if (coverage) {
        row.classList.add(`coverage-${coverage}`);
        current.title = coverage === "covered" ? "Executed in the supplied coverage run" : "Not executed in the supplied coverage run";
    }
    row.append(
        el("span", "line-number", oldNumber || ""),
        current,
        el("span", "diff-prefix", prefix),
        el("code", "", content),
    );
    return row;
}

const SPLIT_DIFF_MIN_WIDTH = 1100;
let splitRendering = false;
let splitPairCounter = 0;
const diffLayoutPreference = () => { try { return localStorage.getItem("agent-review.diff-layout") === "split" ? "split" : "unified"; } catch { return "unified"; } };
// Split needs room for two columns of code; narrower windows always read unified.
const splitDiffActive = (tab = state.sourceTab) => tab === "diff" && diffLayoutPreference() === "split" && innerWidth >= SPLIT_DIFF_MIN_WIDTH;

function* diffRowIterator(text, split = false) {
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
                const header = codeRow("hunk", "", "", "", `Lines ${range}${context ? ` · ${context}` : ""}`);
                header.dataset.oldStart = String(oldLine);
                header.dataset.newStart = String(newLine);
                yield header;
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
            if (split) {
                // Pair each removed line with the added line in the same position so edits read side by side.
                for (let pair = 0; pair < Math.max(removed.length, added.length); pair++) {
                    const id = `p${++splitPairCounter}`;
                    if (pair < removed.length) { const row = codeRow("delete", oldLine++, "", "−", removed[pair]); row.dataset.pair = id; yield row; }
                    if (pair < added.length) { const row = codeRow("add", "", newLine++, "+", added[pair]); row.dataset.pair = id; yield row; }
                }
                continue;
            }
            for (const content of removed) yield codeRow("delete", oldLine++, "", "−", content);
            for (const content of added) yield codeRow("add", "", newLine++, "+", content);
            continue;
        } else if (line.startsWith("+")) {
            const row = codeRow("add", "", newLine++, "+", line.slice(1));
            if (split) row.dataset.pair = `p${++splitPairCounter}`;
            yield row;
        } else if (line.startsWith(" ")) {
            yield codeRow("context", oldLine++, newLine++, " ", line.slice(1));
        } else if (line) {
            yield codeRow("meta", "", "", "", line);
        }
        index += 1;
    }
}

function parseDiff(text) {
    return [...diffRowIterator(text)];
}

function* plainSourceRows(text, side) {
    if (text === null || text === undefined) return;
    const segments = diffSegments(state.source?.diff);
    const marks = side === "base" ? segments.base : segments.current;
    const gaps = side === "base" ? segments.addedBefore : segments.removedBefore;
    const gapRow = (count) => {
        const row = codeRow("gap", "", "", side === "base" ? "+" : "−",
            side === "base" ? `${countLabel(count, "line")} added here in Current`
                : `${countLabel(count, "line")} removed here (see Base)`);
        row.classList.add(side === "base" ? "gap-added" : "gap-removed");
        return row;
    };
    const lines = String(text).split(/\r\n|\r|\n/);
    for (const [index, line] of lines.entries()) {
        const number = index + 1;
        if (gaps.has(number)) yield gapRow(gaps.get(number));
        const type = marks.get(number);
        yield codeRow(type || "context", side === "base" ? number : "", side === "base" ? "" : number,
            type ? (side === "base" ? "−" : "+") : "", line);
    }
    if (gaps.has(lines.length + 1)) yield gapRow(gaps.get(lines.length + 1));
}

// Unchanged regions between hunks, with matching base/current line numbers for in-place expansion.
function diffGaps(source) {
    if (typeof source.base !== "string" || typeof source.current !== "string") return [];
    const hunks = [...String(source.diff || "").matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
        oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1), newStart: Number(match[3]), newCount: Number(match[4] ?? 1) }));
    if (!hunks.length) return [];
    const currentLines = source.current.split(/\r\n|\r|\n/);
    if (currentLines.at(-1) === "") currentLines.pop();
    const gaps = [];
    let oldEnd = 0;
    let newEnd = 0;
    for (const [index, hunk] of hunks.entries()) {
        const newTo = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
        if (newTo > newEnd) gaps.push({ before: index, newFrom: newEnd + 1, newTo, oldFrom: oldEnd + 1 });
        oldEnd = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart + hunk.oldCount - 1;
        newEnd = hunk.newCount === 0 ? hunk.newStart : hunk.newStart + hunk.newCount - 1;
    }
    if (currentLines.length > newEnd) gaps.push({ before: hunks.length, newFrom: newEnd + 1, newTo: currentLines.length, oldFrom: oldEnd + 1 });
    return gaps.map((gap) => ({ ...gap, key: `${gap.newFrom}-${gap.newTo}`,
        *iterateRows() {
            for (let line = gap.newFrom; line <= gap.newTo; line++) {
                yield codeRow("context", gap.oldFrom + line - gap.newFrom, line, " ", currentLines[line - 1]);
            }
        },
        rows() { return [...this.iterateRows()]; } }));
}

function gapToggleRow(gap, expanded, contextRows) {
    const count = gap.newTo - gap.newFrom + 1;
    const row = codeRow("gap-toggle", "", "", expanded ? "▴" : "▾",
        `${expanded ? "Hide" : "Show"} ${countLabel(count, "unchanged line")} (${gap.newFrom}–${gap.newTo})`);
    row.dataset.gap = gap.key;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-expanded", String(expanded));
    let displayedRows = contextRows;
    let displayedChunks = [];
    let toggling = false;
    const toggle = async () => {
        if (!row.isConnected || state.sourceTab !== "diff" || toggling) return;
        const source = state.source;
        toggling = true;
        row.setAttribute("aria-busy", "true");
        try {
            const previousScroll = { top: elements.source.scrollTop, left: elements.source.scrollLeft };
            const expandedGaps = state.source.expandedGaps ||= new Set();
            const expand = !expandedGaps.has(gap.key);
            if (expand) {
                const prepared = [];
                let started = performance.now();
                for (const context of gap.iterateRows()) {
                    prepared.push(context);
                    if (prepared.length % 100 === 0 && performance.now() - started > 8) {
                        await new Promise((resolve) => setTimeout(resolve, 0));
                        if (!row.isConnected || state.source !== source || state.sourceTab !== "diff") return;
                        started = performance.now();
                    }
                }
                const referencedRows = [...elements.source.querySelectorAll(`[data-gap-context="${gap.key}"]`)];
                referencedRows.forEach((context) => context.remove());
                displayedRows = prepared;
                const focusSide = state.source.declaration_highlight?.side || state.source.focus_side
                    || (state.source.current === null ? "base" : "current");
                applySourceFocus(displayedRows, Number(state.source.start_line),
                    Number(state.source.end_line || state.source.start_line), focusSide);
                applyCitedHighlights(displayedRows);
                const fragment = document.createDocumentFragment();
                if (displayedRows.length > 2000) {
                    for (let offset = 0; offset < displayedRows.length; offset += 100) {
                        const chunk = el("div", "source-chunk");
                        chunk.append(...displayedRows.slice(offset, offset + 100));
                        displayedChunks.push(chunk);
                        fragment.append(chunk);
                    }
                } else fragment.append(...displayedRows);
                row.after(fragment);
                expandedGaps.add(gap.key);
            } else {
                if (displayedChunks.length) displayedChunks.forEach((chunk) => chunk.remove());
                else displayedRows.forEach((context) => context.remove());
                displayedChunks = [];
                displayedRows = [];
                const focusSide = state.source.declaration_highlight?.side || state.source.focus_side
                    || (state.source.current === null ? "base" : "current");
                const start = Number(state.source.start_line);
                const context = unchangedDiffContext({ ...state.source, line: start, side: focusSide });
                if (context?.length && context[0].newLine >= gap.newFrom && context.at(-1).newLine <= gap.newTo) {
                    const referencedRows = [codeRow("hunk", "", "", "", `Referenced line ${start} · unchanged context`),
                        ...context.map((item) => codeRow("context", item.oldLine, item.newLine, " ", item.content))];
                    referencedRows.forEach((item) => { item.dataset.gapContext = gap.key; });
                    applySourceFocus(referencedRows, start, Number(state.source.end_line || start), focusSide);
                    applyCitedHighlights(referencedRows);
                    row.after(...referencedRows);
                }
                expandedGaps.delete(gap.key);
            }
            row.querySelector(".diff-prefix").textContent = expand ? "▴" : "▾";
            row.querySelector("code").textContent =
                `${expand ? "Hide" : "Show"} ${countLabel(count, "unchanged line")} (${gap.newFrom}–${gap.newTo})`;
            row.setAttribute("aria-expanded", String(expand));
            renderChangeRuler([...elements.source.querySelectorAll(".code-row")]);
            elements.source.scrollTop = previousScroll.top;
            elements.source.scrollLeft = previousScroll.left;
            row.focus({ preventScroll: true });
        } finally {
            toggling = false;
            row.removeAttribute("aria-busy");
        }
    };
    row.addEventListener("click", () => toggle().catch(showError));
    row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle().catch(showError);
        }
    });
    return row;
}

function diffRowsWithGaps(source, rows) {
    const gaps = diffGaps(source);
    if (!gaps.length) return rows.filter((row) => !row.dataset.newStart);
    const headers = new Map(rows.filter((row) => row.classList.contains("diff-hunk") && row.dataset.newStart)
        .map((row, index) => [row, index]));
    const result = [];
    const expandedGaps = source.expandedGaps || new Set();
    const insertGap = (gap) => {
        if (gap.newTo - gap.newFrom + 1 < 5) {
            result.push(...gap.rows());
            return;
        }
        const expanded = expandedGaps.has(gap.key);
        const contextRows = expanded ? gap.rows() : [];
        result.push(gapToggleRow(gap, expanded, contextRows), ...contextRows);
    };
    let gapIndex = 0;
    for (const row of rows) {
        const hunkIndex = headers.get(row) ?? -1;
        while (hunkIndex >= 0 && gapIndex < gaps.length && gaps[gapIndex].before <= hunkIndex) insertGap(gaps[gapIndex++]);
        if (hunkIndex < 0) result.push(row);
    }
    while (gapIndex < gaps.length) insertGap(gaps[gapIndex++]);
    return result;
}

const sourceRowCache = new Map();
let sourceRenderVersion = 0;

const rowCacheKey = (source, tab) => `${source.path}\0${tab}${splitDiffActive(tab) ? "\0split" : ""}`;

// Wrap each paired removed/added line in one side-by-side unit; every line stays its own .code-row for selection,
// citations and coverage. Unpaired sides get an empty filler so columns stay aligned.
function splitDiffUnits(rows) {
    const units = [];
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (!row.dataset?.pair) { units.push(row); continue; }
        const pair = el("div", "split-pair");
        const next = rows[index + 1];
        const partner = next?.dataset?.pair === row.dataset.pair ? next : null;
        if (partner) index++;
        const left = row.classList.contains("diff-delete") ? row : null;
        const right = row.classList.contains("diff-add") ? row : partner;
        pair.append(left || el("div", "split-filler"), right || el("div", "split-filler"));
        units.push(pair);
    }
    return units;
}

function renderDiffLayoutControl() {
    const control = elements.diff_layout;
    const available = state.sourceTab === "diff" && innerWidth >= SPLIT_DIFF_MIN_WIDTH;
    control.classList.toggle("hidden", !available);
    const preference = diffLayoutPreference();
    for (const button of control.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.layout === preference));
}

function setDiffLayout(layout) {
    try { localStorage.setItem("agent-review.diff-layout", layout); } catch { /* the choice still applies to this view */ }
    if (!state.source || state.sourceTab !== "diff") { renderDiffLayoutControl(); return; }
    rememberReadingLine();
    renderSource().then(restoreReadingLine).catch(showError);
}

// Switching layout keeps the reader on the same line instead of jumping to the top.
function rememberReadingLine() {
    const viewed = viewedSourceLocation();
    state.layoutReadingLine = viewed ? { ...viewed } : null;
}

function restoreReadingLine() {
    const viewed = state.layoutReadingLine;
    state.layoutReadingLine = null;
    if (!viewed) return;
    const row = elements.source.querySelector(`.code-row[data-${viewed.side === "base" ? "old" : "new"}-line="${viewed.line}"]`);
    if (row) elements.source.scrollTop += row.getBoundingClientRect().top - elements.source.getBoundingClientRect().top;
}

function matchingSourceRows(source, tab) {
    const cached = sourceRowCache.get(rowCacheKey(source, tab));
    return cached && cached.generation === state.payload?.review_generation && cached.diff === source.diff
        && cached.text === source[tab] && cached.current === source.current && cached.base === source.base ? cached : null;
}

async function cachedSourceRows(source, tab, isCurrent) {
    const key = rowCacheKey(source, tab);
    const generation = state.payload?.review_generation;
    const cached = matchingSourceRows(source, tab);
    if (cached) {
        sourceRowCache.delete(key);
        sourceRowCache.set(key, cached);
        for (const row of new Set([...cached.marked,
            ...(cached.lines?.querySelectorAll(".focus-line, .cited-line") || [])])) {
            row.classList.remove("focus-line", "focus-start", "focus-end", "cited-line", "cited-start", "cited-end");
            const code = row.querySelector("code");
            if (code?.querySelector("mark")) code.textContent = code.textContent;
        }
        cached.marked = [];
        cached.references?.forEach((row) => row.remove());
        cached.lines?.querySelectorAll("[data-gap-context]").forEach((row) => row.remove());
        cached.references = [];
        source.expandedGaps = cached.expandedGaps;
        return cached;
    }
    const rows = [];
    const iterator = tab === "diff" ? diffRowIterator(source.diff, splitDiffActive(tab)) : plainSourceRows(source[tab], tab);
    let started = performance.now();
    for (const row of iterator) {
        rows.push(row);
        if (rows.length % 100 === 0 && performance.now() - started > 8) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (!isCurrent()) return null;
            started = performance.now();
        }
    }
    if (!isCurrent()) return null;
    const entry = { generation, diff: source.diff, text: source[tab], current: source.current, base: source.base,
        rows, marked: [], references: [],
        expandedGaps: source.expandedGaps ||= new Set() };
    if (rows.length > 60_000) return entry;
    sourceRowCache.set(key, entry);
    let total = [...sourceRowCache.values()].reduce((sum, entry) => sum + entry.rows.length, 0);
    while (sourceRowCache.size > 3 || (total > 60_000 && sourceRowCache.size > 1)) {
        const first = sourceRowCache.keys().next().value;
        total -= sourceRowCache.get(first).rows.length;
        sourceRowCache.delete(first);
    }
    return entry;
}

async function renderSource({ preserveScroll = false } = {}) {
    if (!state.source) return;
    state.reviewPage = "review";
    if (!state.readingPane) state.readingPane = "code";
    elements.source_panel.classList.remove("no-source");
    const source = state.source;
    const tab = state.sourceTab;
    const version = ++sourceRenderVersion;
    const isCurrent = () => version === sourceRenderVersion && state.source === source && state.sourceTab === tab;
    const previousScroll = { top: elements.source.scrollTop, left: elements.source.scrollLeft };
    elements.source_panel.classList.remove("hidden");
    renderWorkspaceNavigation();
    state.navigationCursor = { path: source.path, group: state.activeReviewGroup || null };
    renderWorkspaceShell();
    elements.source_title.textContent = `${state.source.path}${state.source.start_line ? `:${state.source.start_line}` : ""}`;
    renderSourcePosition(state.source.path);
    elements.source_section.classList.toggle("hidden", !(state.payload?.model?.changes || [])
        .some((change) => change.path === state.source.path && change.status !== "unchanged"));
    elements.source.setAttribute("aria-busy", "true");
    elements.source_focus.disabled = !state.sourceFocused;
    elements.source_location.disabled = true;
    if (!matchingSourceRows(source, tab)) elements.source.replaceChildren(el("p", "muted", "Rendering saved source…"));
    elements.source_ruler.classList.add("hidden");
    splitRendering = splitDiffActive(tab);
    renderDiffLayoutControl();
    const cached = await cachedSourceRows(source, tab, isCurrent);
    if (!cached || !isCurrent()) return false;
    const reused = Boolean(cached.lines);
    const rows = reused ? [...cached.lines.querySelectorAll(".code-row")]
        : tab === "diff" ? diffRowsWithGaps(source, cached.rows) : cached.rows;
    const start = Number(state.source.start_line);
    const focusSide = state.source.declaration_highlight?.side || state.source.focus_side
        || (state.source.current === null ? "base" : "current");
    elements.source_context_notice.classList.add("hidden");
    if (state.sourceTab === "diff" && Number.isInteger(start) && start > 0
        && !rows.some((row) => Number(row.dataset?.[focusSide === "base" ? "oldLine" : "newLine"]) === start)) {
        const context = unchangedDiffContext({ ...state.source, line: start, side: focusSide });
        if (context) {
            const key = focusSide === "base" ? "oldLine" : "newLine";
            const headerKey = focusSide === "base" ? "oldStart" : "newStart";
            const first = context[0][key];
            const position = rows.findIndex((row) =>
                Number(row.dataset?.[headerKey]) >= first || Number(row.dataset?.[key]) >= first);
            const referencedRows = [
                codeRow("hunk", "", "", "", `Referenced line ${start} · unchanged context`),
                ...context.map((row) => codeRow("context", row.oldLine, row.newLine, " ", row.content))];
            const gap = rows.find((row) => {
                if (!row.dataset.gap) return false;
                const [from, to] = row.dataset.gap.split("-").map(Number);
                return context[0].newLine >= from && context.at(-1).newLine <= to;
            });
            if (gap) referencedRows.forEach((row) => { row.dataset.gapContext = gap.dataset.gap; });
            cached.references = referencedRows;
            if (reused) {
                if (position < 0) rows.at(-1)?.after(...referencedRows);
                else rows[position].before(...referencedRows);
            }
            rows.splice(position < 0 ? rows.length : position, 0, ...referencedRows);
        } else {
            elements.source_context_notice.textContent = `Referenced line ${start} is not included in this diff. Open ${focusSide === "base" ? "Base" : "Current"} to inspect it.`;
            elements.source_context_notice.classList.remove("hidden");
        }
    }
    const lines = cached.lines || el("div", "code-lines");
    const oldNumbers = rows.some((row) => row.dataset?.oldLine);
    const newNumbers = rows.some((row) => row.dataset?.newLine);
    elements.source_focus.disabled = !(oldNumbers || newNumbers) && !state.sourceFocused;
    elements.source_location.disabled = !(oldNumbers || newNumbers);
    lines.classList.toggle("new-lines-only", newNumbers && !oldNumbers);
    lines.classList.toggle("old-lines-only", oldNumbers && !newNumbers);
    const largestLine = rows.reduce((largest, row) =>
        Math.max(largest, Number(row.dataset?.oldLine) || 0, Number(row.dataset?.newLine) || 0), 0);
    lines.dataset.lineDigits = String(Math.max(2, String(largestLine).length));
    lines.style.setProperty("--source-line-digits", lines.dataset.lineDigits);
    lines.classList.toggle("split-diff", splitRendering);
    if (!reused) {
        const units = splitRendering ? splitDiffUnits(rows) : rows;
        if (units.length > 2000) {
            const fragment = document.createDocumentFragment();
            for (let offset = 0; offset < units.length; offset += 100) {
                const chunk = el("div", "source-chunk");
                chunk.append(...units.slice(offset, offset + 100));
                fragment.append(chunk);
            }
            lines.append(fragment);
        } else lines.append(...(units.length ? units : [el("p", "empty-code", "(not present in this snapshot)")]));
        cached.lines = lines;
    }
    let focusStart = start;
    let focusEnd = Number(state.source.end_line || state.source.start_line);
    if (state.sourceTab !== "diff" && state.sourceTab !== focusSide) {
        const diffRows = parseDiff(state.source.diff);
        const fromKey = focusSide === "base" ? "oldLine" : "newLine";
        const toKey = state.sourceTab === "base" ? "oldLine" : "newLine";
        const mapLine = (line) => {
            const row = diffRows.find((candidate) => Number(candidate.dataset?.[fromKey]) === line
                && Number(candidate.dataset?.[toKey]) > 0);
            const context = row?.dataset || unchangedDiffContext({ ...state.source, line, side: focusSide, radius: 0 })?.[0];
            return Number(context?.[toKey]) || null;
        };
        focusStart = mapLine(start);
        focusEnd = mapLine(focusEnd) || focusStart;
    }
    const focused = applySourceFocus(rows, focusStart, focusEnd, focusSide);
    const cited = applyCitedHighlights(rows);
    cached.marked = [...new Set([...focused, ...cited])];
    if (elements.source.firstElementChild !== lines) elements.source.replaceChildren(lines);
    elements.source.removeAttribute("aria-busy");
    renderChangeRuler(rows);
    renderSourceComments();
    const annotation = state.payload?.annotations?.[state.selected?.id];
    const selectedPath = state.selected?.path || state.payload?.model?.nodes?.find((node) =>
        node.id === (state.selected?.node_id || state.selected?.id))?.path;
    if (annotation && selectedPath === state.source.path) renderAnnotation(state.selected, annotation);
    else if (selectedPath === state.source.path && state.annotationRequests.has(`${state.payload.review_generation}:${state.selected?.id}`)) {
        renderAnnotation(state.selected, null, true);
    } else if (!renderSectionEvidence()) elements.source_annotation.classList.add("hidden");
    renderSourceRisk();
    renderSourceCoverage();
    renderSourceDecisions();
    renderProvenance();
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === state.sourceTab));
    renderSourceNavigation();
    renderFileReview();
    schedulePrefetchNext();
    if (preserveScroll) {
        elements.source.scrollTop = previousScroll.top;
        elements.source.scrollLeft = previousScroll.left;
    } else {
        elements.source.scrollTop = 0;
        elements.source.scrollLeft = 0;
        const target = focused[0] || cited[0];
        target?.scrollIntoView({ block: "center" });
    }
    queueReviewCursor();
    return true;
}

// ---- Per-layer verification: run the linked tests of the layer being read, beside the code ----

const layerPaths = (layer) => [...new Set(layer.groups.flatMap((group) => group.files.map((file) => file.path)))];
// The deterministic area name labels runs, so the run history reads the same before and after AI step titles load.
const layerScope = (layer) => ({ id: layer.id, name: layer.name, number: layer.number || null, paths: layerPaths(layer) });
const layerTests = (layer) => layerTestStatus(state.payload?.decision_map, state.payload?.test_run, layerPaths(layer));

function currentReadingLayer() {
    const navigation = state.workspaceNavigation;
    return state.source && navigation ? layerOf(navigation, { path: state.source.path }) : null;
}

function layerPlanFor(layer) {
    const payload = state.payload;
    const key = [payload?.review_generation, Boolean(payload?.worktree_changed), payload?.decision_map?.status, payload?.decision_map?.total_ms, layer.id].join(":");
    state.layerPlans ||= new Map();
    const cached = state.layerPlans.get(key);
    if (cached) return cached.plan;
    state.layerPlans.set(key, { plan: null });
    api("/api/test-run/plan", { method: "POST", body: JSON.stringify({ layer: layerScope(layer) }) })
        .then((plan) => { state.layerPlans.set(key, { plan }); renderReviewContext(); })
        .catch((error) => { state.layerPlans.set(key, { plan: { available: false, reason: error.message } }); renderReviewContext(); });
    return null;
}

function layerTestSummary(status) {
    if (status.state === "running") return `${countLabel(status.linked, "linked test")} · running${
        status.ran ? ` (before this run: ${layerTestSummary({ ...status, state: status.outcome })})` : ""}`;
    if (status.state === "not-run") return `${countLabel(status.linked, "linked test")} · not run`;
    const parts = ["passed", "failed", "error", "skipped"].filter((key) => status.counts[key]).map((key) => `${status.counts[key]} ${key}`);
    if (status.counts.not_run) parts.push(`${status.counts.not_run} not run`);
    return `${parts.join(" · ")}${status.stale ? " · stale" : ""}`;
}

// A compact status chip for rails and lists; nothing when the layer has no linked tests. Only fresh, all-passing results get a ✓.
function layerTestChip(layer) {
    const status = layerTests(layer);
    if (!["running", "not-run", "passed", "failing", "partial", "skipped"].includes(status.state)) return null;
    const kind = status.stale && status.state !== "running" ? "stale" : status.state;
    const text = status.state === "running" ? "Testing…"
        : status.state === "failing" ? `✗ ${status.counts.failed + status.counts.error} failing`
        : status.stale ? `${status.ran}/${status.linked} tested · stale`
        : status.state === "passed" ? `✓ ${status.counts.passed} passed`
        : status.state === "skipped" ? `${status.counts.passed} passed · ${status.counts.skipped} skipped`
        : status.state === "partial" ? `${status.ran}/${status.linked} tested` : `${status.linked} tests`;
    const chip = el("span", `layer-tests layer-tests-${kind}`, text);
    chip.title = `Linked tests for this layer: ${layerTestSummary(status)}. Run them from "What was verified?" beside the code.`;
    return chip;
}

function layerVerifyBlock(layer) {
    const block = el("div", "layer-verify");
    block.setAttribute("aria-live", "polite");
    const status = layerTests(layer);
    const label = layerLabel(layer);
    if (status.state === "loading") {
        block.append(el("p", "muted", `Finding the tests linked to ${label}…`));
        return block;
    }
    if (status.state === "unavailable") {
        block.append(el("p", "muted", state.payload?.decision_map?.status === "error"
            ? "Linked tests are unavailable because code-path analysis failed."
            : "Linked tests are unavailable for this review (no code-path test links)."));
        return block;
    }
    if (status.state === "none") {
        block.append(el("p", "", `No linked tests reach the changed code in ${label}.`));
        return block;
    }
    const run = state.payload?.test_run;
    const plan = layerPlanFor(layer);
    const head = el("p", "layer-verify-status");
    head.append(el("strong", "", `${label}: `), layerTestSummary(status));
    block.append(head);
    const last = [...(run?.history || [])].reverse().find((entry) => entry.scope?.id === layer.id);
    if (last && ["error", "cancelled"].includes(last.status) && status.state !== "running") {
        block.append(el("p", last.status === "error" ? "error" : "muted", last.status === "error"
            ? `The last run of this layer's tests failed to complete: ${last.error || "see the test output in Explore → Code paths."}` : "The last run of this layer's tests was cancelled."));
    }
    const failing = (scopeDecisionMap(state.payload.decision_map, layerPaths(layer)).verification?.tests || [])
        .filter((test) => ["failed", "error"].includes(linkedTestOutcome(run, test.id)));
    if (failing.length) {
        const list = el("ul", "layer-verify-failing");
        for (const test of failing.slice(0, 5)) {
            const item = el("li", "");
            const open = el("button", "link-button", `${test.name} ${linkedTestOutcome(run, test.id)}`);
            open.type = "button";
            open.title = `Open ${test.path}:${test.line}`;
            open.addEventListener("click", async () => {
                const epoch = ++state.selectionEpoch;
                try {
                    if (await loadSource(`path=${encodeURIComponent(test.path)}&line=${test.line}&side=current`, epoch, "current", "reset")
                        && epoch === state.selectionEpoch) elements.source.focus({ preventScroll: true });
                } catch (error) { if (epoch === state.selectionEpoch) showError(error); }
            });
            item.append(open);
            list.append(item);
        }
        block.append(list);
    }
    const actions = el("div", "layer-verify-actions");
    const running = run?.status === "running";
    const button = el("button", "layer-verify-run", status.state === "running" ? "Running…"
        : status.state === "not-run" ? `Run ${countLabel(status.linked, "linked test")}` : "Rerun this layer's tests");
    button.type = "button";
    button.dataset.focusKey = "run";
    button.disabled = running || !plan?.available;
    button.title = plan?.available ? plan.command : plan?.reason || "Checking the linked tests…";
    button.addEventListener("click", async () => {
        // Re-renders replace these controls; keep keyboard focus on the equivalent control (Cancel while running).
        state.layerVerifyFocus = "cancel";
        button.disabled = true;
        try { await api("/api/test-run", { method: "POST", body: JSON.stringify({ layer: layerScope(layer) }) }); }
        catch (error) { state.layerVerifyFocus = null; showError(error); button.disabled = false; }
    });
    actions.append(button);
    if (running) {
        const cancel = el("button", "link-button", "Cancel");
        cancel.type = "button";
        cancel.dataset.focusKey = "cancel";
        cancel.addEventListener("click", () => {
            state.layerVerifyFocus = "run";
            api("/api/test-run/cancel", { method: "POST", body: "{}" }).catch(showError);
        });
        actions.append(cancel);
    }
    block.append(actions);
    const traced = plan && !["csharp", "rust"].includes(plan.adapter_id);
    if (traced && status.ran && !status.stale) {
        const legend = el("p", "muted layer-verify-note trace-legend");
        for (const [kind, text] of [["passed", "a linked test ran this changed path"], ["missed", "no linked test reached it"], ["failing", "only failing tests ran it"]]) {
            const item = el("span", "");
            item.append(el("span", `trace-dot trace-dot-${kind}`), text);
            legend.append(item);
        }
        block.append(legend);
    }
    block.append(el("p", "muted layer-verify-note", running
        ? `${run.scope?.id === layer.id ? "Running" : `Running ${run.scope ? layerLabel(state.workspaceNavigation?.layers.find((item) => item.id === run.scope.id)) || "another layer" : "all linked tests"}:`} ${
            countLabel(run.planned || 0, "test")} in ${run.location || "the worktree"}. Usually under a minute; you can keep reading.`
        : plan?.available ? `Runs in ${plan.location} and executes repository code.${traced ? " Changed code-path lines a linked test executed are marked in the gutter." : " Records outcomes; this language has no per-line trace."}`
            : plan?.reason || "Checking the linked tests…"));
    return block;
}

// Gutter marks on changed code paths that a linked test run executed (green), only failing tests executed (red), or did not reach.
function renderTestTrace() {
    for (const cell of elements.source.querySelectorAll(".line-number[data-trace]")) {
        cell.removeAttribute("data-trace");
        cell.removeAttribute("title");
    }
    const run = state.payload?.test_run;
    const map = state.payload?.decision_map;
    const source = state.source;
    const lines = elements.source.querySelector(".code-lines");
    // Trace dots sit left of the line number; widen the number column while any are shown so digits stay readable.
    const widen = (marked) => { if (lines?.dataset.lineDigits) lines.style.setProperty("--source-line-digits", String(Number(lines.dataset.lineDigits) + (marked ? 1.5 : 0))); };
    widen(false);
    if (!source || map?.status !== "complete" || !["complete", "running"].includes(run?.status) || !run?.executed || run.stale || elements.source.getAttribute("aria-busy") === "true") return;
    let marked = 0;
    for (const callable of (map.callables || []).filter((item) => item.path === source.path)) {
        if (!run.ran?.[callable.id]) continue;
        for (const entry of callable.entries || []) {
            if (entry.status === "removed" || entry.decision.implicit) continue;
            const hits = run.executed[`${callable.id}:${entry.decision.line}`];
            if (hits === undefined || hits === null) continue;
            const row = commentRow(entry.decision.line, "RIGHT");
            const cell = row?.children[1]?.classList.contains("line-number") ? row.children[1] : row?.querySelector(".line-number");
            if (!cell) continue;
            const failing = hits.length && hits.every((hit) => hit.outcome !== "passed");
            cell.dataset.trace = !hits.length ? "missed" : failing ? "failing" : "passed";
            marked++;
            const names = hits.map((hit) => hit.id.split("::").at(-1));
            cell.title = !hits.length ? `Line ${entry.decision.line}: no linked test executed this code path`
                : `Line ${entry.decision.line}: executed by ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} (${failing ? "failing" : "passed"})`;
        }
    }
    widen(marked > 0);
}

// ---- Line comments: GitHub threads (read-only) and local drafts that post with the reviewer's review ----

function ensurePrReview() {
    const payload = state.payload;
    if (!payload?.model || payload.loading || state.reviewPickerPending) return;
    const key = `${payload.review_generation}:${JSON.stringify(payload.review_target || {})}`;
    if (state.prReviewKey === key) return;
    state.prReviewKey = key;
    state.commentEditors = new Map();
    loadPrReview();
}

async function loadPrReview({ force = false } = {}) {
    const key = state.prReviewKey;
    if (!force && state.prReviewLoading === key) return state.prReviewPromise;
    state.prReviewLoading = key;
    state.prReviewPromise = (async () => {
        try {
            const data = await api("/api/pr-review");
            if (state.prReviewKey !== key) return;
            state.prReview = data;
            state.prReviewError = data.github_error || null;
        } catch (error) {
            if (state.prReviewKey !== key) return;
            state.prReviewError = error.message;
        } finally {
            if (state.prReviewLoading === key) state.prReviewLoading = null;
        }
        renderSourceComments();
        renderFileReview();
        if (state.reviewPage === "finish") renderFinishReview();
    })();
    return state.prReviewPromise;
}

const isChangedPath = (path) => (state.payload?.model?.changes || []).some((file) => file.path === path && file.status !== "unchanged");
// A PR whose head moved past the reviewed snapshot cannot take comments anchored to what the reviewer is reading.
const prHeadMoved = () => state.prReview?.available && state.prReview.head_matches === false;

// Lines GitHub can anchor a review comment to (inside a diff hunk), mirrored from the server's validation.
function commentableLines(diff) {
    const right = new Set(), left = new Set();
    let oldLine = 0, newLine = 0, inHunk = false;
    for (const line of String(diff || "").split(/\r?\n/)) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; continue; }
        if (!inHunk || /^(diff --git |index |--- |\+\+\+ |\\ )/.test(line)) continue;
        if (line.startsWith("+")) right.add(newLine++);
        else if (line.startsWith("-")) left.add(oldLine++);
        else if (line.startsWith(" ")) { left.add(oldLine++); right.add(newLine++); }
    }
    return { RIGHT: right, LEFT: left };
}

// On a pull request GitHub's own patch decides which lines take comments; it can have narrower context than the saved diff.
function commentableFor(source) {
    const lines = state.prReview?.commentable;
    if (!lines) return commentableLines(source?.diff);
    const file = lines[source?.path];
    return { RIGHT: new Set(file?.RIGHT || []), LEFT: new Set(file?.LEFT || []) };
}

// The Comment button and C key comment on the line being read, or the nearest commentable line on that side.
function commentOnCurrentLine() {
    const source = state.source;
    if (!source || !isChangedPath(source.path)) { showError(new Error("Open a changed file to comment on it.")); return; }
    if (prHeadMoved()) { elements.source.querySelector(".review-comment-notice")?.scrollIntoView({ block: "nearest" }); return; }
    const viewed = viewedSourceLocation();
    const side = viewed?.side === "base" ? "LEFT" : "RIGHT";
    const lines = [...commentableFor(source)[side]];
    if (!lines.length) { showError(new Error("This file has no diff lines on that side to comment on.")); return; }
    const wanted = viewed?.line || lines[0];
    const line = lines.reduce((best, item) => Math.abs(item - wanted) < Math.abs(best - wanted) ? item : best, lines[0]);
    if (!commentRow(line, side)) { showError(new Error(`Line ${line} is not shown in this tab. Open the Diff tab to comment on it.`)); return; }
    openCommentEditor({ path: source.path, line, side });
}

function commentRow(line, side) {
    return elements.source.querySelector(`.code-row[data-${side === "LEFT" ? "old" : "new"}-line="${line}"]`);
}

// Which side a clicked line number belongs to: the first number column is the base (old) line.
function lineNumberAnchor(row, number) {
    const left = number === row.children[0];
    const line = Number(left ? row.dataset.oldLine : row.dataset.newLine);
    return line ? { line, side: left ? "LEFT" : "RIGHT" } : null;
}

// Comment blocks follow their line (after a split pair as a whole) and after any blocks already there.
function insertAfterLine(row, block) {
    let anchor = row.closest(".split-pair") || row;
    while (anchor.nextElementSibling?.matches(".review-comment, .review-comment-editor, .review-comment-inline-note")) anchor = anchor.nextElementSibling;
    anchor.after(block);
}

function commentHeader(author, meta, kind) {
    const header = el("div", "review-comment-header");
    header.append(el("strong", "", author), el("span", `review-comment-kind kind-${kind}`, meta));
    return header;
}

const sideLabel = (side, line) => `${side === "LEFT" ? "base line" : "line"} ${line}`;

function commentBody(text) {
    const body = el("div", "review-comment-body markdown");
    renderMarkdown(body, text);
    return body;
}

function threadBlock(thread, replies, className, meta) {
    const block = el("div", className);
    for (const item of [thread, ...replies]) {
        const entry = el("div", "review-comment-entry");
        entry.append(commentHeader(item.author, item === thread ? meta : `reply · ${new Date(item.created_at).toLocaleDateString()}`, "thread"),
            commentBody(item.body));
        block.append(entry);
    }
    if (thread.url) {
        const link = el("a", "review-comment-link", "Reply on GitHub");
        link.href = thread.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        block.append(link);
    }
    return block;
}

const editorKey = (editor) => editor.id ? `draft:${editor.id}` : `new:${editor.path}:${editor.side}:${editor.line}`;
const editorDirty = (editor) => editor.body.trim() !== (editor.original || "").trim();

function renderSourceComments() {
    // Keep the caret in whichever editor is being typed in across re-renders.
    const active = document.activeElement?.closest?.(".review-comment-editor");
    const focusKey = active?.dataset.editorKey || state.commentFocusKey;
    const selection = active ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    state.commentFocusKey = null;
    elements.source.querySelectorAll(".review-comment, .review-comment-editor, .review-comment-outdated, .review-comment-notice, .review-comment-inline-note")
        .forEach((node) => node.remove());
    const source = state.source;
    const data = state.prReview;
    const moved = prHeadMoved();
    elements.workspace_comment.disabled = !source || !isChangedPath(source.path) || moved;
    elements.workspace_comment.title = !source || !isChangedPath(source.path) ? "Open a changed file to comment on it"
        : moved ? "The pull request has newer commits than this review; re-open it to comment"
        : `${data?.available ? "Draft a pull request comment" : "Comment"} on the line you are reading (C), or click a line number`;
    if (!source || elements.source.getAttribute("aria-busy") === "true") return;
    const path = source.path;
    const lines = elements.source.querySelector(".code-lines");
    const commentable = isChangedPath(path) && !moved ? commentableFor(source) : { RIGHT: new Set(), LEFT: new Set() };
    for (const row of elements.source.querySelectorAll(".code-row")) {
        for (const number of row.querySelectorAll(":scope > .line-number")) {
            const anchor = lineNumberAnchor(row, number);
            number.classList.toggle("commentable", Boolean(anchor && commentable[anchor.side].has(anchor.line)));
        }
    }
    if (!data) return;
    if (moved && lines) {
        const notice = el("div", "review-comment-notice");
        notice.setAttribute("role", "status");
        notice.append(el("strong", "", "This pull request has newer commits. "), `GitHub's head is ${String(data.head || "").slice(0, 7)}; this review shows ${
            String(data.reviewed_head || "").slice(0, 7)}. Commenting and Viewed sync are paused so nothing is posted against code you did not read. Re-open the pull request in Agent Review to review the new commits.`);
        lines.prepend(notice);
    }
    const threads = (data.threads || []).filter((thread) => thread.path === path);
    const repliesTo = (thread) => threads.filter((reply) => reply.reply_to === thread.id);
    for (const thread of threads.filter((item) => !item.reply_to && !item.outdated)) {
        const row = commentRow(thread.line, thread.side);
        if (!row) continue;
        insertAfterLine(row, threadBlock(thread, repliesTo(thread), "review-comment review-comment-thread",
            `on GitHub · ${thread.side === "LEFT" ? "base · " : ""}${new Date(thread.created_at).toLocaleDateString()}`));
    }
    const outdated = threads.filter((item) => !item.reply_to && item.outdated);
    if (outdated.length && lines) {
        const details = el("details", "review-comment-outdated");
        details.append(el("summary", "", `${countLabel(outdated.length, "comment")} on other commits of this file`));
        for (const thread of outdated) {
            details.append(threadBlock(thread, repliesTo(thread), "review-comment-entry",
                `${sideLabel(thread.side, thread.original_line ?? "?")} on commit ${String(thread.original_commit || "").slice(0, 7) || "unknown"}`));
        }
        lines.prepend(details);
    }
    const editors = state.commentEditors || new Map();
    for (const draft of (data.drafts?.comments || []).filter((item) => item.path === path)) {
        const row = commentRow(draft.line, draft.side);
        if (!row || editors.has(`draft:${draft.id}`)) continue;
        const block = el("div", "review-comment review-comment-draft");
        block.dataset.draftId = draft.id;
        block.append(commentHeader("Your draft", `${sideLabel(draft.side, draft.line)} · ${data.available ? "pending · posts with your review" : "local · included in the handoff"}`, "draft"),
            commentBody(draft.body));
        const actions = el("div", "review-comment-actions");
        const edit = el("button", "link-button", "Edit");
        edit.type = "button";
        edit.setAttribute("aria-label", `Edit draft on ${sideLabel(draft.side, draft.line)}`);
        edit.addEventListener("click", () => openCommentEditor({ path, line: draft.line, side: draft.side, id: draft.id, body: draft.body }));
        const remove = el("button", "link-button", "Delete");
        remove.type = "button";
        remove.setAttribute("aria-label", `Delete draft on ${sideLabel(draft.side, draft.line)}`);
        remove.addEventListener("click", async () => {
            try { await saveDraftChange({ action: "delete", id: draft.id }); }
            catch (error) { showError(error); }
            elements.source.focus({ preventScroll: true });
        });
        actions.append(edit, remove);
        block.append(actions);
        insertAfterLine(row, block);
    }
    for (const [key, editor] of editors) {
        if (editor.path !== path) continue;
        const row = commentRow(editor.line, editor.side);
        if (!row) continue;
        const block = commentEditorBlock(key, editor);
        insertAfterLine(row, block);
        if (key === focusKey) {
            const textarea = block.querySelector("textarea");
            requestAnimationFrame(() => {
                textarea.focus({ preventScroll: !!selection });
                if (selection) textarea.setSelectionRange(...selection);
            });
        }
    }
    const note = state.commentNote;
    if (note?.path === path) {
        const row = commentRow(note.line, note.side);
        if (row) {
            const node = el("p", "review-comment-inline-note", note.message);
            node.setAttribute("role", "status");
            insertAfterLine(row, node);
        }
    }
}

function commentEditorBlock(key, editor) {
    const block = el("div", "review-comment-editor");
    block.dataset.editorKey = key;
    const label = `${editor.path.split("/").at(-1)}:${editor.line}${editor.side === "LEFT" ? " (base)" : ""}`;
    const textarea = el("textarea", "");
    textarea.rows = 3;
    textarea.maxLength = 4000;
    textarea.value = editor.body;
    textarea.setAttribute("aria-label", `Comment on ${label}`);
    textarea.placeholder = state.prReview?.available ? "Leave a comment. It posts when you submit your review." : "Leave a comment. It is saved locally and included in the handoff.";
    textarea.addEventListener("input", () => { editor.body = textarea.value; });
    const error = el("p", "error", editor.error || "");
    error.setAttribute("role", "alert");
    error.classList.toggle("hidden", !editor.error);
    const actions = el("div", "review-comment-actions");
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    const save = el("button", "review-comment-save", editor.id ? "Save comment" : "Add comment");
    save.type = "button";
    save.disabled = Boolean(editor.saving);
    const submit = async () => {
        if (editor.saving) return;
        editor.saving = true;
        editor.error = null;
        save.disabled = true;
        error.classList.add("hidden");
        try {
            await saveDraftChange(editor.id ? { action: "edit", id: editor.id, body: editor.body }
                : { action: "add", comment: { path: editor.path, line: editor.line, side: editor.side, body: editor.body } });
            state.commentEditors.delete(key);
            renderSourceComments();
            elements.source.focus({ preventScroll: true });
        } catch (failure) {
            editor.saving = false;
            editor.error = failure.message;
            // A draft deleted elsewhere cannot be edited; keep the text as a new comment on the same line instead.
            if (failure.code === "draft_missing") {
                state.commentEditors.delete(key);
                delete editor.id;
                editor.original = "";
                editor.error = "This draft was deleted in another tab. Your text is kept here; select Add comment to save it as a new comment.";
                state.commentEditors.set(editorKey(editor), editor);
                state.commentFocusKey = editorKey(editor);
            } else state.commentFocusKey = key;
            renderSourceComments();
        }
    };
    cancel.addEventListener("click", () => { state.commentEditors.delete(key); renderSourceComments(); elements.source.focus({ preventScroll: true }); });
    save.addEventListener("click", submit);
    textarea.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submit(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel.click(); }
    });
    actions.append(cancel, save);
    block.append(el("p", "review-comment-target muted", `${editor.id ? "Edit comment" : "Comment"} on ${label}`), textarea, error, actions);
    return block;
}

// Several editors can be open at once, like on GitHub; opening one never discards text typed in another.
async function openCommentEditor(editor) {
    if (!isChangedPath(editor.path)) { showError(new Error("Comments can only be added to changed files.")); return; }
    // Comments may still be loading from GitHub; open the editor as soon as they arrive rather than refusing.
    if (!state.prReview) {
        ensurePrReview();
        await state.prReviewPromise;
        if (!state.prReview) { showError(new Error(state.prReviewError || "Review comments could not be loaded.")); return; }
        if (state.source?.path !== editor.path) return;
    }
    if (prHeadMoved()) { renderSourceComments(); return; }
    state.commentEditors ||= new Map();
    const key = editorKey(editor);
    if (!state.commentEditors.has(key)) state.commentEditors.set(key, { ...editor, body: editor.body || "", original: editor.body || "" });
    state.commentNote = null;
    state.commentFocusKey = key;
    renderSourceComments();
}

window.addEventListener("beforeunload", (event) => {
    if ([...(state.commentEditors?.values() || [])].some(editorDirty)) event.preventDefault();
});

async function saveDraftChange(change) {
    const drafts = state.prReview?.drafts;
    if (!drafts) throw new Error("Review comments are still loading.");
    const send = (revision) => api("/api/pr-review/drafts", { method: "POST", body: JSON.stringify({ revision, ...change }) });
    const missing = (list) => change.id && !list.comments.some((comment) => comment.id === change.id);
    if (missing(drafts)) {
        if (change.action === "delete") return;
        throw Object.assign(new Error("This draft was deleted in another tab."), { code: "draft_missing" });
    }
    let result;
    try { result = await send(drafts.revision); }
    catch (error) {
        if (error.status !== 409) throw error;
        // Another tab changed the drafts: reload them and apply this one change on top.
        await loadPrReview({ force: true });
        const current = state.prReview?.drafts;
        if (!current) throw new Error("Review comments could not be reloaded; your text is kept. Try again.");
        if (missing(current)) {
            if (change.action === "delete") return;
            throw Object.assign(new Error("This draft was deleted in another tab."), { code: "draft_missing" });
        }
        result = await send(current.revision);
    }
    state.prReview = { ...state.prReview, drafts: result };
    renderSourceComments();
    renderFileReview();
}

// Clicking a line number starts a comment on that side of that line.
elements.source.addEventListener("click", (event) => {
    const number = event.target.closest?.(".line-number");
    const row = number?.closest(".code-row");
    if (!number || !row || !state.source || !isChangedPath(state.source.path)) return;
    const anchor = lineNumberAnchor(row, number);
    if (!anchor) return;
    if (prHeadMoved()) return;
    if (!commentableFor(state.source)[anchor.side].has(anchor.line)) {
        // Explain beside the line rather than with the page-wide error banner.
        state.commentNote = { path: state.source.path, ...anchor,
            message: state.prReview?.commentable
                ? `${sideLabel(anchor.side, anchor.line)} is outside the pull request's diff on GitHub, so GitHub cannot anchor a comment there. Comment on a changed or nearby line.`
                : `${sideLabel(anchor.side, anchor.line)} is outside the diff. Comment on a changed or nearby line.` };
        renderSourceComments();
        return;
    }
    openCommentEditor({ path: state.source.path, ...anchor });
});

function applySourceFocus(rows, focusStart, focusEnd, focusSide) {
    const focused = [];
    if (Number.isFinite(focusStart) && focusStart > 0) {
        for (const row of rows) {
            const oldLine = Number(row.dataset?.oldLine);
            const newLine = Number(row.dataset?.newLine);
            const line = state.sourceTab === "base"
                ? oldLine
                : state.sourceTab === "current"
                    ? newLine
                    : focusSide === "base" ? oldLine : newLine;
            if (Number.isFinite(line) && line >= focusStart && line <= focusEnd) {
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
    }
    return focused;
}

// Lines cited by a check (for example, repository rules) stay marked in whichever tab shows them.
function applyCitedHighlights(rows) {
    const ranges = state.source?.highlights || [];
    if (!ranges.length) return [];
    const key = state.sourceTab === "base" ? "oldLine" : "newLine";
    const marked = [];
    for (const row of rows) {
        const line = Number(row.dataset?.[key]);
        if (!Number.isFinite(line) || line < 1) continue;
        const range = ranges.find(([from, to]) => line >= from && line <= to);
        if (!range) continue;
        row.classList.add("cited-line");
        if (line === range[0]) row.classList.add("cited-start");
        if (line === range[1]) row.classList.add("cited-end");
        marked.push(row);
    }
    return marked;
}

// A clickable overview of where changes, cited lines, and the focused symbol sit in a long file.
function renderChangeRuler(rows) {
    const ruler = elements.source_ruler;
    ruler.replaceChildren();
    const kinds = [["cited-line", "cited", "Cited lines"], ["focus-line", "focus", "Selected code"],
        ["diff-add", "added", "Added lines"], ["diff-modified", "modified", "Changed lines"],
        ["diff-delete", "removed", "Removed lines"], ["gap-removed", "removed", "Removed lines"],
        ["gap-added", "added", "Lines added in Current"]];
    const segments = [];
    rows.forEach((row, index) => {
        const kind = kinds.find(([className]) => row.classList?.contains(className));
        if (!kind) return;
        const last = segments.at(-1);
        if (last && last.kind === kind[1] && last.end === index - 1) last.end = index;
        else segments.push({ kind: kind[1], label: kind[2], start: index, end: index });
    });
    const scrollable = elements.source.scrollHeight > elements.source.clientHeight + 1;
    ruler.classList.toggle("hidden", !segments.length || !scrollable || rows.length < 2);
    if (ruler.classList.contains("hidden")) return;
    ruler.style.setProperty("--scrollbar-width", `${elements.source.offsetWidth - elements.source.clientWidth}px`);
    for (const segment of segments.slice(0, 400)) {
        const mark = el("button", `ruler-mark ruler-${segment.kind}`);
        mark.type = "button";
        const first = rows[segment.start];
        const number = first.dataset?.newLine || first.dataset?.oldLine;
        mark.title = `${segment.label}${number ? ` at line ${number}` : ""}`;
        mark.setAttribute("aria-label", mark.title);
        mark.style.top = `${(segment.start / rows.length) * 100}%`;
        mark.style.height = `max(3px, ${((segment.end - segment.start + 1) / rows.length) * 100}%)`;
        mark.addEventListener("click", () => first.scrollIntoView({ block: "center" }));
        ruler.append(mark);
    }
}

function collectionTitle(mode) {
    if (mode === "areas") return state.areaGroup?.title || "Large change areas";
    return {
        impact: "Change impact", sections: "Review sections",
        walkthrough: "Attention",
        files: "Changed files", lines: "Lines changed by file", symbols: "Changed symbols",
        edges: "New relationships", packages: "Package changes", findings: "Ranked findings",
        decisions: "Code path changes",
    }[mode] || "Review details";
}

function openReviewPlanItem(item) {
    if (item.kind === "package") {
        const declaration = (item.package.declared_current?.length ? item.package.declared_current : item.package.declared_base || [])[0];
        if (!declaration?.source) {
            showError(new Error("This priority has no saved package declaration to review. Browse all changed files instead."));
            return;
        }
        rememberSourceReturnFocus();
        state.selected = { ...item.package, kind: "package" };
        setDiscussionMode(false);
        renderDetail(state.selected);
        openSourceReference({ path: declaration.source, lines: declaration.line ? [declaration.line] : [],
            side: item.package.change === "removed" ? "base" : "current", packageName: item.package.name },
        { focus: true, tab: "diff", nav: "reset" }).catch(showError);
        return;
    }
    if (item.kind === "callable" && item.preferred) {
        rememberSourceReturnFocus();
        openDecision(item.callable, item.preferred.entry, { focus: true });
        return;
    }
    selectItem(item.finding || item.node, false);
}

function renderReviewPlan(model, findings) {
    const query = state.query.toLowerCase();
    const allPlan = buildReviewPlan(model, state.payload?.decision_map, state.payload?.test_run, findings);
    const plan = allPlan
        .filter((item) => !query || `${item.title} ${item.path || ""} ${item.reasons.join(" ")}`.toLowerCase().includes(query));
    const progress = reviewProgress(allPlan, state.reviewLedger);
    const view = el("div", "collection-list review-plan");
    const intro = el("section", "review-plan-intro");
    const introCopy = el("div", "");
    introCopy.append(
        el("strong", "", "Attention"),
        el("p", "muted", "Changes that cross impact, churn, caller-reach, dependency or untested-behavior thresholds, shown in reading-path layer order and by priority within each layer. Review follows the layers; this is a lens, not a second order."),
    );
    if (progress.total) {
        introCopy.append(el("p", "review-progress",
            `${progress.completed.toLocaleString()} of ${countLabel(progress.total, "attention item")} covered by reviewed files or concern triage${
                progress.followUp ? ` · ${countLabel(progress.followUp, "item")} ${plural(progress.followUp, "needs", "need")} follow-up` : ""}${
                allPlan.omitted ? ` · ${countLabel(allPlan.omitted, "additional qualifying change")} omitted` : ""}`));
    }
    intro.append(introCopy);
    view.append(intro);
    if (!plan.length) {
        view.append(el("p", "collection-empty", query
            ? "No attention items match this filter."
            : "No changes crossed the attention thresholds. Use the reading path, Architecture, Files, or Code paths for exhaustive inspection."));
        elements.graph.replaceChildren(view);
        return;
    }
    const navigation = layeredNavigation();
    const buckets = new Map((navigation?.layers || []).map((layer) => [layer.id, []]));
    const unplaced = [];
    for (const item of plan) {
        const layer = item.path && layerOf(navigation, { path: item.path });
        (layer ? buckets.get(layer.id) : unplaced).push(item);
    }
    const sections = [...(navigation?.layers || []).map((layer) => [layer, buckets.get(layer.id)]), [null, unplaced]]
        .filter(([, items]) => items.length);
    const dispositionLabels = Object.fromEntries(REVIEW_DISPOSITIONS);
    for (const [layer, items] of sections) {
        if (sections.length > 1 || layer) {
            view.append(el("h3", "review-plan-layer", layer ? layerLabel(layer) : "Outside the reading path"));
        }
        for (const item of items.sort((a, b) => b.score - a.score)) {
            const record = state.reviewLedger.get(item.id);
            const disposition = effectiveDisposition(item, state.reviewLedger);
            const row = el("button", "review-plan-row");
            row.type = "button";
            row.dataset.reviewId = item.id;
            row.dataset.disposition = disposition;
            row.classList.toggle("is-reviewed", isReviewComplete(disposition));
            row.classList.toggle("needs-follow-up", disposition === "follow-up");
            const copy = el("span", "review-plan-copy");
            const heading = el("span", "review-plan-heading");
            heading.append(el("strong", "", item.title));
            const badges = el("span", "review-plan-badges");
            if (disposition !== "pending") badges.append(el("span", `review-disposition disposition-${disposition}`, dispositionLabels[disposition]));
            badges.append(el("b", "impact-score", `Static priority ${item.score}/100`));
            heading.append(badges);
            copy.append(heading);
            if (item.path) copy.append(el("span", "review-plan-path", `${item.path}${item.line ? `:${item.line}` : ""}`));
            if (record?.note) {
                const note = el("span", "review-plan-note", `${record.path}${record.line ? `:${record.line}` : ""} · ${record.note}`);
                copy.append(note);
            }
            const reasons = el("span", "review-plan-reasons");
            for (const reason of item.reasons) reasons.append(el("span", "", reason));
            copy.append(reasons);
            const proof = el("span", "review-plan-proof");
            if (item.evidence.untested) proof.append(el("span", "proof-untested", `${item.evidence.untested} untested`));
            if (item.evidence.inferred) proof.append(el("span", "proof-inferred", `${item.evidence.inferred} inferred`));
            if (item.evidence.confirmed) proof.append(el("span", "proof-confirmed", `${item.evidence.confirmed} confirmed`));
            if (proof.childElementCount) copy.append(proof);
            const chip = layer ? layerMarker(layer, "layer-chip") : el("span", "layer-chip", "–");
            chip.title = layer ? layerLabel(layer) : "Outside the reading path";
            row.append(chip, copy, el("span", "review-plan-open", "Open →"));
            row.addEventListener("click", () => openReviewPlanItem(item));
            view.append(row);
        }
    }
    elements.graph.replaceChildren(view);
}

function collectionItems(model, mode) {
    if (mode === "areas") {
        const nodes = new Map(model.nodes.map((node) => [node.id, node]));
        return (state.areaGroup?.members || []).map((finding, index) => ({
            ...nodes.get(finding.node_id),
            finding,
            area_number: index + 1,
        }));
    }
    if (mode === "files" || mode === "lines") {
        const files = model.changes.filter((item) => item.status !== "unchanged"
            && (mode !== "lines" || item.lines_added + item.lines_removed > 0));
        return files.sort((a, b) =>
            (b.lines_added + b.lines_removed) - (a.lines_added + a.lines_removed)
            || a.path.localeCompare(b.path)
        );
    }
    if (mode === "symbols") return model.nodes
        .filter((node) => isReviewSymbol(node) && node.change !== "unchanged")
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
    if (state.mode === "decisions") {
        renderDecisionView(model);
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
    if (state.mode === "areas") {
        list.append(el("p", "muted", "Each numbered entry matches one area in the queue. Nested areas can overlap; their line counts are not additive."));
    }
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
        if (state.mode === "areas") {
            title = `${item.area_number}. ${item.display_name || item.name || item.finding.title}`;
            subtitle = `${item.kind || "area"} · ${item.path || "Source unavailable"}${item.start_line ? `:${item.start_line}` : ""} · +${item.metrics?.lines_added || 0} / −${item.metrics?.lines_removed || 0}`;
            row.dataset.itemId = item.finding.id;
            row.dataset.nodeId = item.finding.node_id;
            row.addEventListener("click", () => selectItem(item.id ? item : item.finding, false));
        } else if (item.path && item.status) {
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
            subtitle = `${item.type} · ${countLabel(item.count || 1, "relationship")} · ${item.confidence}`;
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
        if (["files", "lines", "symbols", "areas"].includes(state.mode) && ["added", "modified", "removed", "deleted"].includes(statusLabel)) {
            row.append(el("span", `label label-${statusLabel === "deleted" ? "removed" : statusLabel} row-label`, statusLabel === "deleted" ? "removed" : statusLabel));
        }
        if (["files", "lines", "symbols", "areas"].includes(state.mode)) {
            const churn = item.lines_added != null
                ? item.lines_added + item.lines_removed
                : item.metrics?.lines_changed || 0;
            const kind = item.status || item.change;
            row.append(churnBar(churn / maxChurn, kind === "deleted" || kind === "removed" ? "removed" : kind === "added" ? "added" : "modified"));
            row.classList.add("has-bar");
        }
        list.append(row);
    }
    elements.graph.append(list);
}

function decisionMetric(map) {
    const totals = decisionTotals(map);
    let detail;
    if (!map) detail = "Unavailable for this review";
    else if (map.status === "loading") detail = "Extracting code paths…";
    else if (map.status === "error") detail = "Extraction failed";
    else if (!map.callables?.length) detail = "No changed production callables";
    else if (!totals.callables) detail = "No code path changes";
    else {
        const untested = map.verification ? evidenceCounts(map, state.payload?.test_run).untested : null;
        detail = [countLabel(totals.callables, "callable"),
            untested !== null ? `${untested} without test evidence`
                : totals.gates ? countLabel(totals.gates, "conditional gate") : null].filter(Boolean).join(" · ");
    }
    if (map?.status !== "complete") {
        const card = metric("Code paths", map?.status === "loading" ? "…" : "–", detail, "decisions");
        if (map?.status === "loading") card.classList.add("metric-pending");
        return card;
    }
    return deltaMetric("Code paths", totals.added, totals.removed, detail, "decisions", totals.changed + totals.moved);
}

function appendCodeText(container, text) {
    String(text).split(/(`[^`]+`)/).forEach((part) => {
        if (!part) return;
        container.append(part.startsWith("`") && part.endsWith("`") ? el("code", "", part.slice(1, -1)) : document.createTextNode(part));
    });
}

function decisionStatusLabel(status) {
    return el("span", `label label-${["changed", "moved"].includes(status) ? "modified" : status} decision-status`, status);
}

function decisionRow(callable, entry, open) {
    const decision = entry.decision;
    const row = el("button", `decision-row decision-${entry.status}`);
    row.type = "button";
    row.dataset.line = String(decision.line);
    row.title = `Open ${callable.path}:${decision.line}${entry.status === "removed" ? " in Base" : ""}`;
    const action = decisionAction(decision);
    const head = el("span", "decision-action");
    head.append(decisionStatusLabel(entry.status), el("strong", "", action.verb));
    if (action.code) head.append(el("code", "", action.code));
    if (action.via) head.append(el("span", "decision-via", "via"), el("code", "", action.via));
    head.append(el("span", "decision-line", `${entry.status === "removed" ? "Base " : ""}L${decision.line}`));
    row.append(head);
    const conditions = decisionConditions(decision);
    if (conditions.length) {
        const list = el("span", "decision-conditions");
        for (const part of conditions) {
            const item = el("span", `decision-condition tone-${part.tone}`);
            item.append(el("em", "", part.label));
            part.code.forEach((code, index) => {
                if (index) item.append(el("span", "decision-joiner", part.label === "when any of" ? "or" : "and"));
                item.append(el("code", "", code));
            });
            list.append(item);
        }
        row.append(list);
    }
    if (entry.status === "changed" && entry.base) {
        const before = el("span", "decision-note");
        before.append(el("em", "", "Before"));
        appendCodeText(before, ` ${decisionSentence(entry.base)} (L${entry.base.line})`);
        row.append(before);
    }
    if (entry.after || entry.before || entry.moved) {
        const order = el("span", "decision-note decision-order");
        order.append(el("em", "", "Order"));
        if (entry.moved) order.append(" Moved relative to other code paths.");
        if (entry.after) appendCodeText(order, ` After ${entry.after.label} (L${entry.after.line}).`);
        if (entry.before) appendCodeText(order, ` Before ${entry.before.label} (L${entry.before.line}).`);
        row.append(order);
    }
    const evidence = state.payload?.decision_map?.verification ? pathEvidence(callable, entry, state.payload?.test_run) : null;
    if (evidence) {
        const line = el("span", `decision-note decision-evidence evidence-${evidence.tone}`);
        line.append(el("em", "", "Tests"));
        appendCodeText(line, ` ${evidence.text}`);
        row.dataset.evidence = evidence.level;
        row.append(line);
    }
    row.addEventListener("click", () => open(callable, entry));
    return row;
}

function decisionCounts(item) {
    const counts = el("span", "decision-counts");
    for (const [status, symbol, className] of [["added", "+", "delta-add"], ["changed", "~", "delta-modified"],
        ["moved", "↕", "delta-modified"], ["removed", "−", "delta-remove"]]) {
        if (item.counts?.[status]) {
            const value = el("span", className, `${symbol}${item.counts[status]}`);
            value.title = status;
            counts.append(value);
        }
    }
    return counts;
}

async function openDecision(callable, entry, { select = true, focus = false } = {}) {
    const node = state.payload?.model?.nodes.find((candidate) => candidate.id === callable.id);
    if (select && node) {
        state.selected = node;
        markSelectedCards();
        renderDetail(node);
    }
    const epoch = ++state.selectionEpoch;
    const decision = entry.decision;
    const side = entry.status === "removed" ? "base" : "current";
    const query = `path=${encodeURIComponent(callable.path)}&line=${decision.line}&end=${decision.end_line || decision.line}&side=${side}`;
    try {
        const loaded = await loadSource(query, epoch, side, select ? "reset" : "push");
        if (loaded && state.selected) ensureAnnotation(state.selected, epoch);
        if (loaded && focus && epoch === state.selectionEpoch) elements.source.focus({ preventScroll: true });
    } catch (error) {
        if (epoch === state.selectionEpoch) showError(error);
    }
}

function renderDecisionView(model) {
    const map = state.payload?.decision_map;
    const view = el("div", "collection-list decision-view");
    view.append(el("p", "muted decision-note-intro",
        "Exits, error handling, and name-based wiring extracted statically from changed production callables. "
        + "“Only if” marks gates that apply only when a value is present. Static extraction does not prove runtime reachability."));
    elements.graph.replaceChildren(view);
    if (!map || map.status !== "complete") {
        if (map?.status === "loading") {
            view.append(aiPlaceholder("code-paths", "Extracting code paths and linking tests…", 4));
        } else if (map?.error) {
            const failure = el("section", "flash flash-danger code-path-error");
            failure.append(el("strong", "", "Code paths could not be analyzed"),
                el("p", "", "This is an analyzer failure, not a finding about your code. No code-path results were produced."));
            if (/Invalid command format|Did you mean:\s*copilot/.test(map.error)) {
                failure.append(el("p", "", "The provider used Copilot's executable instead of Node. Reload extensions and reopen this Canvas to use the installed runtime fix."));
            }
            const details = el("details", "");
            details.append(el("summary", "", "Technical details"), el("pre", "", map.error));
            failure.append(details);
            view.append(failure);
        } else {
            view.append(el("p", "collection-empty", "Code paths are unavailable for this review."));
        }
        return;
    }
    if (map.limited) view.append(el("p", "flash", "Large review: code path extraction covered a bounded set of files and callables."));
    if (map.warnings?.length) {
        const notes = el("details", "code-path-notes");
        const key = `${state.payload?.review_generation}:${map.total_ms}`;
        notes.open = state.codePathNotesOpenKey === key;
        notes.addEventListener("toggle", () => {
            if (notes.isConnected) state.codePathNotesOpenKey = notes.open ? key : null;
        });
        notes.append(el("summary", "", `${countLabel(map.warnings.length, "analysis note")} about these code paths`),
            el("p", "analysis-warning-intro", "These explain incomplete static analysis. They are not confirmed runtime failures."),
            analysisWarningList(map.warnings));
        view.append(notes);
    }
    if (map.verification) view.append(renderVerificationBar(map));
    const filter = map.verification ? state.evidenceFilter || "all" : "all";
    const run = state.payload?.test_run;
    const visibleEntries = (item) => filter === "all" ? item.entries || []
        : (item.entries || []).filter((entry) => EVIDENCE_GROUPS[filter].includes(pathEvidence(item, entry, run)?.level));
    const query = state.query.toLowerCase();
    const matches = (item) => !query || `${item.qualname} ${item.path} ${JSON.stringify(item.entries)}`.toLowerCase().includes(query);
    const changed = changedCallables(map).filter(matches).filter((item) => visibleEntries(item).length).sort((a, b) =>
        (b.entries?.length || 0) - (a.entries?.length || 0) || a.path.localeCompare(b.path) || (a.line || 0) - (b.line || 0));
    const quiet = filter !== "all" ? [] : (map.callables || []).filter((item) => !changed.includes(item) && !(item.entries?.length) && matches(item));
    if (!changed.length) {
        view.append(el("p", "collection-empty", filter !== "all" ? "No code paths match this evidence filter."
            : map.callables?.length
                ? "No code path changes: changed callables keep the same exits, error handling, and wiring."
                : "No changed production callables in supported languages in this review."));
    }
    for (const item of changed) {
        const group = el("section", "decision-group");
        const header = el("button", "decision-group-heading");
        header.type = "button";
        const title = el("span", "decision-group-title");
        title.append(el("strong", "", callableName(item)),
            el("small", "", `${item.path}:${item.line || item.base_line}`));
        header.append(title, decisionCounts(item), el("span", `label label-${item.change} row-label`, item.change));
        header.addEventListener("click", () => {
            const node = model.nodes.find((candidate) => candidate.id === item.id);
            if (node) selectItem(node);
        });
        group.append(header);
        const rows = el("div", "decision-rows");
        rows.append(...visibleEntries(item).map((entry) => decisionRow(item, entry, openDecision)));
        if (item.omitted_entries) rows.append(el("p", "muted decision-omitted",
            `${countLabel(item.omitted_entries, "more code path change")} not shown.`));
        if (item.truncated) rows.append(el("p", "muted decision-omitted", "Very large callable: only the first code paths were extracted."));
        group.append(rows);
        view.append(group);
    }
    if (quiet.length) {
        const same = quiet.filter((item) => item.change === "modified").length;
        const none = quiet.length - same;
        const details = el("details", "decision-unchanged");
        details.append(el("summary", "", [
            same ? `${countLabel(same, "modified callable")} ${plural(same, "keeps", "keep")} the same code paths` : null,
            none ? `${countLabel(none, "added or removed callable")} ${plural(none, "has", "have")} no exits, handlers, or wiring` : null,
        ].filter(Boolean).join(" · ")));
        const list = el("div", "decision-unchanged-list");
        for (const item of quiet) {
            const button = el("button", "link-button", callableName(item));
            button.type = "button";
            button.title = `${item.path}:${item.line || item.base_line}`;
            button.addEventListener("click", () => {
                const node = model.nodes.find((candidate) => candidate.id === item.id);
                if (node) selectItem(node);
            });
            list.append(button);
        }
        details.append(list);
        view.append(details);
    }
    if (map.verification?.tests?.length) view.append(renderLinkedTests(map));
}

function testPlanFor(generation) {
    if (state.testPlan?.generation === generation) return state.testPlan.plan;
    if (state.testPlan?.pending !== generation) {
        state.testPlan = { generation, pending: generation, plan: null };
        api("/api/test-run/plan").then((plan) => {
            if (state.testPlan?.generation !== generation) return;
            state.testPlan = { generation, plan };
            if (state.mode === "decisions") render();
            if (!elements.source_panel.classList.contains("hidden")) {
                state.sourceDecisionsKey = null;
                renderSourceDecisions();
            }
        }).catch((error) => {
            if (state.testPlan?.generation !== generation) return;
            state.testPlan = { generation, plan: { available: false, reason: error.message } };
            if (state.mode === "decisions") render();
            if (!elements.source_panel.classList.contains("hidden")) {
                state.sourceDecisionsKey = null;
                renderSourceDecisions();
            }
        });
    }
    return null;
}

function renderVerificationBar(map, { compact = false, callables = null } = {}) {
    const run = state.payload?.test_run;
    const counts = evidenceCounts(callables ? { callables } : map, run);
    const bar = el("section", `verification-bar${compact ? " source-verification" : ""}`);
    const total = counts.confirmed + counts.inferred + counts.untested;
    if (compact) {
        bar.append(el("p", "source-verification-summary", [
            counts.untested ? `${counts.untested} untested` : null,
            counts.inferred ? `${counts.inferred} inferred` : null,
            counts.confirmed ? `${counts.confirmed} confirmed` : null,
        ].filter(Boolean).join(" · ") || countLabel(total, "path")));
    } else {
        const filters = el("div", "verification-filters");
        filters.setAttribute("role", "group");
        filters.setAttribute("aria-label", "Filter code paths by test evidence");
        for (const [key, label, count] of [["all", "All", total], ["untested", "Untested", counts.untested],
            ["inferred", "Inferred", counts.inferred], ["confirmed", "Confirmed", counts.confirmed]]) {
            const button = el("button", `evidence-filter evidence-filter-${key}`);
            button.type = "button";
            button.append(el("span", "", label), el("b", "", String(count)));
            button.setAttribute("aria-pressed", String((state.evidenceFilter || "all") === key));
            button.addEventListener("click", () => {
                state.evidenceFilter = key;
                render();
            });
            filters.append(button);
        }
        bar.append(filters);
    }
    const runner = el("div", "verification-run");
    const payload = state.payload;
    const plan = testPlanFor([payload?.review_generation, Boolean(payload?.worktree_changed), Boolean(payload?.loading),
        payload?.decision_map?.status, payload?.decision_map?.total_ms].join(":"));
    const status = el("p", "verification-status");
    const button = el("button", "verification-run-button", run?.status === "running" ? "Running…" : "Run linked tests");
    button.type = "button";
    button.disabled = run?.status === "running" || !plan?.available;
    button.title = plan?.available ? `Runs ${countLabel(plan.tests.length, "linked test")}${["csharp", "rust"].includes(plan.adapter_id) ? " with test outcomes (no per-test path tracing)" : " with line tracing"}: ${plan.command}` : plan?.reason || "Checking linked tests…";
    button.addEventListener("click", async () => {
        button.disabled = true;
        try {
            await api("/api/test-run", { method: "POST", body: "{}" });
        } catch (error) {
            showError(error);
            button.disabled = false;
        }
    });
    runner.append(button);
    if (run?.status === "running") {
        const cancel = el("button", "link-button", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => api("/api/test-run/cancel", { method: "POST", body: "{}" }).catch(showError));
        runner.append(cancel);
        status.textContent = `Running ${countLabel(run.planned, "linked test")} in ${run.location || "the worktree"} with ${run.python}…`;
        status.classList.add("is-running");
    } else if (run?.status === "complete") {
        const parts = ["passed", "failed", "error", "skipped"].filter((key) => run.counts?.[key])
            .map((key) => key === "error" ? countLabel(run.counts[key], "error") : `${run.counts[key]} ${key}`);
        status.textContent = `${parts.join(" · ") || "No tests ran"} · ${run.path_evidence_limitation || "Confirmed paths use per-test line traces."}${run.stale ? " Stale: the worktree changed after this run." : ""}`;
        status.classList.toggle("is-stale", Boolean(run.stale));
        status.classList.toggle("has-failures", Boolean(run.counts?.failed || run.counts?.error));
    } else if (run?.status === "error") {
        status.textContent = run.error.split("\n")[0];
        status.classList.add("has-failures");
    } else if (run?.status === "cancelled") {
        status.textContent = "Test run cancelled.";
    } else {
        status.textContent = plan?.available
            ? `Runs ${countLabel(plan.tests.length, "linked test")} in ${plan.location} with ${plan.python} (${plan.python_source}). ${plan.prerequisites || "Executes repository code."}`
            : plan?.reason || "Checking linked tests…";
    }
    runner.append(status);
    if (run?.status === "running") runner.append(el("span", "run-progress"));
    if (plan?.command || run?.output) {
        const details = el("details", "verification-command");
        // Server updates re-render this view; keep the reader's open/closed choice.
        details.open = Boolean(state.verificationCommandOpen);
        details.addEventListener("toggle", () => { if (details.isConnected) state.verificationCommandOpen = details.open; });
        details.append(el("summary", "", run?.output ? "Command and output" : "Command"));
        details.append(el("pre", "", `${run?.command || plan.command}${run?.output ? `\n\n${run.output}` : ""}${run?.error ? `\n\n${run.error}` : ""}`));
        runner.append(details);
    }
    bar.append(runner);
    return bar;
}

function renderLinkedTests(map) {
    const run = state.payload?.test_run;
    const outcomeFor = (id) => run?.status === "complete" ? linkedTestOutcome(run, id) : undefined;
    const section = el("details", "linked-tests");
    section.open = state.linkedTestsOpen !== false;
    section.addEventListener("toggle", () => { if (section.isConnected) state.linkedTestsOpen = section.open; });
    const tests = map.verification.tests;
    section.append(el("summary", "", `${countLabel(tests.length, "Linked test")}${
        map.verification.omitted_tests ? ` shown of ${(tests.length + map.verification.omitted_tests).toLocaleString()}` : ""}`));
    const list = el("div", "linked-test-list");
    for (const test of tests) {
        const row = el("button", "linked-test");
        row.type = "button";
        const copy = el("span", "linked-test-copy");
        copy.append(el("strong", "", test.name), el("small", "", `${test.path}:${test.line} · ${
            test.link === "direct" ? "calls changed code" : test.link === "via" ? `via ${test.via}` : "name match only"} · ${test.callables.join(", ")}`));
        row.append(copy);
        if (test.changed) row.append(el("span", "label label-added", "changed"));
        const outcome = outcomeFor(test.id);
        if (outcome) row.append(el("span", `label test-outcome outcome-${outcome}`, outcome));
        row.addEventListener("click", async () => {
            const epoch = ++state.selectionEpoch;
            try { await loadSource(`path=${encodeURIComponent(test.path)}&line=${test.line}&side=current`, epoch, "current", "reset"); }
            catch (error) { if (epoch === state.selectionEpoch) showError(error); }
        });
        list.append(row);
    }
    section.append(list);
    return section;
}

function renderSourceRisk() {
    const panel = elements.source_risk;
    const model = state.payload?.model;
    const selected = state.selected;
    if (!model || !selected || !state.source) {
        panel.classList.add("hidden");
        state.sourceStripRisk = null;
        renderSourceStrip();
        return;
    }
    const findings = [
        ...groupFindings(model.attention || []),
        ...(state.payload?.generated_observations || []),
    ];
    const plan = buildReviewPlan(model, state.payload?.decision_map, state.payload?.test_run, findings);
    const selectedId = selected.package_id || selected.id;
    const subjectId = selected.node_id || selected.id;
    const item = plan.find((candidate) =>
        candidate.package?.id === selectedId
        || candidate.node?.id === subjectId
        || candidate.finding?.id === selectedId);
    if (!item || (item.path && item.path !== state.source.path && item.kind !== "package")) {
        panel.classList.add("hidden");
        state.sourceStripRisk = null;
        renderSourceStrip();
        return;
    }
    panel.replaceChildren();
    panel.classList.remove("hidden");
    const heading = el("div", "source-risk-heading");
    const score = el("b", "impact-score", `Static priority ${item.score}/100`);
    score.title = "Deterministic priority from impact, churn, caller reach and test evidence. It is separate from any AI risk assessment.";
    heading.append(el("strong", "", item.finding?.title || item.title), score);
    const explanation = item.finding?.reason || item.finding?.body;
    if (explanation) panel.append(heading, el("p", "source-risk-copy", explanation));
    else panel.append(heading);
    const reasons = el("div", "source-risk-reasons");
    for (const reason of item.reasons.filter((reason) => reason !== item.finding?.title)) {
        reasons.append(el("span", "", reason));
    }
    const record = state.reviewLedger.get(item.id);
    const controls = el("div", "source-review-controls");
    const dispositionLabel = el("label", "");
    dispositionLabel.append(document.createTextNode("Triage"));
    const disposition = el("select", "source-review-disposition");
    // Triage explains a concern; review progress itself is the whole-file decision.
    const current = record?.disposition || "pending";
    for (const [value, label] of [["pending", "Not triaged"], ["follow-up", "Needs follow-up"], ["accepted", "Accepted risk"],
        ["false-positive", "False positive"], ...(current === "reviewed" ? [["reviewed", "Reviewed (earlier record)"]] : [])]) {
        const option = el("option", "", label);
        option.value = value;
        option.selected = current === value;
        disposition.append(option);
    }
    dispositionLabel.append(disposition);
    const note = el("input", "source-review-note");
    note.type = "text";
    note.maxLength = 500;
    note.value = record?.note || "";
    note.placeholder = `Review note for ${state.source.path}:${state.source.start_line || item.line || 1}`;
    note.setAttribute("aria-label", "Review note");
    const save = el("button", "source-review-save", "Save triage");
    save.type = "button";
    const saveEntry = () => setReviewDisposition(item, disposition.value, note.value);
    save.addEventListener("click", saveEntry);
    note.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            saveEntry();
        }
    });
    controls.append(dispositionLabel, note, save);
    const priority = el("details", "priority-review-details");
    const triaged = current !== "pending" && current !== "reviewed";
    priority.append(el("summary", "", triaged
            ? `Concern triage: ${reviewStateLabel(current)}${record?.note ? ` — ${record.note}` : ""}`
            : "Triage this concern (optional): accepted risk, false positive or follow-up"),
        el("p", "muted", "Review progress comes from the whole-file decision below; triage records why a concern can be set aside."), controls);
    panel.append(reasons, priority);
    state.sourceStripRisk = { title: item.finding?.title || item.title, score: item.score,
        reason: item.reasons.find((reason) => reason !== item.finding?.title) || null, triage: triaged ? reviewStateLabel(current) : null };
    renderSourceStrip();
}

function renderMarkdownEvidence(panel) {
    const path = state.source.path;
    const facts = state.payload.model.instruction_documents;
    if (!facts?.current?.documents?.[path] && !facts?.base?.documents?.[path]) return false;
    const generation = state.payload.review_generation;
    const cached = state.documentRoleView;
    if (!cached || cached.generation !== generation) {
        state.documentRoleView = { generation, loading: true };
        api("/api/document-roles").then(({ roles }) => {
            if (state.payload.review_generation !== generation) return;
            state.documentRoleView = { generation, roles };
            if (state.source) renderReviewContext();
        }).catch((error) => {
            if (state.payload.review_generation !== generation) return;
            state.documentRoleView = { generation, error: error.message };
            if (state.source) renderReviewContext();
        });
    }
    const view = state.documentRoleView;
    if (view.loading) { panel.append(el("p", "muted", "Loading document classification…")); return true; }
    if (view.error) {
        const retry = el("button", "link-button", "Retry classification");
        retry.type = "button";
        retry.addEventListener("click", () => { state.documentRoleView = null; renderReviewContext(); });
        panel.append(el("p", "", `Unable to load document roles: ${view.error}`), retry);
        return true;
    }
    const side = state.sourceTab === "base" || !facts.current.documents[path] ? "base" : "current";
    const document = view.roles.documents[side][path];
    if (!document) { panel.append(el("p", "muted", `This document is absent from the ${side} snapshot.`)); return true; }
    const labels = { instructions: "Agent instructions", supporting: "Supporting reference", documentation: "Ordinary documentation", example: "Quoted / example material" };
    const section = el("section", "review-context-question markdown-evidence");
    section.append(el("h3", "", "Document role"),
        el("p", "", `${labels[document.role]} · ${side === "base" ? "Base" : "Current"} saved snapshot${
            document.overridden ? " · Reviewer correction" : document.inherited_correction ? " · From corrected reference path" : ""}`),
        el("p", "muted", `Analyzer: ${labels[document.original_role]}. ${document.classification.reason}`));
    const rationale = document.classification;
    section.append(sourceReferenceButton("Classification evidence", { path: rationale.path || path, lines: [rationale.line || 1], side }));
    const label = el("label", "", "Correct document role");
    const select = el("select", "");
    select.setAttribute("aria-label", "Correct document role");
    for (const [value, title] of Object.entries(labels)) {
        const option = el("option", "", title);
        option.value = value;
        select.append(option);
    }
    select.value = document.role;
    label.append(select);
    const save = el("button", "", "Save role"), reset = el("button", "link-button", "Reset to analyzer");
    save.type = reset.type = "button";
    reset.disabled = !document.overridden;
    const status = el("p", "muted", view.roles.durable ? "Corrections are saved for this review snapshot." : "Memory-only: this provider has no session workspace.");
    status.setAttribute("role", "status");
    const submit = async (role) => {
        save.disabled = reset.disabled = select.disabled = true;
        status.textContent = "Saving document role…";
        try {
            await api("/api/document-roles", { method: "POST", body: JSON.stringify({
                snapshot: view.roles.snapshot, revision: view.roles.revision, path, role,
            }) });
            state.payload = await api("/api/state");
            state.documentRoleView = null;
            render();
            await renderSource({ preserveScroll: true });
            if (state.selected) ensureAnnotation(state.selected);
        } catch (error) {
            status.textContent = `Unable to save: ${error.message}`;
            save.disabled = select.disabled = false;
            reset.disabled = !document.overridden;
        }
    };
    save.addEventListener("click", () => void submit(select.value));
    reset.addEventListener("click", () => void submit(null));
    section.append(label, save, reset, status);
    panel.append(section);
    const relationships = el("section", "review-context-question");
    relationships.append(el("h3", "", "How it reaches an agent"),
        el("p", "muted", "Deterministic source references, not proof that an agent received, read, or obeyed this document."));
    const edges = facts[side].relationships || [];
    const queue = [path], visited = new Set([path]), selected = new Set();
    let cycle = false;
    while (queue.length && visited.size <= 40) {
        const target = queue.shift();
        for (const edge of edges.filter((edge) => edge.path === target
            && (["instructions", "supporting"].includes(view.roles.documents[side][edge.from]?.role)
                || ["supplies_instructions", "packages"].includes(edge.kind)))) {
            if (selected.has(edge.id)) continue;
            selected.add(edge.id);
            const row = el("p", "");
            row.append(sourceReferenceButton(`${edge.from}:${edge.line}`, { path: edge.from, lines: [edge.line], side }),
                documentText(` ${edge.kind === "prescribes" ? "prescribes use of" : edge.kind} ${edge.path} (${edge.status})`));
            relationships.append(row);
            if (visited.has(edge.from)) { cycle = true; continue; }
            visited.add(edge.from);
            queue.push(edge.from);
        }
    }
    if (!selected.size) relationships.append(el("p", "", document.root
        ? "Recognized entry-point convention; no explicit supplying loader was established in this snapshot."
        : "No incoming consumption path is established in the saved snapshot."));
    if (cycle) relationships.append(el("p", "muted", "A reference cycle or converging path was encountered; no execution order is implied."));
    if (visited.size > 40) relationships.append(el("p", "muted", "Consumption-path display was limited to 40 documents."));
    const outgoing = edges.filter((edge) => edge.from === path);
    const referenceDetails = el("details", "markdown-references");
    referenceDetails.append(el("summary", "", `Local and external references (${outgoing.length})`));
    for (const edge of outgoing.slice(0, 40)) {
        const row = el("p", "");
        row.append(sourceReferenceButton(`Line ${edge.line}`, { path, lines: [edge.line], side }),
            documentText(` ${edge.kind}: ${edge.path || edge.target} — ${edge.status === "missing" ? "not found in saved snapshot" : edge.status}`));
        if (edge.status === "resolved") row.append(documentText(" "), sourceReferenceButton("Open saved target", { path: edge.path, lines: [], side }));
        referenceDetails.append(row);
    }
    if (outgoing.length > 40) referenceDetails.append(el("p", "muted", `${outgoing.length - 40} further references are omitted from this display.`));
    if (outgoing.length) relationships.append(referenceDetails);
    panel.append(relationships);
    const verification = el("section", "review-context-question");
    verification.append(el("h3", "", "Evidence and limits"),
        el("p", "", "Deterministic checks: document structure and local reference resolution."),
        el("p", "", "AI interpretation: explanations and semantic concerns are not execution guarantees."),
        el("p", "", "Observed agent behavior: unavailable. Repository tests and code coverage do not measure instruction compliance."),
        el("p", "muted", facts[side].precedence));
    for (const gap of facts[side].gaps || []) verification.append(el("p", "muted", `${gap.path || "Markdown analysis"}: ${gap.reason}`));
    panel.append(verification);
    return true;
}

function documentText(text) {
    return document.createTextNode(text);
}

function renderReviewContext() {
    const panel = elements.source_review_context;
    // Re-renders replace the verify controls; remember which one had keyboard focus so it can be restored.
    const held = panel.contains(document.activeElement) ? document.activeElement.dataset?.focusKey || null : null;
    panel.replaceChildren();
    panel.classList.toggle("hidden", !state.source);
    if (!state.source || !state.payload?.model) return;
    if (renderMarkdownEvidence(panel)) return;
    const annotation = state.payload.annotations?.[state.selected?.id];
    const context = reviewContext(state.payload.model, { path: state.source.path, selected: state.selected,
        decisionMap: state.payload.decision_map, run: state.payload.test_run, annotation });
    const section = (title, lines) => {
        const block = el("section", "review-context-question");
        block.append(el("h3", "", title));
        for (const line of lines) block.append(el("p", "", line));
        panel.append(block);
        return block;
    };
    if (!annotation?.body) section("What changed?", [context.change
        ? context.change.generated
            ? `${context.change.status} generated or minified file (built output): +${context.change.lines_added || 0} / -${context.change.lines_removed || 0} saved lines. It is not parsed for symbols; review the source that produces it instead.`
            : `${context.change.status} file: +${context.change.lines_added || 0} / -${context.change.lines_removed || 0} saved lines. Inspect the diff for behavior.`
        : "Related saved source, outside the changed-file scope."]);
    const consumers = context.impact.counts["Potential consumer"];
    const tests = context.impact.counts["Related test"];
    const affected = section("Who might be affected?", [consumers || tests
        ? `${consumers} potential consumer components and ${tests} related test components in the bounded, source-backed Impact view. Static relationships, not runtime proof.`
        : "No source-backed consumer relationship is established for this selection. That does not establish no impact."]);
    const impact = el("button", "link-button", "Inspect impact");
    impact.type = "button";
    impact.addEventListener("click", () => elements.source_impact.click());
    affected.append(impact);
    const verified = section("What was verified?", context.verification);
    const layer = currentReadingLayer();
    if (layer && (state.payload.model.changes || []).some((change) => change.path === state.source.path)) verified.prepend(verified.firstChild, layerVerifyBlock(layer));
    section("What remains open?", context.gaps.length ? context.gaps : ["No additional gaps were recorded for this selection; this is not a correctness guarantee."]);
    const wanted = state.layerVerifyFocus || held;
    if (wanted && (document.activeElement === document.body || panel.contains(document.activeElement))) {
        const target = [panel.querySelector(`[data-focus-key="${wanted}"]`), panel.querySelector('[data-focus-key="cancel"]'), panel.querySelector('[data-focus-key="run"]')]
            .find((node) => node && !node.disabled);
        if (target) {
            target.focus({ preventScroll: true });
            state.layerVerifyFocus = null;
        }
    }
}

function renderSourceDecisions() {
    renderReviewContext();
    renderTestTrace();
    const panel = elements.source_decisions;
    const map = state.payload?.decision_map;
    const model = state.payload?.model;
    const selected = state.selected;
    const subject = !selected ? null : selected.kind === "file" ? selected
        : model?.nodes.find((node) => node.id === (selected.node_id || selected.id)) || null;
    const callables = map?.status === "complete" ? callablesForSubject(map, model, subject) : [];
    const loading = map?.status === "loading" && languageForPath(subject?.path) && languageForPath(subject?.path).executable !== false
        && (isReviewSymbol(subject) || ["module", "file"].includes(subject.kind || subject.type));
    const run = state.payload?.test_run;
    const key = JSON.stringify([map?.status, map?.total_ms, subject?.id, subject?.path, state.source?.path,
        run?.status, run?.finished_at, run?.stale]);
    if (key === state.sourceDecisionsKey && panel.childElementCount) return;
    state.sourceDecisionsKey = key;
    panel.replaceChildren();
    if (!state.source || !subject || subject.path !== state.source.path || (!callables.length && !loading)) {
        panel.classList.add("hidden");
        return;
    }
    panel.classList.remove("hidden");
    const heading = el("div", "decisions-heading");
    heading.append(el("strong", "", "Code path changes"));
    const totals = { added: 0, changed: 0, moved: 0, removed: 0 };
    for (const item of callables) for (const status of Object.keys(totals)) totals[status] += item.counts?.[status] || 0;
    heading.append(decisionCounts({ counts: totals }));
    panel.append(heading);
    if (loading) {
        panel.append(aiPlaceholder("code-paths-pane", "Extracting code paths…", 2));
        return;
    }
    if (map.verification) panel.append(renderVerificationBar(map, { compact: true, callables }));
    for (const item of callables) {
        if (callables.length > 1) panel.append(el("p", "decisions-callable", callableName(item)));
        if (!item.entries?.length) {
            panel.append(el("p", "muted decisions-same", item.change === "modified"
                ? "Same exits, error handling, and wiring as the base." : "No exits, error handling, or wiring."));
            continue;
        }
        const rows = el("div", "decision-rows");
        rows.append(...item.entries.map((entry) => decisionRow(item, entry, (callable, value) => openDecision(callable, value, { select: false }))));
        if (item.omitted_entries) rows.append(el("p", "muted decision-omitted",
            `${countLabel(item.omitted_entries, "more code path change")} in the Code path changes view.`));
        panel.append(rows);
    }
}

function packageVersion(item) {
    const declarations = item.declared_current || [];
    const declared = declarations.map((entry) => entry.specifier).filter(Boolean).join(", ");
    return item.resolved_current || declared || "version unspecified";
}

function packageLockParents(item) {
    const parents = new Map();
    for (const declaration of [...(item.declared_current || []), ...(item.declared_base || [])]) {
        for (const parent of declaration.required_by || []) {
            const key = `${parent.name}\0${parent.version || ""}\0${parent.source || ""}\0${parent.line || ""}`;
            if (!parents.has(key)) parents.set(key, parent);
        }
    }
    return [...parents.values()];
}

function packageKey(item) {
    return `${item.ecosystem || "pypi"}:${item.name}@${packageVersion(item)}`;
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
        body: JSON.stringify({ name: item.name, ecosystem: item.ecosystem || "pypi", explain }),
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

function focusedControlKey(container) {
    const control = document.activeElement;
    if (!container.contains(control) || !control.matches("button, a, input, select, textarea")) return null;
    return {
        tag: control.tagName, id: control.id, title: control.getAttribute("title"),
        label: control.getAttribute("aria-label"), text: control.textContent,
        href: control.getAttribute("href"), packageId: control.dataset.package,
    };
}

function restoreControlFocus(container, key) {
    if (!key) return;
    const control = [...container.querySelectorAll("button, a, input, select, textarea")].find((candidate) =>
        candidate.tagName === key.tag && candidate.id === key.id && candidate.getAttribute("title") === key.title
        && candidate.getAttribute("aria-label") === key.label && candidate.textContent === key.text
        && candidate.getAttribute("href") === key.href && candidate.dataset.package === key.packageId);
    control?.focus({ preventScroll: true });
}

function renderPackageView(model) {
    const focused = focusedControlKey(elements.graph);
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
    list.append(el("p", "package-list-heading", countLabel(changes.length, "package change")));
    for (const item of changes) {
        const row = el("button", `package-row${state.selected?.id === item.id ? " is-selected" : ""}`);
        row.type = "button";
        row.dataset.package = item.id;
        const heading = el("div", "package-row-heading");
        heading.append(el("strong", "", item.name), el("span", `label label-${item.change}`, item.change));
        const usage = item.usage_locations?.length || 0;
        const lockedParents = packageLockParents(item);
        row.append(
            heading,
            el("small", "", `${item.ecosystem === "nuget" ? "NuGet · "
                : item.ecosystem === "gomod" ? "Go module · "
                    : item.ecosystem === "cargo" ? "Cargo · " : ""}${packageVersionText(item)}${
                item.change === "removed" ? "" : usage ? ` · used in ${countLabel(usage, "file")}`
                    : lockedParents.length ? ` · required by ${countLabel(lockedParents.length, "locked package")}`
                        : item.ecosystem === "nuget" ? " · usage unresolved" : " · no usages found"}`),
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
    restoreControlFocus(elements.graph, focused);
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
    const focused = focusedControlKey(host);
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
            item.ecosystem === "nuget" ? "NuGet"
                : item.ecosystem === "gomod" ? "Go module"
                    : item.ecosystem === "cargo" ? "Cargo" : null,
            `Version ${packageVersionText(item)}`,
            item.ecosystem ? `${item.ecosystem} ecosystem` : null,
            declared?.source ? `declared in ${declared.source}` : null,
            declared?.group ? `${declared.group} dependency` : null,
        ].filter(Boolean).join(" · ")),
    );
    const packageDescription = assessment?.indicators?.provenance?.summary;
    header.append(el("p", `package-description${packageDescription ? "" : " muted"}`,
        packageDescription || (entry.assessmentError
            ? "Package description unavailable because registry metadata could not be loaded."
            : assessment
                ? "No package description was provided by the public registry."
                : "Loading package description from the public registry…")));
    sections.push(header);
    const declaration = el("p", "package-declaration-note");
    declaration.append(document.createTextNode(`Reported because a dependency declaration was ${item.change} in `));
    if (declared?.source) declaration.append(sourceReferenceButton(declared.source, { path: declared.source, lines: [], packageName: item.name }));
    else declaration.append(document.createTextNode("the package manifest"));
    declaration.append(document.createTextNode(". Manifest changes are reviewed even when no static usage is resolved."));
    sections.push(declaration);
    if (["nuget", "gomod", "cargo"].includes(item.ecosystem)) {
        const declarations = el("ul", "usage-list");
        for (const entry of item.declared_current?.length ? item.declared_current : item.declared_base || []) {
            const row = el("li", "");
            row.append(el("code", "inline-code", entry.specifier || "unresolved version"), document.createTextNode(" in "),
                sourceReferenceButton(`${entry.source}:${entry.line}`, {
                    path: entry.source, lines: [entry.line], packageName: item.name,
                }));
            if (entry.version_source && entry.version_source !== entry.source) {
                row.append(document.createTextNode(" · version from "), sourceReferenceButton(
                    `${entry.version_source}:${entry.version_line}`, {
                        path: entry.version_source, lines: [entry.version_line],
                    }));
            }
            if (entry.replace_source) {
                row.append(document.createTextNode(` · replaced by ${entry.replacement || "unresolved target"} at `),
                    sourceReferenceButton(`${entry.replace_source}:${entry.replace_line}`, {
                        path: entry.replace_source, lines: [entry.replace_line],
                    }));
            }
            if (entry.sum_source) {
                row.append(document.createTextNode(" · checksum evidence at "),
                    sourceReferenceButton(`${entry.sum_source}:${entry.sum_line}`, {
                        path: entry.sum_source, lines: [entry.sum_line],
                    }));
            } else if (item.ecosystem === "gomod" && entry.resolved_version) {
                row.append(el("small", "muted", " · no matching saved go.sum checksum"));
            }
            if (entry.lock_source && entry.lock_line) {
                row.append(document.createTextNode(" · exact version from "), sourceReferenceButton(
                    `${entry.lock_source}:${entry.lock_line}`, {
                        path: entry.lock_source, lines: [entry.lock_line],
                    }), entry.lock_package_source
                    ? document.createTextNode(` · ${entry.lock_package_source}`) : document.createTextNode(""));
            }
            if (entry.resolution_error) row.append(el("small", "muted", ` · ${entry.resolution_error}`));
            declarations.append(row);
        }
        sections.push(packageSection(item.ecosystem === "gomod" ? "Saved Go module declarations"
            : item.ecosystem === "cargo" ? "Saved Cargo declarations" : "Saved project declarations", declarations));
    }

    if (item.change === "removed") {
        sections.push(el("p", "flash flash-attention", "This dependency was removed. Check that nothing in the repository still imports it."));
        host.replaceChildren(...sections);
        restoreControlFocus(host, focused);
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
        sections.push(el("p", "flash flash-neutral", item.ecosystem === "npm"
            ? "Checking npm registry metadata and OSV advisories…"
            : item.ecosystem === "nuget" ? "Checking NuGet metadata and OSV for the saved project version…"
                : item.ecosystem === "gomod" ? "Checking Go proxy metadata and OSV for the saved module version…"
                : item.ecosystem === "cargo" ? "Checking crates.io metadata and OSV for the exact saved Cargo.lock version…"
                : "Checking PyPI, OSV, OpenSSF Scorecard, and download statistics…"));
    }

    // Copilot explanation
    const why = el("div", "annotation-body");
    if (entry.explanation) {
        revealOnce(why, "package-explanation");
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
        why.append(aiPlaceholder("package-explanation", "Copilot is explaining why this package was added and what uses it…", 4));
    }
    const whyHeading = el("div", "package-section-heading");
    whyHeading.append(el("h3", "", "Copilot assessment"));
    if (entry.explanation) whyHeading.append(copyButton(entry.explanation, "Copy assessment"));
    const whySection = el("section", "package-section");
    whySection.append(whyHeading, why);
    sections.push(whySection);

    // Usage
    const usage = item.usage_locations || [];
    const lockedParents = packageLockParents(item);
    if (lockedParents.length) {
        const parentList = el("ul", "usage-list");
        for (const parent of lockedParents) {
            const row = el("li", "");
            row.append(el("strong", "", parent.name),
                document.createTextNode(`${parent.version ? `@${parent.version}` : ""} requires ${item.name} ${parent.specifier || ""}`));
            if (parent.source && parent.line) {
                row.append(document.createTextNode(" · "), sourceReferenceButton(
                    `${parent.source}:${parent.line}`,
                    { path: parent.source, lines: [parent.line], packageName: item.name },
                ));
            }
            parentList.append(row);
        }
        sections.push(packageSection(`${plural(lockedParents.length, "Locked dependency parent")} (${lockedParents.length.toLocaleString()})`, parentList));
    }
    const usageList = el("ul", "usage-list");
    for (const location of usage) {
        const reference = parseSourceReference(location);
        const row = el("li", "");
        row.append(reference ? sourceReferenceButton(location, reference) : el("code", "inline-code", location));
        usageList.append(row);
    }
    sections.push(packageSection(
        `${plural(usage.length, "Static usage location")} (${usage.length.toLocaleString()})`,
        usage.length ? usageList : el("p", "flash flash-attention", item.ecosystem === "nuget"
            ? "NuGet-to-assembly usage is unresolved. Namespace spelling does not prove package usage. Review the saved manifest and implementation."
            : lockedParents.length
                ? "No direct source import is expected for this transitive package. Its observed usage is the saved lockfile dependency chain above."
                : "No static import was mapped to this declaration. This is a manifest change, not an observed import. Verify why the dependency is needed: it may support tooling, dynamic loading, use a different import name, or be unused."),
    ));

    if (assessment) {
        const indicators = assessment.indicators || {};
        const maintenance = indicators.maintenance || {};
        const vulns = indicators.known_vulnerabilities || [];
        const score = indicators.scorecard_score;
        const links = packageEvidenceLinks(item.name, assessment.version, indicators.repository_url, item.ecosystem || "pypi");
        const tiles = el("div", "stat-grid");
        tiles.append(
            statTile("Known vulnerabilities", formatCount(indicators.vulnerability_count),
                assessment.version ? `Affects reviewed version ${assessment.version}`
                    : "Not assessed: the exact project version is unknown.",
                indicators.vulnerability_count > 0 ? "danger" : indicators.vulnerability_count === 0 ? "success" : "", links.vulnerabilities),
            statTile("Advisory history", formatCount(indicators.vulnerability_history_count),
                "Across all versions; not necessarily this release.", "", links.vulnerabilities),
            statTile("OpenSSF Scorecard", score != null ? `${score}/10` : null, score != null ? null : "No scorecard published",
                score == null ? "" : score >= 7 ? "success" : score >= 4 ? "attention" : "danger", links.scorecard),
            statTile("Maintenance", maintenance.status ? maintenance.status : null,
                `${countLabel(maintenance.releases_last_12_months ?? 0, "release")} in 12 months${maintenance.latest_release_date ? ` · latest ${formatDate(maintenance.latest_release_date)}` : ""}`,
                maintenance.status === "active" ? "success" : maintenance.status === "stale" ? "attention" : maintenance.status === "dormant" ? "danger" : "", links.maintenance),
            statTile("Downloads (last month)", formatCount(indicators.recent_downloads),
                indicators.recent_downloads == null ? assessment.sources?.pypistats?.error || "Download data unavailable." : "Across all package versions.",
                "", links.downloads),
            statTile("Reviewed version", assessment.version,
                `${assessment.version ? indicators.release_age_days != null ? `${countLabel(indicators.release_age_days, "day")} old` : "age unknown"
                    : "Declared as a range; no exact version in this snapshot."}${indicators.latest_version ? ` · latest ${indicators.latest_version}` : ""}${indicators.yanked ? " · YANKED" : ""}`,
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
                definitionRow("Registry", (provenance.registry_url || provenance.pypi_url)
                    ? externalLink((provenance.registry_url || provenance.pypi_url).replace(/^https:\/\//, ""), provenance.registry_url || provenance.pypi_url) : null),
                definitionRow("Homepage", provenance.homepage ? externalLink(provenance.homepage.replace(/^https?:\/\//, ""), provenance.homepage) : null),
                definitionRow("Other links", links),
                definitionRow("First release", formatDate(provenance.first_release_date)),
                definitionRow("Releases", provenance.release_count ? String(provenance.release_count) : null),
                definitionRow("Requires Python", provenance.requires_python),
            ]) if (row) list.append(row);
            sections.push(packageSection("Provenance", list));
        }
        const statuses = el("ul", "source-status evidence-sources");
        const sourceUrls = { pypi: links.registry, npm: links.registry, nuget: links.registry,
            npm_downloads: links.downloads, proxy: links.registry, crates_io: links.registry,
            osv: links.vulnerabilities, osv_history: links.vulnerabilities,
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
    restoreControlFocus(host, focused);
}
function isEmptyReview(payload) {
    return Boolean(payload?.model && !payload.loading && !payload.error && !payload.cancelled
        && !(payload.model.changes || []).some((change) => change.status !== "unchanged"));
}

function renderCustomAnalyses() {
    elements.custom_analyses.classList.toggle("hidden", !state.payload?.model || state.reviewPickerPending
        || state.reviewSubmitting || isEmptyReview(state.payload));
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
        appendInternalReview(details, result, `custom:${key}`, () => runCustomAnalyses({ scope: prompt.scope, id: prompt.id, force: false }));
        if (result?.status === "running" && !result.coverage) {
            details.append(aiPlaceholder(`custom:${key}`, "Copilot is running this check...", 3));
        }
        if (result?.content) {
            markdownContext.subject = null;
            markdownContext.intent = null;
            const body = revealOnce(el("div", "annotation-body"), `custom:${key}`);
            if (result.coverage) renderInternalReviewBody(body, result);
            else renderMarkdown(body, result.content);
            details.append(body);
        } else if (result?.status === "queued") {
            details.append(aiPlaceholder(`custom:${key}`, "Waiting for the previous check...", 3));
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
    const repo = state.payload?.repo_root;
    try {
        const prompts = (await api("/api/custom-prompts")).prompts;
        if (repo !== state.payload?.repo_root) return;
        state.customPrompts = prompts;
        state.customLibraryError = null;
        promptManagerError(null);
        renderPromptLibrary();
        renderCustomAnalyses();
    } catch (error) {
        if (repo !== state.payload?.repo_root) return;
        if (error.code === "connection_lost") return;
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

// Async data (sections, AI layer intents, progress) re-renders lists; keep keyboard focus on the same item instead of dropping it to <body>.
function captureListFocus() {
    const active = document.activeElement;
    const container = active && active !== document.body
        && active.closest("#graph, #review-finish, #overview-layers, #review-navigation");
    if (!container) return () => {};
    const selector = active.dataset.reviewId ? `[data-review-id="${CSS.escape(active.dataset.reviewId)}"]` : null;
    const { tagName, className } = active;
    const text = active.textContent;
    return () => {
        if (active.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
        const match = (selector && container.querySelector(selector))
            || [...container.querySelectorAll(tagName)].find((item) => item.className === className && item.textContent === text);
        match?.focus({ preventScroll: true });
    };
}

function render() {
    const restoreFocus = captureListFocus();
    try { renderView(); } finally { restoreFocus(); }
}

function renderView() {
    const targetMode = state.payload?.review_target?.mode || "none";
    elements.review_target_label.textContent = state.payload?.review_target?.label || "Choose review target";
    const targetKey = JSON.stringify(state.payload?.review_target || {});
    if (state.reviewTargetKey !== targetKey) {
        state.reviewTargetKey = targetKey;
        const target = state.payload?.review_target;
        state.reviewPickerPending = targetMode === "none";
        const selectedRef = target?.currentRef && target.mode === "commit" ? target.currentRef : target?.ref;
        const pickerMatches = targetMode !== "none" && elements.review_mode.value === target?.mode
            && [...elements.review_ref.options].some((option) => option.value === selectedRef);
        elements.review_mode.value = targetMode === "none" ? "" : targetMode;
        if (targetMode === "none") {
            elements.review_ref.classList.add("hidden");
            elements.review_list_refresh.classList.add("hidden");
            elements.review_more.classList.add("hidden");
        } else if (pickerMatches) elements.review_ref.value = selectedRef;
        else loadReviewOptions({ selectedRef });
        resetReviewNavigation();
    }
    const payload = state.payload;
    const model = payload?.model;
    elements.review_command_open.disabled = !model || Boolean(payload.loading);
    elements.impact_view.disabled = !model || Boolean(payload.loading);
    elements.sections_view.disabled = !model || Boolean(payload.loading);
    const worktreeNotice = !state.reviewPickerPending && !state.reviewSubmitting && !payload?.loading
        && payload?.review_target?.mode === "worktree" && (payload.worktree_changed || payload.worktree_check_error);
    // Freshness is one header chip; its explanation is disclosed on demand and the header Reanalyze is the single action.
    elements.worktree_notice.classList.toggle("hidden", !worktreeNotice || !state.freshnessOpen);
    elements.worktree_notice_text.textContent = payload?.worktree_check_error
        || "Worktree changed since this review. Reanalyze from the Overview header to include the latest edits.";
    elements.status.setAttribute("aria-disabled", String(!worktreeNotice));
    elements.status.setAttribute("aria-expanded", String(Boolean(worktreeNotice && state.freshnessOpen)));
    // The header is hidden while reading code; the workflow row repeats only the stale state so it is never invisible.
    elements.workspace_freshness.classList.toggle("hidden", !worktreeNotice);
    elements.workspace_freshness.textContent = payload?.worktree_changed ? "Worktree changed" : "Freshness unknown";
    elements.workspace_freshness.setAttribute("aria-expanded", String(Boolean(worktreeNotice && state.freshnessOpen)));
    elements.refresh.classList.toggle("needs-attention", Boolean(worktreeNotice));
    elements.repository_identity.textContent = model?.metadata?.repo_root
        ? `${model.metadata.repo_root} · ${state.reviewPickerPending ? "Choose a comparison" : `Base ${model.metadata.base_sha?.slice(0, 8) || "empty tree"}`}` : payload?.repo_root || "";
    elements.change_repository.disabled = Boolean(payload?.loading || state.repositorySubmitting || state.connectionLost);
    const progress = payload?.progress;
    elements.status.textContent = payload?.loading ? `Analyzing ${progress?.percent || 0}%`
        : payload?.cancelled ? "Analysis cancelled" : model ? payload.restored_from_cache ? "Saved review" : "Analysis current"
            : targetMode === "none" ? "Choose review" : "Waiting";
    elements.status.title = payload?.loading ? progress?.message || "Analyzing repository"
        : payload?.analyzed_at ? `Analyzed ${new Date(payload.analyzed_at).toLocaleString()}${payload.restored_from_cache ? ". Reanalyze to update." : ""}` : "";
    elements.status.classList.toggle("working", Boolean(payload?.loading));
    elements.status.classList.toggle("stale", Boolean(worktreeNotice));
    if (worktreeNotice) elements.status.textContent = payload.worktree_changed ? "Worktree changed" : "Freshness unknown";
    elements.refresh.disabled = Boolean(payload?.loading || state.reviewPickerPending || state.connectionLost);
    elements.cancel_analysis.classList.toggle("hidden", !payload?.loading);
    elements.cancel_analysis.disabled = Boolean(state.cancelling);
    elements.cancel_analysis.textContent = state.cancelling ? "Cancelling…" : "Cancel";
    elements.analysis_cancelled.classList.toggle("hidden", !payload?.cancelled);
    updateReviewApply();
    // Background re-renders must not erase a client-side warning; it stays until the user opens other source or the review changes.
    const clientError = state.clientError?.generation === payload?.review_generation ? state.clientError.message : null;
    elements.error.classList.toggle("hidden", !payload?.error && !clientError);
    elements.error.textContent = payload?.error || clientError || "";
    elements.analysis_progress.classList.toggle("hidden", !payload?.loading || state.connectionLost);
    if (payload?.loading) {
        const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
        elements.progress_phase.textContent = String(progress?.phase || "starting").replaceAll("_", " ").toUpperCase();
        elements.progress_message.textContent = progress?.message || "Analyzing repository";
        elements.progress_percent.textContent = `${percent}%`;
        elements.progress_bar.style.width = `${percent}%`;
        elements.analysis_progress.querySelector(".progress-track").setAttribute("aria-valuenow", String(percent));
    }
    renderReviewPickerNotice();
    renderWorkspaceShell();
    renderConnectionNotice();
    renderCustomAnalyses();
    const clean = !state.reviewPickerPending && !state.reviewSubmitting && isEmptyReview(payload);
    elements.clean_review.classList.toggle("hidden", !clean);
    if (clean) {
        if (!worktreeNotice && !state.connectionLost) elements.status.textContent = "No changes";
        elements.clean_review.querySelector("h2").textContent = worktreeNotice || state.connectionLost
            ? "Previous snapshot had no changes" : "No changes to review";
        elements.clean_review.querySelector("p").textContent = worktreeNotice
            ? "Reanalyze to check the latest worktree. This saved snapshot does not include later edits."
            : state.connectionLost ? "This is the last saved result; it cannot confirm the current worktree while disconnected."
                : "The selected snapshot has no reviewable changes against its baseline.";
        for (const element of [elements.review_overview, elements.review_background, elements.change_brief, elements.custom_analyses, elements.summary,
            elements.breadcrumbs, document.querySelector(".workspace"), elements.source_panel, elements.session_history_panel]) {
            element.classList.add("hidden");
        }
        return;
    }
    if (state.reviewPickerPending || state.reviewSubmitting || (payload?.loading && !model)) return;
    if (!model) {
        renderChangeBrief();
        return;
    }
    loadClosedFindingKeys(model);
    loadReviewLedger(model);
    ensurePrReview();
    if (state.queueError) showError(new Error(state.queueError));
    if (state.reviewLedgerError) showError(new Error(state.reviewLedgerError));
    if (!state.connectionLost && !payload.loading && !payload.cancelled) {
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
    renderFinishReview();
    renderSummary(model);
    renderBreadcrumbs();
    const groupedObservations = [
        ...groupFindings(model.attention || []),
        ...(payload.generated_observations || []),
    ].sort((a, b) => (concernPriority(b) ?? 0) - (concernPriority(a) ?? 0));
    const active = groupedObservations.filter((item) => !concernClosed(item));
    const closed = groupedObservations.filter((item) => concernClosed(item));
    elements.attention_count.textContent = String(active.length);
    elements.attention_count.title = `${countLabel(active.length, "active finding")} · ${countLabel(closed.length, "closed finding")}`;
    renderCards(elements.attention, [
        ...collapseSizeFindings(active, model),
        ...collapseSizeFindings(closed, model),
    ], "No rule-based findings. Checks focus on Python; this is not a guarantee of correctness.");
    renderCards(elements.packages, model.package_changes || [], "No package changes.");
    const hasPackageChanges = (model.package_changes || []).length > 0;
    elements.packages.classList.toggle("hidden", !hasPackageChanges);
    elements.packages.previousElementSibling?.classList.toggle("hidden", !hasPackageChanges);

    const parent = state.stack.at(-1);
    const workspace = document.querySelector(".workspace");
    workspace.classList.toggle("package-mode", state.mode === "packages");
    workspace.classList.toggle("walkthrough-mode", state.mode === "walkthrough");
    workspace.classList.toggle("impact-mode", state.mode === "impact");
    workspace.classList.toggle("sections-mode", state.mode === "sections");
    elements.zoom_out.disabled = state.mode === "graph" && state.stack.length === 0;
    elements.zoom_out.title = state.mode !== "graph" ? "Back to architecture" : parent ? `Back from ${parent.name}` : "Already at architecture level";
    elements.zoom_out.textContent = state.mode === "walkthrough" ? "Architecture" : "← Back";
    elements.impact_view.setAttribute("aria-pressed", String(state.mode === "impact"));
    elements.impact_view.textContent = state.mode === "impact" ? "Structure" : "Impact";
    elements.sections_view.setAttribute("aria-pressed", String(state.mode === "sections"));
    elements.sections_view.textContent = state.mode === "sections" ? "Attention" : "Sections";
    renderWorkspaceNavigation();
    renderWorkspaceShell();
    if (state.reviewPage === "review" && state.exploring && state.mode === "findings") {
        elements.level_label.textContent = "CONCERNS";
        elements.graph_title.textContent = "All review concerns";
        elements.graph.replaceChildren(elements.attention);
    } else if (state.reviewPage === "review" && !state.exploring && !state.source) {
        elements.graph.replaceChildren(el("div", "workspace-empty"));
        const empty = elements.graph.firstChild;
        empty.append(el("h2", "", "Choose a group or file to continue"),
            el("p", "muted", "Changed code stays in the center; context and discussion stay beside it. Impact is available without leaving this review."));
        if (state.workspaceReturn) {
            const reopen = el("button", "review-next", "Return to code");
            reopen.type = "button";
            reopen.addEventListener("click", () => returnWorkspaceSource().catch(showError));
            empty.append(reopen);
        }
    } else if (state.mode === "sections") {
        elements.level_label.textContent = "GROUPED REVIEW";
        elements.graph_title.textContent = "Source-backed review sections";
        renderSections(model);
    } else if (state.mode === "impact") {
        elements.level_label.textContent = "CHANGE IMPACT";
        elements.graph_title.textContent = "Evidence-backed impact";
        renderImpact(model);
    } else if (state.mode === "walkthrough") {
        elements.level_label.textContent = "EXPLORE";
        elements.graph_title.textContent = "Attention";
        renderReviewPlan(model, groupedObservations);
    } else if (state.mode === "graph") {
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
    applyServerSelection(payload);
    if (state.selected && payload.annotations?.[state.selected.id]) {
        renderAnnotation(state.selected, payload.annotations[state.selected.id]);
    }
    if (state.source && !elements.source_panel.classList.contains("hidden")) renderSourceDecisions();
    if (state.source && state.selected?.kind === "section" && !payload.annotations?.[state.selected.id]) renderSectionEvidence();
    if (!state.selected) renderEmptyDetail();
    applyReviewLocation().catch(showError);
}

function applyServerSelection(payload) {
    const model = payload.model;
    if (model && payload.selection?.id && payload.selection.id !== state.appliedServerSelection && state.selected?.id !== payload.selection.id) {
        state.appliedServerSelection = payload.selection.id;
        const all = [...model.nodes, ...model.edges, ...(model.package_changes || []), ...(model.attention || []), ...(payload.generated_observations || [])];
        const selected = all.find((item) => item.id === payload.selection.id) || { id: payload.selection.id, kind: "evidence" };
        state.selected = selected;
        renderDetail(selected);
    }
}

function showError(error) {
    if (error.code === "connection_lost") {
        markDisconnected();
        return;
    }
    elements.error.textContent = error.message;
    elements.error.classList.remove("hidden");
    state.clientError = { message: error.message, generation: state.payload?.review_generation };
    renderWorkspaceShell();
}

async function reanalyze() {
    try {
        await api("/api/refresh", { method: "POST" });
    } catch (error) {
        if (!state.cancelling && !state.payload?.cancelled) showError(error);
    }
}
elements.refresh.addEventListener("click", reanalyze);
for (const button of elements.diff_layout.querySelectorAll("button")) {
    button.addEventListener("click", () => setDiffLayout(button.dataset.layout));
}
// Crossing the split threshold re-renders the diff in the layout that fits.
{
    let wide = innerWidth >= SPLIT_DIFF_MIN_WIDTH;
    window.addEventListener("resize", () => {
        const now = innerWidth >= SPLIT_DIFF_MIN_WIDTH;
        if (now === wide) return;
        wide = now;
        if (state.source && state.sourceTab === "diff" && diffLayoutPreference() === "split"
            && !elements.source_panel.classList.contains("hidden")) setDiffLayout("split");
        else renderDiffLayoutControl();
    });
}
elements.source_strip_toggle.addEventListener("click", () => {
    state.sourceStripOpen = !state.sourceStripOpen;
    renderSourceStrip();
});
elements.status.addEventListener("click", () => {
    if (elements.status.getAttribute("aria-disabled") === "true") return;
    state.freshnessOpen = !state.freshnessOpen;
    render();
});
elements.workspace_freshness.addEventListener("click", () => {
    state.freshnessOpen = !state.freshnessOpen;
    render();
});
// Reanalyze lives once, in the Overview header; from Review the notice leads there instead of duplicating it.
elements.worktree_overview.addEventListener("click", () => {
    elements.workflow_overview.click();
    elements.refresh.focus({ preventScroll: true });
});
elements.cancel_analysis.addEventListener("click", async () => {
    state.cancelling = true;
    render();
    try {
        state.payload = await api("/api/cancel", { method: "POST" });
    } catch (error) {
        showError(error);
    } finally {
        state.cancelling = false;
        render();
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
    if (event.key === "Escape" && state.navigationOpen && matchMedia("(max-width: 900px)").matches
        && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        state.navigationOpen = false;
        renderWorkspaceShell();
        elements.workspace_nav_toggle.focus({ preventScroll: true });
        return;
    }
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "Escape" && state.sourceFocused) {
        event.preventDefault();
        setSourceFocus(false);
        elements.source_focus.focus({ preventScroll: true });
        return;
    }
    if (event.key === "Escape" && !elements.session_history_panel.classList.contains("hidden")) {
        elements.session_history_close.click();
        return;
    }
    if (event.key === "Escape" && !elements.source_panel.classList.contains("hidden")) {
        // Over an Explore lens the source is an overlay, so Esc returns to the lens. In Review, Esc never leaves the file:
        // it clears the highlighted range, and Close × remains the way to close it.
        if (state.reviewPage !== "review" || state.exploring) {
            elements.source_close.click();
            return;
        }
        if (event.target.closest?.("input, textarea, select")) return;
        event.preventDefault();
        const marked = elements.source.querySelectorAll(".focus-line, .cited-line");
        for (const row of marked) row.classList.remove("focus-line", "focus-start", "focus-end", "cited-line", "cited-start", "cited-end");
        if (state.source) state.source.highlights = null;
        if (!elements.source_panel.contains(document.activeElement)) elements.source.focus({ preventScroll: true });
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
        return;
    }
    if (event.isComposing || event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openReviewCommands();
        return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const inReview = state.reviewPage === "review" && (document.activeElement === document.body
        || document.activeElement.closest?.(".workspace, #source-panel, #review-navigation, #review-workflow"));
    if (!inReview) return;
    const key = event.key.toLowerCase();
    if (key === "j" || key === "k") {
        event.preventDefault();
        if (state.reviewPage === "review" && !state.exploring && state.workspaceNavigation) {
            const groupsById = new Map(state.workspaceNavigation.groups.map((group) => [group.id, group]));
            const sequence = reviewSequence(state.workspaceNavigation, state.navigationMode)
                .map((entry) => ({ file: entry.file, group: entry.group ? groupsById.get(entry.group) : null }));
            const cursor = state.navigationCursor || { path: (state.source || state.workspaceReturn?.source)?.path, group: state.activeReviewGroup };
            let current = sequence.findIndex((entry) => entry.file.path === cursor.path
                && (!entry.group || entry.group.id === cursor.group));
            // The cursor may name a provisional group recorded before review groups finished loading.
            if (current < 0) current = sequence.findIndex((entry) => entry.file.path === cursor.path);
            if (current < 0) current = key === "j" ? -1 : 0;
            const next = sequence[(current + (key === "j" ? 1 : sequence.length - 1) + sequence.length) % sequence.length];
            if (next) openWorkspaceFile(next.file, next.group).catch(showError);
            return;
        }
        if (state.mode === "sections" && elements.source_panel.classList.contains("hidden")) {
            const summaries = [...elements.graph.querySelectorAll(".section-card > summary")];
            const current = summaries.indexOf(document.activeElement.closest("summary"));
            const next = summaries[(current + (key === "j" ? 1 : summaries.length - 1) + summaries.length) % summaries.length];
            if (next) {
                next.parentElement.open = true;
                next.scrollIntoView({ block: "nearest" });
                next.focus({ preventScroll: true });
            }
        } else {
            const cards = [...elements.attention.querySelectorAll(".review-card")];
            let current = cards.findIndex((card) => card.dataset.itemId === state.selected?.id);
            if (current < 0) current = key === "j" ? -1 : 0;
            const next = cards[(current + (key === "j" ? 1 : cards.length - 1) + cards.length) % cards.length];
            if (!next) return;
            if (elements.source_panel.classList.contains("hidden")) next.focus({ preventScroll: true });
            else {
                state.sourceReturnFocus = next;
                state.sourceOriginItemId = next.dataset.itemId;
            }
            next.click();
        }
    } else if (key === "a") {
        event.preventDefault();
        discussItem(focusedReviewItem()).catch(showError);
    } else if (key === "i") {
        event.preventDefault();
        openImpact(focusedReviewItem());
    } else if (key === "f") {
        event.preventDefault();
        setSourceFocus(!state.sourceFocused);
    } else if (key === "c" && state.source && !elements.source_panel.classList.contains("hidden")) {
        event.preventDefault();
        commentOnCurrentLine();
    } else if (key === "u" && state.source && state.sourceTab === "diff" && innerWidth >= SPLIT_DIFF_MIN_WIDTH) {
        event.preventDefault();
        setDiffLayout(diffLayoutPreference() === "split" ? "unified" : "split");
    } else if (key === "m" && state.reviewPage === "review" && !state.exploring && !elements.file_review_form.classList.contains("hidden")) {
        // Mark the open file and move on, without reaching for the footer (also works in focus mode). Held keys never mark a run of files.
        event.preventDefault();
        if (!event.repeat && !elements.file_review_next.disabled && !state.advancing) elements.file_review_form.requestSubmit(elements.file_review_next);
    } else if (key === "/") {
        event.preventDefault();
        if (elements.review_search.getClientRects().length) elements.review_search.focus();
        else openReviewCommands();
    }
});
let resizeFrame = null;
function detectHostResize() {
    if (document.hidden || resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (!document.hidden) {
            renderWorkspaceShell();
            resizeGraph(elements.graph);
        }
    });
}
window.addEventListener("resize", detectHostResize);
window.addEventListener("focus", detectHostResize);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) detectHostResize();
});
window.visualViewport?.addEventListener("resize", detectHostResize);
const resizeObserver = new ResizeObserver(detectHostResize);
resizeObserver.observe(elements.graph);
// Retain the fallback for hosts that miss resize notifications.
setInterval(detectHostResize, 500);

let railResizeStart = null;
function setRailWidth(width) {
    const workspaceWidth = document.querySelector(".workspace")?.clientWidth || window.innerWidth;
    const maximum = Math.max(260, Math.min(520, workspaceWidth - 420));
    const value = Math.max(190, Math.min(maximum, width));
    document.documentElement.style.setProperty("--review-rail-width", `${value}px`);
    localStorage.setItem("agent-review:rail-width", String(value));
    detectHostResize();
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

// ---- Resizable Review panes: the file navigation on the left and the evidence pane on the right ----
// Widths persist across sessions and are clamped so the code always keeps a usable width.
const PANE_WIDTHS = {
    nav: { key: "agent-review.navigation-width", property: "--workspace-navigation-width", min: 180,
        max: () => Math.max(240, Math.min(560, window.innerWidth - 640)) },
    side: { key: "agent-review.evidence-width", property: "--source-side-width", min: 240,
        max: () => Math.max(280, (elements.source_side_resize.parentElement?.clientWidth || window.innerWidth) - 360) },
};

function setPaneWidth(name, width, { persist = true } = {}) {
    const pane = PANE_WIDTHS[name];
    const value = Math.round(Math.max(pane.min, Math.min(pane.max(), width)));
    document.documentElement.style.setProperty(pane.property, `${value}px`);
    const handle = name === "nav" ? elements.workspace_nav_resize : elements.source_side_resize;
    handle.setAttribute("aria-valuenow", String(value));
    handle.setAttribute("aria-valuemin", String(pane.min));
    handle.setAttribute("aria-valuemax", String(Math.round(pane.max())));
    if (persist) { try { localStorage.setItem(pane.key, String(value)); } catch { /* still applies to this view */ } }
    positionSideResize();
    detectHostResize();
}

function resetPaneWidth(name) {
    const pane = PANE_WIDTHS[name];
    document.documentElement.style.removeProperty(pane.property);
    try { localStorage.removeItem(pane.key); } catch { /* nothing saved */ }
    positionSideResize();
    detectHostResize();
}

const paneWidth = (name) => name === "nav"
    ? elements.review_navigation.getBoundingClientRect().width
    : document.querySelector(".source-side")?.getBoundingClientRect().width || 0;

// The evidence-pane handle sits on the pane's left border wherever the grid puts it.
function positionSideResize() {
    const handle = elements.source_side_resize;
    const side = handle.parentElement?.querySelector(".source-side");
    const body = handle.parentElement;
    const visible = Boolean(side && body && document.body.classList.contains("reviewing") && side.offsetWidth > 0
        && getComputedStyle(body).display === "grid" && !document.body.classList.contains("review-source-focus"));
    handle.classList.toggle("hidden", !visible);
    if (visible) handle.style.left = `${side.offsetLeft - 4}px`;
}

function wirePaneResize(name, handle) {
    // Dragging toward the code widens the navigation; dragging toward the code narrows the evidence pane.
    const direction = name === "nav" ? 1 : -1;
    let start = null;
    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        start = { x: event.clientX, width: paneWidth(name) };
        handle.setPointerCapture(event.pointerId);
        handle.classList.add("is-dragging");
        document.body.classList.add("resizing-pane");
        event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
        if (!start || !handle.hasPointerCapture(event.pointerId)) return;
        setPaneWidth(name, start.width + direction * (event.clientX - start.x), { persist: false });
    });
    const finish = (event) => {
        if (!start) return;
        start = null;
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        handle.classList.remove("is-dragging");
        document.body.classList.remove("resizing-pane");
        setPaneWidth(name, paneWidth(name));
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("dblclick", () => resetPaneWidth(name));
    handle.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Home") { resetPaneWidth(name); return; }
        setPaneWidth(name, paneWidth(name) + direction * (event.key === "ArrowRight" ? 24 : -24));
    });
}
wirePaneResize("nav", elements.workspace_nav_resize);
wirePaneResize("side", elements.source_side_resize);
for (const name of Object.keys(PANE_WIDTHS)) {
    let saved = NaN;
    try { saved = Number(localStorage.getItem(PANE_WIDTHS[name].key)); } catch { /* no saved width */ }
    if (Number.isFinite(saved) && saved > 0) setPaneWidth(name, saved, { persist: false });
}
const paneObserver = new ResizeObserver(() => positionSideResize());
for (const node of [document.querySelector(".source-side"), elements.source_side_resize.parentElement]) if (node) paneObserver.observe(node);
window.addEventListener("resize", () => {
    positionSideResize();
    // Keep saved widths within the new window size.
    for (const name of Object.keys(PANE_WIDTHS)) {
        const current = parseFloat(document.documentElement.style.getPropertyValue(PANE_WIDTHS[name].property));
        if (Number.isFinite(current) && current > PANE_WIDTHS[name].max()) setPaneWidth(name, current, { persist: false });
    }
});
elements.source_close.addEventListener("click", () => {
    rememberWorkspaceSource();
    setSourceFocus(false);
    setDiscussionMode(false);
    const fileSelection = state.selected?.kind === "file";
    state.selectionEpoch += 1;
    state.source = null;
    state.attribution = [];
    state.sourceHistory = { entries: [], index: -1, pending: -1 };
    elements.source_panel.classList.add("hidden");
    elements.source_ruler.classList.add("hidden");
    if (fileSelection) {
        clearSelection();
        setDetailVisible(false);
    }
    renderWorkspaceShell();
    if (state.reviewPage === "review" && !state.exploring) {
        state.navigationOpen = matchMedia("(max-width: 900px)").matches;
        renderWorkspaceNavigation();
        renderWorkspaceShell();
        const file = [...elements.workspace_nav_list.querySelectorAll(".workspace-file")]
            .find((button) => button.getAttribute("aria-current") === "location");
        (file || elements.workspace_find).focus({ preventScroll: true });
        render();
        return;
    }
    if (state.mode === "impact") {
        if (state.sourceReturnFocus?.isConnected) {
            state.sourceReturnFocus.scrollIntoView({ block: "nearest" });
            state.sourceReturnFocus.focus({ preventScroll: true });
        } else focusImpactNode();
    } else if (state.sourceReturnFocus?.isConnected && state.sourceReturnFocus.getClientRects().length) {
        state.sourceReturnFocus.scrollIntoView({ block: "nearest" });
        state.sourceReturnFocus.focus({ preventScroll: true });
    } else {
        const visible = (element) => element?.getClientRects().length ? element : null;
        const card = [...document.querySelectorAll(".review-card[data-item-id]")]
            .find((card) => card.dataset.itemId === (state.sourceOriginItemId || state.selected?.id) && visible(card));
        const section = [...elements.graph.querySelectorAll(".section-card")]
            .find((section) => section.dataset.sectionId === state.selected?.id)?.querySelector("summary");
        const graphNode = [...elements.graph.querySelectorAll(".node")]
            .find((node) => node.dataset.nodeId === (state.selected?.node_id || state.selected?.id));
        const target = visible(section) || visible(graphNode) || card || visible(elements.review_command_open) || elements.workspace_find;
        target.scrollIntoView({ block: "nearest" });
        target.focus({ preventScroll: true });
    }
    state.sourceReturnFocus = null;
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
    renderSource().catch(showError);
}));

function updateReviewApply() {
    const busy = Boolean(state.connectionLost || state.reviewSubmitting || state.payload?.loading);
    elements.review_mode.disabled = busy;
    elements.review_ref.disabled = busy || Boolean(state.reviewOptionsLoading)
        || elements.review_mode.value === "worktree" || ![...elements.review_ref.options].some((option) => option.value);
    elements.review_list_refresh.disabled = busy || Boolean(state.reviewOptionsLoading);
    elements.review_more.disabled = busy || Boolean(state.reviewOptionsLoading);
}

function resetReviewNavigation() {
    clearTimeout(state.cursorSaveTimer);
    state.progressReady = false;
    state.progressSaving = false;
    state.progressLoading = false;
    state.progressError = null;
    state.savedReviewCursor = null;
    elements.review_background.open = false;
    state.reviewPage = "overview";
    state.navigationMode = "groups";
    state.navigationQuery = "";
    state.navigationKey = null;
    state.navigationCursor = null;
    state.navigationOpen = false;
    state.activeReviewGroup = null;
    state.workspaceReturn = null;
    state.exploring = false;
    state.readingPane = "code";
    elements.workspace_search.value = "";
    setSourceFocus(false);
    state.appliedReviewLocation = null;
    setDiscussionMode(false);
    sourceRowCache.clear();
    state.selectionEpoch += 1;
    state.customOpenKeys.clear();
    state.selected = null;
    state.source = null;
    state.sectionData = null;
    state.sectionDataKey = null;
    state.sectionLoadingKey = null;
    state.sectionError = null;
    state.layerSummaryRequested = null;
    state.layerSummaryLoading = false;
    state.layerSummaryError = null;
    state.annotationRequests.clear();
    state.prefetchedAnnotations = new Set();
    state.prefetchStatus = null;
    clearTimeout(state.prefetchTimer);
    renderPrefetchStatus();
    state.openSectionKeys = new Set();
    state.openSectionRangeKeys = new Set();
    state.summaryKey = null;
    state.overviewLoading = false;
    state.overviewError = null;
    state.briefIntent = null;
    state.briefIntentKey = null;
    state.stack = [];
    state.mode = "walkthrough";
    state.areaGroup = null;
    state.appliedServerSelection = null;
    state.reviewLedger = new Map();
    state.reviewLedgerStorageKey = null;
    state.reviewLedgerError = null;
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
    for (const element of [elements.graph, elements.attention, elements.packages, elements.summary,
        elements.change_brief, elements.custom_results, elements.source, elements.source_annotation, elements.source_provenance]) {
        element.replaceChildren();
    }
    elements.graph.scrollTop = 0;
    document.querySelector(".rail").scrollTop = 0;
}

function renderReviewPickerNotice() {
    const pending = Boolean(state.reviewPickerPending || state.reviewSubmitting
        || (state.payload?.loading && !state.payload.model));
    for (const element of [elements.review_overview, elements.review_background, elements.change_brief, elements.summary, document.querySelector(".workspace")]) {
        element.classList.toggle("hidden", pending);
    }
    // renderBreadcrumbs owns their visibility once a review is open; the picker only hides them.
    if (pending) elements.breadcrumbs.classList.add("hidden");
    const loading = state.reviewSubmitting || state.reviewOptionsLoading || state.payload?.loading;
    elements.review_picker_notice.classList.toggle("hidden", !pending || (loading && !state.reviewOpenError));
    if (pending) {
        if (!loading) elements.review_target_label.textContent = "Choose a review target";
        if (!state.payload?.loading) elements.status.textContent = loading ? "Loading review…" : "Choose review";
        elements.review_picker_notice.textContent = state.reviewOpenError ? ""
            : !elements.review_mode.value
                ? "Choose Worktree, Commit, or Pull request to begin analysis."
                : `Select ${elements.review_mode.value === "pr" ? "a pull request" : "a commit"} to load its review automatically.`;
        if (state.reviewOpenError) {
            const retry = el("button", "brief-generate", "Retry review");
            retry.type = "button";
            retry.addEventListener("click", openSelectedReview);
            elements.review_picker_notice.append(el("p", "error", state.reviewOpenError), retry);
        }
    }
}

async function loadReviewOptions({ append = false, selectedRef = null, refresh = false } = {}) {
    const epoch = (state.reviewOptionsEpoch || 0) + 1;
    state.reviewOptionsEpoch = epoch;
    const mode = elements.review_mode.value;
    const selected = selectedRef ?? (elements.review_ref.value || null);
    elements.review_ref.classList.remove("hidden");
    elements.review_ref.required = mode !== "worktree";
    elements.review_more.classList.add("hidden");
    elements.review_list_refresh.classList.toggle("hidden", mode === "worktree");
    elements.review_options_status.textContent = "";
    state.reviewOptionsLoading = mode !== "worktree";
    if (!append) {
        state.reviewOptionsPage = -1;
        elements.review_ref.replaceChildren();
        if (mode !== "worktree") {
            const placeholder = el("option", "", mode === "commit" ? "Choose a commit…" : "Choose a pull request…");
            placeholder.value = "";
            placeholder.disabled = true;
            elements.review_ref.append(placeholder);
        }
    }
    elements.review_ref.disabled = true;
    updateReviewApply();
    if (mode === "worktree") {
        elements.review_ref.append(el("option", "", "Working tree snapshot"));
        renderReviewPickerNotice();
        if (state.reviewPickerPending) await openSelectedReview();
        return;
    }
    const page = append ? state.reviewOptionsPage + 1 : 0;
    elements.review_options_status.textContent = `Loading ${mode === "commit" ? "commits" : "pull requests"}…`;
    try {
        const result = refresh
            ? await api("/api/review-targets/refresh", {
                method: "POST",
                body: JSON.stringify({ mode }),
            })
            : await api(`/api/review-targets?mode=${mode}&page=${page}`);
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
        if (!selected) elements.review_ref.value = "";
        state.reviewOptionsPage = page;
        state.reviewOptionsRetryAppend = null;
        const hasOptions = [...elements.review_ref.options].some((option) => option.value);
        elements.review_ref.disabled = !hasOptions;
        elements.review_more.textContent = "Load more";
        elements.review_more.classList.toggle("hidden", !result.has_more);
        elements.review_options_status.textContent = hasOptions
            ? refresh ? `${mode === "commit" ? "Commit" : "Pull request"} list refreshed.`
                : mode === "pr" ? result.repository || "" : ""
            : mode === "commit" ? "No commits found." : "No pull requests found for this repository.";
    } catch (error) {
        if (epoch !== state.reviewOptionsEpoch) return;
        state.reviewOptionsRetryAppend = append;
        elements.review_options_status.textContent = `Unable to load ${mode === "commit" ? "commits" : "pull requests"}: ${error.message}`;
        elements.review_more.textContent = "Retry list";
        elements.review_more.classList.remove("hidden");
        elements.review_ref.disabled = ![...elements.review_ref.options].some((option) => option.value);
    } finally {
        if (epoch === state.reviewOptionsEpoch) {
            state.reviewOptionsLoading = false;
            updateReviewApply();
            renderReviewPickerNotice();
        }
    }
}

elements.review_mode.addEventListener("change", async () => {
    state.reviewPickerPending = true;
    state.reviewOpenError = null;
    resetReviewNavigation();
    render();
    await loadReviewOptions({ selectedRef: "" });
});
elements.review_ref.addEventListener("change", async () => {
    state.reviewPickerPending = true;
    state.reviewOpenError = null;
    resetReviewNavigation();
    updateReviewApply();
    render();
    await openSelectedReview();
});
elements.review_more.addEventListener("click", () => loadReviewOptions({ append: state.reviewOptionsRetryAppend ?? true }));
elements.review_list_refresh.addEventListener("click", () => loadReviewOptions({
    selectedRef: elements.review_ref.value || null,
    refresh: true,
}));
elements.review_target_form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await openSelectedReview();
});

async function openSelectedReview() {
    if (state.reviewSubmitting || state.payload?.loading || state.reviewOptionsLoading
        || (elements.review_mode.value !== "worktree" && !elements.review_ref.value)) return;
    state.reviewSubmitting = true;
    state.reviewOpenError = null;
    resetReviewNavigation();
    render();
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
        state.clientError = null;
        elements.error.classList.add("hidden");
        render();
        window.scrollTo({ top: 0, behavior: "instant" });
    } catch (error) {
        state.reviewPickerPending = true;
        state.reviewOpenError = error.message;
        renderReviewPickerNotice();
        showError(error);
    } finally {
        state.reviewSubmitting = false;
        updateReviewApply();
        render();
    }
}

elements.change_repository.addEventListener("click", () => {
    elements.repository_path.value = state.payload?.repo_root || state.payload?.model?.metadata?.repo_root || "";
    elements.repository_picker_error.classList.add("hidden");
    elements.repository_picker.showModal();
    elements.repository_path.focus();
    elements.repository_path.select();
});
elements.repository_picker_close.addEventListener("click", () => elements.repository_picker.close());
elements.repository_picker_form.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.repositorySubmitting = true;
    elements.repository_open.disabled = true;
    elements.repository_picker_error.classList.add("hidden");
    try {
        await api("/api/repository", { method: "POST", body: JSON.stringify({ repoPath: elements.repository_path.value }) });
        state.payload = await api("/api/state");
        resetReviewNavigation();
        state.reviewTargetKey = null;
        state.reviewPickerPending = true;
        state.customPrompts = [];
        state.customLibraryError = null;
        elements.repository_picker.close();
        loadCustomPrompts();
        render();
    } catch (error) {
        elements.repository_picker_error.textContent = error.message;
        elements.repository_picker_error.classList.remove("hidden");
    } finally {
        state.repositorySubmitting = false;
        elements.repository_open.disabled = false;
        render();
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
    if (state.eventSnapshotReceived) return;
    state.payload = payload;
    render();
}).catch(showError);

function renderConnectionNotice() {
    const showWarning = state.connectionLost && connectionFeedback.phase === "lost";
    elements.connection_notice.classList.toggle("hidden", !showWarning);
    if (state.connectionLost) {
        elements.status.textContent = showWarning ? "Connection lost"
            : connectionFeedback.hasConnected ? "Reconnecting…" : "Connecting…";
        elements.status.classList.add("working");
        elements.analysis_progress.classList.add("hidden");
        elements.refresh.disabled = true;
        elements.cancel_analysis.disabled = true;
        updateReviewApply();
    }
}

function markDisconnected() {
    connectionFeedback.failed();
    if (!elements.clean_review.classList.contains("hidden")) {
        elements.clean_review.querySelector("h2").textContent = "Previous snapshot had no changes";
        elements.clean_review.querySelector("p").textContent = "This is the last saved result; it cannot confirm the current worktree while disconnected.";
    }
}

elements.reconnect.addEventListener("click", () => {
    clearTimeout(state.reconnectTimer);
    state.eventSource?.close();
    connectEvents();
});

function connectEvents() {
    clearTimeout(state.reconnectTimer);
    state.eventSource?.close();
    const events = new EventSource("/events");
    state.eventSource = events;
    events.addEventListener("state", (event) => {
        if (state.eventSource !== events) return;
        const update = JSON.parse(event.data);
        const previousOverview = state.payload?.annotations?.overview;
        const previousLayers = state.payload?.annotations?.layers;
        state.eventSnapshotReceived = true;
        const payload = update.partial ? { ...state.payload, ...update } : update;
        if (payload.type === "repository-changed") {
            resetReviewNavigation();
            state.reviewTargetKey = null;
            state.reviewPickerPending = false;
            state.customPrompts = [];
            state.customLibraryError = null;
        }
        const roleCorrection = payload.type === "document-roles" && payload.model?.review_snapshot_key
            && payload.model.review_snapshot_key === state.payload?.model?.review_snapshot_key;
        if (state.payload?.review_generation !== payload.review_generation
            && payload.model && !payload.loading && !roleCorrection) resetReviewNavigation();
        if (roleCorrection) {
            state.documentRoleView = null;
            state.annotationRequests.clear();
            state.prefetchedAnnotations = new Set();
            state.prefetchStatus = null;
            state.overviewLoading = false;
            state.layerSummaryLoading = false;
            state.layerSummaryRequested = null;
        }
        connectionFeedback.connected();
        state.payload = payload;
        if (state.discussionMode && discussionPane.thread?.id === payload.discussion_update?.id) {
            discussionPane.update(payload.discussion_update);
        }
        if (payload.type === "discussion") return;
        if (payload.type === "connected" && state.discussionMode) discussionPane.refresh().catch(showError);
        if (payload.type === "selection") {
            applyServerSelection(payload);
            return;
        }
        if (payload.type === "annotation") {
            const overview = payload.annotations?.overview;
            if (["body", "basis", "refining", "refine_error"].some((key) => previousOverview?.[key] !== overview?.[key])) renderChangeBrief();
            if (previousLayers?.generated_at !== payload.annotations?.layers?.generated_at) {
                renderWorkspaceNavigation();
                renderReviewOverview();
            }
            const annotation = payload.annotations?.[state.selected?.id];
            if (annotation) renderAnnotation(state.selected, annotation);
            return;
        }
        if (["connected", "refreshed", "repository-changed"].includes(state.payload.type)) loadCustomPrompts();
        render();
        if (roleCorrection && state.source) {
            renderSource({ preserveScroll: true }).then(() => {
                if (state.selected) ensureAnnotation(state.selected);
            }).catch(showError);
        }
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
        if (state.eventSource !== events) return;
        events.close();
        state.eventSource = null;
        markDisconnected();
        state.reconnectTimer = setTimeout(connectEvents, 2000);
    };
}
connectEvents();
