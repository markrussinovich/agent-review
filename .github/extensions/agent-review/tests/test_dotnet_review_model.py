from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "analyzer"))

from dotnet_packages import dotnet_package_diff, parse_dotnet_packages
from packages import package_diff, parse_packages
from review_model import ReviewModel, stable_id


class DotnetReviewModelTests(unittest.TestCase):
    def test_optional_csharp_metadata_is_only_exposed_when_supplied(self) -> None:
        python_metadata = ReviewModel({"python_loc": 4}).to_dict()["metadata"]
        self.assertEqual({
            "schema_version": 1, "repo_root": None, "base_ref": None,
            "base_sha": None, "head_sha": None, "generated_at": None, "python_loc": 4,
        }, python_metadata)
        metadata = ReviewModel({"csharp_loc": 0, "languages": ["csharp"]}).to_dict()["metadata"]
        self.assertEqual(0, metadata["csharp_loc"])
        self.assertEqual(["csharp"], metadata["review_languages"])
        explicit = ReviewModel({"languages": ["python"], "review_languages": ["csharp", "python"]}).to_dict()["metadata"]
        self.assertEqual(["csharp", "python"], explicit["review_languages"])

    def test_python_output_ids_and_evidence_unchanged(self) -> None:
        before = parse_packages({"requirements.txt": b"demo==1.0\n"})
        after = parse_packages({"requirements.txt": b"demo==2.0\n"})
        dto = ReviewModel({}, packages={"baseline": before, "current": after, "changes": package_diff(before, after)}).to_dict()
        self.assertEqual("package:demo", dto["package_dependencies"][0]["id"])
        self.assertNotIn("ecosystem", dto["package_dependencies"][0])
        self.assertNotIn("ecosystem", dto["nodes"][0])
        self.assertEqual(stable_id("attention", "package", "demo"), dto["attention"][0]["id"])
        evidence = next(iter(dto["evidence"].values()))
        self.assertNotIn("ecosystem", evidence)

    def test_same_name_pypi_and_nuget_are_isolated_everywhere(self) -> None:
        python = parse_packages({"requirements.txt": b"demo==1.0\n"})
        nuget = parse_dotnet_packages({"App.csproj": b'<Project><ItemGroup><PackageReference Include="Demo" Version="2.0"/></ItemGroup></Project>'})
        dto = ReviewModel({}, packages={
            "baseline": [], "current": python + nuget,
            "changes": package_diff([], python) + dotnet_package_diff([], nuget),
        }).to_dict()
        for key in ("nodes", "package_dependencies", "package_changes"):
            self.assertEqual({"package:demo", "package:nuget:demo"}, {item["id"] for item in dto[key]})
        self.assertEqual(2, len({item["id"] for item in dto["attention"]}))
        nuget_dependency = next(item for item in dto["package_dependencies"] if item.get("ecosystem") == "nuget")
        self.assertEqual(("Demo", "csharp", "demo", "2.0"), (nuget_dependency["name"], nuget_dependency["language"], nuget_dependency["identity"], nuget_dependency["resolved_current"]))
        self.assertEqual(2, dto["summary"]["new_packages"])
        self.assertEqual([], nuget_dependency["usage_locations"])

    def test_nuget_projects_keep_distinct_versions_and_modification_not_addition(self) -> None:
        before = parse_dotnet_packages({"A.csproj": b'<Project><ItemGroup><PackageReference Include="Demo" Version="1.0"/></ItemGroup></Project>'})
        after = parse_dotnet_packages({
            "A.csproj": b'<Project><ItemGroup><PackageReference Include="demo" Version="1.0"/></ItemGroup></Project>',
            "B.csproj": b'<Project><ItemGroup><PackageReference Include="Demo" Version="2.0"/></ItemGroup></Project>',
        })
        dto = ReviewModel({}, packages={"baseline": before, "current": after, "changes": dotnet_package_diff(before, after)}).to_dict()
        dependency = dto["package_dependencies"][0]
        self.assertEqual("package:nuget:demo", dependency["id"])
        self.assertEqual("modified", dependency["change"])
        self.assertIsNone(dependency["resolved_current"])
        self.assertEqual(2, len(dependency["declared_current"]))
        self.assertEqual("modified", dto["nodes"][0]["change"])

    def test_package_usage_evidence_is_ecosystem_scoped(self) -> None:
        python = parse_packages({"requirements.txt": b"demo==1.0\n"})
        nuget = parse_dotnet_packages({"App.csproj": b'<Project><ItemGroup><PackageReference Include="Demo" Version="2.0"/></ItemGroup></Project>'})
        model = ReviewModel({}, packages={"baseline": [], "current": python + nuget, "changes": package_diff([], python) + dotnet_package_diff([], nuget)})
        model.edges = [{
            "id": "usage", "kind": "uses_package", "source": "source",
            "target": "package:nuget:demo", "confidence": 1, "evidence_ids": ["nuget-evidence"],
        }]
        changes = {item["id"]: item for item in model.to_dict()["package_changes"]}
        self.assertEqual(["nuget-evidence"], changes["package:nuget:demo"]["evidence_ids"])
        self.assertNotEqual(["nuget-evidence"], changes["package:demo"]["evidence_ids"])

    def test_csharp_symbol_identity_metadata_without_python_changes(self) -> None:
        model = ReviewModel({})
        model.aggregates = {
            "components": [{"id": "component", "name": "App", "module_ids": ["module"]}],
            "modules": [{"id": "module", "name": "App.Code", "component": "App", "path": "App/Code.cs", "change": "added", "language": "csharp"}],
            "edges": [],
        }
        model.symbols = [{
            "id": "method", "identity": "csharp:App:Code.Run()", "module": "App.Code",
            "qualname": "Code.Run", "name": "Run", "kind": "method",
            "language": "csharp", "ecosystem": "nuget",
            "path": "App/Code.cs", "range": {"start_line": 1, "end_line": 2},
            "classification": "added",
        }]
        dto = model.to_dict()
        method = next(node for node in dto["nodes"] if node["id"] == "method")
        self.assertEqual(("csharp", "nuget", "csharp:App:Code.Run()"), (method["language"], method["ecosystem"], method["identity"]))
        self.assertEqual("csharp", next(node for node in dto["nodes"] if node["id"] == "module")["language"])
        model.symbols[0]["path"] = "App/code.py"
        model.symbols[0].pop("language")
        model.symbols[0].pop("ecosystem")
        model.aggregates["modules"][0]["path"] = "App/code.py"
        model.aggregates["modules"][0].pop("language")
        python = next(node for node in model.to_dict()["nodes"] if node["id"] == "method")
        self.assertNotIn("language", python)
        self.assertNotIn("identity", python)

    def test_csharp_parent_identity_is_not_reconstructed_as_python_identity(self) -> None:
        model = ReviewModel({})
        model.aggregates = {
            "components": [{"id": "component", "name": "App", "module_ids": ["module"]}],
            "modules": [{"id": "module", "name": "App.Code", "component": "App", "path": "App/Code.cs", "change": "added"}],
            "edges": [],
        }
        common = {
            "module": "App.Code", "path": "App/Code.cs",
            "range": {"start_line": 1, "end_line": 2}, "classification": "added",
        }
        model.symbols = [
            {**common, "id": "class", "identity": "csharp:project:Code", "name": "Code", "qualname": "Code", "kind": "class"},
            {**common, "id": "method", "identity": "csharp:project:Code.Run()", "parent_identity": "csharp:project:Code", "name": "Run", "qualname": "Code.Run", "kind": "method"},
        ]
        method = next(node for node in model.to_dict()["nodes"] if node["id"] == "method")
        self.assertEqual("class", method["parent_id"])
        model.symbols[-1]["parent_identity"] = "missing"
        model.symbols[-1]["parent_id"] = "class"
        method = next(node for node in model.to_dict()["nodes"] if node["id"] == "method")
        self.assertEqual("class", method["parent_id"])

    def test_symbol_language_and_ecosystem_are_not_synthesized(self) -> None:
        model = ReviewModel({})
        model.aggregates = {
            "components": [{"id": "component", "name": "App", "module_ids": ["module"]}],
            "modules": [{"id": "module", "name": "App.Code", "component": "App", "path": "App/Code.cs", "change": "added"}],
            "edges": [],
        }
        model.symbols = [{
            "id": "method", "identity": "method", "module": "App.Code",
            "qualname": "Code.Run", "name": "Run", "kind": "method",
            "path": "App/Code.cs", "range": {"start_line": 1, "end_line": 2},
            "classification": "added",
        }]
        nodes = model.to_dict()["nodes"]
        self.assertTrue(all("language" not in node and "ecosystem" not in node for node in nodes))
        model.symbols[0]["language"] = "csharp"
        method = next(node for node in model.to_dict()["nodes"] if node["id"] == "method")
        self.assertEqual("csharp", method["language"])
        self.assertNotIn("ecosystem", method)

    def test_csharp_overloaded_qualname_does_not_use_python_parent_inference(self) -> None:
        model = ReviewModel({})
        module = "App/App.csproj@net10.0"
        qualname = "Sample.C.F(System.String)"
        model.aggregates = {
            "components": [{"id": "component", "name": "App", "module_ids": ["module"]}],
            "modules": [{"id": "module", "name": module, "component": "App", "path": "App/Code.cs", "change": "added"}],
            "edges": [],
        }
        common = {
            "module": module, "path": "App/Code.cs", "language": "csharp",
            "range": {"start_line": 1, "end_line": 2}, "classification": "added",
        }
        model.symbols = [
            {**common, "id": "unrelated", "identity": f"{module}:{qualname.rsplit('.', 1)[0]}", "qualname": "Unrelated", "name": "Unrelated", "kind": "class"},
            {**common, "id": "method", "identity": f"{module}::M:Sample.C.F(System.String)", "qualname": qualname, "name": "F", "kind": "method"},
        ]
        method = next(node for node in model.to_dict()["nodes"] if node["id"] == "method")
        self.assertEqual("module", method["parent_id"])

    def test_optional_component_language_and_identity_are_exposed(self) -> None:
        model = ReviewModel({})
        model.aggregates["components"] = [{
            "id": "component", "name": "App", "module_ids": [],
            "language": "csharp", "identity": "csharp:App", "ecosystem": "dotnet",
        }]
        node = model.to_dict()["nodes"][0]
        self.assertEqual(("csharp", "dotnet", "csharp:App"), (node["language"], node["ecosystem"], node["identity"]))

    def test_module_display_name_does_not_change_symbol_lookup_or_ids(self) -> None:
        model = ReviewModel({})
        lookup = "csharp:App/App.csproj:net10.0:App/Widget.cs"
        display = "App/Widget.cs [App/App.csproj@net10.0]"
        model.aggregates = {
            "components": [{"id": "component", "name": "App", "module_ids": ["module"]}],
            "modules": [{
                "id": "module", "name": lookup, "display_name": display,
                "component": "App", "path": "App/Widget.cs", "change": "added",
                "language": "csharp",
            }],
            "edges": [],
        }
        model.symbols = [{
            "id": "method", "identity": "App/App.csproj@net10.0::M:Widget.Run",
            "module": lookup, "qualname": "Widget.Run", "name": "Run", "kind": "method",
            "language": "csharp", "path": "App/Widget.cs", "classification": "added",
            "range": {"start_line": 1, "end_line": 2},
        }]
        nodes = {node["id"]: node for node in model.to_dict()["nodes"]}
        self.assertEqual(display, nodes["module"]["name"])
        self.assertEqual("module", nodes["method"]["module_id"])
        self.assertEqual("module", nodes["method"]["parent_id"])
        self.assertEqual(lookup, model.aggregates["modules"][0]["name"])
        self.assertEqual(lookup, model.symbols[0]["module"])
        model.aggregates["modules"][0].pop("display_name")
        module_node = next(node for node in model.to_dict()["nodes"] if node["id"] == "module")
        self.assertEqual(lookup, module_node["name"])

    def test_csharp_properties_interfaces_namespaces_counts_and_attention(self) -> None:
        model = ReviewModel({})
        model.aggregates = {
            "components": [{"id": "component", "name": "App", "module_ids": ["module"]}],
            "modules": [{"id": "module", "name": "App.Code", "component": "App", "path": "App/Code.cs", "change": "modified"}],
            "edges": [],
        }
        model.changes = [{
            "path": "App/Code.cs", "status": "modified", "current_lines": 30,
            "added_lines": list(range(1, 31)), "removed_lines": [], "lines_added": 30,
        }]
        model.coverage = {
            "available": True,
            "files": [{"path": "App/Code.cs", "executable_lines": [2], "covered_lines": []}],
            "changed_lines": {"App/Code.cs": {"covered_lines": [], "uncovered_lines": [2]}},
        }
        model.symbols = [
            {
                "id": kind, "identity": kind, "language": "csharp",
                "module": "App.Code", "path": "App/Code.cs",
                "name": kind, "qualname": kind, "kind": kind,
                "range": {"start_line": 1, "end_line": 30},
                "classification": "modified", "signature_base": "old", "signature_current": "new",
            }
            for kind in ("property", "interface", "namespace")
        ]
        dto = model.to_dict()
        self.assertEqual(3, dto["summary"]["symbols_changed"])
        self.assertEqual(3, dto["summary"]["symbols_modified"])
        self.assertEqual(1, dto["summary"]["changed_functions_uncovered"])
        uncovered = [item["node_id"] for item in dto["attention"] if item["type"] == "uncovered"]
        self.assertEqual(["property"], uncovered)
        signatures = [item for item in dto["attention"] if item["type"] == "signature"]
        self.assertEqual({"property", "interface", "namespace"}, {item["node_id"] for item in signatures})
        self.assertTrue(all(item["title"] == "Public symbol contract changed" for item in signatures))
        size = [item for item in dto["attention"] if item["type"] == "size"]
        self.assertTrue({"property", "interface", "namespace"} <= {item["node_id"] for item in size})

    def test_extended_symbol_counts_are_gated_to_csharp(self) -> None:
        model = ReviewModel({})
        model.aggregates = {
            "components": [{"id": "component", "name": "App", "module_ids": ["module"]}],
            "modules": [{"id": "module", "name": "App.Code", "component": "App", "path": "App/code.py", "change": "added"}],
            "edges": [],
        }
        model.symbols = [{
            "id": "property", "identity": "property", "module": "App.Code",
            "path": "App/code.py", "language": "python", "name": "property",
            "qualname": "property", "kind": "property", "classification": "added",
            "range": {"start_line": 1, "end_line": 2},
        }]
        self.assertEqual(0, model.to_dict()["summary"]["symbols_changed"])


if __name__ == "__main__":
    unittest.main()
