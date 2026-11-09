import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { reviewAdapter, sourceAdapter, testAdapterForMap } from "../language-adapters.mjs";
import { assessCratePackageRisk } from "../crate-package-risk.mjs";
import { cargoTestCommand, cargoTestPlan, formatCargoTestCommand, runCargoTests, rustSourceHash } from "../rust-test-run.mjs";
import { exportSnapshot } from "../test-run.mjs";
import { isReviewSymbol, isTestPath, languageForPath } from "../web/languages.mjs";
import { packageEvidenceLinks } from "../web/package-presentation.mjs";

const libTarget = { kind: "lib", name: "fixture", path: "src/lib.rs" };

test("Rust language, symbols, test paths, and review adapter are registered", () => {
    assert.equal(languageForPath("src/lib.rs").id, "rust");
    assert.equal(sourceAdapter("src/lib.rs"), reviewAdapter("rust"));
    assert.equal(testAdapterForMap({ adapter_id: "rust" }).id, "rust");
    assert.throws(() => testAdapterForMap({ adapter_ids: ["python", "rust"] }),
        /combined execution is not implemented/);
    assert.equal(isReviewSymbol({ language: "rust", kind: "trait" }), true);
    assert.equal(isReviewSymbol({ language: "rust", kind: "enum" }), true);
    assert.equal(isTestPath("tests/integration.rs"), true);
    assert.equal(isTestPath("src/lib.rs"), false);
});

test("Cargo linked-test plan uses an exact locked command and advertises execution risks", () => {
    const source = "fn changed() {}";
    const hash = createHash("sha256").update(source).digest("hex");
    const map = {
        status: "complete", adapter_id: "rust", source_hashes: { "src/lib.rs": hash },
        callables: [{ path: "src/lib.rs", line: 1, entries: [{ status: "added" }] }],
        verification: { tests: [{
            id: "src/lib.rs::tests::checks_changed", name: "tests::checks_changed",
            path: "src/lib.rs", manifest: "Cargo.toml", link: "direct",
            cargo_target: libTarget,
        }] },
    };
    const plan = cargoTestPlan(map, "C:\\repo");
    assert.equal(plan.reason, null);
    assert.match(plan.prerequisites, /build scripts\/procedural macros/);
    assert.deepEqual(cargoTestCommand({ executable: "cargo" }, plan), [
        "cargo", "test", "--manifest-path", `.${sep}Cargo.toml`, "--locked", "--lib", "--",
        "tests::checks_changed", "--exact", "--nocapture",
    ]);
    assert.match(formatCargoTestCommand({ executable: "cargo" }, plan), /--locked/);
});

test("Cargo plans reject ambiguous and legacy selectors instead of guessing", async () => {
    for (const extra of [{}, { cargo_target: libTarget, selector_error: "Multiple module paths." }]) {
        const plan = cargoTestPlan({
            status: "complete", verification: { tests: [{
                id: "src/app.rs::checks", name: "checks", path: "src/app.rs",
                manifest: "Cargo.toml", link: "direct", ...extra,
            }] },
        }, "C:\\repo");
        assert.ok(plan.reason);
        assert.match(formatCargoTestCommand({ executable: "cargo" }, plan), /Unavailable/);
        assert.throws(() => cargoTestCommand({ executable: "cargo" }, plan));
        await assert.rejects(runCargoTests({ repoRoot: "C:\\repo", python: { executable: "cargo" }, plan }));
    }
});

test("Rust review fingerprints normalize BOM and CRLF without changing saved evidence", () => {
    const source = "pub fn changed() {\n    return;\n}\n";
    for (const current of [source, source.replaceAll("\n", "\r\n"), `\uFEFF${source.replaceAll("\n", "\r\n")}`]) {
        const request = reviewAdapter("rust").buildCodePathRequest({
            symbols: [{ id: "changed", qualname: "changed", language: "rust", kind: "function",
                path: "src/lib.rs", classification: "modified" }],
            source_files: { "src/lib.rs": { current } },
        });
        assert.equal(request.current["src/lib.rs"], current);
        assert.equal(request.source_hashes["src/lib.rs"], createHash("sha256").update(source).digest("hex"));
    }
    assert.notEqual(rustSourceHash(`${source}// real edit\n`), rustSourceHash(source));
    assert.notEqual(rustSourceHash(source.replace("return;", "panic!();")), rustSourceHash(source));
});

test("historical Rust runs accept checkout CRLF but still reject source edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-review-rust-newlines-"));
    const exec = promisify(execFile);
    const git = (...args) => exec("git", ["-C", root, ...args], { windowsHide: true });
    let exported;
    try {
        await mkdir(join(root, "src"));
        const source = "pub fn changed() {\n    return;\n}\n";
        await writeFile(join(root, "src", "lib.rs"), source);
        await writeFile(join(root, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
        await writeFile(join(root, ".gitattributes"), "*.rs text eol=crlf\n");
        await writeFile(join(root, "test"), "console.log('test tests::checks_changed ... ok');");
        await git("init", "--quiet");
        await git("config", "core.autocrlf", "true");
        await git("add", ".");
        await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
            "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
        exported = await exportSnapshot(root, "HEAD");
        const text = await readFile(join(exported, "src", "lib.rs"), "utf8");
        assert.equal(text, source.replaceAll("\n", "\r\n"), "exercise actual Git checkout conversion");
        const plan = {
            manifest: "Cargo.toml", tests: ["src/lib.rs::tests::checks_changed"],
            rust_tests: [{ id: "src/lib.rs::tests::checks_changed", name: "tests::checks_changed",
                path: "src/lib.rs", manifest: "Cargo.toml", cargo_target: libTarget }],
            source_hashes: { "src/lib.rs": rustSourceHash(source) },
        };
        const run = () => runCargoTests({ repoRoot: exported, python: { executable: process.execPath }, plan });
        assert.equal((await run()).trace.tests[plan.tests[0]].outcome, "passed");
        await writeFile(join(exported, "src", "lib.rs"), `\uFEFF${text}`);
        assert.equal((await run()).trace.tests[plan.tests[0]].outcome, "passed");
        await writeFile(join(exported, "src", "lib.rs"), `${text}// real edit\r\n`);
        await assert.rejects(run(), /Reviewed Rust source changed/);
    } finally {
        if (exported) await rm(exported, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("crates.io assessment uses exact OSV version and exposes registry evidence", async () => {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        requests.push([url, init]);
        if (url.includes("api.osv.dev")) return { ok: true, json: async () => ({ vulns: [] }) };
        return { ok: true, json: async () => ({
            crate: { max_stable_version: "2.0.1", recent_downloads: 12, repository: "https://github.com/demo/demo", description: "Demo" },
            versions: [{ num: "2.0.1", created_at: "2026-01-01T00:00:00Z", yanked: false, license: "MIT" }],
        }) };
    };
    const result = await assessCratePackageRisk("thiserror", "2.0.1", { fetchImpl, now: "2026-02-01" });
    assert.equal(result.ecosystem, "cargo");
    assert.equal(result.sources.osv.status, "ok");
    const osv = requests.find(([url]) => url.includes("api.osv.dev"));
    assert.deepEqual(JSON.parse(osv[1].body), {
        package: { ecosystem: "crates.io", name: "thiserror" }, version: "2.0.1",
    });
    assert.match(packageEvidenceLinks("thiserror", "2.0.1", null, "cargo").registry, /crates\.io/);
});

test("opt-in Cargo runner verifies source and records exact test outcomes", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), `.rust-runner-fixture-${process.pid}-${Date.now()}`);
    try {
        await mkdir(join(root, "src"), { recursive: true });
        const source = "pub fn changed() {}\n";
        await writeFile(join(root, "src", "lib.rs"), source);
        await writeFile(join(root, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
        await writeFile(join(root, "test"), "console.log('test tests::checks_changed ... ok');");
        const plan = {
            manifest: "Cargo.toml", tests: ["src/lib.rs::tests::checks_changed"],
            rust_tests: [{ id: "src/lib.rs::tests::checks_changed", name: "tests::checks_changed",
                path: "src/lib.rs", manifest: "Cargo.toml", cargo_target: libTarget }],
            source_hashes: { "src/lib.rs": createHash("sha256").update(source).digest("hex") },
        };
        const result = await runCargoTests({
            repoRoot: root, python: { executable: "node" }, plan, signal: new AbortController().signal,
        });
        assert.equal(result.trace.tests[plan.tests[0]].outcome, "passed");
        assert.equal(result.trace.per_test_path_evidence, false);
        await writeFile(join(root, "src", "lib.rs"), `${source}// changed after review\n`);
        await assert.rejects(runCargoTests({
            repoRoot: root, python: { executable: "node" }, plan, signal: new AbortController().signal,
        }), /source changed/);
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("cancelling an owned Cargo run stops the test process without outcomes", { timeout: 15_000 }, async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), `.rust-runner-fixture-${process.pid}-${Date.now()}`);
    const controller = new AbortController();
    let pending;
    try {
        await mkdir(join(root, "src"), { recursive: true });
        const source = "pub fn changed() {}\n";
        await writeFile(join(root, "src", "lib.rs"), source);
        await writeFile(join(root, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
        await writeFile(join(root, "test"), "while (true) {}");
        const plan = {
            manifest: "Cargo.toml", tests: ["src/lib.rs::tests::slow"],
            rust_tests: [{ id: "src/lib.rs::tests::slow", name: "tests::slow",
                path: "src/lib.rs", manifest: "Cargo.toml", cargo_target: libTarget }],
            source_hashes: { "src/lib.rs": createHash("sha256").update(source).digest("hex") },
        };
        pending = runCargoTests({ repoRoot: root, python: { executable: "node" }, plan, signal: controller.signal });
        await new Promise((resolve) => setTimeout(resolve, 500));
        controller.abort(new DOMException("Cancelled Cargo fixture", "AbortError"));
        await assert.rejects(pending, /Cancelled Cargo fixture/);
    } finally {
        controller.abort(new DOMException("Fixture cleanup", "AbortError"));
        await pending?.catch(() => {});
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("generated Cargo exact selectors execute root and declared-module tests in pinned targets", {
    skip: process.env.AGENT_REVIEW_EXECUTE_CARGO_TESTS !== "1", timeout: 300_000,
}, async () => {
    const extension = dirname(dirname(fileURLToPath(import.meta.url)));
    const fixture = join(extension, "tests", "fixtures", "rust-selectors");
    const root = await mkdtemp(join(tmpdir(), "agent-review-rust-selectors-"));
    const exec = promisify(execFile);
    try {
        await cp(fixture, root, { recursive: true });
        const current = {};
        async function load(directory, prefix = "") {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
                const path = prefix + entry.name;
                if (entry.isDirectory()) await load(join(directory, entry.name), `${path}/`);
                else current[path] = await readFile(join(directory, entry.name), "utf8");
            }
        }
        await load(root);
        const request = reviewAdapter("rust").buildCodePathRequest({
            symbols: [{ id: "placeholder", language: "rust", kind: "function", classification: "modified",
                name: "changed", qualname: "changed", path: "src/lib.rs" }],
            source_files: Object.fromEntries(Object.entries(current).map(([path, text]) => [path, { current: text }])),
        });
        const input = join(root, "review-input.json");
        await writeFile(input, JSON.stringify(request));
        const script = [
            "import json,sys", "sys.path.insert(0,sys.argv[1])",
            "from rust_graph import _scan_side", "from rust_decisions import build",
            "payload=json.load(open(sys.argv[2],encoding='utf-8'))",
            "facts=_scan_side({p:t.encode() for p,t in payload['current'].items()},[])",
            "symbol=next(s for s in facts['symbols'].values() if s['name']=='changed')",
            "payload['callables']=[{'id':symbol['id'],'qualname':'changed'}]",
            "json.dump(build(payload),sys.stdout)",
        ].join("\n");
        const { stdout } = await exec(process.env.AGENT_REVIEW_PYTHON || "python",
            ["-c", script, join(extension, "analyzer"), input], { windowsHide: true });
        const map = { ...JSON.parse(stdout), status: "complete", adapter_id: "rust" };
        const plan = cargoTestPlan(map, root);
        assert.equal(plan.reason, null);
        assert.equal(plan.rust_tests.length, 24);
        assert.ok(plan.source_hashes["Cargo.toml"], "Cargo target declarations must be pinned too");
        assert.ok(plan.rust_tests.some((test) => test.name === "app::tests::nonroot_checks"));
        const runtime = { executable: process.env.AGENT_REVIEW_TEST_CARGO || "cargo" };
        const result = await runCargoTests({ repoRoot: root, python: runtime, plan });
        assert.equal(result.exit_code, 0, result.output);
        assert.equal(Object.values(result.trace.tests).filter((test) => test.outcome === "passed").length, 24, result.output);
        assert.equal((result.output.match(/running 1 test\b/g) || []).length, 24, result.output);
        assert.doesNotMatch(result.output, /wrong Cargo target/);
        const wrong = await exec(runtime.executable, [
            "test", "--manifest-path", join(root, "Cargo.toml"), "--locked", "--lib", "--",
            "tests::nonroot_checks", "--exact", "--nocapture",
        ], { windowsHide: true });
        assert.match(wrong.stdout, /running 0 tests/, "reproduce the issue's missing-module selector");
        await writeFile(join(root, "Cargo.toml"), `${current["Cargo.toml"]}\n# target declaration edit\n`);
        await assert.rejects(runCargoTests({ repoRoot: root, python: runtime, plan }), /source changed: Cargo.toml/);
        const customRoot = join(root, "custom-library");
        const customFiles = {
            "Cargo.toml": '[workspace.package]\nedition="2021"\n'
                + '[package]\nname="custom-library"\nversion="0.1.0"\nedition.workspace=true\n'
                + '[lib]\nname="renamed_library"\npath="roots/entry.rs"\n'
                + '[[bin]]\nname="explicit"\npath="roots/custom_bin.rs"\n',
            "Cargo.lock": 'version=4\n[[package]]\nname="custom-library"\nversion="0.1.0"\n',
            "roots/entry.rs": "pub fn changed() -> bool { true }\nmod worker;\n"
                + "#[test]\nfn root_checks() { assert!(changed()); }\n",
            "roots/worker.rs": "#[test]\nfn module_checks() { assert!(crate::changed()); }\n",
            "roots/custom_bin.rs": "fn main() {}\n#[test]\n"
                + "fn custom_bin_checks() { assert!(renamed_library::changed()); }\n",
            "src/bin/auto.rs": "fn main() {}\n#[test]\n"
                + "fn auto_bin_checks() { assert!(renamed_library::changed()); }\n",
        };
        for (const [path, source] of Object.entries(customFiles)) {
            await mkdir(dirname(join(customRoot, path)), { recursive: true });
            await writeFile(join(customRoot, path), source);
        }
        await writeFile(input, JSON.stringify({
            current: customFiles, source_hashes: Object.fromEntries(Object.entries(customFiles)
                .filter(([path]) => path.endsWith(".rs") || path === "Cargo.toml")
                .map(([path, source]) => [path, rustSourceHash(source)])),
        }));
        const custom = await exec(process.env.AGENT_REVIEW_PYTHON || "python",
            ["-c", script, join(extension, "analyzer"), input], { windowsHide: true });
        const customPlan = cargoTestPlan({ ...JSON.parse(custom.stdout), status: "complete" }, customRoot);
        assert.equal(customPlan.reason, null);
        assert.deepEqual(customPlan.rust_tests.map((test) => test.name).sort(),
            ["auto_bin_checks", "custom_bin_checks", "root_checks", "worker::module_checks"]);
        const autoBin = customPlan.rust_tests.find((test) => test.name === "auto_bin_checks");
        assert.deepEqual(autoBin.cargo_target, { kind: "bin", name: "auto", path: "src/bin/auto.rs" });
        const customResult = await runCargoTests({ repoRoot: customRoot, python: runtime, plan: customPlan });
        assert.equal(customResult.exit_code, 0, customResult.output);
        assert.equal(Object.values(customResult.trace.tests).filter((test) => test.outcome === "passed").length, 4, customResult.output);
        assert.equal((customResult.output.match(/running 1 test\b/g) || []).length, 4, customResult.output);
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
