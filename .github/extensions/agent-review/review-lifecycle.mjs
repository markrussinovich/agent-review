import { markerFile, removeCanvasMarker } from "./canvas-persistence.mjs";
import { watchSessionOwnership } from "./ownership-guard.mjs";

export class ReviewLifecycle {
    constructor(session, instances, reviewStates, pendingInstances) {
        this.session = session;
        this.instances = instances;
        this.reviewStates = reviewStates;
        this.pendingInstances = pendingInstances;
        this.closedInstances = new Set();
        this.closed = false;
        this.owners = new Map();
        // The SDK reports Canvas closes, but session deletion has no provider event.
        this.guard = watchSessionOwnership(session.workspacePath, () => this.dispose());
    }

    register(instanceId) {
        return this.guard.registerMarker(markerFile(this.session.sessionId, instanceId));
    }

    acquire(instanceId, state) {
        this.owners.set(instanceId, state);
    }

    async closeInstance(instanceId, { preserveMarker = false } = {}) {
        this.closedInstances.add(instanceId);
        const pending = this.pendingInstances.get(instanceId);
        if (pending) {
            try { await pending; }
            catch (error) { console.error("[agent-review pending Canvas]", error); }
        }
        const instance = this.instances.get(instanceId);
        const ownedState = this.owners.get(instanceId);
        this.owners.delete(instanceId);
        if (instance) {
            this.instances.delete(instanceId);
            instance.unsubscribeMarker?.();
        }
        if (ownedState && ![...this.owners.values()].includes(ownedState)) {
            for (const [key, state] of this.reviewStates) {
                if (state === ownedState) this.reviewStates.delete(key);
            }
            await ownedState.dispose();
        }
        if (instance) await instance.server.close();
        if (!preserveMarker) {
            await removeCanvasMarker(this.session.sessionId, instanceId);
            this.guard.unregisterMarker(markerFile(this.session.sessionId, instanceId));
        }
    }

    async dispose({ preserveMarkers = false } = {}) {
        if (this.disposePromise) return this.disposePromise;
        this.closed = true;
        this.disposePromise = (async () => {
            const ids = new Set([...this.instances.keys(), ...this.pendingInstances.keys()]);
            const results = await Promise.allSettled([...ids].map((id) => this.closeInstance(id, { preserveMarker: preserveMarkers })));
            for (const result of results) {
                if (result.status === "rejected") console.error("[agent-review cleanup]", result.reason);
            }
            await Promise.all([...this.reviewStates.values()].map((state) => state.dispose()));
            this.reviewStates.clear();
            await this.guard.close({ preserveMarkers });
        })();
        return this.disposePromise;
    }
}
