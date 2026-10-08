import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LIMITS = { files: 600, bytes: 6 * 1024 * 1024, callables: 400, entries: 2000, tests: 200 };
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const lineAt = (source, offset) => source.slice(0, offset).split(/\r?\n/).length;

function mask(source) {
    const chars = [...source];
    let state = null;
    for (let i = 0; i < source.length; i++) {
        const pair = source.slice(i, i + 2), char = source[i];
        if (state === "line") {
            if (char === "\n" || char === "\r") state = null; else chars[i] = " ";
        } else if (state === "block") {
            if (pair === "*/") { chars[i] = chars[i + 1] = " "; i++; state = null; }
            else if (char !== "\n" && char !== "\r") chars[i] = " ";
        } else if (state) {
            if (state !== "`" && char === "\\") { chars[i] = " "; if (i + 1 < chars.length) chars[++i] = " "; }
            else if (char === state) { chars[i] = " "; state = null; }
            else if (char !== "\n" && char !== "\r") chars[i] = " ";
        } else if (pair === "//") { chars[i] = chars[i + 1] = " "; i++; state = "line"; }
        else if (pair === "/*") { chars[i] = chars[i + 1] = " "; i++; state = "block"; }
        else if (['"', "'", "`"].includes(char)) { chars[i] = " "; state = char; }
    }
    return chars.join("");
}

function braceEnd(text, opening) {
    let depth = 0;
    for (let index = opening; index < text.length; index++) {
        if (text[index] === "{") depth++;
        else if (text[index] === "}" && --depth === 0) return index + 1;
    }
    return text.length;
}

function functions(source) {
    const text = mask(source), found = new Map();
    const pattern = /^[ \t]*func[ \t]+(?:\(\s*([^)]+?)\s*\)\s*)?([A-Za-z_]\w*)\s*(\([^{};]*?\)(?:\s*\([^{}]*?\)|\s+[A-Za-z_][\w.\[\]*]*)?)\s*\{/gm;
    for (const match of text.matchAll(pattern)) {
        const opening = match.index + match[0].lastIndexOf("{"), end = braceEnd(text, opening);
        const receiver = match[1]?.trim().split(/\s+/).at(-1)?.replace(/[^A-Za-z0-9_]/g, "").split("[")[0] || null;
        const qualname = receiver ? `${receiver}.${match[2]}` : match[2];
        found.set(qualname, { name: match[2], receiver, qualname, start: match.index, opening, end,
            line: lineAt(source, match.index), body: source.slice(opening + 1, end - 1),
            masked: text.slice(opening + 1, end - 1) });
    }
    return found;
}

function containingCondition(text, offset) {
    const matches = [...text.matchAll(/\bif\s+([^{\n]+)\s*\{/g)];
    const scopes = matches.map((match) => {
        const opening = match.index + match[0].lastIndexOf("{");
        return { condition: match[1].trim(), opening, end: braceEnd(text, opening) };
    }).filter((scope) => scope.opening < offset && offset < scope.end);
    return scopes.at(-1)?.condition || null;
}

export function collectGoDecisions(fn, source) {
    const decisions = [];
    const bodyOffset = fn.opening + 1;
    const pattern = /\b(return|panic|break|continue)\b([^\n;}]*)/g;
    for (const match of fn.masked.matchAll(pattern)) {
        const line = lineAt(source, bodyOffset + match.index);
        const raw = source.slice(bodyOffset + match.index, bodyOffset + match.index + match[0].length);
        const value = raw.replace(/^\s*(?:return|panic|break|continue)\s*/, "").trim()
            .replace(/^\((.*)\)$/, "$1") || null;
        const condition = containingCondition(fn.masked, match.index);
        const outcome = match[1] === "panic" ? "raise" : match[1] === "break" ? "stop"
            : match[1] === "continue" ? "skip"
                : !value ? "empty" : value === "true" ? "true" : value === "false" ? "false" : "value";
        decisions.push({ line, end_line: line, outcome, value,
            when: condition ? [condition] : [], when_mode: "all", only_if: [], context: [],
            thresholds: condition ? [...condition.matchAll(/(?:[<>=!]=?|==)\s*(-?\d+(?:\.\d+)?)/g)].map((item) => item[1]) : [],
            trace: [line, line] });
    }
    return decisions;
}

const key = (decision) => JSON.stringify([decision.outcome, decision.value, decision.when]);
function diff(before, after) {
    const used = new Set(), entries = [];
    for (const decision of after) {
        let index = before.findIndex((item, candidate) => !used.has(candidate) && key(item) === key(decision));
        if (index >= 0) {
            used.add(index);
            if (before[index].line !== decision.line) entries.push({ status: "moved", decision, base: before[index], moved: true });
        } else {
            index = before.findIndex((item, candidate) => !used.has(candidate) && item.outcome === decision.outcome);
            if (index >= 0) { used.add(index); entries.push({ status: "changed", decision, base: before[index] }); }
            else entries.push({ status: "added", decision });
        }
    }
    before.forEach((decision, index) => { if (!used.has(index)) entries.push({ status: "removed", decision }); });
    return entries;
}

function testsFor(request, callables, sources) {
    const tests = [], warnings = [];
    for (const saved of request.tests || []) {
        const indexed = functions(saved.current || "");
        for (const fn of indexed.values()) {
            if (!/^Test[A-Z0-9_]/.test(fn.name) || fn.receiver) continue;
            const id = `${saved.path}::${fn.name}`;
            const calls = [...fn.masked.matchAll(/\b(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*\(/g)].map((item) => item[1]);
            const linked = callables.filter((item) => calls.includes(item.name));
            if (!linked.length) continue;
            const checks = [...fn.masked.matchAll(/\bif\s+([^{\n]+)\s*\{/g)].flatMap((match) => {
                const opening = match.index + match[0].lastIndexOf("{"), end = braceEnd(fn.masked, opening);
                if (!/\bt\.(?:Error|Errorf|Fail|FailNow|Fatal|Fatalf)\s*\(/.test(fn.masked.slice(opening, end))) return [];
                const condition = fn.body.slice(match.index + match[0].indexOf(match[1]),
                    match.index + match[0].indexOf(match[1]) + match[1].length).trim();
                return [{ condition, line: fn.line + fn.body.slice(0, match.index).split(/\r?\n/).length - 1 }];
            });
            const summary = { id, path: saved.path, line: fn.line, name: fn.name, adapter: "go", adapter_id: "go",
                package: saved.path.includes("/") ? saved.path.slice(0, saved.path.lastIndexOf("/")) : ".",
                source_hash: hash(saved.current), link: "direct", changed: false,
                callable_ids: linked.map((item) => item.id), callables: linked.map((item) => item.qualname),
                matches: 0 };
            tests.push(summary);
            for (const callable of linked) {
                const assigned = [...fn.body.matchAll(new RegExp(
                    `\\b([A-Za-z_]\\w*)\\s*(?::=|=)\\s*(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${callable.name}\\s*\\(`, "g",
                ))].map((item) => item[1]);
                const relevant = checks.filter((check) => check.condition.includes(`${callable.name}(`)
                    || assigned.some((name) => new RegExp(`\\b${name}\\b`).test(check.condition)));
                for (const entry of callable.entries) {
                    if (entry.status === "removed") { entry.evidence = null; continue; }
                    const asserted = relevant.find((check) => entry.decision.value
                        && check.condition.includes(String(entry.decision.value)));
                    if (asserted) summary.matches++;
                    entry.evidence = { level: asserted ? "asserted" : "exercised",
                        tests: [{ id, path: saved.path, line: fn.line, link: "direct",
                            ...(asserted ? { match: "failure condition",
                                assertion: { line: asserted.line, text: asserted.condition, kind: "assert" } } : {}) }],
                        omitted_tests: 0 };
                }
            }
        }
    }
    return { tests: tests.slice(0, LIMITS.tests), omitted_tests: Math.max(0, tests.length - LIMITS.tests),
        test_files_examined: (request.tests || []).length, limited: tests.length > LIMITS.tests, warnings };
}

export function buildGoCodePathMap(request, limits = LIMITS) {
    const started = performance.now(), warnings = [], sourceMap = new Map();
    let bytes = 0, limited = false;
    for (const item of request.sources || []) {
        const size = Buffer.byteLength(item.current || "") + Buffer.byteLength(item.baseline || "");
        if (sourceMap.size >= limits.files || bytes + size > limits.bytes) { limited = true; continue; }
        bytes += size; sourceMap.set(item.path, item);
    }
    const callables = [], totals = { added: 0, removed: 0, changed: 0, moved: 0, callables: 0, callables_changed: 0 };
    for (const file of (request.files || []).slice(0, limits.files)) {
        const saved = sourceMap.get(file.path) || file;
        const before = typeof saved.baseline === "string" ? functions(saved.baseline) : new Map();
        const after = typeof saved.current === "string" ? functions(saved.current) : new Map();
        for (const target of file.callables || []) {
            if (callables.length >= limits.callables) { limited = true; break; }
            const oldFn = before.get(target.qualname), newFn = after.get(target.qualname);
            if (!oldFn && !newFn) { warnings.push(`${file.path}: callable ${target.qualname} has no saved implementation.`); continue; }
            const beforeDecisions = oldFn ? collectGoDecisions(oldFn, saved.baseline) : [];
            const afterDecisions = newFn ? collectGoDecisions(newFn, saved.current) : [];
            let entries = diff(beforeDecisions, afterDecisions);
            if (entries.length + callables.reduce((sum, item) => sum + item.entries.length, 0) > limits.entries) {
                entries = entries.slice(0, Math.max(0, limits.entries - callables.reduce((sum, item) => sum + item.entries.length, 0)));
                limited = true;
            }
            const counts = Object.fromEntries(["added", "removed", "changed", "moved"]
                .map((status) => [status, entries.filter((entry) => entry.status === status).length]));
            Object.entries(counts).forEach(([status, count]) => { totals[status] += count; });
            totals.callables++; if (entries.length) totals.callables_changed++;
            callables.push({ ...target, path: file.path, line: newFn?.line || null, base_line: oldFn?.line || null,
                source_hash: typeof saved.current === "string" ? hash(saved.current) : null,
                decisions_base: beforeDecisions.length, decisions_current: afterDecisions.length,
                counts, entries, omitted_entries: 0, truncated: false });
        }
    }
    const verification = testsFor(request, callables, sourceMap);
    warnings.push(...verification.warnings); delete verification.warnings;
    if (limited) warnings.push("Go code path extraction reached explicit source, callable, decision, or entry limits; omitted evidence is incomplete.");
    return { adapter_id: "go", callables, totals, verification,
        source_hashes: Object.fromEntries([...sourceMap].filter(([, item]) => typeof item.current === "string")
            .map(([path, item]) => [path, hash(item.current)])),
        files_examined: (request.files || []).length, limited, warnings,
        elapsed_ms: Math.round(performance.now() - started) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const args = process.argv.slice(2);
        if (args.length !== 2 || args[0] !== "--input") throw new Error("Usage: go-codepaths.mjs --input request.json");
        process.stdout.write(`${JSON.stringify(buildGoCodePathMap(JSON.parse(await readFile(args[1], "utf8"))))}\n`);
    } catch (error) {
        process.stderr.write(`agent-review Go decisions: ${error.message}\n`);
        process.exitCode = 2;
    }
}
