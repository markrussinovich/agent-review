from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ANALYZER = Path(__file__).parents[1] / "analyzer" / "analyze.py"


class AnalyzerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name)
        self.git("init", "-q")
        self.git("config", "user.email", "agent-review@example.invalid")
        self.git("config", "user.name", "Agent Review")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ).stdout

    def write(self, path: str, content: str) -> None:
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def commit(self) -> str:
        self.git("add", ".")
        self.git("commit", "-qm", "baseline")
        return self.git("rev-parse", "HEAD").strip()

    def analyze(self, base: str, *extra: str) -> dict:
        process = subprocess.run(
            [
                sys.executable,
                str(ANALYZER),
                "--repo",
                str(self.repo),
                "--base-ref",
                base,
                *extra,
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return json.loads(process.stdout)

    def test_symbols_calls_inheritance_complexity_and_aggregate_edges(self) -> None:
        self.write("lib/util.py", "def helper(value):\n    return value\n\nclass Base:\n    pass\n")
        self.write("app/main.py", "def removed():\n    return 1\n")
        base = self.commit()
        self.write(
            "lib/util.py",
            "def helper(value: int) -> int:\n"
            "    if value:\n"
            "        return value\n"
            "    return 0\n\n"
            "class Base:\n"
            "    pass\n",
        )
        self.write(
            "app/main.py",
            "from lib.util import helper, Base\n\n"
            "class Service(Base):\n"
            "    def run(self, value):\n"
            "        return self.finish(helper(value))\n\n"
            "    def finish(self, value):\n"
            "        return value\n",
        )
        model = self.analyze(base)
        symbols = {item["identity"]: item for item in model["symbols"]}
        self.assertEqual("modified", symbols["lib.util:helper"]["classification"])
        self.assertEqual(2, symbols["lib.util:helper"]["complexity"])
        self.assertEqual("removed", symbols["app.main:removed"]["classification"])
        self.assertEqual("added", symbols["app.main:Service.run"]["classification"])
        kinds = {edge["type"] for edge in model["edges"]}
        self.assertTrue({"imports", "calls", "inherits"}.issubset(kinds))
        call_targets = {
            edge["target"] for edge in model["edges"] if edge["type"] == "calls"
        }
        self.assertIn(symbols["lib.util:helper"]["id"], call_targets)
        self.assertIn(symbols["app.main:Service.finish"]["id"], call_targets)
        aggregate = [
            edge
            for edge in model["aggregate_edges"]
            if edge["level"] == "component"
        ]
        self.assertTrue(aggregate)
        self.assertTrue(all(edge["underlying_edge_ids"] for edge in aggregate))
        self.assertTrue(all({"count", "added_count", "removed_count"} <= edge.keys() for edge in aggregate))

    def test_field_source_locations_and_saved_source_diff(self) -> None:
        self.write("health.py", "class HealthCheck:\n    name: str\n    passed: bool")
        base = self.commit()
        text = "class HealthCheck:\n    name: str\n    passed: bool\n    message: str"
        self.write("health.py", text)
        self.write(".agent-review/prompts.json", '{"version": 1, "prompts": []}')
        self.write(".agent-review/prompt-lock/owner", "temporary reviewer state")
        model = self.analyze(base)
        klass = next(node for node in model["nodes"] if node["name"] == "HealthCheck")
        self.assertEqual([{"name": "name", "line": 2}, {"name": "passed", "line": 3},
                          {"name": "message", "line": 4}], klass["fields"])
        self.assertEqual(text, model["source_files"]["health.py"]["current"].replace("\r\n", "\n"))
        self.assertIn("+    message: str\n", model["source_files"]["health.py"]["diff"])
        self.assertNotIn(".agent-review/prompts.json", model["source_files"])
        self.assertFalse(any(change["path"].startswith(".agent-review/") for change in model["changes"]))

    def test_pyyaml_distribution_maps_to_actual_yaml_import(self) -> None:
        self.write("main.py", "print('base')\n")
        base = self.commit()
        self.write("requirements.txt", "PyYAML==6.0.3\n")
        self.write("main.py", "import yaml\nprint(yaml.safe_load('value: 1'))\n")
        model = self.analyze(base)
        package = next(item for item in model["package_changes"] if item["name"] == "pyyaml")
        self.assertEqual(["main.py:1"], package["usage_locations"])
        self.assertTrue(any(edge["target"] == "package:yaml" for edge in model["edges"]))

    def test_package_changes_usage_staged_unstaged_and_exclusion(self) -> None:
        self.write("requirements.txt", "requests==1.0\n")
        self.write("main.py", "print('old')\n")
        base = self.commit()
        self.write("requirements.txt", "requests>=2\nsample-project==3\n")
        self.git("add", "requirements.txt")
        self.write("main.py", "import requests\nprint(requests)\n")
        self.write("generated/ignored.py", "def ignored():\n    pass\n")
        model = self.analyze(base, "--exclude", "generated")
        changes = {item["path"]: item["status"] for item in model["changes"]}
        self.assertEqual("modified", changes["requirements.txt"])
        self.assertEqual("modified", changes["main.py"])
        self.assertNotIn("generated/ignored.py", changes)
        package_changes = {(item["name"], item["kind"]) for item in model["packages"]["changes"]}
        self.assertIn(("requests", "version_changed"), package_changes)
        self.assertIn(("sample-project", "added"), package_changes)
        self.assertTrue(any(edge["type"] == "uses_package" for edge in model["edges"]))
        package = next(item for item in model["package_changes"] if item["name"] == "requests")
        self.assertEqual("package:requests", package["id"])
        self.assertTrue(package["declared_base"])
        self.assertTrue(package["declared_current"])
        self.assertEqual(["main.py:1"], package["usage_locations"])

    def test_revision_graph_dependencies_and_enrichment_ignore_worktree(self) -> None:
        self.write("main.py", "def old():\n    return 1\n")
        base = self.commit()
        self.write("main.py", "import croniter\n\ndef committed():\n    return 2\n")
        self.write("requirements.txt", "croniter==6.0.0\n")
        self.write("codeboarding.json", '{"components":[{"name":"Committed","paths":["main.py"]}]}')
        head = self.commit()
        self.write("main.py", "def dirty_only():\n    return 999\n")
        self.write("requirements.txt", "unrelated-package==1.0\n")
        self.write("codeboarding.json", '{"components":[{"name":"Dirty","paths":["main.py"]}]}')
        model = self.analyze(base, "--current-ref", head)
        self.assertEqual(head, model["metadata"]["head_sha"])
        self.assertEqual(base, model["metadata"]["base_sha"])
        self.assertIn("committed", {symbol["name"] for symbol in model["symbols"]})
        self.assertNotIn("dirty_only", {symbol["name"] for symbol in model["symbols"]})
        self.assertEqual(["croniter"], [package["name"] for package in model["packages"]["current"]])
        self.assertEqual(["main.py:1"], model["package_changes"][0]["usage_locations"])
        self.assertFalse(model["coverage"]["available"])
        self.assertEqual("Committed", model["codeboarding"]["components"][0]["name"])

    def test_changed_line_coverage_and_deterministic_output(self) -> None:
        self.write("calc.py", "def calc(value):\n    return value\n")
        base = self.commit()
        self.write(
            "calc.py",
            "def calc(value):\n"
            "    if value:\n"
            "        return value\n"
            "    return 0\n",
        )
        self.write(
            "coverage.xml",
            '<?xml version="1.0" ?>'
            '<coverage><packages><package><classes>'
            '<class filename="calc.py"><lines>'
            '<line number="1" hits="1"/><line number="2" hits="1"/>'
            '<line number="3" hits="1"/><line number="4" hits="0"/>'
            "</lines></class></classes></package></packages></coverage>",
        )
        first = self.analyze(base)
        second = self.analyze(base)
        self.assertEqual(first, second)
        self.assertTrue(first["coverage"]["available"])
        changed = first["coverage"]["changed_lines"]["calc.py"]
        self.assertGreater(changed["total"], 0)
        self.assertIn(4, changed["uncovered_lines"])
        self.assertEqual(first["summary"]["files_changed"], 2)
        self.assertGreater(first["summary"]["lines_added"], 0)

    def test_primary_canvas_contract(self) -> None:
        self.write("pkg/base.py", "class Base:\n    pass\n")
        self.write("pkg/api.py", "from pkg.base import Base\n\nclass Api(Base):\n    pass\n")
        base = self.commit()
        self.write(
            "pkg/api.py",
            "from pkg.base import Base\n\n"
            "class Api(Base):\n"
            "    def run(self, flag: bool) -> int:\n"
            "        if flag:\n"
            "            return 1\n"
            "        return 0\n",
        )
        model = self.analyze(base)
        self.assertEqual(
            {
                "schema_version", "repo_root", "base_ref", "base_sha",
                "head_sha", "generated_at", "python_loc",
            },
            set(model["metadata"]),
        )
        self.assertEqual(1, model["metadata"]["schema_version"])
        self.assertEqual(base, model["metadata"]["base_sha"])
        self.assertEqual(
            {
                "files_changed", "lines_added", "lines_removed", "modules_changed",
                "symbols_changed", "new_arch_edges", "new_packages",
                "changed_functions_uncovered", "files_added", "files_removed",
                "files_modified", "symbols_added", "symbols_removed",
                "symbols_modified", "arch_edges_removed", "packages_removed",
                "packages_modified",
            },
            set(model["summary"]),
        )
        node_fields = {
            "id", "type", "kind", "name", "parent_id", "module_id", "component_id",
            "path", "start_line", "end_line", "change", "metrics", "signatures",
        }
        metric_fields = {
            "complexity_base", "complexity_current", "signature_base", "signature_current",
            "coverage_percent", "changed_lines_coverage_percent",
            "changed_lines_total", "changed_lines_covered", "changed_lines_uncovered",
            "lines_added", "lines_removed", "lines_changed",
            "churn_commits_90d", "churn_additions_90d", "churn_deletions_90d",
            "direct_callers", "transitive_callers",
        }
        self.assertTrue(model["nodes"])
        self.assertTrue(all(node_fields <= node.keys() for node in model["nodes"]))
        self.assertTrue(all(node["kind"] == node["type"] for node in model["nodes"]))
        self.assertTrue(all(set(node["metrics"]) == metric_fields for node in model["nodes"]))
        self.assertTrue(all(
            isinstance(node["metrics"]["direct_callers"], int)
            and isinstance(node["metrics"]["transitive_callers"], int)
            for node in model["nodes"]
        ))
        self.assertTrue(all(
            node["change"] in {"unchanged", "added", "removed", "modified"}
            for node in model["nodes"]
        ))
        edge_fields = {
            "id", "type", "source", "target", "change", "confidence", "count",
            "evidence_ids",
        }
        node_ids = {node["id"] for node in model["nodes"]}
        self.assertTrue(all(set(edge) == edge_fields for edge in model["edges"]))
        self.assertTrue(all(edge["type"] in {"imports", "calls", "inherits", "uses_package"} for edge in model["edges"]))
        self.assertTrue(all(edge["confidence"] in {"resolved", "likely", "unresolved"} for edge in model["edges"]))
        self.assertTrue(all(edge["source"] in node_ids and edge["target"] in node_ids for edge in model["edges"]))
        self.assertIsInstance(model["evidence"], dict)
        evidence_ids = set(model["evidence"])
        self.assertTrue(all(
            evidence in evidence_ids
            for edge in model["edges"]
            for evidence in edge["evidence_ids"]
        ))
        self.assertTrue(all(
            edge["source"] in node_ids and edge["target"] in node_ids
            for edge in model["aggregate_edges"]
        ))
        self.assertTrue(all(
            evidence in evidence_ids
            for item in model["attention"]
            for evidence in item["evidence_ids"]
        ))

    def test_base_sha_is_merge_base_not_branch_tip(self) -> None:
        self.write("shared.py", "VALUE = 1\n")
        common = self.commit()
        default_branch = self.git("branch", "--show-current").strip()
        self.git("checkout", "-qb", "feature")
        self.write("feature.py", "VALUE = 2\n")
        self.git("add", ".")
        self.git("commit", "-qm", "feature")
        self.git("checkout", "-q", default_branch)
        self.write("default.py", "VALUE = 3\n")
        self.git("add", ".")
        self.git("commit", "-qm", "default advances")
        default_tip = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-q", "feature")
        model = self.analyze(default_branch)
        self.assertEqual(common, model["metadata"]["base_sha"])
        self.assertNotEqual(default_tip, model["metadata"]["base_sha"])

    def test_explicit_base_falls_back_to_remote_tracking_ref(self) -> None:
        self.write("base.py", "VALUE = 1\n")
        base = self.commit()
        self.git("update-ref", "refs/remotes/origin/review-base", base)
        self.write("base.py", "VALUE = 2\n")
        model = self.analyze("review-base")
        self.assertEqual("origin/review-base", model["metadata"]["base_ref"])
        self.assertEqual(base, model["metadata"]["base_sha"])
        self.assertEqual(1, model["summary"]["files_changed"])

    def test_checkout_line_endings_do_not_create_false_changes(self) -> None:
        self.write("unchanged.py", "VALUE = 1\n")
        self.write("changed.py", "VALUE = 1\n")
        base = self.commit()
        (self.repo / "unchanged.py").write_bytes(b"VALUE = 1\r\n")
        (self.repo / "changed.py").write_bytes(b"VALUE = 2\r\n")
        model = self.analyze(base)
        changes = {item["path"]: item for item in model["changes"]}
        self.assertEqual("unchanged", changes["unchanged.py"]["status"])
        self.assertEqual("modified", changes["changed.py"]["status"])
        self.assertEqual(1, model["summary"]["files_changed"])

    def test_unchanged_external_package_edges_are_not_added(self) -> None:
        self.write("requirements.txt", "requests>=2\n")
        self.write("client.py", "import requests\n\n\ndef fetch():\n    return requests.get('https://example.test')\n")
        base = self.commit()
        model = self.analyze(base)
        package_edges = [edge for edge in model["edges"] if edge["type"] == "uses_package"]
        self.assertTrue(package_edges)
        self.assertTrue(all(edge["change"] == "unchanged" for edge in package_edges))
        self.assertEqual(0, model["summary"]["new_arch_edges"])

    def test_unchanged_high_fan_in_symbol_is_not_an_attention_finding(self) -> None:
        self.write(
            "service.py",
            "def shared():\n    return 1\n\n"
            "def first():\n    return shared()\n\n"
            "def second():\n    return shared()\n\n"
            "def third():\n    return shared()\n",
        )
        base = self.commit()
        self.write("new_feature.py", "def added():\n    return 2\n")
        model = self.analyze(base)
        shared = next(node for node in model["nodes"] if node["name"] == "shared")
        self.assertEqual("unchanged", shared["change"])
        self.assertFalse(any(
            item.get("node_id") == shared["id"] and item["type"] == "broad_impact"
            for item in model["attention"]
        ))

    def test_duplicate_unchanged_import_edges_are_not_added(self) -> None:
        self.write("pkg/models.py", "class First:\n    pass\n\nclass Second:\n    pass\n")
        self.write(
            "pkg/service.py",
            "from pkg.models import First, Second\n\n\ndef build():\n    return First(), Second()\n",
        )
        base = self.commit()
        model = self.analyze(base)
        import_edges = [edge for edge in model["edges"] if edge["type"] == "imports"]
        self.assertGreaterEqual(len(import_edges), 2)
        self.assertTrue(all(edge["change"] == "unchanged" for edge in import_edges))
        self.assertEqual(0, model["summary"]["new_arch_edges"])


if __name__ == "__main__":
    unittest.main()
