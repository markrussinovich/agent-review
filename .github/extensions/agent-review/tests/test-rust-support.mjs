import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { reviewAdapter, sourceAdapter, testAdapterForMap } from "../language-adapters.mjs";
import { assessCratePackageRisk } from "../crate-package-risk.mjs";
import { cargoTestCommand, cargoTestPlan, formatCargoTestCommand, runCargoTests, rustSourceHash } from "../rust-test-run.mjs";
import { exportSnapshot } from "../test-run.mjs";
import { isReviewSymbol, isTestPath, languageForPath } from "../web/languages.mjs";
import { packageEvidenceLinks } from "../web/package-presentation.mjs";

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
        }] },
    };
    const plan = cargoTestPlan(map, "C:\\repo");
    assert.equal(plan.reason, null);
    assert.match(plan.prerequisites, /build scripts\/procedural macros/);
    assert.deepEqual(cargoTestCommand({ executable: "cargo" }, plan), [
        "cargo", "test", "--manifest-path", ".\\Cargo.toml", "--locked", "--",
        "tests::checks_changed", "--exact", "--nocapture",
    ]);
    assert.match(formatCargoTestCommand({ executable: "cargo" }, plan), /--locked/);
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
                path: "src/lib.rs", manifest: "Cargo.toml" }],
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
                path: "src/lib.rs", manifest: "Cargo.toml" }],
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
                path: "src/lib.rs", manifest: "Cargo.toml" }],
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
