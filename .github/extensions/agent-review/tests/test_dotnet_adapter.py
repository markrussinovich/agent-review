from __future__ import annotations

import os
import sys
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from dotnet_adapter import DOTNET_ADAPTER, dotnet_input_path, run_dotnet_helper
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


if __name__ == "__main__":
    unittest.main()
