import { spawnOwnedAnalyzer } from "./ownership-guard.mjs";

export function runOwnedTestCommand(executable, args, { repoRoot, signal, timeoutMs, workspacePath, label }) {
    return new Promise((resolvePromise, reject) => {
        signal?.throwIfAborted();
        const child = spawnOwnedAnalyzer(executable, args, { cwd: repoRoot, workspacePath });
        let output = "", failure, timedOut = false;
        const append = (chunk) => { output = (output + chunk.toString("utf8")).slice(-64000); };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("message", (message) => { if (message.type === "spawn-error") failure = new Error(message.message); });
        child.once("error", (error) => { failure = error; });
        const stop = () => child.stop();
        signal?.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
        child.once("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", stop);
            if (signal?.aborted) reject(signal.reason);
            else if (failure) reject(failure);
            else if (timedOut) reject(new Error(`${label} exceeded its timeout and was stopped.\n${output}`));
            else if (code === null) reject(new Error(`${label} terminated without an exit code.\n${output}`));
            else resolvePromise({ code, output });
        });
    });
}
