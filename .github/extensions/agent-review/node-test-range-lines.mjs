import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function preciseRangeLines(source, functions) {
    const ranges = functions.flatMap((fn) => fn.ranges || []);
    const executable = [];
    const covered = [];
    let offset = 0;
    for (const [index, text] of source.split("\n").entries()) {
        const trimmed = text.trim();
        const start = offset + text.search(/\S|$/);
        const end = offset + text.trimEnd().length;
        offset += text.length + 1;
        // A header or mixed guard/body line cannot prove that a branch body ran.
        if (!trimmed || /^(?:[{}()[\],;]+|\/\/.*)$/.test(trimmed)
            || /^(?:import|export|function|class|(?:async\s+)?(?:if|else|switch|case|for|while|catch|try|finally))\b/.test(trimmed)
            || /[?]|&&|\|\|/.test(trimmed) || (trimmed.match(/;/g) || []).length > 1
            || trimmed.includes("=>") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
        const applicable = ranges.filter((range) => range.startOffset <= start && range.endOffset >= end);
        if (!applicable.length) continue;
        executable.push(index + 1);
        const smallest = applicable.sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset))[0];
        const blocked = ranges.some((range) => range.count === 0 && range.startOffset < end && range.endOffset > start
            && range.endOffset - range.startOffset <= smallest.endOffset - smallest.startOffset);
        if (smallest.count > 0 && !blocked) covered.push(index + 1);
    }
    return { executable, covered };
}

export async function callbackCoverageLines(report, files) {
    const selected = new Set(files.map((file) => resolve(file)));
    const lines = {};
    for (const script of report.result || []) {
        if (!script.url.startsWith("file:")) continue;
        const path = resolve(fileURLToPath(script.url));
        if (!selected.has(path)) continue;
        const source = await readFile(path, "utf8");
        lines[path] = preciseRangeLines(source, script.functions).covered;
    }
    return lines;
}
