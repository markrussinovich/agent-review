// Only implemented adapters are registered. Unsupported source files remain ordinary diffs.
export const LANGUAGE_SUPPORT = Object.freeze([
    Object.freeze({ id: "python", name: "Python", extensions: Object.freeze([".py"]) }),
    Object.freeze({ id: "node", name: "JavaScript / TypeScript", extensions: Object.freeze([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]) }),
    Object.freeze({ id: "csharp", name: "C# / .NET", extensions: Object.freeze([".cs"]) }),
    Object.freeze({ id: "rust", name: "Rust", extensions: Object.freeze([".rs"]) }),
]);

export function languageForPath(path) {
    return LANGUAGE_SUPPORT.find((language) => language.extensions.some((extension) =>
        (language.id === "python" ? String(path || "") : String(path || "").toLowerCase()).endsWith(extension))) || null;
}

export function isTestPath(path) {
    return /(^|\/)(tests?|__tests__)\//i.test(path || "") || /(^|\/)test_[^/]+\.py$|_test\.py$/i.test(path || "")
        || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path || "")
        || /(^|\/)[^/]*tests?[^/]*\/.*\.cs$|tests?\.cs$/i.test(path || "")
        || /(^|\/)tests\/.*\.rs$|(^|\/)(?:tests?|benches)\/.*\.rs$/i.test(path || "");
}

export function isReviewSymbol(node) {
    const kind = node?.kind || node?.type;
    return ["class", "function", "method"].includes(kind)
        || (node?.language === "csharp" && ["namespace", "interface", "struct", "record", "enum",
            "delegate", "constructor", "operator", "property", "accessor", "field", "event"].includes(kind))
        || (node?.language === "rust" && ["module", "struct", "enum", "trait"].includes(kind));
}
