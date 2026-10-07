function nugetProjectCandidates(model, dependency) {
    const projects = new Set((dependency.declared_current || [])
        .map((declaration) => declaration.project || declaration.source)
        .filter((path) => typeof path === "string" && path.toLowerCase().endsWith(".csproj"))
        .map((path) => path.replaceAll("\\", "/")));
    if (!projects.size) return [];
    const scoped = new Map();
    for (const symbol of model.symbols || []) {
        const project = String(symbol.compiler_scope || "").split("@")[0];
        if (!projects.has(project) || !symbol.path?.toLowerCase().endsWith(".cs")) continue;
        if (!scoped.has(symbol.path)) scoped.set(symbol.path, new Set());
        scoped.get(symbol.path).add(project);
    }
    // Without compiler scope facts, source inside a declaring project is only a directory-scoped candidate.
    if (!scoped.size) {
        const knownProjects = Object.keys(model.source_files || {}).filter((path) => path.toLowerCase().endsWith(".csproj"));
        for (const path of Object.keys(model.source_files || {})) {
            if (!path.toLowerCase().endsWith(".cs")) continue;
            const directory = (project) => project.includes("/") ? project.slice(0, project.lastIndexOf("/") + 1) : "";
            const owners = knownProjects.filter((project) => path.startsWith(directory(project)))
                .sort((left, right) => directory(right).length - directory(left).length);
            const nearestDepth = owners.length ? directory(owners[0]).length : -1;
            const declaring = owners.filter((project) => directory(project).length === nearestDepth && projects.has(project));
            if (declaring.length) scoped.set(path, new Set(declaring));
        }
    }
    const namespace = String(dependency.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namespaceImport = new RegExp(`^\\s*(?:global\\s+)?using\\s+(?:static\\s+)?(?:\\w+\\s*=\\s*)?${namespace}(?:\\.[\\w.]+)?\\s*;`);
    return [...scoped].map(([path, projects]) => {
        const saved = model.source_files?.[path];
        const usingLines = typeof saved?.current === "string"
            ? saved.current.split(/\r?\n/).flatMap((line, index) => namespaceImport.test(line) ? [index + 1] : []) : [];
        return { path, projects: [...projects], using_lines: usingLines };
    });
}

export function buildPackageUsageContext(model, dependency, isTestPath = () => false) {
    const locations = dependency.usage_locations || [];
    const byPath = new Map();
    for (const location of locations) {
        const match = /^(.*):(\d+)$/.exec(location);
        if (!match) continue;
        if (!byPath.has(match[1])) byPath.set(match[1], []);
        byPath.get(match[1]).push(Number(match[2]));
    }
    const candidates = dependency.ecosystem === "nuget" ? nugetProjectCandidates(model, dependency) : [];
    const candidateByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
    for (const candidate of candidates) if (!byPath.has(candidate.path)) byPath.set(candidate.path, []);
    const paths = [...byPath.keys()].sort((a, b) =>
        Number(Boolean(candidateByPath.get(b)?.using_lines.length)) - Number(Boolean(candidateByPath.get(a)?.using_lines.length))
        || Number(isTestPath(a)) - Number(isTestPath(b)) || a.localeCompare(b));
    let remaining = 64_000;
    const files = [];
    for (const path of paths.slice(0, 12)) {
        const saved = model?.source_files?.[path];
        if (!saved || saved.binary || typeof saved.current !== "string") {
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
        const candidate = candidateByPath.get(path);
        files.push({ path, import_lines: byPath.get(path), excerpts, diff,
            ...(candidate ? {
                project_paths: candidate.projects, using_lines: candidate.using_lines,
                association: byPath.get(path).length ? "resolved usage location"
                    : candidate.using_lines.length ? "inferred candidate: declaring project and matching namespace import"
                        : "project source context only; package use is unverified",
                methods: (model.symbols || []).filter((symbol) => symbol.path === path
                    && ["method", "function", "constructor"].includes(symbol.kind)).slice(0, 20)
                    .map((symbol) => ({ name: symbol.qualname || symbol.name, line: symbol.range?.start_line, end_line: symbol.range?.end_line })),
            } : {}),
            truncated: numbered.length > sourceBudget || (saved.diff || "").length > diff.length });
    }
    return {
        scope: candidates.length ? "Saved source from projects declaring this NuGet dependency; unresolved associations are candidates, not proof"
            : "Actual consuming code from the selected saved review snapshot",
        files,
        omitted_importing_files: Math.max(0, paths.length - 12),
        max_code_characters: 64_000,
        note: candidates.length ? "Inspect actual API calls in these saved implementations. Namespace spelling alone does not prove NuGet-to-assembly usage; label candidate package associations as inferred. Missing adoption motivation remains unknown."
            : locations.length ? "Import locations alone do not prove usage; inspect the supplied implementations."
            : "No static import was mapped. Do not invent runtime usage from the package name.",
    };
}
