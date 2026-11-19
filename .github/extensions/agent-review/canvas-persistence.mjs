import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { renameWithRetry } from "./atomic-file.mjs";

const MAX_MARKER_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function markerDirectory() {
    return process.env.AGENT_REVIEW_STATE_DIR || join(homedir(), ".copilot", "agent-review", "canvases");
}

export function providerMarkerDirectory(extensionId, directory = markerDirectory()) {
    const key = createHash("sha256").update(extensionId).digest("base64url").slice(0, 22);
    return join(directory, "providers", key);
}

function safe(value) {
    return String(value).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

export function markerFile(sessionId, instanceId, directory = markerDirectory()) {
    return join(directory, `${safe(sessionId)}__${safe(instanceId)}.json`);
}

// A stable per-repository port keeps a persisted Canvas URL valid after the host
// restarts the extension process, so a replacement provider can serve the same URL.
export function preferredPort(repoPath, baseRef = "") {
    const digest = createHash("sha1").update(`${String(repoPath).toLowerCase()}|${baseRef || ""}`).digest();
    return 41000 + (digest.readUInt16BE(0) % 8000);
}

export async function writeCanvasMarker(marker, directory = markerDirectory()) {
    await mkdir(directory, { recursive: true });
    const path = markerFile(marker.sessionId, marker.instanceId, directory);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify({ ...marker, providerPid: process.pid, updatedAt: new Date().toISOString() }), "utf8");
        await renameWithRetry(temporary, path);
    } catch (error) {
        await rm(temporary, { force: true }).catch((cleanupError) =>
            console.error("[agent-review] Unable to remove temporary Canvas marker:", cleanupError));
        throw error;
    }
}

export async function removeCanvasMarker(sessionId, instanceId, directory = markerDirectory()) {
    await rm(markerFile(sessionId, instanceId, directory), { force: true });
}

export async function readCanvasMarkers(sessionId, directory = markerDirectory()) {
    let names;
    try {
        names = await readdir(directory);
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
    const markers = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
        const path = join(directory, name);
        try {
            const marker = JSON.parse(await readFile(path, "utf8"));
            const updated = Date.parse(marker.updatedAt);
            if (!Number.isFinite(updated) || Date.now() - updated > MAX_MARKER_AGE_MS) {
                await rm(path, { force: true });
                continue;
            }
            if (marker.sessionId === sessionId
                && path === markerFile(marker.sessionId, marker.instanceId, directory)) {
                markers.push(marker);
            }
        } catch (error) {
            console.error("[agent-review] Unable to read Canvas marker:", path, error.message);
        }
    }
    return markers;
}
