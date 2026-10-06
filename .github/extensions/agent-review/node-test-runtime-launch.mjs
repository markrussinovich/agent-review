import { spawn } from "node:child_process";

// Nested test runners must not inherit node:test's internal worker marker.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const child = spawn(process.execPath, process.argv.slice(2), {
    env, windowsHide: true, stdio: "inherit",
});
child.once("error", (error) => {
    console.error(`Unable to start isolated node:test: ${error.message}`);
    process.exitCode = 1;
});
child.once("close", (code) => { process.exitCode = code ?? 1; });
