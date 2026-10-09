import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canvasDefinition } from "./canvas-definition.mjs";
import { ensureBundle, validateRelease } from "./runtime.mjs";
import { startSetupServer } from "./setup-server.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const release = validateRelease(JSON.parse(await readFile(join(root, "release-manifest.json"), "utf8")));
const instances = new Map();
const controller = new AbortController();
let session, runtime, preparing;
let progress = { phase: "waiting", message: "Preparing Agent Review..." };

function prepare() {
    if (!preparing) {
        preparing = ensureBundle(release, { signal: controller.signal, onProgress: (value) => { progress = value; } })
            .then(async (directory) => {
                const review = await import(pathToFileURL(join(directory, "review-extension.mjs")));
                await review.initialize(session);
                runtime = review;
                return review;
            })
            .catch((error) => { preparing = null; throw error; });
    }
    return preparing;
}

function launch(instance, ctx) {
    if (instance.loading) return;
    instance.loading = true;
    instance.error = null;
    prepare().then(async (review) => {
        if (instances.get(ctx.instanceId) !== instance) return;
        const result = await review.canvas.open(ctx);
        instance.url = result.url;
    }).catch((error) => {
        instance.error = error.message;
        console.error("[agent-review preparation]", error);
        session.log(`Agent Review preparation failed: ${error.message}`, { level: "error" })
            .catch((logError) => console.error("[agent-review log]", logError));
    }).finally(() => { instance.loading = false; });
}

const canvas = createCanvas({
    ...canvasDefinition,
    actions: canvasDefinition.actions.map((action) => ({
        ...action,
        handler: async (ctx) => {
            if (!runtime) throw new CanvasError("preparation_required", "Open Agent Review and finish first-run preparation before invoking review actions.");
            return runtime.handlers[action.name](ctx);
        },
    })),
    open: async (ctx) => {
        if (runtime) return runtime.canvas.open(ctx);
        let instance = instances.get(ctx.instanceId);
        if (!instance) {
            instance = { loading: false, error: null, url: null };
            instances.set(ctx.instanceId, instance);
            instance.serverPromise = startSetupServer(() => ({
                ...progress, message: instance.error ? "Preparation failed. Resolve the error below and retry." : progress.message,
                error: instance.error, url: instance.url,
                repository: ctx.input?.repoPath || session.workspacePath || process.cwd(),
                source: release.source_commit,
            }), () => launch(instance, ctx)).then((server) => {
                instance.server = server;
                return server;
            }).catch((error) => {
                instances.delete(ctx.instanceId);
                throw error;
            });
        }
        await instance.serverPromise;
        if (instances.get(ctx.instanceId) !== instance) {
            await instance.server.close();
            throw new CanvasError("canvas_not_open", "This preparation canvas has been closed.");
        }
        launch(instance, ctx);
        return { title: "Agent Review", status: "Preparing the verified extension bundle", url: instance.server.url };
    },
    onClose: async (ctx) => {
        const instance = instances.get(ctx.instanceId);
        instances.delete(ctx.instanceId);
        if (instance?.server) await instance.server.close();
        if (runtime) await runtime.canvas.onClose(ctx);
    },
});

session = await joinSession({ canvases: [canvas] });
await session.log("Agent Review ready. First open prepares its pinned release bundle.", { ephemeral: true });
for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
        controller.abort();
        Promise.all([...instances.values()].map((instance) => instance.server?.close()))
            .catch((error) => console.error("[agent-review preparation shutdown]", error));
    });
}
