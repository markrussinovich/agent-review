import { AsyncLocalStorage, createHook } from "node:async_hooks";

const origin = new AsyncLocalStorage();
const setupResources = new Set();
let active = false;
let overlap = false;
createHook({
    init(id, type, trigger) {
        if (origin.getStore() === "test") return;
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 100;
        const frames = new Error().stack?.replace(/\\/g, "/").toLowerCase().split("\n") || [];
        Error.stackTraceLimit = limit;
        const fromRepository = !frames.some((frame) => frame.includes("node:internal/test_runner"))
            && frames.some((frame) => /(?:file:\/|[a-z]:\/|\(\/|at \/)/.test(frame)
            && !/node-test-(?:async-origin|isolation-|runtime-launch)/.test(frame));
        if (setupResources.has(trigger) || fromRepository) setupResources.add(id);
    },
    before(id) { if (active && setupResources.has(id)) overlap = true; },
    destroy(id) { setupResources.delete(id); },
}).enable();

export function activateCapture() {
    active = true;
    overlap = false;
}

export function beginCallback(callback) {
    return origin.run("test", callback);
}

export function finishCallback() {
    active = false;
    return overlap;
}
