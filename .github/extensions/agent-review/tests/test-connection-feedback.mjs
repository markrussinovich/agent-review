import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionFeedback } from "../web/connection-feedback.mjs";

function fixture() {
    const changes = [];
    const timers = new Map();
    let id = 0;
    const feedback = new ConnectionFeedback({
        onChange: (phase) => changes.push(phase),
        setTimer: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
        clearTimer: (timer) => timers.delete(timer),
    });
    return { feedback, changes, timers };
}

test("transient startup failures stay neutral and recovery cancels the warning", () => {
    const { feedback, timers, changes } = fixture();
    feedback.failed();
    feedback.failed();
    assert.equal(feedback.phase, "connecting");
    assert.equal(timers.size, 1, "repeated failures don't restart the grace period");
    assert.equal([...timers.values()][0].delay, 3000);
    feedback.connected();
    assert.equal(timers.size, 0);
    assert.equal(feedback.phase, "connected");
    assert.equal(feedback.hasConnected, true);
    assert.ok(!changes.includes("lost"));
});

test("persistent failures become explicit and later failures do not hide the warning", () => {
    const { feedback, timers, changes } = fixture();
    feedback.failed();
    [...timers.values()][0].callback();
    assert.equal(feedback.phase, "lost");
    const count = changes.length;
    feedback.failed();
    assert.equal(feedback.phase, "lost");
    assert.equal(changes.length, count);
    feedback.connected();
    assert.equal(feedback.phase, "connected");
    feedback.failed();
    assert.equal(feedback.phase, "reconnecting");
});
