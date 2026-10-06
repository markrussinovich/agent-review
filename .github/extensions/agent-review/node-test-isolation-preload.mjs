import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import "./node-test-async-origin.mjs";

const wrapper = new URL("./node-test-isolation-wrapper.mjs", import.meta.url).href;
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "node:test" && context.parentURL !== wrapper) {
            return { url: wrapper, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});
if (!process.env.AGENT_REVIEW_NODE_TRACE) {
    throw new Error(`Missing isolated trace output for ${fileURLToPath(import.meta.url)}`);
}
