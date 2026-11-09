import { spawnSync } from "node:child_process";

const windows = process.platform === "win32";
const command = windows ? "cl" : "c++";
const args = windows
    ? ["/nologo", "/EHsc", "/std:c++17", "/Fe:native-tests.exe", "/Fo:native-tests.obj", "tests\\policy_tests.cpp"]
    : ["-std=c++17", "tests/policy_tests.cpp", "-o", "native-tests.exe"];
const result = spawnSync(command, args, { stdio: "inherit", shell: false });
if (result.error) throw new Error(`Unable to launch ${command}: ${result.error.message}`);
process.exitCode = result.status ?? 1;
