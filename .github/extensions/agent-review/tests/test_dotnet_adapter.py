from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from dotnet_adapter import DOTNET_ADAPTER, dotnet_input_path, helper_path, run_dotnet_helper
from dotnet_decisions import normalize_code_paths
from language_adapters import AnalysisSnapshot, active_adapters
from review_model import ReviewModel


class DotnetAdapterTests(unittest.TestCase):
    def test_malformed_manifest_cannot_fabricate_dependency_removals(self):
        baseline = {"App.csproj": b'<Project><ItemGroup><PackageReference Include="Foo" Version="1.0" /></ItemGroup></Project>'}
        snapshot = AnalysisSnapshot(Path("."), baseline, {"App.csproj": b"<Project>"}, None, True, False)
        with self.assertRaisesRegex(ValueError, "current manifest App.csproj contains invalid XML"):
            DOTNET_ADAPTER.dependencies(snapshot, [])
        snapshot = AnalysisSnapshot(Path("."), {}, {"Directory.Packages.props": b"<NotProject/>"}, None, True, False)
        with self.assertRaisesRegex(ValueError, "Project XML root"):
            DOTNET_ADAPTER.dependencies(snapshot, [])

    def test_no_cache_disables_helper_persistence_without_mutating_environment(self):
        before = dict(os.environ)
        with patch("dotnet_adapter.helper_path", return_value=Path(__file__)):
            with patch("dotnet_adapter.subprocess.run", return_value=SimpleNamespace(
                returncode=0, stdout="{}", stderr=""
            )) as run:
                run_dotnet_helper({"use_cache": False})
                self.assertEqual(run.call_args.kwargs["env"]["AGENT_REVIEW_DOTNET_CACHE"], "")
        self.assertEqual(dict(os.environ), before)

    def test_verification_schema_maps_semantic_ids_to_display_names(self):
        identity = "App.csproj@net10.0::M:Demo.App.Run"
        facts = {"symbols": [{"id": identity, "qualname": "Demo.App.Run()"}],
                 "code_paths": {"callables": [{"id": identity}],
                                "verification": {"tests": [{"id": "Test.Run", "calls": [identity],
                                                            "link": "reachable"}]}}}
        result = normalize_code_paths(facts)
        self.assertEqual(result["verification"]["tests"][0]["callables"], ["Demo.App.Run()"])
        self.assertEqual(result["verification"]["tests"][0]["link"], "via")
        self.assertEqual(result["callables"][0]["target_framework"], "net10.0")

    def test_python_only_activation_never_invokes_dotnet(self):
        snapshot = AnalysisSnapshot(Path("."), {}, {"app.py": b"def run(): return 1"}, None, False, False)
        with patch("dotnet_adapter.run_dotnet_helper", side_effect=AssertionError("compiler started")):
            self.assertEqual([adapter.id for adapter in active_adapters(snapshot)], ["python"])

    def test_configuration_inputs_and_saved_both_trees(self):
        before = {"App.cs": b"class App { int Value => 1; }", "App.csproj": b"<Project/>"}
        after = {**before, "App.cs": b"class App { int Value => 2; }", "custom.props": b"<Project/>"}
        snapshot = AnalysisSnapshot(Path("not-a-live-repo"), before, after, "old", True, False)
        model = ReviewModel({})
        model.changes = [{"path": "App.cs", "status": "modified"}]
        facts = {"symbols": [{"id": "csharp:App.Value", "kind": "property", "name": "Value",
                              "qualname": "App.Value", "path": "App.cs", "line": 1, "end_line": 1,
                              "classification": "modified", "language": "csharp", "ecosystem": "nuget"}],
                 "edges": [], "warnings": ["References incomplete"]}
        with patch("dotnet_adapter.run_dotnet_helper", return_value=facts) as helper:
            DOTNET_ADAPTER.scan(snapshot, model, {}, lambda *_: None)
        payload = helper.call_args.args[0]
        self.assertEqual(payload["baseline"]["App.cs"], before["App.cs"].decode())
        self.assertEqual(payload["current"]["App.cs"], after["App.cs"].decode())
        self.assertEqual(payload["mode"], "graph")
        self.assertIn("custom.props", payload["current"])
        self.assertEqual(model.source_files["App.cs"]["baseline"], before["App.cs"].decode())
        self.assertIn("References incomplete", model.warnings)
        self.assertEqual(model.symbols[0]["range"], {"start_line": 1, "end_line": 1})
        self.assertTrue(dotnet_input_path(".editorconfig"))
        self.assertFalse(dotnet_input_path("readme.md"))

    def test_missing_helper_never_builds_and_reports_preparation(self):
        with patch("dotnet_adapter.helper_path", return_value=Path("missing-helper-test.dll").resolve()):
            with patch("dotnet_adapter.subprocess.run", side_effect=AssertionError("process started")):
                with self.assertRaisesRegex(RuntimeError, "Scanning never builds or restores"):
                    run_dotnet_helper({"baseline": {}, "current": {}})


@unittest.skipUnless(helper_path().is_file(), "Requires the prepared Roslyn helper")
class DotnetProtocolTests(unittest.TestCase):
    def test_combined_snapshots_over_32_mi_preserve_graph_and_decisions(self):
        project = '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'
        padding = "/*" + "x" * (17 * 1024 * 1024) + "*/"
        baseline = {
            "App.csproj": project,
            "Policy.cs": "public class Policy { public static int Run(int x) { if (x < 10) return 1; return 2; } }\n" + padding,
            "Caller.cs": "public class Caller { public int Run() => Policy.Run(1); }",
        }
        current = {**baseline, "Policy.cs": baseline["Policy.cs"].replace("x < 10", "x < 12")}
        payload = {"baseline": baseline, "current": current, "use_cache": False}
        self.assertGreater(len(json.dumps(payload)), 32 * 1024 * 1024)
        for files in (baseline, current):
            self.assertLess(sum(len(text) for text in files.values()), 32 * 1024 * 1024)
        graph = run_dotnet_helper({**payload, "mode": "graph"})
        decisions = run_dotnet_helper({**payload, "mode": "decisions"})
        self.assertEqual(graph["symbols"], decisions["symbols"])
        self.assertEqual(graph["edges"], decisions["edges"])
        target = next(symbol["id"] for symbol in graph["symbols"]
                      if symbol["name"] == "Run" and symbol["path"] == "Policy.cs")
        self.assertTrue(any(edge["kind"] == "calls" and edge["target"] == target for edge in graph["edges"]))
        self.assertTrue(any(symbol["id"] == target and symbol["classification"] == "modified"
                            for symbol in graph["symbols"]))
        self.assertFalse(decisions["code_paths"]["limited"])
        callable = next(item for item in decisions["code_paths"]["callables"] if item["id"] == target)
        self.assertTrue(any(entry["status"] == "changed"
                            and "x < 12" in entry["decision"]["thresholds"]
                            and "x < 10" in entry["base"]["thresholds"] for entry in callable["entries"]))

    def test_snapshot_source_limit_is_still_enforced_without_crashing(self):
        with self.assertRaisesRegex(RuntimeError, r"exit 2.*Snapshot source exceeds 32 Mi characters") as raised:
            run_dotnet_helper({"baseline": {}, "current": {"TooLarge.cs": " " * (32 * 1024 * 1024 + 1)}})
        self.assertNotIn("Unhandled exception", str(raised.exception))

    def test_invalid_snapshot_request_is_reported_without_crashing(self):
        for payload in ({"baseline": {}}, {"baseline": {}, "current": {}, "mode": "invalid"},
                        {"baseline": {}, "current": {"App.cs": None}}):
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(RuntimeError, "exit 2") as raised:
                    run_dotnet_helper(payload)
                self.assertNotIn("Unhandled exception", str(raised.exception))

    def test_oversized_file_and_stdin_requests_are_reported_without_crashing(self):
        with tempfile.TemporaryDirectory(prefix="agent-review-dotnet-protocol-") as directory:
            request = Path(directory) / "request.json"
            with request.open("w", encoding="utf-8", newline="") as stream:
                for _ in range(128):
                    stream.write(" " * (1024 * 1024))
                stream.write(" ")
            command = [os.environ.get("AGENT_REVIEW_DOTNET", "dotnet"), str(helper_path())]
            for use_stdin in (False, True):
                with self.subTest(use_stdin=use_stdin), request.open("rb") as stream:
                    result = subprocess.run(
                        command if use_stdin else [*command, "--input", str(request)],
                        stdin=stream if use_stdin else subprocess.DEVNULL,
                        capture_output=True, text=True, encoding="utf-8", timeout=120,
                    )
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(result.stdout, "")
                    self.assertIn("Request JSON exceeds 128 Mi characters; reduce snapshot scope.", result.stderr)
                    self.assertNotIn("Unhandled exception", result.stderr)


if __name__ == "__main__":
    unittest.main()
