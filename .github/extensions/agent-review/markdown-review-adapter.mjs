export const MARKDOWN_REVIEW_ADAPTER = Object.freeze({
    id: "markdown",
    capabilities: Object.freeze({ documentEvidence: true, codePaths: false, testExecution: false }),
    sourcePath: (path) => String(path || "").toLowerCase().endsWith(".md"),
    buildCodePathRequest: () => null,
    tests: null,
});
