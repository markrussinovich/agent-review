import { fork, spawn, execFile } from "node:child_process";
import { stat, rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";

const guardPath = fileURLToPath(import.meta.url);

function forkGuard(config, stdio) {
    return fork(guardPath, [JSON.stringify(config)], {
        execPath: isSea() || process.versions.bun ? "node" : process.execPath,
        execArgv: [],
        stdio,
        windowsHide: true,
        // Windows otherwise places the guard in the provider's kill-on-close job.
        detached: true,
    });
}

export function spawnOwnedAnalyzer(executable, args, { workspacePath } = {}) {
    const guard = forkGuard({ executable, args, workspacePath }, ["ignore", "pipe", "pipe", "ipc"]);
    guard.stop = () => {
        if (guard.connected) guard.send({ type: "stop" });
    };
    return guard;
}

export function watchSessionOwnership(workspacePath, onDeleted) {
    const pendingMarkers = new Map();
    const guard = forkGuard({ workspacePath, watch: true, providerPid: process.pid }, ["ignore", "ignore", "pipe", "ipc"]);
    let startupError;
    guard.stderr.on("data", (chunk) => console.error("[agent-review ownership]", chunk.toString().trim()));
    guard.on("error", (error) => {
        startupError = error.code === "ENOENT"
            ? new Error("Unable to start the ownership guard. Install Node.js 20+ and ensure node is available on PATH.", { cause: error })
            : error;
        console.error("[agent-review ownership]", startupError);
    });
    guard.on("message", (message) => {
        if (message.type === "marker-registered") {
            pendingMarkers.get(message.path)?.resolve();
            pendingMarkers.delete(message.path);
        }
        if (message.type === "owner-deleted") {
            Promise.resolve(onDeleted()).catch((error) => console.error("[agent-review cleanup]", error));
        }
    });
    guard.on("close", (code, signal) => {
        startupError ||= new Error(`Ownership guard exited before registering the Canvas marker (code ${code}, signal ${signal || "none"}).`);
        for (const pending of pendingMarkers.values()) pending.reject(startupError);
        pendingMarkers.clear();
    });
    return {
        registerMarker(path) {
            if (!guard.connected) return Promise.reject(startupError || new Error("Ownership guard is disconnected."));
            return new Promise((resolve, reject) => {
                pendingMarkers.set(path, { resolve, reject });
                guard.send({ type: "marker", path });
            });
        },
        unregisterMarker(path) { if (guard.connected) guard.send({ type: "unmark", path }); },
        async close({ preserveMarkers = false } = {}) {
            if (preserveMarkers) {
                guard.unref();
                guard.channel?.unref();
                return;
            }
            if (guard.exitCode !== null) return;
            const closed = new Promise((resolve) => guard.once("close", resolve));
            if (guard.connected) guard.send({ type: "stop" });
            await closed;
        },
    };
}

async function guardMain(config) {
    const markers = new Set();
    let child;
    let stopping;
    let timer;
    let orphaned = false;
    const log = (error) => console.error("[agent-review ownership]", error.message || error);
    const removeMarkers = async () => {
        await Promise.all([...markers].map((path) => rm(path, { force: true }).catch(log)));
    };
    const killTree = async () => {
        if (!child?.pid) return;
        if (process.platform === "win32") {
            await new Promise((resolve, reject) => {
                execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, (error) => {
                    if (error && child.exitCode === null && child.signalCode === null) reject(error);
                    else resolve();
                });
            });
        } else {
            const kill = (signal) => {
                try { process.kill(-child.pid, signal); }
                catch (error) { if (error.code !== "ESRCH") throw error; }
            };
            kill("SIGTERM");
            await new Promise((resolve) => setTimeout(resolve, 350));
            kill("SIGKILL");
        }
    };
    const stop = (code = 130, cleanup = true) => {
        if (stopping) return stopping;
        stopping = (async () => {
            clearInterval(timer);
            try { await killTree(); }
            catch (error) { log(error); code = 1; child?.kill("SIGKILL"); }
            if (cleanup) await removeMarkers();
            process.stdout.write("", () => process.exit(code));
        })();
        return stopping;
    };
    process.on("message", (message) => {
        if (message.type === "stop") void stop();
        if (message.type === "marker") {
            markers.add(message.path);
            if (process.connected) process.send({ type: "marker-registered", path: message.path });
        }
        if (message.type === "unmark") markers.delete(message.path);
    });
    process.on("disconnect", () => {
        if (config.watch && config.workspacePath && markers.size) {
            // Keep watching after a provider restart; only session deletion owns cleanup.
            orphaned = true;
        } else void stop(130, !config.watch);
    });
    process.on("SIGTERM", () => void stop());
    process.on("SIGINT", () => void stop());
    process.stdout.on("error", (error) => {
        if (error.code !== "EPIPE") log(error);
        void stop();
    });
    process.stderr.on("error", () => void stop());
    let checking = false;
    if (config.workspacePath) {
        timer = setInterval(async () => {
            if (checking || stopping) return;
            checking = true;
            try {
                await stat(config.workspacePath);
                if (orphaned) {
                    for (const path of markers) {
                        try {
                            const marker = JSON.parse(await readFile(path, "utf8"));
                            if (marker.providerPid !== config.providerPid) markers.delete(path);
                        } catch (error) {
                            if (error.code === "ENOENT") markers.delete(path);
                            else log(error);
                        }
                    }
                    if (!markers.size) void stop(0, false);
                }
            } catch (error) {
                if (error.code === "ENOENT") {
                    if (process.connected) process.send({ type: "owner-deleted" });
                    void stop();
                } else log(error);
            } finally { checking = false; }
        }, 200);
    }
    if (config.watch) return;
    child = spawn(config.executable, config.args, {
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once("spawn", () => {
        if (process.connected) process.send({ type: "analyzer-started", pid: child.pid });
    });
    child.once("error", (error) => {
        if (process.connected) process.send({ type: "spawn-error", code: error.code, message: error.message });
        void stop(1, false);
    });
    child.once("close", (code) => void stop(code ?? 1, false));
}

if (process.argv[1] === guardPath && process.argv[2]) {
    guardMain(JSON.parse(process.argv[2])).catch((error) => {
        console.error("[agent-review ownership]", error);
        process.exit(1);
    });
}
