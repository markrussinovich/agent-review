// Changed lines per side of a unified diff, plus where the other side's lines were removed or inserted.
export function diffSegments(diff) {
    const current = new Map();
    const base = new Map();
    const removedBefore = new Map();
    const addedBefore = new Map();
    const lines = String(diff || "").split(/\r?\n/);
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    for (let index = 0; index < lines.length;) {
        const line = lines[index];
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk) {
            oldLine = Number(hunk[1]) + (hunk[2] === "0" ? 1 : 0);
            newLine = Number(hunk[3]) + (hunk[4] === "0" ? 1 : 0);
            inHunk = true;
            index += 1;
            continue;
        }
        if (!inHunk || line.startsWith("diff --git ")) {
            inHunk = false;
            index += 1;
            continue;
        }
        if (line.startsWith("-") || line.startsWith("+")) {
            const removed = [];
            while (lines[index]?.startsWith("-")) { removed.push(oldLine++); index += 1; }
            const added = [];
            while (lines[index]?.startsWith("+")) { added.push(newLine++); index += 1; }
            if (removed.length && added.length) {
                for (const number of removed) base.set(number, "modified");
                for (const number of added) current.set(number, "modified");
            } else if (removed.length) {
                for (const number of removed) base.set(number, "delete");
                removedBefore.set(newLine, (removedBefore.get(newLine) || 0) + removed.length);
            } else {
                for (const number of added) current.set(number, "add");
                addedBefore.set(oldLine, (addedBefore.get(oldLine) || 0) + added.length);
            }
            continue;
        }
        if (line.startsWith(" ")) {
            oldLine += 1;
            newLine += 1;
        }
        index += 1;
    }
    return { current, base, removedBefore, addedBefore };
}

export function unchangedDiffContext({ diff, base, current, line, side = "current", radius = 3 }) {
    if (!Number.isInteger(line) || line < 1 || typeof base !== "string" || typeof current !== "string") return null;
    const oldLines = base.split(/\r\n|\r|\n/);
    const newLines = current.split(/\r\n|\r|\n/);
    const targetLines = side === "base" ? oldLines : newLines;
    if (line > targetLines.length) return null;
    let offset = 0;
    let gapStart = 1;
    let gapEnd = targetLines.length;
    for (const match of String(diff || "").matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm)) {
        const oldCount = Number(match[2] ?? 1);
        const newCount = Number(match[4] ?? 1);
        const oldStart = Number(match[1]) + (oldCount === 0 ? 1 : 0);
        const newStart = Number(match[3]) + (newCount === 0 ? 1 : 0);
        const start = side === "base" ? oldStart : newStart;
        const count = side === "base" ? oldCount : newCount;
        const otherStart = side === "base" ? newStart : oldStart;
        const otherCount = side === "base" ? newCount : oldCount;
        if (line < start) {
            gapEnd = Math.min(gapEnd, start - 1);
            break;
        }
        if (line < start + count) return null;
        gapStart = start + count;
        offset = otherStart + otherCount - gapStart;
    }
    const rows = [];
    const from = Math.max(1, gapStart, line - radius);
    const to = Math.min(targetLines.length, gapEnd, line + radius);
    for (let number = from; number <= to; number++) {
        const oldLine = side === "base" ? number : number + offset;
        const newLine = side === "base" ? number + offset : number;
        if (oldLine < 1 || newLine < 1 || oldLine > oldLines.length || newLine > newLines.length
            || oldLines[oldLine - 1] !== newLines[newLine - 1]) return null;
        rows.push({ oldLine, newLine, content: newLines[newLine - 1] });
    }
    return rows.length ? rows : null;
}
