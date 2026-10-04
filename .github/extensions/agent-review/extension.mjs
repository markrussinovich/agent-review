import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { generateIsolatedExplanation } from "./ai-explainer.mjs";
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
import { preferredPort, readCanvasMarkers, removeCanvasMarker, writeCanvasMarker } from "./canvas-persistence.mjs";
import { startReviewServer } from "./server.mjs";

const instances = new Map();
const pendingInstances = new Map();
const reviewStates = new Map();
let session;

function instanceFor(ctx) {
    const instance = instances.get(ctx.instanceId);
    if (!instance) throw new CanvasError("canvas_not_open", "Open Agent Review before invoking this action.");
    return instance;
}

const canvas = createCanvas({
    id: "agent-review",
    displayName: "Agent Review",
    description: "Understand an agent's Python changes from architecture through modules and symbols to deterministic source evidence.",
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
        let instance = instances.get(ctx.instanceId);
        if (!instance && pendingInstances.has(ctx.instanceId)) {
            const wait = new Promise((resolve) => setTimeout(() => resolve(null), 4_000));
            instance = await Promise.race([pendingInstances.get(ctx.instanceId).catch(() => null), wait]);
        }
        if (!instance) instance = await createInstance(ctx.instanceId, ctx.input || {});
        return { title: "Agent Review", status: "Architecture-to-source change review", url: instance.server.url };
    },
    onClose: async (ctx) => {
        await removeCanvasMarker(session.sessionId, ctx.instanceId).catch(() => {});
        const instance = instances.get(ctx.instanceId);
        if (!instance) return;
        instances.delete(ctx.instanceId);
        instance.unsubscribeMarker?.();
        await instance.server.close();
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
        generatePackageExplanation: async ({ dependency, assessment }) => generateIsolatedExplanation({
            workingDirectory: state.repoRoot,
            prompt: buildPackagePrompt(dependency, assessment),
            sourceEvents: await session.getEvents(),
            requiredHeadings: PACKAGE_HEADINGS,
        }),
    });
    return state;
}

function createInstance(instanceId, input, serverOptions = {}) {
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
    const server = await startReviewServer(state, {
        port: preferredPort(requestedPath, input.baseRef),
        ...serverOptions,
    });
    const existing = instances.get(instanceId);
    if (existing) {
        await server.close();
        return existing;
    }
    const persistMarker = () => writeCanvasMarker({
        sessionId: session.sessionId,
        instanceId,
        port: server.port,
        input: { repoPath: requestedPath, baseRef: input.baseRef || null, reviewTarget: state.reviewTarget },
    });
    const instance = { state, server, unsubscribeMarker: state.subscribe((event) => {
        if (event.type === "refreshed") {
            persistMarker().catch((error) => console.error("[agent-review] Unable to persist review target:", error));
        }
    }) };
    instances.set(instanceId, instance);
    await persistMarker().catch((error) => console.error("[agent-review] Unable to persist Canvas marker:", error));
    if (isNewState) {
        resolveRepoRoot(requestedPath)
            .then(async (repoRoot) => {
                state.repoRoot = repoRoot;
                const config = await loadReviewConfig(repoRoot);
                state.baseRef = input.baseRef
                    || config.base_ref
                    || process.env.COPILOT_DEFAULT_BRANCH
                    || null;
                return state.refresh();
            })
            .catch((error) => {
                state.failInitialization(error);
                console.error("[agent-review]", error);
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
await session.log("Agent Review canvas ready.", { ephemeral: true });
reclaimPersistedCanvases().catch((error) => console.error("[agent-review] Canvas reclaim failed:", error));
