import assert from "node:assert/strict";
import test from "node:test";

import { ReviewState } from "../review-state.mjs";

test("historical session search times out instead of remaining in loading state", async () => {
    const state = new ReviewState("C:\\repo", {
        currentSessionId: "current-session",
        getSessionEvents: async () => [],
        getHistoricalSessionContexts: () => new Promise(() => {}),
        historicalSessionTimeoutMs: 20,
    });

    await state.refreshSessionContext(false);
    assert.equal(state.attributionStatusForPath("src/feature.py").status, "loading");

    await new Promise((resolve) => setTimeout(resolve, 40));

    const status = state.attributionStatusForPath("src/feature.py");
    assert.equal(status.status, "error");
    assert.match(status.message, /exceeded 20 milliseconds/);
    assert.equal(state.sessionContext.historical_search_complete, true);
});
