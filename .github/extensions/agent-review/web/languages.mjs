// Only implemented adapters are registered. Unsupported source files remain ordinary diffs.
export const LANGUAGE_SUPPORT = Object.freeze([
    Object.freeze({ id: "python", name: "Python", extensions: Object.freeze([".py"]) }),
]);

export function languageForPath(path) {
    return LANGUAGE_SUPPORT.find((language) => language.extensions.some((extension) => String(path || "").endsWith(extension))) || null;
}

export function isTestPath(path) {
    return /(^|\/)(tests?|__tests__)\//i.test(path || "") || /(^|\/)test_[^/]+\.py$|_test\.py$/i.test(path || "");
}
