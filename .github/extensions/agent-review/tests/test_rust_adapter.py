from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))

from language_adapters import AnalysisSnapshot, active_adapters
from review_model import ReviewModel
from rust_adapter import RUST_ADAPTER
from rust_coverage import load_rust_coverage
from rust_decisions import build as build_decisions
from rust_graph import _mask, _scan_side
from rust_packages import cargo_package_diff, parse_cargo_packages


FIXTURE = Path(__file__).parent / "fixtures" / "rust-demo"

WRAPPED_LIMIT = """pub fn limit(
    attempts: u32,
    window: [u8; 4],
) -> bool {
    if attempts > {threshold} {
        return false;
    }
    window[0] == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_limit() {
        assert!(!limit(9, [0; 4]));
    }
}
"""


def tree(name: str) -> dict[str, bytes]:
    root = FIXTURE / name
    return {path.relative_to(root).as_posix(): path.read_bytes()
            for path in root.rglob("*") if path.is_file()}


class RustAdapterTests(unittest.TestCase):
    def snapshot(self, baseline=None, current=None, *, head="a" * 40):
        return AnalysisSnapshot(Path("."), baseline or {}, current or {}, None, True, False, head)

    def test_detection_packages_lock_resolution_and_source_evidence(self):
        before, after = tree("baseline"), tree("changed")
        self.assertEqual([adapter.id for adapter in active_adapters(self.snapshot(before, after))], ["rust"])
        packages = {item["name"]: item for item in parse_cargo_packages(after)}
        self.assertEqual(packages["serde"]["resolved_version"], "1.0.210")
        self.assertEqual(packages["thiserror"]["resolved_version"], "2.0.1")
        self.assertEqual(packages["thiserror"]["lock_source"], "Cargo.lock")
        self.assertEqual(packages["thiserror"]["lock_line"], 15)
        self.assertEqual(packages["thiserror"]["line"], 8)
        changes = cargo_package_diff(parse_cargo_packages(before), list(packages.values()))
        self.assertEqual([item["name"] for item in changes], ["thiserror"])
        self.assertEqual(changes[0]["kind"], "added")
        mixed = self.snapshot({}, {"main.py": b"def run(): return 1\n",
                                   "src/lib.rs": b"pub fn run() {}\n"})
        self.assertEqual([adapter.id for adapter in active_adapters(mixed)], ["python", "rust"])

    def test_workspace_renames_target_groups_and_dependency_tables_are_preserved(self):
        files = {
            "Cargo.toml": b"""[workspace]\nmembers=[\"app\"]\n[workspace.dependencies]\nrenamed = { package = \"real-crate\", version = \"1\" }\n""",
            "app/Cargo.toml": b"""[package]\nname=\"app\"\nversion=\"0.1.0\"\n[dependencies]\nrenamed.workspace = true\n[target.'cfg(windows)'.build-dependencies]\nwinapi = \"0.3\"\n[dev-dependencies.pretty_assertions]\nversion = \"1\"\n""",
            "Cargo.lock": b"""version=3\n[[package]]\nname=\"real-crate\"\nversion=\"1.2.3\"\nsource=\"registry+https://github.com/rust-lang/crates.io-index\"\n[[package]]\nname=\"winapi\"\nversion=\"0.3.9\"\nsource=\"registry+https://github.com/rust-lang/crates.io-index\"\n[[package]]\nname=\"pretty_assertions\"\nversion=\"1.4.1\"\nsource=\"registry+https://github.com/rust-lang/crates.io-index\"\n""",
        }
        packages = {item["name"]: item for item in parse_cargo_packages(files)}
        self.assertEqual(packages["real-crate"]["import_name"], "renamed")
        self.assertEqual(packages["real-crate"]["resolved_version"], "1.2.3")
        self.assertTrue(packages["real-crate"]["workspace_inherited"])
        self.assertEqual(packages["winapi"]["target"], "cfg(windows)")
        self.assertEqual(packages["winapi"]["group"], "build")
        self.assertEqual(packages["pretty_assertions"]["group"], "dev")
        self.assertEqual(packages["pretty_assertions"]["line"], 8)
        self.assertGreater(packages["pretty_assertions"]["start_column"], 0)

    def test_graph_symbols_relationships_metrics_and_package_usage(self):
        before, after = tree("baseline"), tree("changed")
        snapshot = self.snapshot(before, after)
        model = ReviewModel({})
        model.changes = [
            {"path": path, "status": "modified" if path in before else "added",
             "lines_added": len(raw.splitlines()), "lines_removed": 1,
             "added_lines": list(range(1, len(raw.splitlines()) + 1)), "removed_lines": [1],
             "current_lines": len(raw.splitlines()), "baseline_lines": len(before.get(path, b"").splitlines())}
            for path, raw in after.items()
        ]
        dependencies = RUST_ADAPTER.dependencies(snapshot, model.warnings)
        model.packages = dependencies
        RUST_ADAPTER.scan(snapshot, model, dependencies, lambda *_: None)
        RUST_ADAPTER.resolve_package_usage(model, dependencies)
        dto = model.to_dict()
        kinds = {(item["type"], item.get("language")) for item in dto["nodes"]}
        self.assertTrue({("struct", "rust"), ("enum", "rust"), ("trait", "rust"), ("method", "rust")} <= kinds)
        self.assertTrue(any(edge["type"] == "uses_package" and edge["target"] == "package:cargo:thiserror"
                            for edge in dto["edges"]))
        crate = next(item for item in dto["package_dependencies"] if item["name"] == "thiserror")
        self.assertEqual(crate["ecosystem"], "cargo")
        self.assertEqual(crate["resolved_current"], "2.0.1")
        self.assertTrue(crate["usage_locations"])
        score = next(item for item in dto["nodes"] if item["type"] == "method" and item["name"] == "score")
        self.assertEqual(score["change"], "modified")
        self.assertGreater(score["metrics"]["lines_changed"], 0)
        self.assertEqual(dto["metadata"]["rust_loc"], len(after["src/lib.rs"].splitlines()))

    def test_file_modules_crate_imports_and_qualified_functions_resolve_without_toolchain(self):
        current = {
            "Cargo.toml": b'[package]\nname="modules"\nversion="0.1.0"\n',
            "src/lib.rs": b"mod worker;\nuse crate::worker::run;\npub async fn start() { run(); }\n",
            "src/worker.rs": b"pub unsafe fn run() {}\n",
        }
        model = ReviewModel({})
        model.changes = [
            {"path": path, "status": "added", "lines_added": len(raw.splitlines()), "lines_removed": 0,
             "added_lines": list(range(1, len(raw.splitlines()) + 1)), "removed_lines": [],
             "current_lines": len(raw.splitlines()), "baseline_lines": 0}
            for path, raw in current.items()
        ]
        snapshot = self.snapshot({}, current)
        dependencies = RUST_ADAPTER.dependencies(snapshot, model.warnings)
        RUST_ADAPTER.scan(snapshot, model, dependencies, lambda *_: None)
        dto = model.to_dict()
        self.assertTrue(any(node["kind"] == "function" and node["name"] == "start" for node in dto["nodes"]))
        imports = [edge for edge in dto["edges"] if edge["type"] == "imports"]
        self.assertGreaterEqual(len(imports), 2)
        self.assertTrue(any(edge["type"] == "calls" for edge in dto["edges"]))

    def test_decisions_link_exact_rust_test_without_execution(self):
        before, after = tree("baseline"), tree("changed")
        snapshot = self.snapshot(before, after)
        model = ReviewModel({})
        model.changes = [{"path": "src/lib.rs", "status": "modified", "lines_added": 8,
                          "lines_removed": 2, "added_lines": list(range(1, 9)), "removed_lines": [1, 2],
                          "current_lines": len(after["src/lib.rs"].splitlines()),
                          "baseline_lines": len(before["src/lib.rs"].splitlines())}]
        dependencies = RUST_ADAPTER.dependencies(snapshot, model.warnings)
        RUST_ADAPTER.scan(snapshot, model, dependencies, lambda *_: None)
        score = next(item for item in model.symbols if item["kind"] == "method"
                     and item["name"] == "score" and item["classification"] == "modified")
        report = build_decisions({
            "baseline": {"Cargo.toml": before["Cargo.toml"].decode(),
                         "src/lib.rs": before["src/lib.rs"].decode()},
            "current": {"Cargo.toml": after["Cargo.toml"].decode(),
                        "src/lib.rs": after["src/lib.rs"].decode()},
            "callables": [{"id": score["id"], "qualname": score["qualname"]}],
            "source_hashes": {"src/lib.rs": hashlib.sha256(after["src/lib.rs"]).hexdigest()},
        })
        self.assertEqual(report["callables"][0]["language"], "rust")
        self.assertTrue(any(entry["status"] in {"added", "changed"} for entry in report["callables"][0]["entries"]))
        self.assertEqual(report["verification"]["tests"][0]["name"], "tests::accepts_large_values")
        self.assertIn(score["id"], report["verification"]["tests"][0]["callables"])

    def test_wrapped_signatures_where_clauses_array_parameters_and_macro_templates(self):
        source = b"""pub struct Cache<K, V>
where
    K: Eq,
{
    items: Vec<(K, V)>,
}

impl Cache<String, u32> {
    pub fn get(
        &self,
        key: &String,
    ) -> Option<&u32> {
        self.items.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

pub fn checksum(bytes: [u8; 4]) -> u32 {
    bytes.iter().map(|b| *b as u32).sum()
}

macro_rules! getter {
    ($name:ident) => {
        pub fn $name(
            &self,
        ) -> u32 {
            0
        }
    };
}
"""
        symbols = {item["qualname"]: item for item in _scan_side({"src/lib.rs": source}, [])["symbols"].values()}
        self.assertEqual(symbols["Cache"]["kind"], "struct")
        self.assertEqual(symbols["Cache::get"]["kind"], "method")
        self.assertEqual(symbols["Cache::get"]["parent_identity"], symbols["Cache"]["identity"])
        self.assertEqual(symbols["Cache::get"]["range"], {"start_line": 9, "end_line": 14})
        self.assertEqual(symbols["Cache::get"]["signature"], "pub fn get( &self, key: &String, ) -> Option<&u32>")
        # `;` inside `[u8; 4]` does not end the signature, so the body belongs to the function.
        self.assertEqual(symbols["checksum"]["range"], {"start_line": 17, "end_line": 19})
        self.assertFalse(any(name.startswith("$") for name in symbols))

    def test_character_literals_preserve_following_symbols_and_function_digests(self):
        literals = ("'_'", "'a'", "'Z'", "b'a'", "'{'", "'}'", "'\u03bb'",
                    r"'\''", r"'\\'", r"'\n'", r"'\x7f'", r"'\u{1f980}'")
        for literal in literals:
            with self.subTest(literal=literal):
                first = f"pub fn first() {{\n    let value = {literal};\n}}"
                before = first + "\n"
                after = before + "pub fn added() {}\n"
                old = _scan_side({"src/lib.rs": before.encode()}, [])["symbols"]
                new = _scan_side({"src/lib.rs": after.encode()}, [])["symbols"]
                symbols = {item["name"]: item for item in new.values()}
                self.assertEqual(set(symbols), {"first", "added"})
                self.assertEqual(symbols["first"]["range"], {"start_line": 1, "end_line": 3})
                self.assertEqual(symbols["added"]["range"], {"start_line": 4, "end_line": 4})
                self.assertEqual(symbols["first"]["digest"], hashlib.sha256(first.encode()).hexdigest())
                self.assertEqual(next(iter(old.values()))["digest"], symbols["first"]["digest"])
                self.assertEqual(len(_mask(after)), len(after))
                self.assertEqual(_mask(after).count("\n"), after.count("\n"))

    def test_lifetimes_and_loop_labels_are_not_masked_as_literals(self):
        source = """pub fn borrow<'a>(value: &'a str) -> &'a str {
    'retry: loop { break 'retry value; }
}
pub fn anonymous(value: &'_ str) {}
pub fn unicode<'\u03bb>(value: &'\u03bb str) -> &'\u03bb str { value }
"""
        self.assertEqual(_mask(source), source)
        symbols = _scan_side({"src/lib.rs": source.encode()}, [])["symbols"].values()
        self.assertEqual({item["name"] for item in symbols}, {"borrow", "anonymous", "unicode"})

    def test_wrapped_function_code_paths_and_test_links(self):
        before = WRAPPED_LIMIT.replace("{threshold}", "3")
        after = WRAPPED_LIMIT.replace("{threshold}", "5")
        limit = next(item for item in _scan_side({"src/lib.rs": after.encode()}, [])["symbols"].values()
                     if item["qualname"] == "limit")
        report = build_decisions({
            "baseline": {"src/lib.rs": before}, "current": {"src/lib.rs": after},
            "callables": [{"id": limit["id"], "qualname": "limit"}],
        })
        changed = [entry for entry in report["callables"][0]["entries"] if entry["status"] == "changed"]
        self.assertEqual([(entry["decision"]["value"], entry["decision"]["when"]) for entry in changed],
                         [("false", ["attempts > 5"])])
        self.assertEqual(changed[0]["base"]["when"], ["attempts > 3"])
        self.assertEqual(report["verification"]["tests"][0]["name"], "tests::blocks_after_limit")
        self.assertEqual(report["verification"]["tests"][0]["callables"], [limit["id"]])

    def test_coverage_requires_revision_and_source_hash_match(self):
        after = tree("changed")
        source_hash = hashlib.sha256(after["src/lib.rs"].replace(b"\r\n", b"\n")).hexdigest()
        metadata = {"revision": "a" * 40, "report": "lcov.info",
                    "source_hashes": {"src/lib.rs": source_hash}}
        after["rust-coverage.json"] = json.dumps(metadata).encode()
        after["lcov.info"] = b"TN:\nSF:src/lib.rs\nDA:19,1\nDA:20,0\nend_of_record\n"
        report = load_rust_coverage(self.snapshot(tree("baseline"), after))
        self.assertTrue(report["available"])
        self.assertEqual(report["files"][0]["covered_lines"], [19])
        stale = dict(after)
        stale["rust-coverage.json"] = json.dumps({**metadata, "revision": "b" * 40}).encode()
        report = load_rust_coverage(self.snapshot(tree("baseline"), stale))
        self.assertFalse(report["available"])
        self.assertRegex(report["warnings"][0], "revision")

    def test_invalid_current_manifest_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "invalid Cargo"):
            RUST_ADAPTER.dependencies(self.snapshot({}, {"Cargo.toml": b"[package"}), [])


if __name__ == "__main__":
    unittest.main()
