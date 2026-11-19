import { managedCopilotPath } from "./managed-copilot.mjs";
import {
    ExplanationValidationError,
    selectedModelFromEvents,
    validateExplanation,
} from "./ai-response.mjs";

export { selectedModelFromEvents, validateExplanation } from "./ai-response.mjs";

export function explanationModelPreference(models, fallbackModel, useFusion) {
    if (useFusion && models.some((model) => model.id === "auto" && model.policy?.state !== "disabled")) {
        return { modelId: "auto", autoTier: "hydrafusion" };
    }
    return { modelId: fallbackModel, autoTier: undefined };
}

async function createClient(workingDirectory) {
    const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
    return new CopilotClient({
        connection: RuntimeConnection.forStdio({
            path: await managedCopilotPath(), args: ["--server", "--stdio", "--no-auto-update"],
        }),
        workingDirectory, logLevel: "error",
    });
}

async function generateOnce({
    workingDirectory,
    prompt,
    sourceEvents = [],
    timeoutMs = 120_000,
    requiredHeadings = [],
    validateResponse = null,
    signal,
    runtimeClient = null,
    modelId,
    autoTier,
    useFusion = false,
    responseSchema,
}) {
    signal?.throwIfAborted();
    const client = runtimeClient || await createClient(workingDirectory);
    let isolated;
    const abort = () => {
        if (isolated) void isolated.abort().catch((error) => console.error("[agent-review] Failed to abort review request:", error));
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
        if (!runtimeClient) await client.start();
        const selectedModel = modelId === undefined ? selectedModelFromEvents(sourceEvents) : modelId;
        const preference = useFusion && !runtimeClient
            ? explanationModelPreference(await client.listModels(), selectedModel, true)
            : { modelId: selectedModel, autoTier };
        isolated = await client.createSession({
            ...(preference.modelId ? { model: preference.modelId } : {}),
            ...(preference.autoTier ? { autoTier: preference.autoTier } : {}),
            availableTools: [],
            excludedTools: ["builtin:*", "mcp:*", "custom:*"],
            onPermissionRequest: () => ({
                kind: "reject",
                feedback: "Agent Review explanation sessions cannot use tools.",
            }),
        });
        signal?.throwIfAborted();
        const response = await isolated.sendAndWait({ prompt, ...(responseSchema ? { responseSchema } : {}) }, timeoutMs);
        signal?.throwIfAborted();
        if (response?.data?.toolRequests?.length) {
            throw new ExplanationValidationError("Copilot attempted to call a tool from an explanation-only session.");
        }
        const content = validateExplanation(response?.data?.content, requiredHeadings);
        return validateResponse ? validateResponse(content) : content;
    } finally {
        signal?.removeEventListener("abort", abort);
        try {
            if (isolated) await isolated.disconnect();
        } catch (error) {
            console.error("[agent-review] Failed to disconnect isolated Copilot session:", error);
        } finally {
            try {
                if (!runtimeClient) await client.stop();
            } catch (error) {
                console.error("[agent-review] Failed to stop isolated Copilot client:", error);
            }
        }
    }
}

export async function createExplanationRuntime(workingDirectory, modelId = null, { useFusion = false } = {}) {
    const client = await createClient(workingDirectory);
    await client.start();
    try {
        const preference = useFusion
            ? explanationModelPreference(await client.listModels(), modelId, true)
            : { modelId, autoTier: undefined };
        return { client, ...preference, dispose: () => client.stop() };
    } catch (error) {
        await client.stop();
        throw error;
    }
}

export async function generateIsolatedExplanation(options) {
    const attempts = options.attempts ?? 2;
    const deadline = options.verifyPrompt ? Date.now() + (options.timeoutMs ?? 120_000) : null;
    const timeout = () => {
        if (deadline === null) return options.timeoutMs;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Explanation generation and source-fidelity check exceeded their time limit.");
        return remaining;
    };
    const generateValidated = async (prompt) => {
        let lastError;
        let requestPrompt = prompt;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                return await generateOnce({ ...options, prompt: requestPrompt, timeoutMs: timeout() });
            } catch (error) {
                lastError = error;
                if (!(error instanceof ExplanationValidationError)) throw error;
                requestPrompt = `${prompt}\n\nThe previous response failed validation: ${error.message}\nReturn a corrected response that satisfies the original format and evidence constraints.`;
            }
        }
        throw new ExplanationValidationError(
            `Copilot did not return a valid explanation after ${attempts} isolated attempt${attempts === 1 ? "" : "s"}: ${lastError?.message}`,
        );
    };
    const content = await generateValidated(options.prompt);
    const verification = options.verifyPrompt?.(content);
    return verification ? generateValidated(verification) : content;
}
