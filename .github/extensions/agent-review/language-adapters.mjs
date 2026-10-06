import { PYTHON_REVIEW_ADAPTER } from "./python-review-adapter.mjs";
import { languageForPath } from "./web/languages.mjs";

export const REVIEW_ADAPTERS = Object.freeze([PYTHON_REVIEW_ADAPTER]);

export function reviewAdapter(id = "python") {
    const adapter = REVIEW_ADAPTERS.find((candidate) => candidate.id === id);
    if (!adapter) throw new Error(`No review adapter is installed for ${id}.`);
    return adapter;
}

export function sourceAdapter(path) {
    const language = languageForPath(path);
    return language ? reviewAdapter(language.id) : null;
}

// Requests stay per-language so each compiler resolves only its own symbols and project configuration.
export function buildCodePathRequests(model, repoRoot, adapters = REVIEW_ADAPTERS) {
    const ids = new Set();
    const requests = [];
    for (const adapter of adapters) {
        if (ids.has(adapter.id)) throw new Error(`Duplicate review adapter: ${adapter.id}.`);
        ids.add(adapter.id);
        const request = adapter.buildCodePathRequest(model, repoRoot);
        if (request) requests.push({ ...request, adapter_id: adapter.id });
    }
    return requests;
}

export function mergeCodePathMaps(maps) {
    if (!maps.length) return { callables: [], totals: {}, limited: false, warnings: [], elapsed_ms: 0 };
    if (maps.length === 1) return maps[0];
    const result = {
        adapter_ids: maps.map((map) => map.adapter_id),
        callables: [], totals: {}, limited: false, warnings: [], elapsed_ms: 0,
        verification: { tests: [], omitted_tests: 0, test_files_examined: 0, limited: false },
    };
    const callableIds = new Set();
    for (const map of maps) {
        for (const callable of map.callables || []) {
            if (callableIds.has(callable.id)) throw new Error(`Language adapters produced a duplicate callable ID: ${callable.id}.`);
            callableIds.add(callable.id);
            result.callables.push({ ...callable, adapter_id: map.adapter_id });
        }
        for (const [key, value] of Object.entries(map.totals || {})) result.totals[key] = (result.totals[key] || 0) + value;
        result.limited ||= Boolean(map.limited);
        result.warnings.push(...map.warnings || []);
        result.elapsed_ms += map.elapsed_ms || 0;
        const verification = map.verification;
        if (verification) {
            result.verification.tests.push(...(verification.tests || []).map((test) => ({ ...test, adapter_id: map.adapter_id })));
            result.verification.omitted_tests += verification.omitted_tests || 0;
            result.verification.test_files_examined += verification.test_files_examined || 0;
            result.verification.limited ||= Boolean(verification.limited);
        }
    }
    return result;
}

export function testAdapterForMap(map) {
    const ids = map?.adapter_ids || [map?.adapter_id || "python"];
    if (ids.length !== 1) {
        throw new Error("This review spans multiple test adapters. Run linked tests per language; combined execution is not implemented yet.");
    }
    return reviewAdapter(ids[0]);
}
