// Python is both the snapshot coordinator's runtime and the Python adapter's parser runtime.
export function pythonCandidates({ platform = process.platform, executable = process.env.AGENT_REVIEW_PYTHON } = {}) {
    if (executable) return [[executable, []]];
    return platform === "win32"
        ? [["py", ["-3"]], ["python", []], ["python3", []]]
        : [["python3", []], ["python", []]];
}
