import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { generateIsolatedExplanation } from "./ai-explainer.mjs";
import { buildCustomAnalysisPrompt, CUSTOM_ANALYSIS_HEADINGS, validateCustomAnalysis } from "./custom-analysis.mjs";
import {
    ANNOTATION_HEADINGS,
    buildAnnotationPrompt,
    buildOverviewPrompt,
    buildPackagePrompt,
    OVERVIEW_HEADINGS,
    PACKAGE_HEADINGS,
} from "./ai-prompts.mjs";
import { loadHistoricalSessionContexts } from "./historical-sessions.mjs";
import { loadReviewConfig, resolveRepoRoot, ReviewState } from "./review-state.mjs";
import { preferredPort, readCanvasMarkers, writeCanvasMarker } from "./canvas-persistence.mjs";
import { startReviewServer } from "./server.mjs";
import { ReviewLifecycle } from "./review-lifecycle.mjs";

const instances = new Map();
const pendingInstances = new Map();
const reviewStates = new Map();
let session;
let lifecycle;

function instanceFor(ctx) {
    const instance = instances.get(ctx.instanceId);
    if (!instance) throw new CanvasError("canvas_not_open", "Open Agent Review before invoking this action.");
    return instance;
}

const canvas = createCanvas({
    id: "agent-review",
    displayName: "Agent Review",
    description: "Understand Python, JavaScript/TypeScript, C#/.NET, Go, and Rust changes from architecture to deterministic source evidence.",
    inputSchema: {
        type: "object",
        properties: {
            repoPath: { type: "string", description: "Repository path. Defaults to the Copilot workspace." },
            baseRef: { type: "string", description: "Optional base branch or ref override." },
        },
        additionalProperties: false,
    },
    actions: [
        {
            name: "cancel",
            description: "Cancel the active deterministic analysis. Reanalyze explicitly to start again.",
            handler: async (ctx) => ({ ok: true, ...await instanceFor(ctx).state.cancel() }),
        },
        {
            name: "refresh",
            description: "Re-analyze the selected worktree, commit, or PR snapshot and update the open Agent Review canvas.",
            handler: async (ctx) => {
                const model = await instanceFor(ctx).state.refresh();
                return { ok: true, summary: model.summary };
            },
        },
        {
            name: "get_review_context",
            description: "Get deterministic evidence and relationships for a selected review node, edge, package, finding, or evidence id. Omit id to summarize the review.",
            inputSchema: {
                type: "object",
                properties: { id: { type: "string", description: "ReviewModel item id." } },
                additionalProperties: false,
            },
            handler: async (ctx) => instanceFor(ctx).state.contextFor(ctx.input?.id),
        },
        {
            name: "get_session_change_context",
            description: "Get Copilot session intent and agent activity associated with the change. This is contextual provenance, not deterministic code evidence.",
            handler: async (ctx) => {
                const instance = instanceFor(ctx);
                await instance.state.refreshSessionContext();
                return instance.state.sessionContext;
            },
        },
        {
            name: "focus_item",
            description: "Focus an item in the open canvas so the human can inspect the same evidence.",
            inputSchema: {
                type: "object",
                properties: { id: { type: "string" }, kind: { type: "string" } },
                required: ["id"],
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const context = instanceFor(ctx).state.select({ id: String(ctx.input.id), kind: String(ctx.input.kind || "") });
                return { ok: true, context };
            },
        },
        {
            name: "add_review_observation",
            description: "Add a model-written review observation to the canvas. Factual claims must cite deterministic evidence ids returned by get_review_context.",
            inputSchema: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    body: { type: "string" },
                    severity: { type: "string", enum: ["info", "low", "medium", "high"] },
                    evidence_ids: { type: "array", items: { type: "string" }, minItems: 1 },
                },
                required: ["title", "body", "evidence_ids"],
                additionalProperties: false,
            },
            handler: async (ctx) => ({ ok: true, observation: instanceFor(ctx).state.addObservation(ctx.input || {}) }),
        },
    ],
    open: async (ctx) => {
        await lifecycle.reopenInstance(ctx.instanceId);
        let instance = instances.get(ctx.instanceId);
        if (!instance && pendingInstances.has(ctx.instanceId)) {
            const wait = new Promise((resolve) => setTimeout(() => resolve(null), 4_000));
            instance = await Promise.race([pendingInstances.get(ctx.instanceId).catch(() => null), wait]);
        }
        if (!instance) instance = await createInstance(ctx.instanceId, ctx.input || {});
        return { title: "Agent Review", status: "Architecture-to-source change review", url: instance.server.url };
    },
    onClose: async (ctx) => {
        await lifecycle.closeInstance(ctx.instanceId);
    },
});

function createReviewState(requestedPath, input) {
    const state = new ReviewState(requestedPath, {
        baseRef: input.baseRef,
        reviewTarget: input.reviewTarget,
        // Re-read on every refresh so a base_ref added by a later commit or checkout takes effect.
        resolveBaseRef: async () => {
            if (input.baseRef) return input.baseRef;
            try {
                const config = await loadReviewConfig(state.repoRoot);
                return config.base_ref || process.env.COPILOT_DEFAULT_BRANCH || null;
            } catch (error) {
                console.error("[agent-review]", error);
                return state.baseRef;
            }
        },
        getSessionEvents: () => session.getEvents(),
        currentSessionId: session.sessionId,
        workspacePath: session.workspacePath,
        getHistoricalSessionContexts: () => loadHistoricalSessionContexts(state.repoRoot, session.sessionId),
        generateAnnotation: async (context) => {
            const overview = context.kind === "overview";
            return generateIsolatedExplanation({
                workingDirectory: state.repoRoot,
                prompt: overview ? buildOverviewPrompt(context) : buildAnnotationPrompt(context),
                sourceEvents: await session.getEvents(),
                requiredHeadings: overview ? OVERVIEW_HEADINGS : ANNOTATION_HEADINGS,
            });
        },
        generatePackageExplanation: async ({ dependency, assessment, usageContext }) => generateIsolatedExplanation({
            workingDirectory: state.repoRoot,
            prompt: buildPackagePrompt(dependency, assessment, usageContext),
            sourceEvents: await session.getEvents(),
            requiredHeadings: PACKAGE_HEADINGS,
        }),
        generateCustomAnalysis: async ({ prompt, context }) => generateIsolatedExplanation({
            workingDirectory: state.repoRoot,
            prompt: buildCustomAnalysisPrompt(prompt, context),
            sourceEvents: await session.getEvents(),
            requiredHeadings: CUSTOM_ANALYSIS_HEADINGS,
            validateResponse: (content) => validateCustomAnalysis(content, context),
        }),
    });
    return state;
}

function createInstance(instanceId, input, serverOptions = {}) {
    if (lifecycle.closed || lifecycle.closedInstances.has(instanceId)) {
        throw new CanvasError("canvas_not_open", "This Agent Review canvas has been closed.");
    }
    const pending = buildInstance(instanceId, input, serverOptions)
        .finally(() => pendingInstances.delete(instanceId));
    pendingInstances.set(instanceId, pending);
    return pending;
}

async function buildInstance(instanceId, input, serverOptions) {
    const requestedPath = input.repoPath
        || process.env.COPILOT_WORKSPACE_PATH
        || process.env.COPILOT_ROOT_PATH
        || process.cwd();
    const stateKey = `${requestedPath}|${input.baseRef || ""}`;
    let state = reviewStates.get(stateKey);
    const isNewState = !state;
    if (!state) {
        state = createReviewState(requestedPath, input);
        reviewStates.set(stateKey, state);
    }
    lifecycle.acquire(instanceId, state);
    let server;
    try {
        server = await startReviewServer(state, {
            port: preferredPort(requestedPath, input.baseRef),
            ...serverOptions,
            changeRepository: async (request) => {
                if ([...lifecycle.owners.values()].filter((owner) => owner === state).length > 1) {
                    throw new Error("This review is shared by multiple canvases. Close the other canvases before changing its repository.");
                }
                return state.setRepository(request);
            },
        });
    } catch (error) {
        lifecycle.owners.delete(instanceId);
        if (![...lifecycle.owners.values()].includes(state)) {
            reviewStates.delete(stateKey);
            await state.dispose();
        }
        throw error;
    }
    const existing = instances.get(instanceId);
    if (existing) {
        await server.close();
        return existing;
    }
    const persistMarker = () => writeCanvasMarker({
        sessionId: session.sessionId,
        instanceId,
        port: server.port,
        input: { repoPath: state.repoRoot,
            baseRef: state.repositoryBaseOverride !== undefined ? state.repositoryBaseOverride : input.baseRef || null,
            reviewTarget: state.reviewTarget },
    });
    const instance = { state, server, unsubscribeMarker: state.subscribe((event) => {
        if (event.type === "repository-changed") {
            for (const [key, value] of reviewStates) if (value === state) reviewStates.delete(key);
            const key = `${state.repoRoot}|${state.repositoryBaseOverride || ""}`;
            reviewStates.set(reviewStates.has(key) ? `${key}|${instanceId}` : key, state);
        }
        if (["refreshed", "repository-changed"].includes(event.type)) {
            persistMarker().catch((error) => console.error("[agent-review] Unable to persist review target:", error));
        }
    }) };
    instances.set(instanceId, instance);
    try {
        await lifecycle.register(instanceId);
    } catch (error) {
        instances.delete(instanceId);
        instance.unsubscribeMarker();
        lifecycle.owners.delete(instanceId);
        if (![...lifecycle.owners.values()].includes(state)) {
            reviewStates.delete(stateKey);
            await state.dispose();
        }
        await server.close();
        throw error;
    }
    await persistMarker().catch((error) => console.error("[agent-review] Unable to persist Canvas marker:", error));
    if (isNewState) {
        resolveRepoRoot(requestedPath)
            .then(async (repoRoot) => {
                if (state.disposed || state.cancelled) return;
                state.repoRoot = repoRoot;
                const config = await loadReviewConfig(repoRoot);
                state.baseRef = input.baseRef
                    || config.base_ref
                    || process.env.COPILOT_DEFAULT_BRANCH
                    || null;
                if (!state.disposed && !state.cancelled) return state.refresh();
            })
            .catch((error) => {
                if (error.name !== "AbortError" && !state.disposed) {
                    state.failInitialization(error);
                    console.error("[agent-review]", error);
                }
            });
    }
    return instance;
}

// The host can restart this extension process several times while a session resumes,
// which kills a Canvas server that is already open. Re-serve the same URL for any
// Canvas this session had open so the page reconnects instead of staying stale.
async function reclaimPersistedCanvases() {
    const markers = await readCanvasMarkers(session.sessionId);
    await Promise.all(markers.map((marker) => {
        if (instances.has(marker.instanceId) || pendingInstances.has(marker.instanceId)) return null;
        return createInstance(marker.instanceId, marker.input || {}, {
            port: marker.port,
            exactPort: true,
            waitMs: 30_000,
        }).catch((error) => console.error("[agent-review] Unable to reclaim Canvas server:", error.message));
    }));
}
session = await joinSession({ canvases: [canvas] });
lifecycle = new ReviewLifecycle(session, instances, reviewStates, pendingInstances);
for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
        lifecycle.dispose({ preserveMarkers: true }).then(() => process.exit(0)).catch((error) => {
            console.error("[agent-review shutdown]", error);
            process.exit(1);
        });
    });
}
await session.log("Agent Review canvas ready.", { ephemeral: true });
reclaimPersistedCanvases().catch((error) => console.error("[agent-review] Canvas reclaim failed:", error));
