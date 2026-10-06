// Python is both the snapshot coordinator's runtime and the Python adapter's parser runtime.
export function pythonCandidates() {
    if (process.env.AGENT_REVIEW_PYTHON) return [[process.env.AGENT_REVIEW_PYTHON, []]];
    return process.platform === "win32"
        ? [["py", ["-3.11"]], ["python", []], ["python3", []]]
        : [["python3", []], ["python", []]];
}
