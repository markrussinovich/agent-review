import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withLocks } from "./custom-prompts.mjs";

export const DOCUMENT_ROLES = Object.freeze(["instructions", "supporting", "documentation", "example"]);
const CONTEXT_CHARACTERS = 64000;

export function effectiveDocuments(facts, overrides = {}) {
    const documents = Object.fromEntries(Object.entries(facts?.documents || {}).map(([path, document]) => [
        path, { ...document, role: Object.hasOwn(overrides, path) ? overrides[path] : (document.root ? "instructions" : "documentation"),
            original_role: document.role, overridden: Object.hasOwn(overrides, path) },
    ]));
    for (let pass = 0; pass < Object.keys(documents).length; pass++) {
        let changed = false;
        for (const edge of facts?.relationships || []) {
            const source = documents[edge.from], target = documents[edge.path];
            if (!source || !target || target.root || target.overridden || edge.status !== "resolved"
                || !["instructions", "supporting"].includes(source.role)) continue;
            const role = source.role === "instructions" && edge.kind === "prescribes" ? "instructions" : "supporting";
            if (target.role === "documentation" || (target.role === "supporting" && role === "instructions")) {
                target.role = role;
                changed = true;
            }
        }
        if (!changed) break;
    }
    for (const document of Object.values(documents)) {
        document.inherited_correction = !document.overridden && document.role !== document.original_role
            && Object.keys(overrides).length > 0;
    }
    return documents;
}

function excerpt(path, side, saved, ranges, maxCharacters) {
    const text = side === "base" && saved?.baseline_same ? saved.current : saved?.[side === "base" ? "baseline" : "current"];
    if (typeof text !== "string") return { path, side, available: false, ranges: [] };
    const lines = text.split(/\r?\n/);
    const selected = new Set();
    for (const [start, end] of ranges) for (let line = Math.max(1, start); line <= Math.min(lines.length, end); line++) selected.add(line);
    let remaining = maxCharacters;
    const chosen = [];
    for (const line of selected) {
        const value = `${line}: ${lines[line - 1]}\n`;
        if (value.length > remaining) continue;
        chosen.push(line);
        remaining -= value.length;
    }
    const result = [];
    for (const line of chosen.sort((a, b) => a - b)) {
        const value = `${line}: ${lines[line - 1]}\n`;
        const previous = result.at(-1);
        if (previous?.end_line === line - 1) {
            previous.end_line = line;
            previous.excerpt += value;
        } else result.push({ start_line: line, end_line: line, excerpt: value });
    }
    return { path, side, available: true, source_lines: lines.length, ranges: result,
        complete: result.reduce((sum, range) => sum + range.end_line - range.start_line + 1, 0) === lines.length };
}

export function instructionContext(model, path, overrides = {}) {
    if (!model.instruction_documents?.base?.documents?.[path] && !model.instruction_documents?.current?.documents?.[path]) return null;
    const result = { path, evidence_type: "deterministic", observed_behavior: { available: false,
        reason: "No controlled agent evaluation was supplied. Repository tests and coverage do not measure instruction compliance." },
    precedence: "Unknown unless the supplied host or loading contract explicitly establishes it.", sides: {} };
    for (const side of ["base", "current"]) {
        const facts = model.instruction_documents[side];
        const documents = effectiveDocuments(facts, overrides);
        const document = documents[path];
        if (!document) { result.sides[side] = { document: null }; continue; }
        const relationships = [], visited = new Set([path]), queue = [path];
        let cycle = false;
        while (queue.length && visited.size <= 40) {
            const target = queue.shift();
            for (const edge of facts.relationships || []) {
                if (edge.path !== target) continue;
                if (!["instructions", "supporting"].includes(documents[edge.from]?.role)
                    && !["supplies_instructions", "packages"].includes(edge.kind)) continue;
                if (relationships.some((item) => item.id === edge.id)) continue;
                relationships.push(edge);
                if (visited.has(edge.from)) { cycle = true; continue; }
                visited.add(edge.from);
                queue.push(edge.from);
                if (visited.size > 40) break;
            }
        }
        const outgoing = (facts.relationships || []).filter((edge) => edge.from === path);
        const saved = model.source_files?.[path];
        const lines = String((side === "base" && saved?.baseline_same ? saved.current
            : saved?.[side === "base" ? "baseline" : "current"]) || "").split(/\r?\n/);
        const ranges = [];
        for (const match of String(saved?.diff || "").matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
            const start = Number(match[side === "base" ? 1 : 3]);
            ranges.push([Math.max(1, start - 8), start + Number(match[side === "base" ? 2 : 4] || 1) + 12]);
        }
        ranges.push([1, Math.min(lines.length, 100)]);
        const sources = [excerpt(path, side, saved, ranges, 16000)];
        for (const sourcePath of [...new Set(relationships.map((edge) => edge.from))].slice(0, 6)) {
            if (sourcePath === path) continue;
            const sourceRanges = relationships.filter((edge) => edge.from === sourcePath).map((edge) => [edge.line - 3, edge.line + 3]);
            sources.push(excerpt(sourcePath, side, model.source_files?.[sourcePath], sourceRanges, 2500));
        }
        for (const edge of outgoing.filter((edge) => edge.status === "resolved").slice(0, 3)) {
            if (!sources.some((source) => source.path === edge.path)) {
                sources.push(excerpt(edge.path, side, model.source_files?.[edge.path], [[1, 60]], 2000));
            }
        }
        const { blocks, anchors, frontmatter, tools, ...metadata } = document;
        result.sides[side] = { document: { ...metadata,
            frontmatter: Object.fromEntries(Object.entries(frontmatter).slice(0, 12).map(([key, value]) => [key.slice(0, 100), value.slice(0, 300)])),
            tools: tools.slice(0, 20).map((tool) => ({ ...tool, name: tool.name.slice(0, 100) })),
            headings: blocks.filter((block) => block.kind === "heading").slice(0, 40),
            omitted_blocks: blocks.length - Math.min(40, blocks.filter((block) => block.kind === "heading").length) },
            relationships: relationships.slice(0, 60), outgoing: outgoing.slice(0, 60), sources,
            gaps: facts.gaps.slice(0, 20), cycle_or_convergence: cycle,
            limited: visited.size > 40 || outgoing.length > 60 || relationships.length > 60 || facts.gaps.length > 20
                || Object.keys(frontmatter).length > 12 || Object.entries(frontmatter).some(([key, value]) => key.length > 100 || value.length > 300)
                || tools.length > 20 || tools.some((tool) => tool.name.length > 100),
            note: "A reference or prescribed use does not prove an agent received, read, or obeyed this document." };
    }
    result.role = result.sides.current.document?.role || result.sides.base.document?.role;
    result.character_limit = CONTEXT_CHARACTERS;
    result.limited = Object.values(result.sides).some((side) => side.limited);
    for (const key of ["sources", "outgoing", "relationships", "gaps"]) {
        for (const side of Object.values(result.sides)) {
            while (side[key]?.length > (key === "sources" ? 1 : 0) && JSON.stringify(result).length > CONTEXT_CHARACTERS) {
                side[key].pop();
                side.limited = result.limited = true;
            }
        }
    }
    for (const side of Object.values(result.sides)) {
        const source = side.sources?.[0];
        while (source?.ranges.length && JSON.stringify(result).length > CONTEXT_CHARACTERS) {
            source.ranges.pop();
            source.complete = false;
            side.limited = result.limited = true;
        }
    }
    return result;
}

export class DocumentRoleStore {
    constructor(workspacePath) {
        this.directory = workspacePath ? join(workspacePath, "files", "agent-review-document-roles") : null;
        this.records = new Map();
        this.writes = new Map();
    }
    async read(snapshot) {
        let record = this.records.get(snapshot) || { version: 1, snapshot, revision: 0, overrides: {} };
        if (this.directory) {
            try { record = JSON.parse(await readFile(this.file(snapshot), "utf8")); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        if (record.version !== 1 || record.snapshot !== snapshot || !Number.isSafeInteger(record.revision)
            || record.revision < 0 || !record.overrides || Array.isArray(record.overrides)
            || typeof record.overrides !== "object"
            || Object.entries(record.overrides).some(([path, role]) => !path || path.length > 2000 || !DOCUMENT_ROLES.includes(role))) {
            throw new Error("Saved document roles do not match this snapshot or schema.");
        }
        return { ...record, overrides: { ...record.overrides }, durable: Boolean(this.directory) };
    }
    file(snapshot) {
        return join(this.directory, `${createHash("sha256").update(snapshot).digest("hex")}.json`);
    }
    async update(snapshot, revision, path, role) {
        if (!Number.isSafeInteger(revision) || revision < 0 || typeof path !== "string" || !path || path.length > 2000
            || (role !== null && !DOCUMENT_ROLES.includes(role))) throw new Error("Invalid document role correction.");
        const write = async () => {
            const current = await this.read(snapshot);
            if (current.revision !== revision) throw new Error("Document roles changed elsewhere. Reload before retrying; your selection has not been saved.");
            const overrides = { ...current.overrides };
            if (role === null) delete overrides[path];
            else Object.defineProperty(overrides, path, { value: role, enumerable: true, configurable: true, writable: true });
            const record = { version: 1, snapshot, revision: revision + 1, overrides };
            if (this.directory) {
                await mkdir(this.directory, { recursive: true });
                const temporary = `${this.file(snapshot)}.${randomUUID()}.tmp`;
                try { await writeFile(temporary, JSON.stringify(record)); await rename(temporary, this.file(snapshot)); }
                finally { await rm(temporary, { force: true }); }
            } else this.records.set(snapshot, record);
            return { ...record, durable: Boolean(this.directory) };
        };
        const lockedWrite = () => this.directory ? withLocks([this.directory], write) : write();
        const pending = (this.writes.get(snapshot) || Promise.resolve()).then(lockedWrite, lockedWrite);
        this.writes.set(snapshot, pending);
        try { return await pending; }
        finally { if (this.writes.get(snapshot) === pending) this.writes.delete(snapshot); }
    }
}
