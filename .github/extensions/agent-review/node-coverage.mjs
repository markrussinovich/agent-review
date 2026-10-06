import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceMapLines } from "./node-coverage-source-map.mjs";

const candidates = ["coverage/coverage-final.json", "coverage/lcov.info", "coverage-final.json", "lcov.info"];
const normalize = (path) => path.replace(/\\/g, "/").replace(/^\.\//, "");
const digest = (source) => createHash("sha256").update(source).digest("hex");

function repoPath(path, repo) {
    let value = normalize(path);
    if (value.startsWith("file:")) value = normalize(fileURLToPath(value));
    if (isAbsolute(value) || /^[A-Za-z]:\//.test(value)) value = normalize(relative(repo, value));
    if (value === ".." || value.startsWith("../") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
    return value;
}

function parseLcov(text) {
    const records = [];
    let record;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("SF:")) {
            record = { path: line.slice(3), lines: new Map() };
            records.push(record);
        } else if (line.startsWith("DA:")) {
            if (!record) throw new Error("LCOV line data has no source file.");
            const fields = line.slice(3).split(",");
            const number = Number(fields[0]);
            const count = Number(fields[1]);
            if (!Number.isInteger(number) || number < 1 || !Number.isFinite(count) || count < 0) throw new Error("Invalid LCOV line counter.");
            record.lines.set(number, (record.lines.get(number) || 0) + count);
        } else if (line === "end_of_record") record = null;
    }
    return records;
}

function parseIstanbul(text) {
    const data = JSON.parse(text);
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error("Invalid Istanbul coverage object.");
    return Object.entries(data).map(([path, record]) => {
        if (!record || typeof record.statementMap !== "object" || typeof record.s !== "object") {
            throw new Error(`Invalid Istanbul counters for ${path}.`);
        }
        const lines = new Map();
        for (const [id, span] of Object.entries(record.statementMap)) {
            const start = span.start?.line;
            const end = span.end?.line;
            const count = record.s[id];
            if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start
                || !Number.isFinite(count) || count < 0) throw new Error(`Invalid Istanbul statement ${id}.`);
            for (let line = start; line <= end; line++) {
                // All statements sharing a line must run before that line is called covered.
                lines.set(line, lines.has(line) ? Math.min(lines.get(line), count) : count);
            }
        }
        return { path: record.path || path, lines, source: record.source,
            sourceMap: record.inputSourceMap, sourceHash: record.sourceHash };
    });
}

export function snapshotChangedLines(before, after) {
    if (before === after) return new Set();
    const a = (before ?? "").split("\n");
    const b = after.split("\n");
    if (a.at(-1) === "") a.pop();
    if (b.at(-1) === "") b.pop();
    if (before == null || a.length * b.length > 2000000) return new Set(b.map((_, index) => index + 1));
    const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
        }
    }
    const changed = new Set();
    let i = 0;
    let j = 0;
    while (j < b.length) {
        if (i < a.length && a[i] === b[j]) { i++; j++; }
        else if (i < a.length && rows[i + 1][j] >= rows[i][j + 1]) i++;
        else changed.add(++j);
    }
    return changed;
}

export async function loadNodeCoverage({ repo, baseline = {}, current = {}, historical = false }) {
    if (typeof repo !== "string" || !current || typeof current !== "object") throw new Error("Coverage requires a repository and saved source snapshot.");
    const root = resolve(repo);
    const saved = Object.fromEntries(Object.entries(current).map(([path, text]) => [normalize(path), text]));
    const before = Object.fromEntries(Object.entries(baseline).map(([path, text]) => [normalize(path), text]));
    const warnings = [];
    async function reportText(path) {
        if (typeof saved[path] === "string") return saved[path];
        if (historical) return null;
        try { return await readFile(resolve(root, path), "utf8"); }
        catch (error) {
            if (error.code === "ENOENT") return null;
            throw new Error(`Unable to read coverage input ${path}: ${error.message}`);
        }
    }
    const manifestText = await reportText("coverage/sources.json");
    const manifest = manifestText === null ? {} : JSON.parse(manifestText);
    const records = new Map();
    function matches(path, supplied, hash) {
        const source = saved[path];
        if (typeof source !== "string") return false;
        const evidence = manifest[path];
        const content = Array.isArray(supplied) ? supplied.join("\n") : supplied;
        return (typeof content === "string" && content === source)
            || (typeof hash === "string" && hash === digest(source))
            || (typeof evidence === "string" && evidence === source)
            || (evidence && typeof evidence.sha256 === "string" && evidence.sha256 === digest(source));
    }
    function add(path, line, count) {
        if (!Number.isInteger(line) || line < 1 || line > saved[path].split("\n").length) {
            throw new Error(`Coverage line ${line} is outside snapshot source ${path}.`);
        }
        if (!records.has(path)) records.set(path, new Map());
        const counters = records.get(path);
        counters.set(line, (counters.get(line) || 0) + count);
    }
    for (const candidate of candidates) {
        const text = await reportText(candidate);
        if (text === null) continue;
        let parsed;
        try { parsed = candidate.endsWith(".info") ? parseLcov(text) : parseIstanbul(text); }
        catch (error) { throw new Error(`Invalid coverage report ${candidate}: ${error.message}`); }
        for (const record of parsed) {
            const path = repoPath(record.path, root);
            if (!path) { warnings.push(`Coverage source outside snapshot ignored: ${record.path}`); continue; }
            let map = record.sourceMap;
            let mapPath = `${path}.map`;
            if (!map && typeof saved[path] === "string") {
                const reference = /\/\/[#@]\s*sourceMappingURL=(\S+)/g;
                const references = [...saved[path].matchAll(reference)];
                if (references.length) {
                    const url = references.at(-1)[1];
                    if (url.startsWith("data:application/json;base64,")) {
                        map = JSON.parse(Buffer.from(url.split(",")[1], "base64").toString("utf8"));
                    } else if (!/^[a-z]+:/.test(url)) {
                        mapPath = normalize(relative(root, resolve(root, path, "..", url)));
                        if (!repoPath(mapPath, root)) throw new Error("Source map escapes the reviewed snapshot.");
                        const sourceMapText = await reportText(mapPath);
                        if (sourceMapText !== null) map = JSON.parse(sourceMapText);
                    }
                }
            }
            if (map) {
                const mapped = sourceMapLines(map, mapPath);
                for (const [line, count] of record.lines) {
                    const target = mapped.get(line);
                    if (!target) continue;
                    const [original, originalLine, sourceIndex] = target;
                    const safePath = repoPath(original, root);
                    if (safePath && matches(safePath, map.sourcesContent?.[sourceIndex])) add(safePath, originalLine, count);
                    else warnings.push(`Coverage source does not match snapshot: ${original}`);
                }
            } else if (matches(path, record.source, record.sourceHash)) {
                for (const [line, count] of record.lines) add(path, line, count);
            } else warnings.push(`Coverage source does not match snapshot: ${path}`);
        }
    }
    const files = [];
    const changedLines = {};
    for (const [path, counters] of [...records].sort(([a], [b]) => a.localeCompare(b))) {
        const executable = [...counters.keys()].sort((a, b) => a - b);
        const covered = executable.filter((line) => counters.get(line) > 0);
        const missing = executable.filter((line) => counters.get(line) === 0);
        files.push({ path, executable_lines: executable, covered_lines: covered, missing_lines: missing,
            line_count: saved[path].split("\n").length });
        const changed = snapshotChangedLines(before[path], saved[path]);
        const coveredChanged = covered.filter((line) => changed.has(line));
        const missingChanged = missing.filter((line) => changed.has(line));
        const total = coveredChanged.length + missingChanged.length;
        changedLines[path] = { covered_lines: coveredChanged, uncovered_lines: missingChanged,
            total, covered: coveredChanged.length, percent: total ? Math.round(10000 * coveredChanged.length / total) / 100 : null };
    }
    return { available: files.length > 0, files, changed_lines: changedLines,
        ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const index = process.argv.indexOf("--input");
    try {
        const argument = index < 0 ? "-" : process.argv[index + 1];
        if (!argument || (argument === "-" && process.stdin.isTTY)) {
            throw new Error("Usage: node-coverage.mjs [--input <saved-snapshot.json | JSON | ->]; otherwise provide snapshot JSON on stdin.");
        }
        let text = "";
        if (argument === "-") {
            for await (const chunk of process.stdin) text += chunk.toString("utf8");
        } else text = argument.trimStart().startsWith("{") ? argument : await readFile(argument, "utf8");
        const input = JSON.parse(text);
        console.log(JSON.stringify(await loadNodeCoverage(input)));
    } catch (error) {
        console.error(`Node coverage analysis failed: ${error.message}`);
        process.exitCode = 1;
    }
}
