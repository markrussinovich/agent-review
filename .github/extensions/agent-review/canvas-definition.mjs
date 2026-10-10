export const canvasDefinition = {
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
        { name: "cancel", description: "Cancel the active deterministic analysis. Reanalyze explicitly to start again." },
        { name: "refresh", description: "Re-analyze the selected worktree, commit, or PR snapshot and update the open Agent Review canvas." },
        {
            name: "get_review_context",
            description: "Get deterministic evidence and relationships for a selected review node, edge, package, finding, or evidence id. Omit id to summarize the review.",
            inputSchema: { type: "object", properties: { id: { type: "string", description: "ReviewModel item id." } },
                additionalProperties: false },
        },
        { name: "get_session_change_context",
            description: "Get Copilot session intent and agent activity associated with the change. This is contextual provenance, not deterministic code evidence." },
        {
            name: "focus_item", description: "Focus an item in the open canvas so the human can inspect the same evidence.",
            inputSchema: { type: "object", properties: { id: { type: "string" }, kind: { type: "string" } },
                required: ["id"], additionalProperties: false },
        },
        {
            name: "add_review_observation",
            description: "Add a model-written review observation to the canvas. Factual claims must cite deterministic evidence ids returned by get_review_context.",
            inputSchema: {
                type: "object",
                properties: {
                    title: { type: "string" }, body: { type: "string" },
                    severity: { type: "string", enum: ["info", "low", "medium", "high"] },
                    evidence_ids: { type: "array", items: { type: "string" }, minItems: 1 },
                },
                required: ["title", "body", "evidence_ids"], additionalProperties: false,
            },
        },
    ],
};
