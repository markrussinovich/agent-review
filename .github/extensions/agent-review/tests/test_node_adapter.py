from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from language_adapters import AnalysisSnapshot
from node_adapter import NODE_ADAPTER, NodeAdapter
from node_packages import package_diff, parse_packages
from review_model import ReviewModel


def snapshot(baseline=None, current=None, historical=True, use_cache=True):
    return AnalysisSnapshot(Path("."), baseline or {}, current or {}, None, historical, use_cache)


def encode(value):
    return json.dumps(value).encode()


class NodePackageTests(unittest.TestCase):
    def test_lock_v2_and_v3_runtime_dev_optional_scoped_alias_workspace_versions(self):
        for version in (2, 3):
            files = {
                "package.json": encode({
                    "dependencies": {"@scope/runtime": "^1", "workspace": "workspace:*", "alias": "npm:actual@^3"},
                    "devDependencies": {"tool": "~2"}, "optionalDependencies": {"native": "^4"},
                }),
                "package-lock.json": encode({"lockfileVersion": version, "packages": {
                    "": {}, "node_modules/@scope/runtime": {"version": "1.2.3"},
                    "node_modules/tool": {"version": "2.0.1", "dev": True},
                    "node_modules/native": {"version": "4.0.0", "optional": True},
                    "node_modules/alias": {"version": "3.2.1", "name": "actual"},
                    "node_modules/workspace": {"link": True, "resolved": "packages/workspace"},
                    "packages/workspace": {"name": "workspace", "version": "0.1.0"},
                }}),
            }
            warnings = []
            packages = {item["name"]: item for item in parse_packages(files, warnings)}
            self.assertEqual(warnings, [])
            self.assertEqual(packages["@scope/runtime"]["resolved_version"], "1.2.3")
            self.assertEqual(packages["tool"]["group"], "dev")
            self.assertEqual(packages["native"]["group"], "optional")
            self.assertEqual(packages["workspace"]["resolved_version"], "0.1.0")
            self.assertTrue(packages["workspace"]["workspace"])
            self.assertTrue(packages["workspace"]["workspace_link"])
            self.assertTrue(packages["workspace"]["local"])
            self.assertEqual(packages["actual"]["import_name"], "alias")
            self.assertTrue(all(item["ecosystem"] == "npm" and item["id"] == f"package:npm:{item['name']}"
                                for item in packages.values()))

    def test_nested_lock_resolution_prefers_nearest_installed_version(self):
        files = {
            "packages/app/package.json": encode({"dependencies": {"demo": "^2"}}),
            "package-lock.json": encode({"lockfileVersion": 3, "packages": {
                "node_modules/demo": {"version": "1.0.0"},
                "packages/app/node_modules/demo": {"version": "2.0.0"},
            }}),
        }
        self.assertEqual(parse_packages(files)[0]["resolved_version"], "2.0.0")

    def test_ranges_unsupported_locks_and_invalid_json_are_explicit_unknowns(self):
        warnings = []
        packages = parse_packages({
            "package.json": encode({"dependencies": {"ranged": "^1.0.0", "pinned": "1.2.3"}}),
            "package-lock.json": encode({"lockfileVersion": 1}),
            "pnpm-lock.yaml": b"irrelevant", "nested/package.json": b"{bad",
        }, warnings)
        by_name = {item["name"]: item for item in packages}
        self.assertIsNone(by_name["ranged"]["resolved_version"])
        self.assertEqual(by_name["pinned"]["resolved_version"], "1.2.3")
        self.assertTrue(any("unsupported package-lock" in message for message in warnings))
        self.assertTrue(any("unsupported Node lockfile" in message for message in warnings))
        self.assertTrue(any("invalid Node" in message for message in warnings))

    def test_declaration_spans_point_to_dependency_key_not_repeated_package_text(self):
        text = '{\n  "description": "demo",\n  "dependencies": {\n    "demo": "^1"\n  },\n  "devDependencies": {"demo": "2.0.0"}\n}'
        packages = parse_packages({"package.json": text.encode()})
        for package in packages:
            line = text.splitlines()[package["line"] - 1]
            self.assertEqual(line[package["start_column"]:package["end_column"]], "demo")
        self.assertEqual({item["line"] for item in packages}, {4, 6})

    def test_lock_only_version_changes_are_not_silently_lost(self):
        manifest = {"package.json": encode({"dependencies": {"demo": "^1"}})}
        def files(version):
            return {**manifest, "package-lock.json": encode({"lockfileVersion": 3, "packages": {
                "node_modules/demo": {"version": version},
            }})}
        change = package_diff(parse_packages(files("1.0.0")), parse_packages(files("1.1.0")))[0]
        self.assertEqual(change["kind"], "version_changed")
        self.assertEqual(change["resolved_after"], "1.1.0")

    def test_workspace_and_local_declarations_cannot_be_mistaken_for_registry_packages(self):
        files = {
            "package.json": encode({"workspaces": ["packages/*"], "dependencies": {
                "private-workspace": "^1", "local-file": "file:../local", "explicit": "workspace:*",
                "public-registry": "^2",
            }}),
            "packages/private/package.json": encode({"name": "private-workspace",
                                                     "version": "1.0.0", "private": True}),
        }
        packages = {item["name"]: item for item in parse_packages(files)}
        self.assertTrue(packages["private-workspace"]["local"])
        self.assertTrue(packages["private-workspace"]["workspace_link"])
        self.assertTrue(packages["private-workspace"]["private"])
        self.assertTrue(packages["local-file"]["local"])
        self.assertTrue(packages["explicit"]["workspace_link"])
        self.assertFalse(packages["public-registry"].get("local", False))
        self.assertIsNone(packages["public-registry"]["resolved_version"])


class NodeAdapterTests(unittest.TestCase):
    def test_activation_is_lazy_and_claims_only_node_inputs(self):
        adapter = NodeAdapter()
        with patch("node_adapter.subprocess.run") as process:
            for name in ("x.js", "x.ts", "x.jsx", "x.tsx", "x.cjs", "x.mjs", "x.mts", "x.cts",
                         "package.json", "package-lock.json", "packages/p/package.json", "tsconfig.build.json"):
                self.assertTrue(adapter.applies({name}), name)
            self.assertFalse(adapter.applies({"x.py", "README.md", "pyproject.toml"}))
            self.assertFalse(adapter.applies({"main.py", ".agent-review/tests/run.mjs",
                                              "node_modules/demo/index.js", ".git/hooks/setup.js"}))
            self.assertFalse(adapter.applies({"main.py", ".agent-review-node-tests-123/run.mjs",
                                              ".node-runner-fixture-123/package.json",
                                              ".coverage-import-fixture-123/source.ts"}))
            process.assert_not_called()

    def test_snapshot_graph_merges_without_rewriting_foreign_facts_and_serializes_model(self):
        current = {
            "package.json": encode({"dependencies": {"demo": "^1"}}),
            "base.ts": b"export class Base { value(){return 1} }",
            "app.ts": b'import {Base} from "./base.js"; import demo from "demo"; export class App extends Base { run(){return this.value()} }',
        }
        model = ReviewModel({})
        facts = NODE_ADAPTER.dependencies(snapshot(current=current), model.warnings)
        model.packages = facts
        sentinel = {"id": "foreign", "kind": "calls", "source": "x", "target": "y",
                    "confidence": "unresolved", "evidence_ids": []}
        model.edges.append(sentinel)
        events = []
        NODE_ADAPTER.scan(snapshot(current=current), model, facts, lambda *event: events.append(event))
        self.assertEqual(model.edges[0], sentinel)
        self.assertTrue(model.symbols, model.warnings)
        self.assertEqual(model.repository["node_loc"], 2)
        NODE_ADAPTER.resolve_package_usage(model, facts)
        self.assertEqual(facts["current"][0]["used_by"], ["app.ts:1"])
        serialized = model.to_dict()
        self.assertTrue(any(node["type"] == "class" for node in serialized["nodes"]))
        self.assertTrue(any(edge["type"] == "inherits" for edge in serialized["edges"]))
        self.assertTrue(events)

    def test_removed_usage_does_not_claim_current_package_usage(self):
        adapter = NodeAdapter()
        dependencies = {"current": [{"name": "demo"}]}
        model = ReviewModel({})
        model.evidence = [{"id": "e", "path": "old.ts", "line": 2}]
        model.edges = [{"kind": "uses_package", "target": "package:npm:demo",
                        "change": "removed", "evidence_ids": ["e"]}]
        adapter.resolve_package_usage(model, dependencies)
        self.assertEqual(dependencies["current"][0]["used_by"], [])

    def test_missing_compiler_reports_unknown_without_losing_other_language_graph(self):
        adapter = NodeAdapter()
        model = ReviewModel({})
        model.symbols.append({"id": "foreign"})
        with patch.object(adapter, "_invoke", side_effect=RuntimeError("missing typescript")):
            adapter.scan(snapshot(current={"app.ts": b"export function run(){}"}), model, {}, lambda *_: None)
        self.assertEqual(model.symbols, [{"id": "foreign"}])
        self.assertTrue(any("missing typescript" in message for message in model.warnings))

    def test_manifest_only_analysis_never_loads_the_compiler_or_coverage_process(self):
        adapter = NodeAdapter()
        saved = snapshot(current={"package.json": encode({"dependencies": {"demo": "1.0.0"}})})
        model = ReviewModel({})
        dependencies = adapter.dependencies(saved, model.warnings)
        self.assertTrue(adapter.applies(set(saved.current)))
        with patch.object(adapter, "_invoke") as invoke:
            adapter.scan(saved, model, dependencies, lambda *_: None)
            self.assertFalse(adapter.coverage(saved)["available"])
        invoke.assert_not_called()
        self.assertEqual(model.symbols, [])
        self.assertEqual(dependencies["current"][0]["resolved_version"], "1.0.0")
        self.assertEqual(model.repository["node_loc"], 0)

    def test_python_only_scan_does_not_add_node_loc_metadata(self):
        model = ReviewModel({"python_loc": 2})
        adapter = NodeAdapter()
        adapter.scan(snapshot(current={"main.py": b"def run():\n    return 1\n"}),
                     model, {}, lambda *_: None)
        self.assertEqual(model.repository, {"python_loc": 2})

    def test_no_cache_snapshot_is_forwarded_to_the_production_compiler_cli(self):
        adapter = NodeAdapter()
        saved = snapshot(current={"app.ts": b"export function run(){}"}, use_cache=False)
        with patch.object(adapter, "_invoke", return_value={}) as invoke:
            adapter.scan(saved, ReviewModel({}), {}, lambda *_: None)
        script, payload = invoke.call_args.args
        self.assertEqual(script, "node-compiler.mjs")
        self.assertIs(payload["use_cache"], False)

    def test_coverage_delegate_receives_historical_snapshot_text_and_repository(self):
        adapter = NodeAdapter()
        expected = {"available": False, "files": [], "changed_lines": {}}
        with patch.object(adapter, "_invoke", return_value=expected) as invoke:
            self.assertIs(adapter.coverage(snapshot({"a.ts": b"old"}, {"a.ts": b"new"})), expected)
        script, payload = invoke.call_args.args
        self.assertEqual(script, "node-coverage.mjs")
        self.assertEqual(payload, {"repo": ".", "baseline": {"a.ts": "old"},
                                   "current": {"a.ts": "new"}, "historical": True})

    def test_real_coverage_cli_accepts_stdin_snapshot_without_live_reports(self):
        report = NODE_ADAPTER.coverage(snapshot(current={"app.ts": b"export function run(){}"}))
        self.assertFalse(report["available"])
        self.assertEqual(report["files"], [])
        self.assertFalse(report.get("warnings"), report)


if __name__ == "__main__":
    unittest.main()
