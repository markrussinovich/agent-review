from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "analyzer"))

from dotnet_packages import dotnet_package_diff, parse_dotnet_packages


def project(name: str = "Newtonsoft.Json", version: str = "13.0.3") -> bytes:
    return f'<Project><ItemGroup><PackageReference Include="{name}" Version="{version}" /></ItemGroup></Project>'.encode()


class DotnetPackageTests(unittest.TestCase):
    def test_literal_namespace_child_version_and_saved_lines(self) -> None:
        records = parse_dotnet_packages({"App\\App.csproj": b'''<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json"><Version>13.0.3</Version></PackageReference>
</ItemGroup></Project>'''})
        item = records[0]
        self.assertEqual("Newtonsoft.Json", item["name"])
        self.assertEqual("newtonsoft.json", item["identity"])
        self.assertEqual(("nuget", "csharp"), (item["ecosystem"], item["language"]))
        self.assertEqual(("App/App.csproj", 3), (item["source"], item["line"]))
        self.assertEqual("13.0.3", item["resolved_version"])

    def test_nearest_central_manifest_and_override(self) -> None:
        files = {
            "Directory.Packages.props": b'<Project><ItemGroup><PackageVersion Include="Demo" Version="1.0"/></ItemGroup></Project>',
            "src/Directory.Packages.props": b'''<Project>
<ItemGroup>
<PackageVersion Include="Demo" Version="2.0" />
</ItemGroup></Project>''',
            "src/App/App.csproj": b'<Project><ItemGroup><PackageReference Include="Demo"/></ItemGroup></Project>',
            "src/Other/Other.csproj": b'<Project><ItemGroup><PackageReference Include="Demo" VersionOverride="3.0"/></ItemGroup></Project>',
        }
        records = parse_dotnet_packages(files)
        self.assertEqual(["2.0", "3.0"], [item["resolved_version"] for item in records])
        self.assertEqual("src/Directory.Packages.props", records[0]["version_source"])
        self.assertEqual(3, records[0]["version_line"])
        self.assertNotIn("version_source", records[1])

    def test_ranges_properties_floating_and_conditions_are_unresolved(self) -> None:
        for version in ("[1.0,2.0)", "1.*", "$(DemoVersion)", "", "not-a-version"):
            with self.subTest(version=version):
                warnings = []
                item = parse_dotnet_packages({"App.csproj": project("Demo", version)}, warnings)[0]
                self.assertNotIn("resolved_version", item)
                self.assertIn("resolution_error", item)
                self.assertTrue(warnings)
        for raw in (
            b'<Project><ItemGroup Condition="true"><PackageReference Include="Demo" Version="1.0"/></ItemGroup></Project>',
            b'<Project><ItemGroup><PackageReference Include="Demo"><Version Condition="true">1.0</Version></PackageReference></ItemGroup></Project>',
            b'<Project><Choose><When Condition="true"><ItemGroup><PackageReference Include="Demo" Version="1.0"/></ItemGroup></When></Choose></Project>',
        ):
            item = parse_dotnet_packages({"App.csproj": raw})[0]
            self.assertIn("conditional", item["resolution_error"])

    def test_singleton_exact_range_and_prerelease(self) -> None:
        for version in ("[1.2.3]", "1.2.3-beta.1+build", "1.2.3.4"):
            item = parse_dotnet_packages({"App.csproj": project("Demo", version)})[0]
            self.assertEqual(version.strip("[]"), item["resolved_version"])

    def test_conditional_or_duplicate_central_versions_unresolved(self) -> None:
        for central in (
            '<PackageVersion Include="Demo" Version="1.0" Condition="true"/>',
            '<PackageVersion Include="Demo" Version="1.0"/><PackageVersion Include="demo" Version="2.0"/>',
        ):
            item = parse_dotnet_packages({
                "App.csproj": b'<Project><ItemGroup><PackageReference Include="Demo"/></ItemGroup></Project>',
                "Directory.Packages.props": f"<Project><ItemGroup>{central}</ItemGroup></Project>".encode(),
            })[0]
            self.assertNotIn("resolved_version", item)
            self.assertIn("resolution_error", item)

    def test_explicitly_disabled_or_conditional_central_management_is_unresolved(self) -> None:
        for setting in (
            '<ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>',
            '<ManagePackageVersionsCentrally Condition="true">true</ManagePackageVersionsCentrally>',
            '<ManagePackageVersionsCentrally>$(CentralEnabled)</ManagePackageVersionsCentrally>',
        ):
            item = parse_dotnet_packages({
                "App.csproj": f'<Project><PropertyGroup>{setting}</PropertyGroup><ItemGroup><PackageReference Include="Demo"/></ItemGroup></Project>'.encode(),
                "Directory.Packages.props": b'<Project><ItemGroup><PackageVersion Include="Demo" Version="1.0"/></ItemGroup></Project>',
            })[0]
            self.assertNotIn("resolved_version", item)
            self.assertIn("resolution_error", item)

    def test_duplicate_attribute_and_child_version_does_not_claim_resolution(self) -> None:
        item = parse_dotnet_packages({
            "App.csproj": b'<Project><ItemGroup><PackageReference Include="Demo" Version="1.0"><Version Condition="true">2.0</Version></PackageReference></ItemGroup></Project>',
        })[0]
        self.assertNotIn("resolved_version", item)
        self.assertIn("resolution_error", item)

    def test_lock_evidence_direct_and_transitive_saved_location(self) -> None:
        files = {
            "App/App.csproj": project("Demo", "1.0"),
            "App/packages.lock.json": json.dumps({"dependencies": {"net8.0": {
                "Demo": {"type": "Direct", "resolved": "1.0"},
                "Another.Package": {"type": "Transitive", "resolved": "2.1.0"},
            }}}, indent=2).encode(),
        }
        records = parse_dotnet_packages(files)
        transitive, direct = records
        self.assertEqual(("Another.Package", "transitive", "2.1.0"), (transitive["name"], transitive["group"], transitive["resolved_version"]))
        self.assertGreater(transitive["line"], 1)
        self.assertEqual("App/packages.lock.json", transitive["source"])
        self.assertEqual("App/App.csproj", direct["source"])
        self.assertEqual(["App/packages.lock.json"], direct["resolution_sources"])

    def test_assets_ignore_project_libraries_and_disambiguate_saved_project(self) -> None:
        files = {
            "App/App.csproj": project("Demo", "1.0"),
            "App/Other.csproj": b"<Project/>",
            "App/obj/project.assets.json": json.dumps({
                "project": {"restore": {"projectPath": "C:\\build\\App\\App.csproj"}},
                "targets": {"net8.0": {
                    "Demo/1.0": {"type": "package"},
                    "Transitive.Name/4.0": {"type": "package"},
                    "Local/1.0": {"type": "project"},
                }},
            }).encode(),
        }
        records = parse_dotnet_packages(files)
        self.assertEqual(["Demo", "Transitive.Name"], [item["name"] for item in records])
        self.assertTrue(all(item["project"] == "App/App.csproj" for item in records))

    def test_assets_libraries_only(self) -> None:
        records = parse_dotnet_packages({
            "App.csproj": b"<Project/>",
            "obj/project.assets.json": b'{"libraries":{"Demo/1.0":{"type":"package"}}}',
        })
        self.assertEqual("1.0", records[0]["resolved_version"])

    def test_lock_conflict_and_framework_conflict_are_unresolved(self) -> None:
        for versions in (("2.0",), ("1.0", "2.0")):
            warnings = []
            dependencies = {f"net{index}": {"Demo": {"type": "Direct", "resolved": version}} for index, version in enumerate(versions)}
            item = parse_dotnet_packages({
                "App.csproj": project("Demo", "1.0"),
                "packages.lock.json": json.dumps({"dependencies": dependencies}).encode(),
            }, warnings)[0]
            self.assertNotIn("resolved_version", item)
            self.assertIn("conflict", item["resolution_error"])
            self.assertTrue(warnings)

    def test_range_is_not_resolved_by_lock(self) -> None:
        item = parse_dotnet_packages({
            "App.csproj": project("Demo", "[1.0,2.0)"),
            "packages.lock.json": b'{"dependencies":{"net8.0":{"Demo":{"type":"Direct","resolved":"1.2"}}}}',
        })[0]
        self.assertNotIn("resolved_version", item)
        self.assertIn("range", item["resolution_error"])

    def test_malformed_and_dtd_manifests_warn(self) -> None:
        for raw in (
            b"<Project>",
            b'<!DOCTYPE Project [<!ENTITY version "1.0">]><Project/>',
            '<!DOCTYPE Project [<!ENTITY version "1.0">]><Project/>'.encode("utf-16"),
        ):
            warnings = []
            self.assertEqual([], parse_dotnet_packages({"App.csproj": raw}, warnings))
            self.assertTrue(warnings)
        for raw in (b"{bad", b"[]", b'{"dependencies":{"net8.0":[]}}'):
            warnings = []
            parse_dotnet_packages({"App.csproj": b"<Project/>", "packages.lock.json": raw}, warnings)
            self.assertIn("cannot parse", warnings[0])

    def test_ambiguous_lock_owner_is_not_assigned(self) -> None:
        warnings = []
        records = parse_dotnet_packages({
            "App.csproj": b"<Project/>", "Other.csproj": b"<Project/>",
            "packages.lock.json": b'{"dependencies":{"net8.0":{"Demo":{"type":"Direct","resolved":"1.0"}}}}',
        }, warnings)
        self.assertEqual([], records)
        self.assertIn("unambiguous", warnings[0])

    def test_duplicate_reference_conflicting_exact_versions(self) -> None:
        records = parse_dotnet_packages({"App.csproj": b'<Project><ItemGroup><PackageReference Include="Demo" Version="1.0"/><PackageReference Include="demo" Version="2.0"/></ItemGroup></Project>'})
        self.assertTrue(all("resolution_error" in item and "resolved_version" not in item for item in records))

    def test_project_specific_diff_case_insensitivity_and_punctuation(self) -> None:
        before = parse_dotnet_packages({"A.csproj": project("Demo.Name", "1.0"), "B.csproj": project("Demo.Name", "2.0")})
        after = parse_dotnet_packages({"A.csproj": project("demo.name", "1.0"), "B.csproj": project("Demo.Name", "3.0"), "C.csproj": project("Demo-Name", "1.0")})
        changes = dotnet_package_diff(before, after)
        self.assertEqual(["B.csproj", "C.csproj"], [item["project"] for item in changes])
        self.assertEqual(["version_changed", "added"], [item["kind"] for item in changes])
        self.assertEqual(("2.0", "3.0"), (changes[0]["before"], changes[0]["after"]))
        removed = dotnet_package_diff(after, before)
        self.assertEqual("removed", removed[1]["kind"])

    def test_resolution_only_changes_are_reported(self) -> None:
        before = parse_dotnet_packages({"App.csproj": project()})
        after = parse_dotnet_packages({
            "App.csproj": project(),
            "packages.lock.json": b'{"dependencies":{"net8.0":{"Newtonsoft.Json":{"type":"Direct","resolved":"12.0.0"}}}}',
        })
        self.assertEqual("version_changed", dotnet_package_diff(before, after)[0]["kind"])

    def test_does_not_read_checkout_execute_or_use_network(self) -> None:
        with patch("pathlib.Path.read_bytes", side_effect=AssertionError("live read")), patch("subprocess.run", side_effect=AssertionError("execution")), patch("urllib.request.urlopen", side_effect=AssertionError("network")):
            self.assertEqual("13.0.3", parse_dotnet_packages({"App.csproj": project()})[0]["resolved_version"])


if __name__ == "__main__":
    unittest.main()
