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
