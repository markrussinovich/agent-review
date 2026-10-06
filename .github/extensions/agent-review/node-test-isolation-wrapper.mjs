import originalTest from "node:test";
import { Session } from "node:inspector";
import { writeFile } from "node:fs/promises";
import { activateCapture, beginCallback, finishCallback } from "./node-test-async-origin.mjs";

let registered = 0;
let unsupportedUse = false;
const unsupported = () => {
    unsupportedUse = true;
    throw new Error("Agent Review supports one top-level ESM node:test per file, without suites, subtests, or concurrency.");
};

function test(name, options, callback) {
    if (++registered !== 1 || typeof name !== "string") unsupported();
    if (typeof options === "function") { callback = options; options = {}; }
    options ||= {};
    if (options.skip && callback === undefined) return originalTest(name, options);
    if (typeof callback !== "function" || options.concurrency || options.todo) unsupported();
    return originalTest(name, options, async (context) => {
        const inspector = new Session();
        inspector.connect();
        const post = (method, params = {}) => new Promise((resolve, reject) => {
            inspector.post(method, params, (error, result) => error ? reject(error) : resolve(result));
        });
        try {
            await post("Profiler.enable");
            activateCapture();
            await post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
            const isolatedContext = new Proxy(context, {
                get(target, key) {
                    if (["test", "before", "after", "beforeEach", "afterEach"].includes(key)) return unsupported;
                    const value = Reflect.get(target, key, target);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            try {
                await beginCallback(() => callback(isolatedContext));
            } finally {
                const coverage = await post("Profiler.takePreciseCoverage");
                const asyncOverlap = finishCallback();
                await post("Profiler.stopPreciseCoverage");
                coverage.unsupported = unsupportedUse;
                coverage.async_overlap = asyncOverlap;
                await writeFile(process.env.AGENT_REVIEW_NODE_TRACE, JSON.stringify(coverage));
            }
        } finally {
            finishCallback();
            inspector.disconnect();
        }
    });
}

test.skip = (name, options, callback) => typeof options === "function"
    ? test(name, { skip: true }, options) : test(name, { ...options, skip: true }, callback);
test.only = unsupported;
test.todo = unsupported;
export { test, test as it };
export const describe = unsupported;
export const suite = unsupported;
export const before = unsupported;
export const after = unsupported;
export const beforeEach = unsupported;
export const afterEach = unsupported;
export default test;
