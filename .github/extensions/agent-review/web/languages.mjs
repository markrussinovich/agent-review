// Only implemented adapters are registered. Unsupported source files remain ordinary diffs.
export const LANGUAGE_SUPPORT = Object.freeze([
    Object.freeze({ id: "python", name: "Python", extensions: Object.freeze([".py"]) }),
    Object.freeze({ id: "csharp", name: "C# / .NET", extensions: Object.freeze([".cs"]) }),
]);

export function languageForPath(path) {
    return LANGUAGE_SUPPORT.find((language) => language.extensions.some((extension) =>
        (language.id === "csharp" ? String(path || "").toLowerCase() : String(path || "")).endsWith(extension))) || null;
}

export function isTestPath(path) {
    return /(^|\/)(tests?|__tests__)\//i.test(path || "") || /(^|\/)test_[^/]+\.py$|_test\.py$/i.test(path || "")
        || /(^|\/)[^/]*tests?[^/]*\/.*\.cs$|tests?\.cs$/i.test(path || "");
}

export function isReviewSymbol(node) {
    const kind = node?.kind || node?.type;
    return ["class", "function", "method"].includes(kind)
        || (node?.language === "csharp" && ["namespace", "interface", "struct", "record", "enum",
            "delegate", "property", "accessor", "field", "event"].includes(kind));
}
