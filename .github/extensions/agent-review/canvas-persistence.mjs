import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_MARKER_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function markerDirectory() {
    return process.env.AGENT_REVIEW_STATE_DIR || join(homedir(), ".copilot", "agent-review", "canvases");
}

function safe(value) {
    return String(value).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

function markerFile(sessionId, instanceId, directory) {
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
    await writeFile(
        markerFile(marker.sessionId, marker.instanceId, directory),
        JSON.stringify({ ...marker, updatedAt: new Date().toISOString() }),
        "utf8",
    );
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
            if (Date.now() - Date.parse(marker.updatedAt) > MAX_MARKER_AGE_MS) {
                await rm(path, { force: true });
            } else if (marker.sessionId === sessionId) {
                markers.push(marker);
            }
        } catch {
            await rm(path, { force: true });
        }
    }
    return markers;
}
