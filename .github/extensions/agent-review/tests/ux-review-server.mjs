import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { currentAnnotations, ReviewState } from "../review-state.mjs";
import { startReviewServer } from "../server.mjs";
import { buildDiscussionVerificationPrompt, discussionPrompt, discussionSchema } from "../item-discussion.mjs";
import { managedCopilotPath } from "../managed-copilot.mjs";
import { generateIsolatedExplanation } from "../ai-explainer.mjs";
import { annotationHeadings, OVERVIEW_HEADINGS, buildAnnotationPrompt, buildAnnotationVerificationPrompt, buildOverviewPrompt } from "../ai-prompts.mjs";
import { layerSummaryPrompt, layerSummarySchema, parseLayerSummaries, validateLayerSummaries } from "../layer-summaries.mjs";
import { resolveReviewTarget } from "../review-target.mjs";

const repo = process.env.AGENT_REVIEW_UX_REPO;
if (!repo) throw new Error("Set AGENT_REVIEW_UX_REPO to a real validation repository.");
let client;
if (process.env.AGENT_REVIEW_UX_SDK) {
    const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(process.env.AGENT_REVIEW_UX_SDK).href);
    client = new CopilotClient({ workingDirectory: repo, logLevel: "error",
        connection: RuntimeConnection.forStdio({ path: await managedCopilotPath(),
            args: ["--server", "--stdio", "--no-auto-update"] }) });
    await client.start();
}
const state = new ReviewState(repo, { baseRef: "HEAD", readWorktreeFingerprint: null,
    workspacePath: process.env.AGENT_REVIEW_UX_WORKSPACE,
    getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
    ...(client ? {
        generateDiscussion: (context, { signal }) => generateIsolatedExplanation({
            workingDirectory: repo, runtimeClient: client, signal, attempts: 1,
            prompt: discussionPrompt(context), responseSchema: discussionSchema(context),
            verifyPrompt: (content) => buildDiscussionVerificationPrompt(context, content),
        }),
        generateAnnotation: (context) => generateIsolatedExplanation({
            workingDirectory: repo, runtimeClient: client,
            prompt: context.kind === "overview" ? buildOverviewPrompt(context) : buildAnnotationPrompt(context),
            requiredHeadings: context.kind === "overview" ? OVERVIEW_HEADINGS : annotationHeadings(context),
            ...(context.kind !== "overview" ? { verifyPrompt: (draft) => buildAnnotationVerificationPrompt(context, draft) } : {}),
        }),
        generateLayerSummaries: async (context) => parseLayerSummaries(await generateIsolatedExplanation({
            workingDirectory: repo, runtimeClient: client, prompt: layerSummaryPrompt(context), responseSchema: layerSummarySchema(context),
            validateResponse: (content) => { validateLayerSummaries(content, context); return content; },
        }), context),
    } : {}) });
if (process.env.AGENT_REVIEW_UX_MODEL) {
    state.model = JSON.parse(await readFile(process.env.AGENT_REVIEW_UX_MODEL, "utf8"));
    const worktree = state.model.metadata.head_sha === state.model.metadata.base_sha;
    // A saved model can be paired with an explicit target, e.g. {"mode":"pr","ref":"1"}, to review a pull request.
    const requested = process.env.AGENT_REVIEW_UX_TARGET ? JSON.parse(process.env.AGENT_REVIEW_UX_TARGET) : null;
    state.reviewTarget = { ...await resolveReviewTarget(repo, requested || { mode: worktree ? "worktree" : "commit", ref: state.model.metadata.head_sha }),
        baseRef: state.model.metadata.base_sha };
    // The product extracts code paths and test links after analysis; a saved model needs the same step.
    state.startDecisionMap();
} else if (process.env.AGENT_REVIEW_UX_TARGET) {
    // Open a specific target (for example {"mode":"pr","ref":"1"}) instead of the worktree.
    await state.setReviewTarget(JSON.parse(process.env.AGENT_REVIEW_UX_TARGET));
} else await state.refresh();
if (process.env.AGENT_REVIEW_UX_ANNOTATIONS) {
    const cached = JSON.parse(await readFile(process.env.AGENT_REVIEW_UX_ANNOTATIONS, "utf8"));
    if (cached.repo !== state.model.metadata.repo_root || cached.base !== state.model.metadata.base_sha
        || cached.head !== state.model.metadata.head_sha) throw new Error("Saved UX annotations do not match the selected source snapshot.");
    state.annotations = currentAnnotations(cached.annotations);
}
const port = process.env.AGENT_REVIEW_UX_PORT ? Number(process.env.AGENT_REVIEW_UX_PORT) : null;
if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("AGENT_REVIEW_UX_PORT must be a valid TCP port.");
const server = await startReviewServer(state, port === null ? {} : { port, exactPort: true });
const info = { url: server.url, repo, pid: process.pid, discussionAvailable: Boolean(client) };
if (process.env.AGENT_REVIEW_UX_INFO) await writeFile(process.env.AGENT_REVIEW_UX_INFO, JSON.stringify(info));
console.log(JSON.stringify(info));
process.on("SIGTERM", () => void state.dispose().then(() => server.close()).then(() => client?.stop()).then(() => process.exit(0)));
