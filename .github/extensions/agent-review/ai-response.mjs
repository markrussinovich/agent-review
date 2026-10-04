export function selectedModelFromEvents(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type === "session.model_change" && event.data?.newModel) return event.data.newModel;
        if (event.type === "session.resume" && event.data?.selectedModel) return event.data.selectedModel;
        if (event.type === "session.start" && event.data?.selectedModel) return event.data.selectedModel;
    }
    return null;
}

export class ExplanationValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ExplanationValidationError";
    }
}

export function validateExplanation(content, requiredHeadings = []) {
    const text = String(content || "").trim();
    if (!text) throw new ExplanationValidationError("Copilot returned an empty explanation.");
    const actualHeadings = [...text.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((match) => match[1]);
    const hasRequiredStructure = actualHeadings.length === requiredHeadings.length
        && actualHeadings.every((heading, index) => heading === requiredHeadings[index]);
    if (!hasRequiredStructure
        && /exact duplicate|already handled|already posted|skipping re-submission|canvas action/i.test(text.slice(0, 400))) {
        throw new ExplanationValidationError("Copilot returned an agent-action response instead of a code explanation.");
    }
    if (/^(?:view|glob|rg|grep|powershell|bash|apply_patch)\b[\s\S]*?(?:\*\*Path:\*\*|path\s*[:=])/i.test(text)) {
        throw new ExplanationValidationError("Copilot returned a tool-style response instead of a code explanation.");
    }
    if (!hasRequiredStructure) {
        throw new ExplanationValidationError(
            `Copilot explanation sections must be exactly: ${requiredHeadings.join(", ")}.`,
        );
    }
    if (requiredHeadings.includes("Risk and review focus")
        && !/^\*\*Risk:\s*(?:Low|Medium|High|Critical)\s*(?:—|–|-)\s*.+\*\*\s*$/m.test(text)) {
        throw new ExplanationValidationError("Copilot explanation is missing the required labeled risk assessment.");
    }
    return text;
}
