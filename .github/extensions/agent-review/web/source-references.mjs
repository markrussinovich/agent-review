export const SOURCE_FILE_EXTENSION_PATTERN =
    "csproj|cs|slnx?|props|targets|py|go|rs|mod|sum|lock|toml|txt|json|ya?ml|md|[cm]?[jt]sx?|css|html";

export function parseSourceReference(value) {
    const tagged = /^(base|current):(.+)$/.exec(value.trim());
    if (tagged) {
        const reference = parseSourceReference(tagged[2]);
        return reference && !reference.side ? { ...reference, side: tagged[1] } : null;
    }
    const expression = new RegExp(
        `^((?:[A-Za-z0-9_.-]+[\\\\/])*[A-Za-z0-9_.-]+\\.(?:${SOURCE_FILE_EXTENSION_PATTERN}))`
        + "(?::(\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*))?$",
    );
    const match = expression.exec(value.trim());
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

export function resolveSourceReference(value, model, subjectPath = null) {
    const tagged = /^(base|current)(?::|\s+)(.+)$/.exec(value.trim());
    if (tagged) {
        const reference = resolveSourceReference(tagged[2], model, subjectPath);
        return reference && !reference.side ? { ...reference, side: tagged[1] } : null;
    }
    if (subjectPath?.toLowerCase().endsWith(".md")) {
        const alias = /^([^:]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/.exec(value.trim());
        const normalize = (text) => text.toLowerCase().replace(/[-_\s]+/g, " ");
        const stem = subjectPath.split("/").at(-1).slice(0, -3);
        if (alias && normalize(alias[1]) === normalize(stem)) {
            return resolveSourceReference(`${subjectPath}:${alias[2]}`, model);
        }
    }
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

export function sourceReferencesInText(text, model, subjectPath = null) {
    const path = `(?:(?:base|current):)?(?:[A-Za-z]:[\\\\/])?(?:[A-Za-z0-9_.-]+[\\\\/])*[A-Za-z0-9_.-]+\\.(?:${SOURCE_FILE_EXTENSION_PATTERN})(?![A-Za-z0-9_])(?::\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*)?`;
    const alternatives = [path];
    if (subjectPath?.toLowerCase().endsWith(".md")) {
        const stem = subjectPath.split("/").at(-1).slice(0, -3).split(/[-_\s]+/)
            .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[-_\\s]+");
        alternatives.unshift(`(?:(?:base|current)(?::|\\s+))?${stem}:\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*`);
    }
    const pattern = new RegExp(`(?<![A-Za-z0-9_/.\\\\])(?:${alternatives.join("|")})`, "gi");
    return [...text.matchAll(pattern)].flatMap((match) => {
        const reference = resolveSourceReference(match[0], model, subjectPath);
        return reference ? [{ start: match.index, end: match.index + match[0].length, reference }] : [];
    });
}
