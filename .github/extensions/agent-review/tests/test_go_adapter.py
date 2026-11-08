from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))

from go_adapter import GO_ADAPTER
from go_coverage import load_go_coverage
from go_graph import analyze_go
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
    def test_identical_snapshots_preserve_complexity_and_signature_baselines(self):
        body = b" if x > 0 { x-- }\n" * 7 + b" return x\n"
        source = (b"package demo\ntype Value struct{}\nfunc Evaluate(x int) int {\n" + body
                  + b"}\nfunc (v Value) Run(x int) int {\n" + body + b"}\n")
        files = {"value.go": source}
        model = ReviewModel({})
        analyze_go(files, files, model, set())
        payload = model.to_dict()
        callables = [node for node in payload["nodes"] if node["type"] in ("function", "method")]
        self.assertEqual({"function", "method"}, {node["type"] for node in callables})
        for node in callables:
            with self.subTest(name=node["name"]):
                self.assertEqual("unchanged", node["change"])
                self.assertEqual(0, node["metrics"]["lines_changed"])
                self.assertEqual(8, node["metrics"]["complexity_base"])
                self.assertEqual(8, node["metrics"]["complexity_current"])
                self.assertIsNotNone(node["signatures"]["base"])
                self.assertEqual(node["signatures"]["base"], node["signatures"]["current"])
                self.assertEqual(node["signatures"]["base"], node["metrics"]["signature_base"])
        self.assertEqual([], payload["attention"])

    def test_body_and_signature_changes_compare_actual_baselines(self):
        before = b"package demo\nfunc Run(x int) int { return x }\n"
        for after, signature_changed in (
            (b"package demo\nfunc Run(x int) int { if x > 0 { return x }; return 0 }\n", False),
            (b"package demo\nfunc Run(x int64) int64 { if x > 0 { return x }; return 0 }\n", True),
        ):
            with self.subTest(signature_changed=signature_changed):
                model = ReviewModel({})
                analyze_go({"value.go": before}, {"value.go": after}, model, set())
                payload = model.to_dict()
                run = next(node for node in payload["nodes"] if node["name"] == "Run")
                self.assertEqual("modified", run["change"])
                self.assertEqual(1, run["metrics"]["complexity_base"])
                self.assertEqual(2, run["metrics"]["complexity_current"])
                self.assertEqual("Run(x int) int", run["signatures"]["base"])
                self.assertEqual("Run(x int64) int64" if signature_changed else "Run(x int) int",
                                 run["signatures"]["current"])
                findings = {item["type"] for item in payload["attention"]}
                self.assertEqual({"complexity", "signature"} if signature_changed else {"complexity"},
                                 findings)

    def test_new_complexity_requires_added_node_and_threshold(self):
        for change in ("unchanged", "modified", "removed", "added"):
            for complexity in (7, 8, 9):
                with self.subTest(change=change, complexity=complexity):
                    model = ReviewModel({})
                    source = (b"package demo\nfunc Run(x int) int {\n"
                              + b" if x > 0 { x-- }\n" * (complexity - 1) + b" return x\n}\n")
                    analyze_go({}, {"value.go": source}, model, set())
                    symbol = model.symbols[0]
                    symbol["classification"] = change
                    symbol["complexity_base"] = None
                    payload = model.to_dict()
                    expected = change == "added" and complexity >= 8
                    findings = [item for item in payload["attention"] if item["type"] == "new_complexity"]
                    self.assertEqual(int(expected), len(findings))
                    evidence = [item for item in payload["evidence"].values()
                                if item.get("detail", "").startswith("New callable complexity")]
                    self.assertEqual(int(expected), len(evidence))

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

    def test_receiver_and_expression_calls_do_not_guess_package_targets(self):
        declarations = (
            "type Closer interface { Close() error }\n"
            "type Resource struct { child Closer }\n"
            "func Close() {}\n"
        )
        cases = {
            "interface receiver": "func Run(c Closer) { c.Close() }\n",
            "selector chain": "func Run(c Resource) { c.child.Close() }\n",
            "spaced selector chain": "func Run(c Resource) { c . child . Close() }\n",
            "call result": "func factory() Closer { return nil }\nfunc Run() { factory().Close() }\n",
            "indexed receiver": "func Run(items []Closer) { items[0].Close() }\n",
            "parenthesized receiver": "func Run(c *Closer) { (*c).Close() }\n",
        }
        for label, body in cases.items():
            with self.subTest(case=label):
                files = {"demo.go": ("package demo\n" + declarations + body).encode()}
                model = ReviewModel({})
                analyze_go(files, files, model, set())
                names = {symbol["id"]: symbol["qualname"] for symbol in model.symbols}
                self.assertIn("Run", names.values())
                self.assertIn("Close", names.values())
                self.assertEqual([], [
                    edge for edge in model.edges
                    if edge["kind"] == "calls" and names[edge["target"]] == "Close"
                ])

    def test_calls_do_not_resolve_to_methods_or_type_conversions(self):
        cases = {
            "bare method name": (
                "type Resource struct{}\nfunc (r Resource) Close() {}\n",
                "func Run() { Close() }\n",
            ),
            "receiver method deferred": (
                "type Resource struct{}\nfunc (r Resource) Close() {}\n",
                "func (r Resource) Run() { r.Close() }\n",
            ),
            "method expression deferred": (
                "type Resource struct{}\nfunc (r Resource) Close() {}\n",
                "func Run(r Resource) { Resource.Close(r) }\n",
            ),
            "type conversion": (
                "type Close int\n",
                "func Run() { _ = Close(1) }\n",
            ),
        }
        for label, (declarations, body) in cases.items():
            with self.subTest(case=label):
                files = {"demo.go": ("package demo\n" + declarations + body).encode()}
                model = ReviewModel({})
                analyze_go(files, files, model, set())
                self.assertEqual([], [edge for edge in model.edges if edge["kind"] == "calls"])

    def test_calls_do_not_resolve_shadowed_imports_or_package_functions(self):
        cases = {
            "import parameter": "func Run(m Caller) { m.Target() }\n",
            "compact pointer parameter": "func Run(m*Resource) { m.Target() }\n",
            "compact grouped parameters": "func Run(other, m*Resource) { m.Target() }\n",
            "compact named result": "func Run() (m*Resource) { m.Target(); return }\n",
            "grouped parameters": "func Run(m, other Caller) { m.Target() }\n",
            "receiver": "func (m Resource) Run() { m.Target() }\n",
            "receiver type parameter": (
                "type Box[Target ~int] struct{}\n"
                "func (b Box[Target]) Run(value int) { _ = Target(value) }\n"
            ),
            "named result": "func Run() (m Caller) { m.Target(); return }\n",
            "short declaration": "func Run(value Caller) { m := value; m.Target() }\n",
            "multiple short names": "func Run(value Caller) { _, m := 0, value; m.Target() }\n",
            "range variable": "func Run(values []Caller) { for _, m := range values { m.Target() } }\n",
            "type switch": "func Run(value any) { switch m := value.(type) { case Caller: m.Target() } }\n",
            "variable": "func Run(value Caller) { var m = value; m.Target() }\n",
            "grouped variable": "func Run(value Caller) { var (\n m = value\n); m.Target() }\n",
            "type alias": "func Run(value Resource) { type m = Resource; m.Target(value) }\n",
            "nested parameter": "func Run(value Caller) { func(m Caller) { m.Target() }(value) }\n",
            "nested pointer result": (
                "func Run(value Caller) { func(m Caller)*Resource { m.Target(); return nil }(value) }\n"
            ),
            "nested struct result": (
                "func Run(value Caller) { "
                "func(m Caller)struct{ Value int } { m.Target(); return struct{ Value int }{} }(value) }\n"
            ),
            "nested function result": (
                "func Run(value Caller) { func(m Caller)func() { m.Target(); return nil }(value) }\n"
            ),
            "literal multiplied by indexed expression": (
                "func Run(value Caller) { values := []int{1}; "
                "result := values[0] * func(m Caller) int { m.Target(); return 1 }(value); "
                "_ = result }\n"
            ),
            "literal multiplied by nested indexed expression": (
                "func Run(value Caller) { values := [][]int{{1}}; "
                "result := values[0][0] * func(m Caller) int { m.Target(); return 1 }(value); "
                "_ = result }\n"
            ),
            "literal inside function slice": (
                "func Run() { callbacks := []func(Caller){func(m Caller) { m.Target() }}; "
                "_ = callbacks }\n"
            ),
            "function parameter": "func Run(Target func()) { Target() }\n",
            "function variable": "func Run(callback func()) { Target := callback; Target() }\n",
        }
        for label, body in cases.items():
            with self.subTest(case=label):
                files = {
                    "go.mod": b"module example.com/demo\n",
                    "model/model.go": b"package model\nfunc Target() {}\n",
                    "app/app.go": (
                        'package app\nimport m "example.com/demo/model"\n'
                        "type Caller interface { Target() }\n"
                        "type Resource struct{}\nfunc (r Resource) Target() {}\n"
                        "func Target() {}\n" + body
                    ).encode(),
                }
                model = ReviewModel({})
                analyze_go(files, files, model, set())
                names = {symbol["id"]: symbol["qualname"] for symbol in model.symbols}
                self.assertTrue(any(name.endswith("Run") for name in names.values()))
                self.assertEqual([], [
                    edge for edge in model.edges if edge["kind"] == "calls"
                    and names[edge["target"]] == "Target"
                ])

    def test_function_type_names_do_not_shadow_package_calls(self):
        cases = {
            "named parameter": "var callback func(m int); _ = callback",
            "named result": "var callback func() (m int); _ = callback",
            "nested function type": "var callback func(callback func(m int)); _ = callback",
            "slice of function types": "var callbacks []func(m int); _ = callbacks",
            "function slice literal": "callbacks := []func(m int){}; _ = callbacks",
            "function array literal": "callbacks := [0]func(m int){}; _ = callbacks",
            "function map literal": "callbacks := map[string]func(m int){}; _ = callbacks",
            "pointer function slice literal": "callbacks := []*func(m int){}; _ = callbacks",
            "pointer function array literal": "callbacks := [0]*func(m int){}; _ = callbacks",
            "pointer function map literal": "callbacks := map[string]*func(m int){}; _ = callbacks",
            "nested pointer function slice literal": "callbacks := [][]*func(m int){}; _ = callbacks",
            "range over pointer function slice": "for range []*func(m int){} {}",
            "literal returning pointer function slice": (
                "callback := func() any { return []*func(m int){} }; _ = callback"
            ),
            "function field": "var holder struct{ callback func(m int) }; _ = holder",
            "function type result": "var callback func()func(m int); _ = callback",
            "literal returning function type": "callback := func()func(m int) { return nil }; _ = callback",
            "literal with function-type parameter": "func(callback func(m int)) { m.Target() }(nil)",
        }
        for label, body in cases.items():
            with self.subTest(case=label):
                files = {
                    "go.mod": b"module example.com/demo\n",
                    "model/model.go": b"package model\nfunc Target() {}\n",
                    "app/app.go": (
                        'package app\nimport m "example.com/demo/model"\n'
                        "func Run() { " + body + "; m.Target() }\n"
                    ).encode(),
                }
                model = ReviewModel({})
                analyze_go(files, files, model, set())
                identities = {symbol["id"]: symbol["identity"] for symbol in model.symbols}
                calls = [
                    (identities[edge["source"]], identities[edge["target"]])
                    for edge in model.edges if edge["kind"] == "calls"
                ]
                self.assertTrue(calls)
                self.assertEqual({("go:app:app:Run", "go:model:model:Target")}, set(calls))

    def test_binding_scan_handles_large_identifier_lists(self):
        source = (
            "package demo\nfunc Target() {}\nfunc Run() { values := []int{"
            + ", ".join(f"v{index}" for index in range(40_000))
            + "}; _ = values; Target() }\n"
        )
        analyzer = str(Path(__file__).parents[1] / "analyzer")
        process = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0, sys.argv[1]); from go_graph import parse_go; "
             "file, warning = parse_go('demo.go', sys.stdin.buffer.read()); "
             "assert warning is None; print([call['name'] for call in file.calls])",
             analyzer],
            input=source.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=True, timeout=10,
        )
        self.assertEqual([b"['Target']"], process.stdout.splitlines())

    def test_import_qualified_calls_do_not_resolve_to_methods(self):
        files = {
            "go.mod": b"module example.com/demo\n",
            "model/model.go": b"package model\ntype Value struct{}\nfunc (v Value) Target() {}\n",
            "app/app.go": b'package app\nimport m "example.com/demo/model"\nfunc Run() { m.Target() }\n',
        }
        model = ReviewModel({})
        analyze_go(files, files, model, set())
        self.assertEqual([], [edge for edge in model.edges if edge["kind"] == "calls"])

    def test_function_calls_remain_resolved_when_methods_share_the_name(self):
        files = {
            "go.mod": b"module example.com/demo\n",
            "model/model.go": (
                b"package model\ntype Value struct{}\n"
                b"func Target() {}\nfunc (v Value) Target() {}\n"
            ),
            "app/app.go": (
                b'package app\nimport m "example.com/demo/model"\n'
                b"type Resource struct{}\nfunc (r Resource) Target() {}\n"
                b"func Target() {}\nfunc Recur() { Recur() }\n"
                b"func Run(arg m . Value, callback func(m int)) { Target()\n m.Target() }\n"
            ),
        }
        model = ReviewModel({})
        analyze_go(files, files, model, set())
        identities = {symbol["id"]: symbol["identity"] for symbol in model.symbols}
        self.assertEqual({
            ("go:app:app:Run", "go:app:app:Target", "Target", "unchanged"),
            ("go:app:app:Run", "go:model:model:Target", "m.Target", "unchanged"),
            ("go:app:app:Recur", "go:app:app:Recur", "Recur", "unchanged"),
        }, {
            (identities[edge["source"]], identities[edge["target"]], edge["detail"], edge["change"])
            for edge in model.edges if edge["kind"] == "calls"
        })

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
        identities = {symbol["id"]: symbol["identity"] for symbol in model.symbols}
        self.assertEqual([("go:app:app:Run", "go:model:model:Value")], [
            (identities[edge["source"]], identities[edge["target"]])
            for edge in payload["edges"] if edge["type"] == "calls"
        ])
        self.assertTrue(any(edge["level"] == "component" and edge["kind"] == "imports"
                            for edge in payload["aggregate_edges"]))


if __name__ == "__main__":
    unittest.main()
