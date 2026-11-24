import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { posix, resolve } from "node:path";
import { scanSwift, swiftHash, swiftId, swiftCallable, isSwiftPath } from "./swift-syntax.mjs";
import { swiftPackages, swiftPackageDiff } from "./swift-packages.mjs";
import { compareDecisions } from "./syntax-decisions.mjs";

export const SWIFT_LIMITATION = "Swift Tree-sitter analysis uses saved syntax only. Calls, inheritance/conformance and test links are inferred, not compiler resolved. Type inference, overload resolution, dynamic dispatch, macro expansion, actor isolation and Sendable correctness are not analyzed. Decisions show lexical conditions, not exhaustive control flow. Package.swift is never evaluated during scanning; Swift/Xcode is not invoked.";

function graph(snapshot, files) {
    const dependencies = swiftPackages({ ...snapshot, files });
    const symbols = snapshot.facts.flatMap((fact) => fact.symbols), byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    const warnings = [...snapshot.warnings, ...snapshot.facts.flatMap((fact) => fact.warnings), ...dependencies.warnings];
    const membership = new Map();
    for (const fact of snapshot.facts) {
        const matches = dependencies.targets.filter((target) => !target.error
            && (fact.path === target.path || fact.path.startsWith(`${target.path}/`)));
        if (matches.length === 1) membership.set(fact.path, matches[0]);
        else if (matches.length > 1) warnings.push(`${fact.path}: overlapping SwiftPM target paths are ambiguous.`);
    }
    const edges = [], tests = [];
    const add = (kind, source, target, location) => edges.push({ kind, source, target, ...location });
    const sameTarget = (a, b) => a && b && a.manifest === b.manifest && a.name === b.name;
    for (const fact of snapshot.facts) {
        const owner = membership.get(fact.path), imported = new Set();
        for (const use of fact.imports) {
            const targets = dependencies.targets.filter((target) => !target.error && owner && target.manifest === owner.manifest
                && target.name === use.name && owner.dependencies.some((dep) => dep.target === use.name));
            if (targets.length === 1) {
                imported.add(targets[0]);
                for (const [path, target] of membership) if (sameTarget(target, targets[0])) add("imports",
                    swiftId("module", fact.path), swiftId("module", path), { path: fact.path, line: use.line, detail: `import ${use.name}` });
            } else {
                const products = owner?.dependencies.filter((dep) => dep.product === use.name) || [];
                const declarations = products.length === 1 ? dependencies.packages.filter((dep) =>
                    dep.evidence_kind === "declaration" && [dep.name, dep.declared_name?.toLowerCase()].includes(products[0].package)
                    && dep.source === owner.manifest) : [];
                if (declarations.length === 1) {
                    add("uses_package", swiftId("module", fact.path), declarations[0].id,
                        { path: fact.path, line: use.line, detail: `import ${use.name}; literal SwiftPM product declaration (inferred)` });
                    (declarations[0].used_by ||= []).push(`${fact.path}:${use.line}`);
                } else if (!["XCTest", "Testing", "PackageDescription", "Swift"].includes(use.name)) {
                    warnings.push(`${fact.path}:${use.line}: Swift import ${use.name} has no unambiguous saved target/product mapping.`);
                }
            }
        }
        const visible = symbols.filter((symbol) => (symbol.path === fact.path || (!symbol.file_private
            && (sameTarget(owner, membership.get(symbol.path)) || [...imported].some((target) => sameTarget(target, membership.get(symbol.path))))))
            && !symbol.conditions.length);
        for (const call of fact.calls) {
            if (call.shadowed || !/^(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*$/.test(call.target)) continue;
            const caller = byId.get(call.source), scope = caller.qualname.split(".").slice(0, -1);
            if (caller.kind === "closure") continue;
            const name = call.target.replace(/^self\./, "");
            const lexicalScope = caller.kind === "accessor" ? scope.slice(0, -1) : scope;
            const names = call.target.startsWith("self.") ? [[...lexicalScope, name].join(".")]
                : [...lexicalScope.map((_, index) => [...lexicalScope.slice(0, lexicalScope.length - index), name].join(".")), name];
            let candidates = [];
            for (const query of names) {
                candidates = visible.filter((symbol) => swiftCallable(symbol) && symbol.definition && symbol.qualname === query
                    && (!query.includes(".") || !call.target.includes(".") || call.target.startsWith("self.") || symbol.static));
                if (candidates.length) break;
            }
            if (candidates.length === 1) add("calls", call.source, candidates[0].id,
                { path: call.path, line: call.line, detail: call.target });
            else if (!/^(?:XCTAssert|XCTFail|expect|require)/.test(call.target)) {
                warnings.push(`${fact.path}:${call.line}: Swift call ${call.target} is unresolved; no type-directed or dynamic target was inferred.`);
            }
        }
        for (const symbol of fact.symbols) for (const name of symbol.inherited || []) {
            const candidates = visible.filter((candidate) => ["class", "struct", "enum", "actor", "protocol"].includes(candidate.kind)
                && candidate.qualname === name);
            if (candidates.length === 1) add("inherits", symbol.id, candidates[0].id,
                { path: fact.path, line: symbol.range.start_line, detail: `declared inheritance/conformance: ${name} (inferred)` });
        }
        for (const test of fact.tests) {
            const importedFramework = fact.imports.some((use) => use.name === (test.framework === "xctest" ? "XCTest" : "Testing"));
            if (!importedFramework) continue;
            const error = test.selector_error || (!owner?.test ? "No unambiguous literal SwiftPM test target contains this test." : null);
            tests.push({ ...test, manifest: owner?.manifest || null, target: owner?.name || null, selector_error: error,
                inference: "saved Swift syntax; test registration and execution are not observed" });
        }
    }
    return { ...snapshot, symbols, edges, tests, membership, dependencies, warnings };
}

export async function analyzeSwiftSnapshot({ baseline = {}, current = {} }) {
    const started = Date.now(), cache = new Map();
    const before = graph(await scanSwift(baseline, cache), baseline), after = graph(await scanSwift(current, cache), current);
    const unknownPackages = new Set([...before.dependencies.unresolved_sources, ...after.dependencies.unresolved_sources]);
    for (const snapshot of [before, after]) {
        snapshot.dependencies.packages = snapshot.dependencies.packages.filter((item) => !unknownPackages.has(item.source));
        const known = new Set(snapshot.dependencies.packages.map((item) => item.id));
        snapshot.edges = snapshot.edges.filter((edge) => edge.kind !== "uses_package" || known.has(edge.target));
    }
    const old = new Map(before.symbols.map((symbol) => [symbol.id, symbol])), now = new Map(after.symbols.map((symbol) => [symbol.id, symbol]));
    const symbols = [...new Set([...old.keys(), ...now.keys()])].sort().map((id) => {
        const a = old.get(id), b = now.get(id), { decisions, complexity, digest, ...symbol } = b || a;
        return { ...symbol, classification: !a ? "added" : !b ? "removed" : a.digest === b.digest ? "unchanged" : "modified",
            signature_base: a?.signature ?? null, signature_current: b?.signature ?? null,
            complexity_base: a?.complexity ?? null, complexity_current: b?.complexity ?? null, normalized_ast_hash: digest };
    });
    const edgeKey = (edge) => JSON.stringify([edge.kind, edge.source, edge.target, edge.path, edge.line, edge.detail]);
    const oldEdges = new Map(before.edges.map((edge) => [edgeKey(edge), edge])), newEdges = new Map(after.edges.map((edge) => [edgeKey(edge), edge]));
    const evidence = [], edges = [];
    for (const key of [...new Set([...oldEdges.keys(), ...newEdges.keys()])].sort()) {
        const edge = newEdges.get(key) || oldEdges.get(key), change = !oldEdges.has(key) ? "added" : !newEdges.has(key) ? "removed" : "unchanged";
        const id = swiftId("evidence", key, change);
        evidence.push({ id, kind: "swift_relationship", path: edge.path, line: edge.line, detail: edge.detail || edge.target,
            side: change === "removed" ? "base" : "current", language: "swift", resolution: "saved Swift syntax (inferred); not compiler resolved" });
        edges.push({ ...edge, id: swiftId("edge", key), change, confidence: 0.65, evidence_ids: [id] });
    }
    const modules = [], components = new Map(), groups = new Map();
    for (const [path] of new Map([...before.facts, ...after.facts].map((fact) => [fact.path, fact]))) {
        const target = after.membership.get(path) || before.membership.get(path);
        const component = target ? `Swift: ${target.manifest}:${target.name}` : `Swift: ${posix.dirname(path)}`;
        const id = swiftId("module", path);
        modules.push({ id, name: path, display_name: path, path, component, language: "swift",
            change: !(path in baseline) ? "added" : !(path in current) ? "removed" : swiftHash(baseline[path]) === swiftHash(current[path]) ? "unchanged" : "modified",
            symbol_ids: symbols.filter((symbol) => symbol.path === path).map((symbol) => symbol.id) });
        if (!components.has(component)) components.set(component, []);
        components.get(component).push(id);
    }
    const symbolModules = new Map(symbols.map((symbol) => [symbol.id, swiftId("module", symbol.path)]));
    for (const edge of edges) {
        const source = symbolModules.get(edge.source) || edge.source, target = symbolModules.get(edge.target) || edge.target;
        if (source === target || edge.kind === "uses_package") continue;
        const key = JSON.stringify([edge.kind, source, target]);
        if (!groups.has(key)) groups.set(key, { id: swiftId("aggregate_edge", key), level: "module", kind: edge.kind,
            source, target, underlying_edge_ids: [], count: 0, added_count: 0, removed_count: 0 });
        const group = groups.get(key);
        group.underlying_edge_ids.push(edge.id);
        group.count += Number(edge.change !== "removed");
        group.added_count += Number(edge.change === "added");
        group.removed_count += Number(edge.change === "removed");
    }
    const changed = symbols.filter((symbol) => swiftCallable(symbol) && symbol.classification !== "unchanged" && !symbol.test
        && !after.membership.get(symbol.path)?.test && !/(?:^|\/)Tests?\//i.test(symbol.path));
    const requested = new Set(changed.map((symbol) => symbol.id)), calls = new Map();
    for (const edge of after.edges.filter((edge) => edge.kind === "calls")) {
        if (!calls.has(edge.source)) calls.set(edge.source, new Set());
        calls.get(edge.source).add(edge.target);
    }
    const tests = [];
    for (const test of after.tests) {
        const reached = new Set([test.symbol_id]), pending = [test.symbol_id];
        for (let i = 0; i < pending.length; i++) for (const id of calls.get(pending[i]) || []) {
            if (!reached.has(id)) { reached.add(id); pending.push(id); }
        }
        const linked = [...reached].filter((id) => requested.has(id));
        if (linked.length) tests.push({ ...test, callables: linked, callable_ids: linked, calls: linked,
            link: linked.some((id) => calls.get(test.symbol_id)?.has(id)) ? "direct" : "via" });
    }
    let remaining = 2000, limited = [...before.facts, ...after.facts].some((fact) => fact.incomplete)
        || before.warnings.length > 0 || after.warnings.length > 0;
    const callables = [];
    for (const symbol of changed) {
        if (remaining <= 0 || Date.now() - started > 20_000) { limited = true; break; }
        const compared = compareDecisions(old.get(symbol.id)?.decisions, now.get(symbol.id)?.decisions), entries = compared.slice(0, Math.min(60, remaining));
        limited ||= entries.length !== compared.length;
        remaining -= entries.length;
        const linked = tests.filter((test) => test.callables.includes(symbol.id));
        for (const entry of entries) if (entry.status !== "removed") entry.evidence = {
            level: linked.length ? "reachable" : "none", limited: symbol.relationships_incomplete,
            tests: linked.slice(0, 10).map((test) => ({ id: test.id, via: symbol.qualname })), omitted_tests: Math.max(0, linked.length - 10),
        };
        callables.push({ id: symbol.id, qualname: symbol.qualname, path: symbol.path, line: symbol.range.start_line, language: "swift", entries,
            counts: Object.fromEntries(["added", "changed", "moved", "removed"].map((status) => [status, entries.filter((entry) => entry.status === status).length])) });
    }
    const warnings = [...new Set([...before.warnings.map((warning) => `[Base] ${warning}`), ...after.warnings.map((warning) => `[Current] ${warning}`),
        ...[...unknownPackages].map((path) => `${path}: dependency comparison is unavailable for this input; unknown declarations are not reported as removals.`),
        SWIFT_LIMITATION])];
    return { symbols, edges, evidence, warnings,
        dependencies: { baseline: before.dependencies.packages, current: after.dependencies.packages,
            changes: swiftPackageDiff(before.dependencies.packages, after.dependencies.packages) },
        aggregates: { modules, components: [...components].map(([name, module_ids]) => ({ id: swiftId("component", name), name, module_ids, language: "swift" })),
            edges: [...groups.values()] },
        code_paths: { callables, limited, warnings, elapsed_ms: Date.now() - started,
            totals: Object.fromEntries(["added", "changed", "moved", "removed"].map((status) => [status, callables.reduce((sum, item) => sum + item.counts[status], 0)])),
            verification: { tests, omitted_tests: 0, test_files_examined: after.facts.filter((fact) => fact.tests.length).length, limited },
            source_hashes: Object.fromEntries(Object.entries(current).filter(([path]) => isSwiftPath(path) || posix.basename(path) === "Package.resolved")
                .map(([path, text]) => [path, swiftHash(text)])) } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const inputIndex = process.argv.indexOf("--input");
        let input = "";
        if (inputIndex >= 0) input = await readFile(process.argv[inputIndex + 1], "utf8");
        else for await (const chunk of process.stdin) input += chunk.toString("utf8");
        process.stdout.write(JSON.stringify(await analyzeSwiftSnapshot(JSON.parse(input))));
    } catch (error) {
        console.error(`Swift saved-syntax analysis failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    }
}
