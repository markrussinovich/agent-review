import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, posix } from "node:path";
import { cppId, cppSourceHash, isCppCallable, resolveCppInclude, scanCpp } from "./cpp-syntax.mjs";
import { isCppSourcePath, isTestPath } from "./web/languages.mjs";

function graph(snapshot) {
    const symbols = snapshot.facts.flatMap((fact) => fact.symbols);
    const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    const paths = new Set(snapshot.facts.map((fact) => fact.path));
    const imports = new Map();
    const edges = [], warnings = [...snapshot.warnings, ...snapshot.facts.flatMap((fact) => fact.warnings)];
    const add = (kind, source, target, location) => edges.push({ kind, source, target, ...location });
    for (const fact of snapshot.facts) {
        const targets = new Set();
        for (const include of fact.includes) {
            const target = resolveCppInclude(fact.path, include.name, paths);
            if (target) {
                targets.add(target);
                add("imports", fact.moduleId, cppId("module", target), {
                    path: fact.path, line: include.line, detail: include.name, conditions: include.conditions,
                });
            } else warnings.push(`${fact.path}:${include.line}: unresolved C/C++ include ${include.name}; target is unknown.`);
        }
        imports.set(fact.path, targets);
    }
    const visiblePaths = (path) => {
        const seen = new Set([path]), pending = [path];
        for (let index = 0; index < pending.length; index++) for (const target of imports.get(pending[index]) || []) {
            if (!seen.has(target)) { seen.add(target); pending.push(target); }
        }
        return seen;
    };
    const sameName = (symbol, name) => symbol.qualname === name || symbol.name === name;
    const definitions = (candidates) => {
        const result = [];
        for (const candidate of candidates) {
            if (candidate.definition || candidate.internal) result.push(candidate);
            else {
                const matches = symbols.filter((symbol) => symbol.definition && symbol.qualname === candidate.qualname
                    && symbol.parameters === candidate.parameters && !symbol.internal);
                result.push(...(matches.length === 1 ? matches : [candidate]));
            }
        }
        return [...new Map(result.map((symbol) => [symbol.id, symbol])).values()];
    };
    for (const fact of snapshot.facts) {
        const visible = symbols.filter((symbol) => visiblePaths(fact.path).has(symbol.path));
        for (const call of fact.calls) {
            const target = call.target.replace(/^this->/, "");
            if (!/^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_~]\w*)*$/.test(target)) continue;
            const caller = byId.get(call.source);
            const scope = caller.qualname.split("::").slice(0, -1);
            const names = target.startsWith("::") ? [target.slice(2)]
                : [...scope.map((_, index) => [...scope.slice(0, scope.length - index), target].join("::")), target];
            let candidates = [];
            for (const name of call.shadowed ? [] : names) {
                candidates = visible.filter((symbol) => isCppCallable(symbol) && sameName(symbol, name));
                if (candidates.length) break;
            }
            candidates = definitions(candidates);
            if (candidates.length === 1) add("calls", call.source, candidates[0].id, {
                path: call.path, line: call.line, detail: call.target, conditions: call.conditions,
            });
            else if (!/^(?:ASSERT_|EXPECT_|REQUIRE|CHECK)/.test(call.target)) {
                warnings.push(`${call.path}:${call.line}: unresolved C/C++ call ${call.target}; target is unknown.`);
            }
        }
        for (const base of fact.bases) {
            const candidates = visible.filter((symbol) => ["class", "struct"].includes(symbol.kind) && sameName(symbol, base.target));
            if (candidates.length === 1) add("inherits", base.source, candidates[0].id, {
                path: base.path, line: base.line, detail: base.target,
            });
            else warnings.push(`${base.path}:${base.line}: unresolved C/C++ base type ${base.target}; target is unknown.`);
        }
    }
    return { ...snapshot, symbols, edges, warnings };
}

function compareDecisions(before = [], after = []) {
    const key = (entry) => JSON.stringify([entry.outcome, entry.value, entry.when, entry.context]);
    const remaining = before.map((decision, index) => ({ decision, index }));
    const entries = [], unmatched = [];
    after.forEach((decision, index) => {
        const previous = remaining.findIndex((entry) => key(entry.decision) === key(decision));
        if (previous < 0) unmatched.push({ decision, index });
        else {
            const old = remaining.splice(previous, 1)[0];
            entries.push({ status: old.index === index ? "unchanged" : "moved", decision, base: old.decision });
        }
    });
    const shape = (decision) => JSON.stringify([decision.when, decision.context]).replace(/-?\d+(?:\.\d+)?/g, "#");
    const pairs = [];
    for (const old of remaining) for (const next of unmatched) {
        if (old.decision.outcome !== next.decision.outcome) continue;
        const value = old.decision.value === next.decision.value;
        const condition = shape(old.decision) === shape(next.decision);
        if (value || condition) pairs.push({ old, next, score: 2 * Number(value) + Number(condition) });
    }
    pairs.sort((a, b) => b.score - a.score
        || Math.abs(a.old.index - a.next.index) - Math.abs(b.old.index - b.next.index));
    const usedOld = new Set(), usedNew = new Set();
    for (const { old, next } of pairs) {
        if (usedOld.has(old) || usedNew.has(next)) continue;
        usedOld.add(old); usedNew.add(next);
        entries.push({ status: "changed", decision: next.decision, base: old.decision });
    }
    entries.push(...unmatched.filter((entry) => !usedNew.has(entry)).map(({ decision }) => ({ status: "added", decision })));
    entries.push(...remaining.filter((entry) => !usedOld.has(entry)).map(({ decision }) => ({ status: "removed", decision })));
    return entries.sort((a, b) => a.decision.line - b.decision.line || a.decision.column - b.decision.column);
}

export async function analyzeCppSnapshot({ baseline = {}, current = {} }) {
    const started = Date.now(), cache = new Map();
    const before = graph(await scanCpp(baseline, cache)), after = graph(await scanCpp(current, cache));
    const old = new Map(before.symbols.map((symbol) => [symbol.id, symbol]));
    const now = new Map(after.symbols.map((symbol) => [symbol.id, symbol]));
    const symbols = [...new Set([...old.keys(), ...now.keys()])].sort().map((id) => {
        const a = old.get(id), b = now.get(id);
        const chosen = b || a;
        const { decisions, complexity, digest, ...symbol } = chosen;
        return { ...symbol, classification: !a ? "added" : !b ? "removed" : a.digest === b.digest ? "unchanged" : "modified",
            signature_base: a?.signature ?? null, signature_current: b?.signature ?? null,
            complexity_base: a?.complexity ?? null, complexity_current: b?.complexity ?? null,
            normalized_ast_hash: digest };
    });
    for (const symbol of symbols) {
        if (!isCppCallable(symbol) || symbol.parent_id || !symbol.qualname.includes("::")) continue;
        const ownerName = symbol.qualname.split("::").slice(0, -1).join("::");
        const owners = symbols.filter((candidate) => ["class", "struct", "union", "namespace"].includes(candidate.kind)
            && candidate.qualname === ownerName);
        if (owners.length === 1) {
            symbol.parent_id = owners[0].id;
            symbol.parent_identity = owners[0].identity;
            if (symbol.kind === "function" && owners[0].kind !== "namespace") symbol.kind = "method";
        }
    }
    const edgeKey = (edge) => JSON.stringify([edge.kind, edge.source, edge.target, edge.detail, edge.conditions || []]);
    const oldEdges = new Map(before.edges.map((edge) => [edgeKey(edge), edge]));
    const newEdges = new Map(after.edges.map((edge) => [edgeKey(edge), edge]));
    const evidence = [], edges = [];
    for (const key of [...new Set([...oldEdges.keys(), ...newEdges.keys()])].sort()) {
        const edge = newEdges.get(key) || oldEdges.get(key);
        const change = !oldEdges.has(key) ? "added" : !newEdges.has(key) ? "removed" : "unchanged";
        const evidenceId = cppId("evidence", key, change);
        evidence.push({ id: evidenceId, kind: "cpp_relationship", path: edge.path, line: edge.line,
            detail: edge.detail, conditions: edge.conditions || [], language: "cpp",
            side: change === "removed" ? "base" : "current", resolution: "saved C/C++ syntax; not compiler resolved" });
        edges.push({ ...edge, id: cppId("edge", key), change, confidence: 0.8, evidence_ids: [evidenceId] });
    }
    const modules = [], components = new Map();
    const allFacts = new Map([...before.facts, ...after.facts].map((fact) => [fact.path, fact]));
    for (const [path, fact] of allFacts) {
        const component = `C / C++: ${posix.dirname(path) === "." ? "root" : posix.dirname(path)}`;
        const state = !(path in baseline) ? "added" : !(path in current) ? "removed"
            : cppSourceHash(baseline[path]) === cppSourceHash(current[path]) ? "unchanged" : "modified";
        modules.push({ id: fact.moduleId, name: fact.module, display_name: path, path, component,
            language: "cpp", dialect: fact.dialect, change: state, symbol_ids: symbols.filter((symbol) => symbol.path === path).map((symbol) => symbol.id) });
        if (!components.has(component)) components.set(component, []);
        components.get(component).push(fact.moduleId);
    }
    const symbolModules = new Map(symbols.map((symbol) => [symbol.id, cppId("module", symbol.path)]));
    const grouped = new Map();
    for (const edge of edges) {
        const source = symbolModules.get(edge.source) || edge.source, target = symbolModules.get(edge.target) || edge.target;
        if (source === target) continue;
        const key = JSON.stringify([edge.kind, source, target]);
        if (!grouped.has(key)) grouped.set(key, { id: cppId("aggregate_edge", key), level: "module",
            kind: edge.kind, source, target, underlying_edge_ids: [], count: 0, added_count: 0, removed_count: 0 });
        const group = grouped.get(key);
        group.underlying_edge_ids.push(edge.id);
        group.count += Number(edge.change !== "removed");
        group.added_count += Number(edge.change === "added");
        group.removed_count += Number(edge.change === "removed");
    }
    const callEdges = new Map();
    for (const edge of after.edges.filter((edge) => edge.kind === "calls")) {
        if (!callEdges.has(edge.source)) callEdges.set(edge.source, new Set());
        callEdges.get(edge.source).add(edge.target);
    }
    const changed = symbols.filter((symbol) => isCppCallable(symbol) && symbol.classification !== "unchanged"
        && !symbol.test && !isTestPath(symbol.path));
    const requested = new Set(changed.map((symbol) => symbol.id));
    const tests = [];
    for (const test of after.facts.flatMap((fact) => fact.tests)) {
        const reached = new Set(), pending = [test.symbol_id];
        for (let index = 0; index < pending.length; index++) for (const target of callEdges.get(pending[index]) || []) {
            if (!reached.has(target)) { reached.add(target); pending.push(target); }
        }
        const linked = [...reached].filter((id) => requested.has(id));
        if (linked.length) tests.push({ ...test, calls: linked, callables: linked,
            link: linked.some((id) => callEdges.get(test.symbol_id)?.has(id)) ? "direct" : "via" });
    }
    let remaining = 2000, limited = false;
    const callables = [];
    for (const symbol of changed) {
        if (remaining <= 0 || Date.now() - started > 20_000) { limited = true; break; }
        const compared = compareDecisions(old.get(symbol.id)?.decisions, now.get(symbol.id)?.decisions);
        const entries = compared.slice(0, Math.min(60, remaining));
        limited ||= entries.length < compared.length;
        remaining -= entries.length;
        const linked = tests.filter((test) => test.callables.includes(symbol.id));
        for (const entry of entries) if (entry.status !== "removed") entry.evidence = {
            level: linked.length ? "reachable" : "none",
            tests: linked.slice(0, 10).map((test) => ({ id: test.id, via: symbol.qualname })),
            omitted_tests: Math.max(0, linked.length - 10),
        };
        callables.push({ id: symbol.id, qualname: symbol.qualname, path: symbol.path, line: symbol.range.start_line,
            language: "cpp", conditions: symbol.conditions, entries,
            counts: Object.fromEntries(["added", "changed", "moved", "removed"].map((status) =>
                [status, entries.filter((entry) => entry.status === status).length])) });
    }
    const warnings = [...new Set([
        ...before.warnings.map((warning) => `[Base] ${warning}`),
        ...after.warnings.map((warning) => `[Current] ${warning}`),
        "C/C++ Tree-sitter analysis uses saved syntax only: macros are not expanded, preprocessor conditions are not evaluated, and overloads, template instantiations and dynamic dispatch are not compiler resolved.",
    ])];
    return { symbols, edges, evidence, warnings,
        aggregates: { modules, components: [...components].map(([name, module_ids]) =>
            ({ id: cppId("component", name), name, module_ids, language: "cpp" })), edges: [...grouped.values()] },
        code_paths: { callables, totals: Object.fromEntries(["added", "changed", "moved", "removed"].map((status) =>
            [status, callables.reduce((sum, item) => sum + item.counts[status], 0)])),
        limited, warnings, elapsed_ms: Date.now() - started,
        verification: { tests, omitted_tests: 0, test_files_examined: after.facts.filter((fact) => fact.tests.length).length, limited: false },
        source_hashes: Object.fromEntries(Object.entries(current).filter(([path]) => isCppSourcePath(path))
            .map(([path, text]) => [path, cppSourceHash(text)])) } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const index = process.argv.indexOf("--input");
        let input = "";
        if (index >= 0) input = await readFile(process.argv[index + 1], "utf8");
        else for await (const chunk of process.stdin) input += chunk.toString("utf8");
        console.log(JSON.stringify(await analyzeCppSnapshot(JSON.parse(input))));
    } catch (error) {
        console.error(`C/C++ analysis failed: ${error.message}`);
        process.exitCode = 1;
    }
}
