import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from review_model import ReviewModel
from dotnet_adapter import DOTNET_ADAPTER, helper_path
from language_adapters import AnalysisSnapshot
from python_adapter import PYTHON_ADAPTER


class MixedPackageIdentityTests(unittest.TestCase):
    @unittest.skipUnless(helper_path().is_file(), "prepared Roslyn helper required")
    def test_csharp_directory_and_dotnet_component_never_collide(self):
        current = {
            "csharp/helper.py": b"def run():\n    return 1\n",
            "App/App.csproj": b'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
            "App/Widget.cs": b"namespace Collision; public class Widget { public int Run() => 1; }\n",
        }
        model = ReviewModel({})
        model.changes = [
            {"path": path, "status": "added", "current_lines": len(data.splitlines()),
             "lines_added": len(data.splitlines()), "lines_removed": 0}
            for path, data in current.items()
        ]
        model.source_files = {path: {"current": data.decode()} for path, data in current.items()}
        snapshot = AnalysisSnapshot(Path("."), {}, current, None, True, False)
        for adapter in (PYTHON_ADAPTER, DOTNET_ADAPTER):
            dependencies = adapter.dependencies(snapshot, model.warnings)
            adapter.scan(snapshot, model, dependencies, lambda *_: None)
        dto = model.to_dict()
        ids = [node["id"] for node in dto["nodes"]]
        self.assertEqual(len(ids), len(set(ids)), "all mixed-language node IDs are unique")
        components = {node["name"]: node["id"] for node in dto["nodes"] if node["kind"] == "component"}
        self.assertNotEqual(components["csharp"], components["C# / .NET"])
        modules = {node["path"]: node for node in dto["nodes"] if node["kind"] == "module"}
        self.assertEqual(modules["csharp/helper.py"]["component_id"], components["csharp"])
        self.assertEqual(modules["App/Widget.cs"]["component_id"], components["C# / .NET"])

    def test_pypi_npm_nuget_and_cargo_same_names_remain_separate(self):
        model = ReviewModel({})
        model.packages["current"] = [
            {"name": "shared", "specifier": "==1.0", "source": "requirements.txt", "resolved_version": "1.0"},
            {"name": "shared", "ecosystem": "npm", "specifier": "^2.0", "source": "package.json", "resolved_version": "2.1"},
            {"name": "Shared", "ecosystem": "nuget", "specifier": "3.0", "source": "App.csproj", "resolved_version": "3.0"},
            {"name": "shared", "ecosystem": "cargo", "specifier": "4", "source": "Cargo.toml", "resolved_version": "4.0.0"},
        ]
        model.packages["changes"] = [
            {"name": item["name"], "kind": "added", **({"ecosystem": item["ecosystem"]} if "ecosystem" in item else {})}
            for item in model.packages["current"]
        ]
        result = model.to_dict()
        expected = {"package:shared", "package:npm:shared", "package:nuget:shared", "package:cargo:shared"}
        self.assertEqual({item["id"] for item in result["package_dependencies"]}, expected)
        self.assertEqual({item["id"] for item in result["package_changes"]}, expected)
        self.assertEqual(len({item["id"] for item in result["attention"]}), 4)
        self.assertEqual(len({item["id"] for item in result["nodes"] if item["kind"] == "package"}), 4)
        by_id = {item["id"]: item for item in result["package_changes"]}
        self.assertEqual(by_id["package:npm:shared"]["ecosystem"], "npm")
        self.assertEqual(by_id["package:nuget:shared"]["ecosystem"], "nuget")
        self.assertEqual(by_id["package:cargo:shared"]["ecosystem"], "cargo")
        self.assertEqual(by_id["package:npm:shared"]["resolved_current"], "2.1")
        self.assertEqual(by_id["package:nuget:shared"]["resolved_current"], "3.0")
        self.assertNotIn("ecosystem", by_id["package:shared"])
        reasons = [item["reason"] for item in result["attention"]]
        self.assertTrue(any("shared ^2.0" in reason for reason in reasons), "npm names and ranges have readable spacing")
        self.assertTrue(any("shared==1.0" in reason for reason in reasons), "Python declaration formatting remains unchanged")


if __name__ == "__main__":
    unittest.main()
