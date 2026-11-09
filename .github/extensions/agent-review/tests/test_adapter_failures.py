from __future__ import annotations

import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ANALYZER = Path(__file__).parents[1] / "analyzer"
sys.path.insert(0, str(ANALYZER))
from analyze import build_review
from language_adapters import AdapterUnavailable
from python_adapter import PYTHON_ADAPTER


class FailingAdapter:
    id = "broken"
    graph_phase = "broken_graph"
    graph_message = "Scanning broken language"

    def __init__(self, phase, error=None):
        self.phase = phase
        self.error = error or AdapterUnavailable("deliberate helper failure")
        self.calls = []

    def fail(self, phase):
        self.calls.append(phase)
        if self.phase == phase:
            raise self.error

    def dependencies(self, snapshot, warnings):
        warnings.append("partial dependency note")
        self.fail("dependencies")
        return {"baseline": [], "current": [{"name": "poison", "specifier": "==1", "source": "manifest"}],
                "changes": [{"name": "poison", "kind": "added"}]}

    def scan(self, snapshot, model, dependencies, progress):
        self.model = model
        model.repository["poison"] = True
        model.changes[0]["status"] = "deleted"
        model.source_files["main.py"]["current"] = "corrupted"
        for key in ("symbols", "edges", "evidence"):
            getattr(model, key).append({"id": "poison"})
        model.aggregates["modules"].append({"id": "poison"})
        model.code_paths["broken"] = {"callables": [{"id": "poison"}]}
        model.instruction_documents["poison"] = True
        self.fail("scan")

    def resolve_package_usage(self, model, dependencies):
        dependencies["current"][0]["used_by"] = ["poison:1"]
        self.fail("package usage")

    def coverage(self, snapshot):
        self.model.coverage["files"].append({"path": "poison"})
        self.fail("coverage")


class AdapterFailureTests(unittest.TestCase):
    def review(self, adapters):
        before = {"main.py": b"def run():\n    return 1\n"}
        after = {"main.py": b"def run():\n    return 2\n"}
        changes = [{"path": "main.py", "status": "modified", "current_lines": 2,
                    "lines_added": 1, "lines_removed": 1, "added_lines": [2], "removed_lines": [2]}]
        snapshot = SimpleNamespace(baseline=before, current=after,
            changes=lambda: copy.deepcopy(changes),
            source_files=lambda *_: {"main.py": {"baseline": before["main.py"].decode(),
                                                "current": after["main.py"].decode()}})
        with ExitStack() as stack:
            stack.enter_context(patch("analyze.discover_repo", return_value=Path(".")))
            stack.enter_context(patch("analyze.discover_base", return_value="main"))
            stack.enter_context(patch("analyze.run_git", return_value="saved-sha"))
            stack.enter_context(patch("analyze.create_snapshot", return_value=snapshot))
            stack.enter_context(patch("analyze.active_adapters", return_value=adapters))
            stack.enter_context(patch("analyze.analyze_churn", return_value=[]))
            stack.enter_context(patch("analyze.load_codeboarding", return_value={"available": False, "components": []}))
            self.stderr = io.StringIO()
            stack.enter_context(redirect_stderr(self.stderr))
            return build_review(".", "main", (), use_cache=False)

    def test_each_phase_discards_the_whole_language_and_retains_healthy_facts(self):
        healthy = self.review((PYTHON_ADAPTER,)).to_dict()
        for phase in ("dependencies", "scan", "package usage", "coverage"):
            for first in (True, False):
                with self.subTest(phase=phase, failing_first=first):
                    broken = FailingAdapter(phase)
                    adapters = (broken, PYTHON_ADAPTER) if first else (PYTHON_ADAPTER, broken)
                    result = self.review(adapters).to_dict()
                    for key in ("nodes", "edges", "evidence", "symbols", "changes", "source_files",
                                "package_changes", "package_dependencies", "attention", "summary"):
                        self.assertEqual(result[key], healthy[key], key)
                    self.assertNotIn("code_paths", result)
                    self.assertNotIn("instruction_documents", result)
                    self.assertNotIn("poison", json.dumps(result))
                    self.assertEqual(result["metadata"]["review_languages"], [adapter.id for adapter in adapters])
                    self.assertTrue(result["metadata"]["analysis_incomplete"])
                    self.assertEqual(result["metadata"]["unavailable_languages"],
                                     [{"language": "broken", "phase": phase, "reason": "deliberate helper failure"}])
                    self.assertTrue(result["coverage"]["incomplete"])
                    self.assertEqual(result["coverage"]["unavailable_languages"], ["broken"])
                    self.assertTrue(any("facts unavailable" in warning for warning in result["warnings"]))
                    events = [json.loads(line.split(" ", 1)[1]) for line in self.stderr.getvalue().splitlines()
                              if line.startswith("AGENT_REVIEW_PROGRESS ")]
                    failure_index = next(index for index, event in enumerate(events) if event["phase"] == "adapter_unavailable")
                    self.assertLess(failure_index, next(index for index, event in enumerate(events)
                                                       if event["phase"] == "churn"))
                    self.assertEqual(broken.calls[-1], phase, "failed adapters never enter a later phase")

    def test_operational_errors_are_reported_but_invariants_and_cancellation_propagate(self):
        for error in (OSError("disk unavailable"), subprocess.TimeoutExpired("helper", 1)):
            with self.subTest(error=type(error).__name__):
                self.assertTrue(self.review((PYTHON_ADAPTER, FailingAdapter("scan", error))).to_dict()
                                ["metadata"]["analysis_incomplete"])
        for error in (ValueError("invariant"), RuntimeError("invariant"), KeyError("schema"),
                      AssertionError("invariant"), KeyboardInterrupt(), SystemExit(7)):
            with self.subTest(error=type(error).__name__):
                with self.assertRaises(type(error)):
                    self.review((PYTHON_ADAPTER, FailingAdapter("scan", error)))
        for target in ("discover_repo", "create_snapshot"):
            with self.subTest(fatal=target), patch(f"analyze.{target}", side_effect=OSError("fatal repository error")):
                with self.assertRaisesRegex(OSError, "fatal repository error"):
                    build_review(".", "main", (), use_cache=False)

    def test_healthy_coverage_survives_another_languages_coverage_failure(self):
        coverage = {"available": True, "source": "coverage.json",
                    "files": [{"path": "main.py", "covered_lines": [2]}],
                    "changed_lines": {"main.py": {"covered": 1, "uncovered": 0}}}
        with patch.object(PYTHON_ADAPTER, "coverage", return_value=coverage):
            result = self.review((PYTHON_ADAPTER, FailingAdapter("coverage"))).to_dict()
        self.assertTrue(result["coverage"]["available"])
        self.assertEqual(result["coverage"]["files"], coverage["files"])
        self.assertEqual(result["coverage"]["changed_lines"], coverage["changed_lines"])
        self.assertTrue(result["coverage"]["incomplete"])
        self.assertNotIn("incomplete", coverage, "the retained report is not mutated")

    def test_all_adapters_unavailable_still_retains_source_review_with_explicit_limits(self):
        result = self.review((FailingAdapter("scan"),)).to_dict()
        self.assertEqual(result["metadata"]["review_languages"], ["broken"])
        self.assertTrue(result["metadata"]["analysis_incomplete"])
        self.assertTrue(result["coverage"]["incomplete"])
        self.assertEqual(result["nodes"], [])
        self.assertEqual(result["changes"][0]["status"], "modified")
        self.assertIn("return 2", result["source_files"]["main.py"]["current"])


class ProductionHelperFailureTests(unittest.TestCase):
    def test_mixed_language_cli_survives_a_real_failed_helper_process(self):
        with tempfile.TemporaryDirectory(prefix="agent-review-adapter-failure-") as directory:
            repo = Path(directory) / "repo"
            repo.mkdir()
            helper = Path(directory) / "failed-helper.py"
            helper.write_text("import sys\nprint('deliberate helper failure', file=sys.stderr)\nraise SystemExit(42)\n",
                              encoding="utf-8")
            def git(*args):
                return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
            git("init", "-q")
            git("config", "user.name", "Test")
            git("config", "user.email", "test@example.invalid")
            (repo / "main.py").write_text("def run():\n    return 1\n", encoding="utf-8")
            (repo / "app.js").write_text("export function run(){ return 1; }\n", encoding="utf-8")
            (repo / "package.json").write_text('{"dependencies":{"Foo":"1.0.0"}}', encoding="utf-8")
            (repo / "App.cs").write_text("class App { int Run() => 1; }\n", encoding="utf-8")
            (repo / "App.csproj").write_text('<Project><ItemGroup><PackageReference Include="Foo" Version="1.0"/></ItemGroup></Project>',
                                           encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "baseline")
            (repo / "main.py").write_text("def run():\n    return 2\n", encoding="utf-8")
            (repo / "app.js").write_text('import Foo from "Foo"; export function run(){ return Foo(2); }\n', encoding="utf-8")
            environment = {**os.environ, "AGENT_REVIEW_DOTNET": sys.executable, "AGENT_REVIEW_DOTNET_HELPER": str(helper)}
            result = subprocess.run([sys.executable, str(ANALYZER / "analyze.py"), "--repo", str(repo),
                                     "--base-ref", "HEAD", "--no-cache"],
                                    capture_output=True, text=True, encoding="utf-8", env=environment, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            model = json.loads(result.stdout)
            self.assertEqual(model["metadata"]["review_languages"], ["python", "node", "csharp"])
            self.assertTrue(model["metadata"]["analysis_incomplete"])
            self.assertEqual(model["metadata"]["unavailable_languages"][0]["language"], "csharp")
            self.assertIn("exit 42", model["metadata"]["unavailable_languages"][0]["reason"])
            self.assertIn("deliberate helper failure", model["warnings"][0])
            self.assertTrue(any(symbol["path"] == "main.py" for symbol in model["symbols"]))
            self.assertTrue(any(symbol["path"] == "app.js" for symbol in model["symbols"]))
            self.assertFalse(any(symbol.get("language") == "csharp" for symbol in model["symbols"]))
            self.assertFalse(any(package.get("ecosystem") == "nuget" for package in model["package_dependencies"]))
            healthy_package = next(package for package in model["package_dependencies"] if package["id"] == "package:npm:Foo")
            self.assertTrue(healthy_package["usage_locations"], "healthy package usage is not lost with failed NuGet facts")
            self.assertTrue(any(edge["type"] == "uses_package" and edge["target"] == healthy_package["id"]
                                for edge in model["edges"]))
            self.assertEqual({change["path"] for change in model["changes"] if change["status"] == "modified"},
                             {"main.py", "app.js"})
            self.assertIn("return Foo(2)", model["source_files"]["app.js"]["current"])
            self.assertIn("class App", model["source_files"]["App.cs"]["current"])
            self.assertIn('"phase":"adapter_unavailable"', result.stderr)


if __name__ == "__main__":
    unittest.main()
