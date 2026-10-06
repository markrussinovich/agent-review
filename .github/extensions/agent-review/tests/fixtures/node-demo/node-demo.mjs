import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ReviewState } from "../../../review-state.mjs";
import { startReviewServer } from "../../../server.mjs";

const args = process.argv.slice(2);
const createOnly = args.includes("--create-only");
const positional = args.filter((arg) => arg !== "--create-only");
if (positional.length !== 2 || positional[0] !== "--demo" || !positional[1] || positional[1].startsWith("--")
    || args.filter((arg) => arg === "--create-only").length > 1) {
    console.error("Usage: node node-demo.mjs --demo <persistent-directory> [--create-only]");
    process.exitCode = 1;
} else {
    const repo = resolve(positional[1]);
    const fixture = fileURLToPath(new URL("./", import.meta.url));
    const marker = join(repo, ".git", "agent-review-node-demo.json");
    const config = join(repo, ".git", "agent-review-node-demo", "config");
    const runtime = join(repo, ".git", "agent-review-node-demo", "runtime");
    const execute = promisify(execFile);
    const git = (...parameters) => execute("git", [
        "-C", repo, "-c", `core.hooksPath=${config}`, "-c", "commit.gpgsign=false", ...parameters,
    ]);
    let state, server;
    try {
        const populated = existsSync(repo) && (await readdir(repo)).length > 0;
        if (populated) {
            if (!existsSync(marker) || JSON.parse(await readFile(marker, "utf8")).fixture !== "node-review-demo-v1") {
                throw new Error("Refusing to modify or serve an existing directory not created by this demo.");
            }
            const gitRoot = resolve((await git("rev-parse", "--show-toplevel")).stdout.trim());
            if (process.platform === "win32" ? gitRoot.toLowerCase() !== repo.toLowerCase() : gitRoot !== repo) {
                throw new Error("The demo directory must be its own Git repository.");
            }
        } else {
            await mkdir(repo, { recursive: true });
            await cp(join(fixture, "baseline"), repo, { recursive: true });
            await git("init", "-q", "--template=");
            await mkdir(config, { recursive: true });
            await git("config", "user.name", "Node review demo");
            await git("config", "user.email", "node-review@example.invalid");
            await git("config", "core.autocrlf", "false");
            await git("add", ".");
            await git("commit", "-qm", "Baseline reference workspace");
            await cp(join(fixture, "changed"), repo, { recursive: true });
            await writeFile(marker, JSON.stringify({ fixture: "node-review-demo-v1" }) + "\n");
        }
        console.log(`Persistent demo repository: ${repo}`);
        console.log("No project packages are installed. Project tests run only through the explicit Run linked tests action.");
        if (!createOnly) {
            await mkdir(config, { recursive: true });
            await mkdir(runtime, { recursive: true });
            for (const name of ["TEMP", "TMP", "TMPDIR"]) process.env[name] = runtime;
            state = new ReviewState(repo, {
                baseRef: "HEAD",
                currentSessionId: "standalone-node-fixture-demo",
                customPromptOptions: { globalDirectory: config },
                getSessionEvents: async () => [],
                getHistoricalSessionContexts: async () => ({ contexts: [], failures: [] }),
            });
            await state.refresh();
            const map = await state.decisionMapFor(60000);
            if (map.status !== "complete") throw new Error(map.error || "Code-path extraction failed.");
            console.log(`Code paths: ${map.callables.length} callables; ${map.verification?.tests.length || 0} static test links.`);
            for (const warning of map.warnings || []) console.warn(`Code-path limitation: ${warning}`);
            server = await startReviewServer(state);
            console.log(`Agent Review: ${server.url}`);
            console.log(`Dark theme: ${server.url}?scoutTheme=dark`);
            console.log("Uses the production ReviewState/server; no Copilot user sessions or AI provider are connected.");
            console.log("Package panels use production public npm metadata/OSV providers on demand.");
            console.log("Press Ctrl+C to stop the server. The demo repository is retained.");
            await new Promise((done) => {
                process.once("SIGINT", done);
                process.once("SIGTERM", done);
            });
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    } finally {
        await server?.close();
        await state?.dispose();
    }
}
