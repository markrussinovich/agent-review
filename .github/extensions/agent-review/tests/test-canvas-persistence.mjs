import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    preferredPort,
    providerMarkerDirectory,
    readCanvasMarkers,
    markerFile,
    removeCanvasMarker,
    writeCanvasMarker,
} from "../canvas-persistence.mjs";
import { startReviewServer } from "../server.mjs";

const fakeState = () => ({
    model: null,
    loading: false,
    subscribe: () => () => {},
    snapshot: () => ({ model: null, loading: false }),
    refresh: async () => {},
    startWorktreeMonitoring: () => () => {},
});

test("reading one session prunes stale markers from every session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-review-"));
    try {
        await writeCanvasMarker({ sessionId: "current", instanceId: "canvas", port: 41234, input: {} }, directory);
        await writeCanvasMarker({ sessionId: "other", instanceId: "stale", port: 41235, input: {} }, directory);
        const stalePath = markerFile("other", "stale", directory);
        const stale = JSON.parse(await readFile(stalePath, "utf8"));
        stale.updatedAt = "2020-01-01T00:00:00.000Z";
        await writeFile(stalePath, JSON.stringify(stale));

        assert.deepEqual((await readCanvasMarkers("current", directory)).map((marker) => marker.port), [41234]);
        await assert.rejects(readFile(stalePath, "utf8"), { code: "ENOENT" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("preferred port is stable per repository and inside the private range", () => {
    const first = preferredPort("C:\\Repo", "main");
    assert.equal(first, preferredPort("c:\\repo", "main"));
    assert.notEqual(first, preferredPort("C:\\Repo", "other"));
    assert.ok(first >= 41000 && first < 49000);
});

test("markers are scoped to a session and removed on close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-review-"));
    try {
        await writeCanvasMarker({ sessionId: "s1", instanceId: "i1", port: 41234, input: {} }, directory);
        await writeCanvasMarker({ sessionId: "s2", instanceId: "i2", port: 41235, input: {} }, directory);
        const own = await readCanvasMarkers("s1", directory);
        assert.deepEqual(own.map((marker) => marker.port), [41234]);
        await removeCanvasMarker("s1", "i1", directory);
        assert.deepEqual(await readCanvasMarkers("s1", directory), []);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("providers in the same session keep their recovery markers separate", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-review-"));
    try {
        const preview = providerMarkerDirectory("user:agent-review-preview", root);
        const installed = providerMarkerDirectory("plugin:agent-review:agent-review", root);
        await writeCanvasMarker({ sessionId: "s1", instanceId: "canvas", port: 41234 }, preview);
        await writeCanvasMarker({ sessionId: "s1", instanceId: "canvas", port: 41235 }, installed);
        assert.deepEqual((await readCanvasMarkers("s1", preview)).map((marker) => marker.port), [41234]);
        assert.deepEqual((await readCanvasMarkers("s1", installed)).map((marker) => marker.port), [41235]);
        assert.deepEqual(await readCanvasMarkers("s1", root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("reading a marker during updates never observes a partially written target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-review-"));
    const marker = (ref) => ({ sessionId: "s1", instanceId: "canvas", port: 41234, input: { ref, padding: "x".repeat(8000) } });
    try {
        await writeCanvasMarker(marker("before"), directory);
        const reader = (async () => {
            for (let index = 0; index < 15; index++) {
                const value = JSON.parse(await readFile(markerFile("s1", "canvas", directory), "utf8"));
                assert.ok(["before", "after"].includes(value.input.ref));
                assert.equal(value.input.padding.length, 8000);
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        })();
        const writer = (async () => {
            for (let index = 0; index < 20; index++) await writeCanvasMarker(marker(index % 2 ? "before" : "after"), directory);
        })();
        await Promise.all([reader, writer]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("a replacement server reclaims the same port after the original stops", async () => {
    const original = await startReviewServer(fakeState());
    const { port, url } = original;
    const pending = startReviewServer(fakeState(), { port, exactPort: true, waitMs: 5000 });
    // The replacement keeps retrying while the original still holds the port.
    await new Promise((resolve) => setTimeout(resolve, 700));
    await original.close();
    const replacement = await pending;
    try {
        assert.equal(replacement.url, url);
        const response = await fetch(`${url}api/state`);
        assert.equal(response.status, 200);
    } finally {
        await replacement.close();
    }
});

test("a fresh server falls back to a random port when the preferred port is busy", async () => {
    const holder = await startReviewServer(fakeState());
    const other = await startReviewServer(fakeState(), { port: holder.port });
    try {
        assert.notEqual(other.port, holder.port);
    } finally {
        await other.close();
        await holder.close();
    }
});

test("a new event stream immediately receives the current snapshot", async () => {
    const server = await startReviewServer(fakeState());
    const controller = new AbortController();
    try {
        const response = await fetch(`${server.url}events`, { signal: controller.signal });
        const reader = response.body.getReader();
        let text = "";
        while (!text.includes("event: state")) {
            const { value, done } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(value);
        }
        assert.match(text, /"type":"connected"/);
    } finally {
        controller.abort();
        await server.close();
    }
});
