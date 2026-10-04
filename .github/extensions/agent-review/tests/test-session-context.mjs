import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionContext, findSessionAttribution } from "../session-context.mjs";

const ROOT = "C:\\repo";

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
