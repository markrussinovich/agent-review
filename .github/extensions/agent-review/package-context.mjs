export function buildPackageUsageContext(model, dependency, isTestPath = () => false) {
    const locations = dependency.usage_locations || [];
    const byPath = new Map();
    for (const location of locations) {
        const match = /^(.*):(\d+)$/.exec(location);
        if (!match) continue;
        if (!byPath.has(match[1])) byPath.set(match[1], []);
        byPath.get(match[1]).push(Number(match[2]));
    }
    const paths = [...byPath.keys()].sort((a, b) => Number(isTestPath(a)) - Number(isTestPath(b)) || a.localeCompare(b));
    let remaining = 64_000;
    const files = [];
    for (const path of paths.slice(0, 12)) {
        const saved = model?.source_files?.[path];
        if (!saved || saved.binary || saved.current === null) {
            files.push({ path, import_lines: byPath.get(path), unavailable: "No readable current source in this saved snapshot" });
            continue;
        }
        const lines = saved.current.split(/\r?\n/);
        const numbered = lines.map((line, index) => `${index + 1}: ${line}`).join("\n");
        const budget = Math.min(32_000, remaining);
        const diff = (saved.diff || "").slice(0, Math.min(3000, budget));
        const sourceBudget = budget - diff.length;
        let excerpts;
        if (numbered.length <= sourceBudget) {
            excerpts = [{ start_line: 1, end_line: lines.length, text: numbered }];
        } else {
            const half = Math.floor(sourceBudget / 2);
            const head = numbered.slice(0, half);
            const tail = numbered.slice(-Math.max(0, sourceBudget - half));
            excerpts = sourceBudget > 0 ? [
                { start_line: 1, text: head },
                { end_line: lines.length, text: tail },
            ] : [];
        }
        remaining -= diff.length + excerpts.reduce((sum, item) => sum + item.text.length, 0);
        files.push({ path, import_lines: byPath.get(path), excerpts, diff,
            truncated: numbered.length > sourceBudget || (saved.diff || "").length > diff.length });
    }
    return {
        scope: "Actual consuming code from the selected saved review snapshot",
        files,
        omitted_importing_files: Math.max(0, paths.length - 12),
        max_code_characters: 64_000,
        note: locations.length ? "Import locations alone do not prove usage; inspect the supplied implementations."
            : "No static import was mapped. Do not invent runtime usage from the package name.",
    };
}
