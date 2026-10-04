import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { generateIsolatedExplanation } from "./ai-explainer.mjs";
import {
    ANNOTATION_HEADINGS,
    buildAnnotationPrompt,
    buildPackagePrompt,
    PACKAGE_HEADINGS,
} from "./ai-prompts.mjs";
import { loadHistoricalSessionContexts } from "./historical-sessions.mjs";
import { loadReviewConfig, resolveRepoRoot, ReviewState } from "./review-state.mjs";
import { startReviewServer } from "./server.mjs";

const instances = new Map();
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
            description: "Re-analyze the current worktree after edits and update the open Agent Review canvas.",
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
        if (!instance) {
            const requestedPath = ctx.input?.repoPath
                || process.env.COPILOT_WORKSPACE_PATH
                || process.env.COPILOT_ROOT_PATH
                || process.cwd();
            const stateKey = `${requestedPath}|${ctx.input?.baseRef || ""}`;
            let state = reviewStates.get(stateKey);
            const isNewState = !state;
            if (!state) {
                state = new ReviewState(requestedPath, {
                    baseRef: ctx.input?.baseRef,
                    getSessionEvents: () => session.getEvents(),
                    currentSessionId: session.sessionId,
                    getHistoricalSessionContexts: () =>
                        loadHistoricalSessionContexts(state.repoRoot, session.sessionId),
                    generateAnnotation: async (context) => {
                    const prompt = buildAnnotationPrompt(context);
                    return generateIsolatedExplanation({
                        workingDirectory: state.repoRoot,
                        prompt,
                        sourceEvents: await session.getEvents(),
                        requiredHeadings: ANNOTATION_HEADINGS,
                    });
                    },
                    generatePackageExplanation: async ({ dependency, assessment }) => {
                    const prompt = buildPackagePrompt(dependency, assessment);
                    return generateIsolatedExplanation({
                        workingDirectory: state.repoRoot,
                        prompt,
                        sourceEvents: await session.getEvents(),
                        requiredHeadings: PACKAGE_HEADINGS,
                    });
                    },
                });
                reviewStates.set(stateKey, state);
            }
            const server = await startReviewServer(state);
            instance = { state, server };
            instances.set(ctx.instanceId, instance);
            if (isNewState) {
                resolveRepoRoot(requestedPath)
                    .then(async (repoRoot) => {
                        state.repoRoot = repoRoot;
                        const config = await loadReviewConfig(repoRoot);
                        state.baseRef = ctx.input?.baseRef
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
        }
        return { title: "Agent Review", status: "Architecture-to-source change review", url: instance.server.url };
    },
    onClose: async (ctx) => {
        const instance = instances.get(ctx.instanceId);
        if (!instance) return;
        instances.delete(ctx.instanceId);
        await instance.server.close();
    },
});

session = await joinSession({ canvases: [canvas] });
await session.log("Agent Review canvas ready.", { ephemeral: true });
