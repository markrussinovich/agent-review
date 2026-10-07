export function parseSourceReference(value) {
    const match = /^((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:csproj|cs|slnx?|props|targets|py|toml|txt|json|ya?ml|md|[cm]?[jt]sx?|css|html))(?::(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*))?$/.exec(value.trim());
    if (!match) return null;
    const lines = [];
    for (const part of match[2]?.split(",") || []) {
        const [start, end = start] = part.split("-").map(Number);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 199) return null;
        for (let line = start; line <= end; line += 1) {
            if (lines.length >= 200) return null;
            lines.push(line);
        }

    }
    return { path: match[1].replaceAll("\\", "/"), lines };
}

export function resolveSourceReference(value, model) {
    let normalized = value.replaceAll("\\", "/");
    if (/^[A-Za-z]:\//.test(normalized)) {
        const root = model?.metadata?.repo_root?.replaceAll("\\", "/").replace(/\/$/, "");
        if (!root || !normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
        normalized = normalized.slice(root.length + 1);
    }
    const reference = parseSourceReference(normalized);
    if (!reference) return null;
    const paths = new Set([
        ...Object.keys(model?.source_files || {}),
        ...(model?.changes || []).map((item) => item.path).filter(Boolean),
        ...(model?.nodes || []).map((item) => item.path).filter(Boolean),
    ]);
    if (paths.has(reference.path)) return reference;
    if (reference.path.includes("/")) return null;
    const candidates = [...paths].filter((path) => path.endsWith(`/${reference.path}`));
    return candidates.length === 1 ? { ...reference, path: candidates[0] } : null;
}
