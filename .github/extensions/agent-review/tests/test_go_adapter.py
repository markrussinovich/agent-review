from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))

from go_adapter import GO_ADAPTER
from go_coverage import load_go_coverage
from go_packages import go_package_diff, parse_go_packages
from language_adapters import AnalysisSnapshot, active_adapters
from review_model import ReviewModel


def snapshot(baseline=None, current=None):
    return AnalysisSnapshot(Path("missing"), baseline or {}, current or {}, None, True, False)


class GoPackageTests(unittest.TestCase):
    def test_exact_versions_checksums_indirect_replace_and_diff(self):
        warnings: list[str] = []
        baseline = parse_go_packages({
            "go.mod": b"module demo\nrequire example.com/lib v1.2.3\n",
            "go.sum": b"example.com/lib v1.2.3 h1:one\n",
        }, warnings)
        current = parse_go_packages({
            "go.mod": b"module demo\nrequire (\n example.com/lib v1.3.0\n example.com/local v0.0.1 // indirect\n)\nreplace example.com/local => ./local\n",
            "go.sum": b"example.com/lib v1.3.0 h1:two\n",
        }, warnings)
        self.assertEqual("v1.2.3", baseline[0]["resolved_version"])
        self.assertTrue(baseline[0]["checksum_verified"])
        by_name = {item["name"]: item for item in current}
        self.assertEqual("indirect", by_name["example.com/local"]["group"])
        self.assertTrue(by_name["example.com/local"]["local"])
        self.assertIsNone(by_name["example.com/local"]["resolved_version"])
        changes = {item["name"]: item["kind"] for item in go_package_diff(baseline, current)}
        self.assertEqual({"example.com/lib": "version_changed", "example.com/local": "added"}, changes)


class GoAdapterTests(unittest.TestCase):
    def test_activation_graph_usage_metrics_and_mixed_language(self):
        before = {
            "go.mod": b"module example.com/demo\nrequire example.com/lib v1.0.0\n",
            "go.sum": b"example.com/lib v1.0.0 h1:x\n",
            "pkg/value.go": b'package pkg\nimport "example.com/lib/sub"\ntype Value struct{}\nfunc Run(x int) int { if x > 1 { return 2 }; return 1 }\n',
        }
        after = {**before, "pkg/value.go": b'package pkg\nimport "example.com/lib/sub"\ntype Value struct{}\nfunc Run(x int) int { if x >= 1 { return 2 }; return 1 }\n'}
        snap = snapshot(before, after)
        self.assertEqual([item.id for item in active_adapters(snap)], ["go"])
        mixed = snapshot({}, {"main.go": b"package main", "main.py": b"x=1", "main.ts": b"export{}"})
        self.assertEqual([item.id for item in active_adapters(mixed)], ["python", "node", "go"])
        model = ReviewModel({})
        model.changes = [{"path": "pkg/value.go", "status": "modified", "added_lines": [4],
                          "removed_lines": [4], "current_lines": 4, "baseline_lines": 4}]
        dependencies = GO_ADAPTER.dependencies(snap, model.warnings)
        model.packages = dependencies
        GO_ADAPTER.scan(snap, model, dependencies, lambda *_: None)
        GO_ADAPTER.resolve_package_usage(model, dependencies)
        payload = model.to_dict()
        run = next(node for node in payload["nodes"] if node.get("language") == "go" and node["name"] == "Run")
        self.assertEqual("modified", run["change"])
        self.assertGreaterEqual(run["metrics"]["complexity_current"], 2)
        self.assertTrue(payload["package_dependencies"][0]["usage_locations"])
        self.assertTrue(any(edge["type"] == "uses_package" for edge in payload["edges"]))

    def test_literal_changes_are_modified_but_comment_only_changes_are_not(self):
        def classify(before: bytes, after: bytes) -> str:
            snap = snapshot({"value.go": before}, {"value.go": after})
            model = ReviewModel({})
            dependencies = GO_ADAPTER.dependencies(snap, model.warnings)
            GO_ADAPTER.scan(snap, model, dependencies, lambda *_: None)
            return next(item["classification"] for item in model.symbols if item["name"] == "Value")
        self.assertEqual("modified", classify(
            b'package demo\nfunc Value() string { return "old" }\n',
            b'package demo\nfunc Value() string { return "new" }\n',
        ))
        self.assertEqual("unchanged", classify(
            b"package demo\nfunc Value() int { return 1 }\n",
            b"package demo\nfunc Value() int { /* documentation */ return 1 }\n",
        ))

    def test_coverprofile_requires_exact_saved_source_hash(self):
        source = b"package demo\nfunc F() int {\n return 1\n}\n"
        proof = json.dumps({"demo.go": {"sha256": hashlib.sha256(source).hexdigest()}}).encode()
        snap = snapshot({}, {
            "demo.go": source,
            "coverage.out": b"mode: set\nexample.com/demo/demo.go:2.1,4.2 1 1\n",
            "coverage.sources.json": proof,
        })
        coverage = load_go_coverage(snap)
        self.assertTrue(coverage["available"])
        self.assertEqual(3, coverage["changed_lines"]["demo.go"]["covered"])
        stale = snapshot({}, {**snap.current,
            "coverage.sources.json": json.dumps({"demo.go": {"sha256": "0" * 64}}).encode()})
        self.assertFalse(load_go_coverage(stale)["available"])

    def test_local_package_imports_files_types_and_cross_file_calls_are_linked(self):
        current = {
            "go.mod": b"module example.com/demo\n",
            "model/model.go": b"package model\ntype Reader interface { Read() int }\nfunc Value() int { return 1 }\n",
            "app/app.go": b'package app\nimport "example.com/demo/model"\nfunc Run() int { return model.Value() }\n',
        }
        snap = snapshot({}, current)
        model = ReviewModel({})
        dependencies = GO_ADAPTER.dependencies(snap, model.warnings)
        GO_ADAPTER.scan(snap, model, dependencies, lambda *_: None)
        payload = model.to_dict()
        self.assertTrue(any(node["kind"] == "interface" and node["name"] == "Reader"
                            for node in payload["nodes"]))
        self.assertTrue(any(edge["type"] == "imports" for edge in payload["edges"]))
        self.assertTrue(any(edge["type"] == "calls" for edge in payload["edges"]))
        self.assertTrue(any(edge["level"] == "component" and edge["kind"] == "imports"
                            for edge in payload["aggregate_edges"]))


if __name__ == "__main__":
    unittest.main()
