import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

import { managedCopilotPath } from "./historical-sessions.mjs";
import {
    ExplanationValidationError,
    selectedModelFromEvents,
    validateExplanation,
} from "./ai-response.mjs";

export { selectedModelFromEvents, validateExplanation } from "./ai-response.mjs";

async function generateOnce({
    workingDirectory,
    prompt,
    sourceEvents = [],
    timeoutMs = 120_000,
    requiredHeadings = [],
    validateResponse = null,
}) {
    const cliPath = await managedCopilotPath();
    const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({
            path: cliPath,
            args: ["--server", "--stdio", "--no-auto-update"],
        }),
        workingDirectory,
        logLevel: "error",
    });
    let isolated;
    try {
        await client.start();
        const model = selectedModelFromEvents(sourceEvents);
        isolated = await client.createSession({
            ...(model ? { model } : {}),
            availableTools: [],
            excludedTools: ["builtin:*", "mcp:*", "custom:*"],
            onPermissionRequest: () => ({
                kind: "reject",
                feedback: "Agent Review explanation sessions cannot use tools.",
            }),
        });
        const response = await isolated.sendAndWait({ prompt }, timeoutMs);
        if (response?.data?.toolRequests?.length) {
            throw new ExplanationValidationError("Copilot attempted to call a tool from an explanation-only session.");
        }
        const content = validateExplanation(response?.data?.content, requiredHeadings);
        return validateResponse ? validateResponse(content) : content;
    } finally {
        try {
            if (isolated) await isolated.disconnect();
        } catch (error) {
            console.error("[agent-review] Failed to disconnect isolated Copilot session:", error);
        } finally {
            try {
                await client.stop();
            } catch (error) {
                console.error("[agent-review] Failed to stop isolated Copilot client:", error);
            }
        }
    }
}

export async function generateIsolatedExplanation(options) {
    let lastError;
    let request = options;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            return await generateOnce(request);
        } catch (error) {
            lastError = error;
            if (!(error instanceof ExplanationValidationError)) throw error;
            request = { ...options, prompt: `${options.prompt}\n\nThe previous response failed validation: ${error.message}\nReturn a corrected response that satisfies the original format and evidence constraints.` };
        }
    }
    throw new Error(
        `Copilot did not return a valid explanation after two isolated attempts: ${lastError?.message}`,
        { cause: lastError },
    );
}
