import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { swiftHash, isSwiftPath } from "./swift-syntax.mjs";
import { runOwnedTestCommand } from "./owned-test-command.mjs";

const identifier = /^[A-Za-z_]\w*$/;
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inputPath = (path) => isSwiftPath(path) || posix.basename(path) === "Package.resolved";
const ignored = new Set(JSON.parse(await readFile(new URL("./analyzer/snapshot-excludes.json", import.meta.url), "utf8"))
    .filter((entry) => !entry.includes("/") && !entry.includes("*")));

export function resolveSwiftRuntime(root, config = {}) {
    const configured = config.test_swift || process.env.AGENT_REVIEW_TEST_SWIFT || "swift";
    if (typeof configured !== "string" || !configured || configured.includes("\0")) {
        return { executable: "<test_swift>", error: "test_swift must name one Swift executable, not shell arguments." };
    }
    return { executable: !isAbsolute(configured) && existsSync(join(root, configured)) ? join(root, configured) : configured,
        source: config.test_swift ? ".agent-review.json test_swift" : process.env.AGENT_REVIEW_TEST_SWIFT ? "AGENT_REVIEW_TEST_SWIFT" : "PATH" };
}

function validTest(test) {
    return test && ["xctest", "swift-testing"].includes(test.framework) && identifier.test(test.target)
        && typeof test.suite === "string"
        && (test.suite === "" || test.suite.split(".").every((name) => identifier.test(name)))
        && (test.framework === "xctest" ? test.suite && /^test\w*$/.test(test.function_name)
            : /^[A-Za-z_]\w*\((?:[A-Za-z_]\w*:)*\)$/.test(test.function_name));
}

function validManifest(manifest) {
    return typeof manifest === "string" && !isAbsolute(manifest) && !manifest.includes("\\")
        && !manifest.includes("\0") && !manifest.split("/").includes("..") && posix.basename(manifest) === "Package.swift";
}

export function swiftTestPlan(map, root) {
    const linked = (map?.verification?.tests || []).filter((test) => test.link !== "name-only");
    const manifests = [...new Set(linked.map((test) => test.manifest))], manifest = manifests[0];
    const hashes = map?.source_hashes || {};
    const invalid = linked.find((test) => test.selector_error || !validTest(test));
    let reason = map?.status !== "complete" ? "Code paths are still being extracted."
        : !linked.length ? "No XCTest or Swift Testing tests are statically linked to changed code."
            : invalid ? `${invalid.id}: ${invalid.selector_error || "The exact SwiftPM test selector is unresolved."}`
                : manifests.length !== 1 ? "Run linked Swift tests from one Package.swift at a time."
                    : !validManifest(manifest) ? "The SwiftPM manifest is outside the saved snapshot." : null;
    if (!reason && (!Object.keys(hashes).length || !hashes[manifest])) reason = "Saved Swift source and manifest hashes are required; reanalyze.";
    return { tests: linked.slice(0, 100).map((test) => test.id), swift_tests: linked.slice(0, 100),
        manifest, source_hashes: hashes, files: [...new Set((map?.callables || []).map((item) => resolve(root, item.path)))],
        omitted: Math.max(0, linked.length - 100), reason,
        prerequisites: "Swift 6+ and the saved SwiftPM dependencies. Explicit Run evaluates Package.swift, may download locked dependencies, "
            + "build plugins/macros and execute reviewed code. A snapshot export is not a sandbox. Xcode projects/schemes are not supported. "
            + "Named test outcomes do not confirm individual paths; no per-test execution trace is collected." };
}

export function swiftTestCommand(runtime, plan, test = plan.swift_tests?.[0], report = "<temporary-results.xml>") {
    if (runtime.error || plan.reason || !test || !validTest(test) || test.selector_error
        || !validManifest(plan.manifest) || test.manifest !== plan.manifest) {
        throw new Error(runtime.error || plan.reason || test?.selector_error || "No exact SwiftPM test selector is available.");
    }
    const swiftTesting = test.framework === "swift-testing";
    const components = [...(test.suite ? test.suite.split(".") : []), test.function_name];
    const selector = `${test.target}.${components.join("/")}`;
    return [runtime.executable, "test", "--package-path", `.${sep}${posix.dirname(plan.manifest).split("/").join(sep)}`,
        "--force-resolved-versions",
        ...(swiftTesting ? ["--enable-swift-testing", "--disable-xctest"] : ["--enable-xctest", "--disable-swift-testing", "--parallel", "--num-workers", "1"]),
        "--filter", `^${escaped(selector)}${swiftTesting ? "(?:/.*)?" : ""}$`, "--xunit-output", report];
}

export function formatSwiftTestCommand(runtime, plan) {
    if (runtime.error || plan.reason) return `Unavailable: ${runtime.error || plan.reason}`;
    const quote = (value) => /^[A-Za-z0-9_@.\\/:=+-]+$/.test(value) ? value
        : process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
    return plan.swift_tests.map((test) => swiftTestCommand(runtime, plan, test).map(quote).join(" ")).join("\n");
}

async function verifySources(root, hashes) {
    if (!Object.keys(hashes || {}).length) throw new Error("Saved Swift source hashes are required.");
    const actual = new Set();
    async function walk(directory, prefix = "") {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (ignored.has(entry.name)) continue;
            const path = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) {
                throw new Error(`Swift snapshot input is a symlink: ${path}`);
            }
            if (entry.isDirectory()) await walk(join(directory, entry.name), path);
            else if (entry.isFile() && inputPath(path)) actual.add(path);
        }
    }
    await walk(root);
    if (JSON.stringify([...actual].sort()) !== JSON.stringify(Object.keys(hashes).sort())) {
        throw new Error("Swift source/Package.resolved inventory changed. Reanalyze before running linked tests.");
    }
    for (const [path, expected] of Object.entries(hashes)) {
        const full = resolve(root, path), local = relative(root, full);
        if (!local || isAbsolute(path) || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)
            || path.includes("\\") || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid reviewed Swift source hash: ${path}`);
        const bytes = await readFile(full);
        let source;
        try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch (error) { throw new Error(`Reviewed Swift source is no longer valid UTF-8: ${path}`, { cause: error }); }
        if (!(await lstat(full)).isFile() || swiftHash(source) !== expected) {
            throw new Error(`Reviewed Swift source changed: ${path}. Reanalyze before running linked tests.`);
        }
    }
}

function xmlValue(value) {
    return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, entity) => {
        if (entity[0] === "#") {
            const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
            return String.fromCodePoint(code);
        }
        return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[entity];
    });
}

export function swiftTestOutcome(xml, test) {
    if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)
        || !/<\/testsuites?>\s*$/.test(xml)) throw new Error("Swift test results are malformed, incomplete, or too large.");
    const cases = xml.match(/<testcase\b[^>]*(?:\/>|>[\s\S]*?<\/testcase>)/g) || [];
    const attributes = (entry) => Object.fromEntries([...entry.slice(0, entry.indexOf(">")).matchAll(/([\w-]+)="([^"]*)"/g)]
        .map((match) => [match[1], xmlValue(match[2])]));
    const expectedClass = [test.target, test.suite].filter(Boolean).join(".");
    if (cases.length !== 1) throw new Error(`Swift did not report exactly one selected test ${test.id}; zero/extra-test runs are not passing evidence.`);
    const entry = cases[0], attrs = attributes(entry);
    if (attrs.classname !== expectedClass || attrs.name !== test.function_name) {
        throw new Error(`Swift reported a different test, not ${test.id}. No test evidence was recorded.`);
    }
    if (/<skipped\b/.test(entry)) return "skipped";
    if (!attrs.time || !Number.isFinite(Number(attrs.time)) || Number(attrs.time) < 0) throw new Error(`Swift test ${test.id} has no completed-test timing.`);
    return /<(?:failure|error)\b/.test(entry) ? "failed" : "passed";
}

export async function runSwiftTests({ repoRoot, python: runtime, plan, signal, workspacePath, timeoutMs = 300_000 }) {
    if (runtime.error || plan.reason || !plan.swift_tests?.length) throw new Error(runtime.error || plan.reason || "No linked Swift tests were selected.");
    if (!validManifest(plan.manifest) || !plan.source_hashes?.[plan.manifest]) throw new Error("The selected SwiftPM manifest must belong to the saved snapshot.");
    await verifySources(repoRoot, plan.source_hashes);
    const directory = await mkdtemp(join(tmpdir(), "agent-review-swift-tests-"));
    const trace = { tests: {}, per_test_path_evidence: false }, deadline = Date.now() + timeoutMs;
    let output = "", exitCode = 0;
    try {
        for (const [index, test] of plan.swift_tests.entries()) {
            signal?.throwIfAborted();
            await verifySources(repoRoot, plan.source_hashes);
            const report = join(directory, `${index}.xml`);
            const [executable, ...args] = swiftTestCommand(runtime, plan, test, report);
            const result = await runOwnedTestCommand(executable, args, {
                repoRoot, signal, workspacePath, timeoutMs: Math.max(1, deadline - Date.now()), label: "Swift build/test",
            });
            output = `${output}\n${result.output}`.slice(-64000);
            await verifySources(repoRoot, plan.source_hashes);
            let xml;
            try {
                const metadata = await lstat(report);
                if (!metadata.isFile() || metadata.size > 2_000_000) throw new Error("xUnit output must be a regular file no larger than 2 MB.");
                xml = await readFile(report, "utf8");
            }
            catch (error) { throw new Error(`Swift produced no readable named-test report (exit ${result.code}): ${error.message}\n${result.output}`); }
            const outcome = swiftTestOutcome(xml, test);
            if (result.code !== 0 && outcome !== "failed") throw new Error(`Swift exited ${result.code} without a matching test failure.\n${result.output}`);
            exitCode ||= result.code || Number(outcome === "failed");
            trace.tests[test.id] = { outcome, executed_lines: {} };
        }
        signal?.throwIfAborted();
        return { exit_code: exitCode, output, trace,
            path_evidence_limitation: "Swift results confirm exact linked test outcomes only. No per-test path tracing was collected; inferred paths remain inferred." };
    } finally { await rm(directory, { recursive: true, force: true }); }
}
