import assert from "node:assert/strict";
import test from "node:test";
import { pythonCandidates } from "../python-runtime.mjs";

test("Windows selects the launcher's installed Python 3 instead of requiring Python 3.11", () => {
    assert.deepEqual(pythonCandidates({ platform: "win32", executable: "" }),
        [["py", ["-3"]], ["python", []], ["python3", []]]);
});

test("other platforms retain PATH-based Python discovery", () => {
    for (const platform of ["linux", "darwin"]) {
        assert.deepEqual(pythonCandidates({ platform, executable: "" }),
            [["python3", []], ["python", []]]);
    }
});

test("an explicit Python executable remains authoritative on every platform", () => {
    const executable = "C:\\Python313\\python.exe";
    for (const platform of ["win32", "linux", "darwin"]) {
        assert.deepEqual(pythonCandidates({ platform, executable }), [[executable, []]]);
    }
});
