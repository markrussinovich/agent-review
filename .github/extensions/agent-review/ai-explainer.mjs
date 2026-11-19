import { managedCopilotPath } from "./managed-copilot.mjs";
import {
    ExplanationValidationError,
    selectedModelFromEvents,
    validateExplanation,
} from "./ai-response.mjs";

export { selectedModelFromEvents, validateExplanation } from "./ai-response.mjs";

export const LANGUAGE_LEVELS = ["default", "medium", "plain"];

const LANGUAGE_INSTRUCTIONS = {
    medium: "Write for a reader with moderate technical background: prefer concrete wording over jargon and briefly explain specialized terms the first time you use them.",
    plain: "Write in plain English for a non-specialist reader: use short sentences and everyday words, explain any technical term you must use, and avoid jargon.",
};

export function withLanguageLevel(prompt, languageLevel) {
    const instruction = LANGUAGE_INSTRUCTIONS[languageLevel];
    return instruction
        ? `${prompt}\n\nReading level: ${instruction} Keep every required heading, field, format, identifier, and citation exactly as specified.`
        : prompt;
}

// modelChoice is "session" (the session's model), "fusion" (Copilot Auto with Fusion routing), or a model ID.
export function explanationModelPreference(models, fallbackModel, modelChoice) {
    if (modelChoice === "fusion" && models.some((model) => model.id === "auto" && model.policy?.state !== "disabled")) {
        return { modelId: "auto", autoTier: "hydrafusion" };
    }
    if (modelChoice && modelChoice !== "session" && modelChoice !== "fusion") return { modelId: modelChoice, autoTier: undefined };
    return { modelId: fallbackModel, autoTier: undefined };
}

async function resolveModelPreference(client, fallbackModel, modelChoice) {
    return explanationModelPreference(modelChoice === "fusion" ? await client.listModels() : [], fallbackModel, modelChoice);
}

export async function listExplanationModels(workingDirectory) {
    const client = await createClient(workingDirectory);
    await client.start();
    try {
        return (await client.listModels())
            .filter((model) => model.id && model.policy?.state !== "disabled")
            .map((model) => ({ id: model.id, name: model.name || model.id }));
    } finally {
        await client.stop();
    }
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
    modelChoice = "session",
    languageLevel = "default",
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
        const preference = runtimeClient
            ? { modelId: selectedModel, autoTier }
            : await resolveModelPreference(client, selectedModel, modelChoice);
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
        const response = await isolated.sendAndWait({ prompt: withLanguageLevel(prompt, languageLevel), ...(responseSchema ? { responseSchema } : {}) }, timeoutMs);
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

export async function createExplanationRuntime(workingDirectory, modelId = null, { modelChoice = "session" } = {}) {
    const client = await createClient(workingDirectory);
    await client.start();
    try {
        const preference = await resolveModelPreference(client, modelId, modelChoice);
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
