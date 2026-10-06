import { join } from "node:path";
import { isTestPath } from "./web/languages.mjs";
import { linkedTestPlan, resolveTestPython, runLinkedTests, testCommand } from "./test-run.mjs";
import { pythonCandidates } from "./python-runtime.mjs";

const MAX_TEST_FILES = 150;
const MAX_TEST_BYTES = 8 * 1024 * 1024;

function callableIdentity(symbol) {
    const parts = String(symbol.qualname || "").split(".");
    return {
        name: parts.at(-1),
        owner: symbol.kind === "method" && parts.length > 1 ? parts.at(-2) : null,
        module: symbol.module || null,
    };
}

function buildCodePathRequest(model, repoRoot) {
    const byPath = new Map();
    const knownClasses = {};
    const symbols = new Map((model?.symbols || []).map((symbol) => [symbol.id, symbol]));
    const callersOf = new Map();
    for (const edge of model?.edges || []) {
        if (edge.type !== "calls") continue;
        if (!callersOf.has(edge.target)) callersOf.set(edge.target, []);
        callersOf.get(edge.target).push(edge.source);
    }
    const callers = (id) => {
        const found = [];
        let frontier = [id];
        for (let depth = 0; depth < 2 && found.length < 10; depth++) {
            const next = [];
            for (const target of frontier) {
                for (const source of callersOf.get(target) || []) {
                    const caller = symbols.get(source);
                    if (!caller || source === id || !["function", "method"].includes(caller.kind) || isTestPath(caller.path)) continue;
                    if (found.some((item) => item.id === source)) continue;
                    found.push({ id: source, ...callableIdentity(caller) });
                    next.push(source);
                }
            }
            frontier = next;
        }
        return found.slice(0, 10).map(({ id: _id, ...item }) => item);
    };
    for (const symbol of model?.symbols || []) {
        if (symbol.kind === "class" && symbol.name && symbol.module) {
            const modules = knownClasses[symbol.name] ||= [];
            if (!modules.includes(symbol.module)) modules.push(symbol.module);
        }
        if (!["function", "method"].includes(symbol.kind) || !["added", "modified", "removed"].includes(symbol.classification)
            || !symbol.path?.endsWith(".py") || isTestPath(symbol.path)) continue;
        if (!byPath.has(symbol.path)) byPath.set(symbol.path, []);
        const { name: _name, ...identity } = callableIdentity(symbol);
        byPath.get(symbol.path).push({ id: symbol.id, qualname: symbol.qualname, change: symbol.classification, ...identity,
            callers: symbol.classification === "removed" ? [] : callers(symbol.id) });
    }
    if (!byPath.size) return null;
    const names = new Set();
    for (const callables of byPath.values()) {
        for (const item of callables) {
            names.add(String(item.qualname).split(".").at(-1));
            if (item.owner) names.add(item.owner);
            for (const caller of item.callers) names.add(caller.name);
        }
    }
    const pattern = new RegExp(`\\b(?:${[...names].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);
    const addedLines = new Map((model.changes || []).map((change) => [change.path, change.added_lines || []]));
    const tests = [];
    let testBytes = 0;
    let testsLimited = false;
    for (const [path, saved] of Object.entries(model.source_files || {})) {
        if (!path.endsWith(".py") || !isTestPath(path) || saved?.binary || typeof saved?.current !== "string") continue;
        if (!pattern.test(saved.current)) continue;
        if (tests.length >= MAX_TEST_FILES || testBytes + saved.current.length > MAX_TEST_BYTES) {
            testsLimited = true;
            continue;
        }
        testBytes += saved.current.length;
        tests.push({ path, current: saved.current, added_lines: addedLines.get(path) || [] });
    }
    return {
        repo: model.metadata?.repo_root || repoRoot,
        base_sha: model.metadata?.base_sha || null,
        files: [...byPath]
            .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
            .map(([path, callables]) => {
                const saved = model.source_files?.[path];
                return { path, current: saved && !saved.binary ? saved.current ?? null : null, callables };
            }),
        tests, tests_limited: testsLimited, known_classes: knownClasses,
        known_modules: (model.nodes || []).filter((node) => node.kind === "module").map((node) => node.name),
    };
}

export const PYTHON_REVIEW_ADAPTER = Object.freeze({
    id: "python",
    buildCodePathRequest,
    sourcePath: (path) => String(path || "").endsWith(".py"),
    codePathProcess: (extensionRoot, input) => ({
        runtime: "python",
        candidates: pythonCandidates(),
        args: [join(extensionRoot, "analyzer", "decisions.py"), "--input", input],
    }),
    tests: Object.freeze({
        plan: linkedTestPlan,
        resolveRuntime: resolveTestPython,
        command: testCommand,
        run: runLinkedTests,
    }),
});
