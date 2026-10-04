import assert from "node:assert/strict";
import test from "node:test";

import {
    buildSessionContext,
    findSessionAttribution,
    isInternalAgentReviewPrompt,
} from "../session-context.mjs";

const ROOT = "C:\\repo";

test("identifies persisted Agent Review explanation sessions", () => {
    assert.equal(
        isInternalAgentReviewPrompt("[Agent Review internal request — exclude from change attribution]\n\nExplain code."),
        true,
    );
    assert.equal(isInternalAgentReviewPrompt("Add health diagnostics to the workflow service."), false);
});

test("maps a changed file to the user turn whose tool activity referenced it", () => {
    const events = [
        {
            id: "user-1",
            type: "user.message",
            timestamp: "2026-10-03T10:00:00Z",
            data: { content: "Add retry scheduling to workflows." },
        },
        {
            id: "tool-1",
            type: "tool.execution_start",
            timestamp: "2026-10-03T10:01:00Z",
            data: {
                toolName: "apply_patch",
                arguments: {
                    patch: "*** Update File: src\\workflow_service\\scheduling.py\n+class RetryPolicy:\n",
                },
            },
        },
        {
            id: "assistant-1",
            type: "assistant.message",
            timestamp: "2026-10-03T10:02:00Z",
            data: { content: "Implemented retry policies and scheduler backoff." },
        },
    ];
    const context = buildSessionContext(events, ROOT);
    const matches = findSessionAttribution(context, "src/workflow_service/scheduling.py");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].confidence, "likely");
    assert.equal(matches[0].prompt, "Add retry scheduling to workflows.");
    assert.equal(matches[0].agent_activity.length, 2);
    assert.deepEqual(matches[0].referenced_files, ["src/workflow_service/scheduling.py"]);
});

test("uses filename mentions as possible attribution without claiming authorship", () => {
    const context = buildSessionContext([
        {
            id: "user-2",
            type: "user.message",
            timestamp: "2026-10-03T11:00:00Z",
            data: { content: "Please reorganize rules.py for composable policies." },
        },
    ], ROOT);
    const matches = findSessionAttribution(context, "src/workflow_service/rules.py");
    assert.equal(matches[0].confidence, "possible");
    assert.match(matches[0].reason, /mentioned/);
    assert.deepEqual(findSessionAttribution(context, "src/workflow_service/audit.py"), []);
});

test("excludes Agent Review internal model requests from attribution", () => {
    const context = buildSessionContext([
        {
            id: "internal-user",
            type: "user.message",
            timestamp: "2026-10-03T12:00:00Z",
            data: {
                content: "[Agent Review internal request — exclude from change attribution]\nWrite a concrete system-understanding annotation about rules.py",
            },
        },
        {
            id: "internal-assistant",
            type: "assistant.message",
            timestamp: "2026-10-03T12:00:01Z",
            data: { content: "Generated review annotation." },
        },
    ], ROOT);
    assert.deepEqual(context.turns, []);
    assert.deepEqual(context.intent, []);
    assert.deepEqual(findSessionAttribution(context, "src/workflow_service/rules.py"), []);
});

test("ranks authoring intent above later inspection of the same file", () => {
    const context = buildSessionContext([
        {
            id: "authoring-user",
            type: "user.message",
            timestamp: "2026-10-03T09:00:00Z",
            data: { content: "Create a new composable rules feature for workflow validation." },
        },
        {
            id: "authoring-read",
            type: "tool.execution_start",
            timestamp: "2026-10-03T09:01:00Z",
            data: {
                toolName: "rg",
                arguments: { path: "src\\workflow_service\\rules.py" },
            },
        },
        {
            id: "review-user",
            type: "user.message",
            timestamp: "2026-10-03T10:00:00Z",
            data: { content: "Why is this highlighted in the review canvas?" },
        },
        {
            id: "review-read",
            type: "tool.execution_start",
            timestamp: "2026-10-03T10:01:00Z",
            data: {
                toolName: "powershell",
                arguments: {
                    description: "Inspect rules.py review evidence",
                    command: "Get-Content src\\workflow_service\\rules.py",
                },
            },
        },
    ], ROOT);
    const matches = findSessionAttribution(context, "src/workflow_service/rules.py");
    assert.equal(matches[0].prompt, "Create a new composable rules feature for workflow validation.");
    assert.equal(matches.length, 1);
});

test("splits multiple file paths from one command argument", () => {
    const context = buildSessionContext([
        {
            id: "user-multi",
            type: "user.message",
            timestamp: "2026-10-03T08:00:00Z",
            data: { content: "Add workflow rules and scheduling features." },
        },
        {
            id: "tool-multi",
            type: "tool.execution_start",
            timestamp: "2026-10-03T08:01:00Z",
            data: {
                toolName: "powershell",
                arguments: {
                    command: "git add src/workflow_service/rules.py src/workflow_service/scheduling.py tests/test_rules.py",
                    description: "Commit feature files",
                },
            },
        },
    ], ROOT);
    assert.deepEqual(context.turns[0].referenced_files, [
        "src/workflow_service/rules.py",
        "src/workflow_service/scheduling.py",
        "tests/test_rules.py",
    ]);
    assert.equal(findSessionAttribution(context, "src/workflow_service/rules.py")[0].prompt, "Add workflow rules and scheduling features.");
});

test("treats explicit file creation as authoring even when review is mentioned", () => {
    const context = buildSessionContext([
        {
            id: "user-create-review",
            type: "user.message",
            timestamp: "2026-10-03T07:00:00Z",
            data: {
                content: "Add src/workflow_service/health.py and leave it for Agent Review.",
            },
        },
    ], ROOT);
    const match = findSessionAttribution(context, "src/workflow_service/health.py")[0];
    assert.equal(match.confidence, "likely");
    assert.equal(match.review_intent, false);
    assert.match(match.reason, /authoring prompt/);
});

test("tool events carry a concise detail for transcript display", () => {
    const events = [
        { id: "u", type: "user.message", timestamp: "2026-10-03T10:00:00Z", data: { content: "Add a feature." } },
        { id: "t1", type: "tool.execution_start", timestamp: "2026-10-03T10:00:01Z", data: { toolName: "view", arguments: { path: "C:\\repo\\src\\a.py" } } },
        { id: "t2", type: "tool.execution_start", timestamp: "2026-10-03T10:00:02Z", data: { toolName: "powershell", arguments: { command: "python -m unittest\nsecond line" } } },
        { id: "t3", type: "tool.execution_start", timestamp: "2026-10-03T10:00:03Z", data: { toolName: "apply_patch", arguments: { patch: "*** Begin Patch\n*** Update File: src\\a.py\n*** End Patch" } } },
    ];
    const tools = buildSessionContext(events, ROOT).timeline.filter((item) => item.role === "tool");
    assert.deepEqual(tools.map((item) => item.detail), ["src/a.py", "python -m unittest", "update src/a.py"]);
});
