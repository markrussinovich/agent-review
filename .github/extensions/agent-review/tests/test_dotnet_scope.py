from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from dotnet_adapter import DOTNET_ADAPTER, helper_path, run_dotnet_helper
from language_adapters import AnalysisSnapshot
from review_model import ReviewModel


def project(*references: str, extra: str = "", tfms: str = "net10.0") -> str:
    return (f"<Project><PropertyGroup><TargetFrameworks>{tfms}</TargetFrameworks></PropertyGroup>"
            "<ItemGroup>" + "".join(f'<ProjectReference Include="{path}"/>' for path in references)
            + "</ItemGroup>" + extra + "</Project>")


def fixture() -> dict[str, str]:
    return {
        "dependency/Dependency.csproj": project(),
        "dependency/Value.cs": "namespace Dependency; public class Value { public static int Read() => 1; }",
        "lib/Lib.csproj": project("../dependency/Dependency.csproj"),
        "lib/Api.cs": "namespace Lib; public class Api { public static int Read(int x) { if (x < 10) return Dependency.Value.Read(); return 2; } }",
        "consumer/Consumer.csproj": project("../lib/Lib.csproj"),
        "consumer/Caller.cs": "namespace Consumer; public class Caller { public static int Read() => Lib.Api.Read(1); }",
        "tests/Tests.csproj": project("../consumer/Consumer.csproj", "../lib/Lib.csproj",
                                   extra="<PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup>"),
        "tests/Test.cs": "namespace Tests; public class Check { [Xunit.Fact] public void Read() { Xunit.Assert.Equal(1, Consumer.Caller.Read()); } }",
        "tests/Xunit.cs": "namespace Xunit { public class FactAttribute : System.Attribute {} public static class Assert { public static void Equal<T>(T expected, T actual) {} } }",
        "unrelated/Unrelated.csproj": project("../dependency/Dependency.csproj"),
        "unrelated/Other.cs": "namespace Other; public class Untouched { public static int Read() => Dependency.Value.Read(); }",
    }


@unittest.skipUnless(helper_path().is_file(), "Requires the prepared Roslyn helper")
class DotnetScopeTests(unittest.TestCase):
    def analyze(self, before, after, **options):
        return run_dotnet_helper({"baseline": before, "current": after, "mode": "decisions",
                                  "use_cache": False}, **options)

    def test_changed_project_keeps_transitive_callers_tests_and_dependencies(self):
        before = fixture()
        after = {**before, "lib/Api.cs": before["lib/Api.cs"].replace("x < 10", "x < 12")}
        messages = []
        result = self.analyze(before, after, on_progress=messages.append)
        projects = {symbol["path"] for symbol in result["symbols"] if symbol["kind"] == "project"}
        self.assertEqual(projects, {"dependency/Dependency.csproj", "lib/Lib.csproj",
                                    "consumer/Consumer.csproj", "tests/Tests.csproj"})
        self.assertFalse(any(symbol["path"].startswith("unrelated/") for symbol in result["symbols"]))
        self.assertTrue(any(edge["source"].startswith("consumer/") and edge["target"].startswith("lib/")
                            and edge["kind"] == "calls" for edge in result["edges"]))
        self.assertTrue(any(edge["source"].startswith("lib/") and edge["target"].startswith("dependency/")
                            and edge["kind"] == "calls" for edge in result["edges"]))
        self.assertTrue(any(test["id"] == "Tests.Check.Read" and test["link"] == "reachable"
                            for test in result["code_paths"]["verification"]["tests"]))
        self.assertTrue(any(symbol["path"] == "consumer/Caller.cs" and symbol["classification"] == "unchanged"
                            for symbol in result["symbols"]))
        self.assertTrue(result["code_paths"]["limited"])
        self.assertTrue(any("omitted 1 unrelated" in warning for warning in result["warnings"]))
        self.assertFalse(any("size limits" in warning for warning in result["code_paths"]["warnings"]))
        self.assertTrue(any(message.startswith("Compiling dependency/Dependency.csproj@net10.0 (1/4, baseline)")
                            for message in messages))
        self.assertTrue(any("Resolving relationships" in message and "current" in message for message in messages))

    def test_deletion_and_linked_sources_select_both_saved_memberships(self):
        before = fixture()
        before["consumer/Consumer.csproj"] = project("../lib/Lib.csproj",
            extra='<ItemGroup><Compile Include="../linked/Part.cs"/></ItemGroup>')
        before["linked/Part.cs"] = "namespace Consumer; public class Linked { public int Read() => Lib.Api.Read(1); }"
        after = {path: text for path, text in before.items() if path != "linked/Part.cs"}
        result = self.analyze(before, after)
        self.assertTrue(any(symbol["path"] == "linked/Part.cs" and symbol["classification"] == "removed"
                            for symbol in result["symbols"]))
        self.assertFalse(any(symbol["path"] == "consumer/Caller.cs" and symbol["classification"] == "removed"
                             for symbol in result["symbols"]))
        self.assertTrue(any(symbol["kind"] == "project" and symbol["path"] == "tests/Tests.csproj"
                            for symbol in result["symbols"]))

    def test_config_only_and_uncertain_membership_retain_full_graph(self):
        cases = [
            {"global.json": '{"sdk":{"version":"10.0.100"}}'},
            {"lib/Lib.csproj": project("../dependency/Dependency.csproj", extra="<PropertyGroup><Nullable>enable</Nullable></PropertyGroup>")},
            {"custom.props": "<Project><ItemGroup><Compile Include='shared/*.cs'/></ItemGroup></Project>"},
            {"unrelated/Unrelated.csproj": project(extra='<ItemGroup Condition="\'$(Configuration)\' == \'Debug\'"><ProjectReference Include="../lib/Lib.csproj"/></ItemGroup>')},
            {"unrelated/Unrelated.csproj": project(extra='<Import Project="missing.props"/>')},
            {"loose.cs": "public class Unknown { }"},
        ]
        for additions in cases:
            with self.subTest(additions=additions):
                before = {**fixture(), **additions}
                after = {**before, "lib/Api.cs": before["lib/Api.cs"].replace("x < 10", "x < 12")}
                if "global.json" in additions:
                    after["global.json"] = '{"sdk":{"version":"10.0.200"}}'
                if "lib/Lib.csproj" in additions:
                    after["lib/Lib.csproj"] = after["lib/Lib.csproj"].replace("enable", "disable")
                if "loose.cs" in additions:
                    after["loose.cs"] += " public class OtherUnknown {}"
                result = self.analyze(before, after)
                self.assertTrue(any(symbol["path"] == "unrelated/Unrelated.csproj" for symbol in result["symbols"]))
                self.assertTrue(any("full supplied project graph" in warning for warning in result["warnings"]))

    def test_all_tfms_are_kept_and_identical_snapshots_compile_once(self):
        before = fixture()
        before["lib/Lib.csproj"] = project("../dependency/Dependency.csproj", tfms="net10.0;net9.0")
        after = {**before, "lib/Api.cs": before["lib/Api.cs"].replace("x < 10", "x < 12")}
        scoped = self.analyze(before, after)
        self.assertEqual({symbol["id"].split("::")[0] for symbol in scoped["symbols"] if symbol["path"] == "lib/Api.cs"},
                         {"lib/Lib.csproj@net10.0", "lib/Lib.csproj@net9.0"})
        messages = []
        identity = self.analyze(before, before, on_progress=messages.append)
        self.assertTrue(all(symbol["classification"] == "unchanged" for symbol in identity["symbols"]))
        self.assertTrue(any(symbol["path"] == "unrelated/Unrelated.csproj" for symbol in identity["symbols"]))
        self.assertEqual(sum(message.startswith("Compiling ") for message in messages), 6)
        self.assertFalse(any("current)" in message for message in messages))
        self.assertIn("Reusing identical baseline compilation for current snapshot", messages)
        self.assertTrue(all(callable["change"] == "unchanged" and callable["entries"] == []
                            for callable in identity["code_paths"]["callables"]))

    def test_actual_adapter_and_protocol_progress_are_json_safe(self):
        before = fixture()
        after = {**before, "lib/Api.cs": before["lib/Api.cs"].replace("x < 10", "x < 12")}
        snapshot = AnalysisSnapshot(Path("."), {path: text.encode() for path, text in before.items()},
                                    {path: text.encode() for path, text in after.items()}, None, True, False)
        model = ReviewModel({})
        messages = []
        DOTNET_ADAPTER.scan(snapshot, model, {}, lambda message, percent: messages.append((message, percent)))
        self.assertTrue(any(message.startswith("Compiling ") and percent == 65 for message, percent in messages))
        self.assertTrue(any(symbol["path"] == "consumer/Caller.cs" for symbol in model.symbols))
        self.assertIn("unrelated/Other.cs", model.source_files)
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / "request.json"
            request.write_text(json.dumps({"baseline": before, "current": after, "progress": True}), encoding="utf-8")
            completed = subprocess.run([os.environ.get("AGENT_REVIEW_DOTNET", "dotnet"), str(helper_path()),
                                        "--input", str(request)], capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIsInstance(json.loads(completed.stdout), dict)
        self.assertIn("AGENT_REVIEW_DOTNET_PROGRESS ", completed.stderr)
        self.assertNotIn("AGENT_REVIEW_DOTNET_PROGRESS", completed.stdout)

    def test_diagnostic_sampling_keeps_errors_and_existing_output_budget(self):
        files = {"App.csproj": project(), "First.cs": "public class First { public int Read() => 1; }",
                 "Last.cs": "public class Last { public int Read() => MissingName; }"}
        result = self.analyze({}, files)
        self.assertTrue(any("semantic incomplete (CS0103)" in warning and "Last.cs" in warning
                            for warning in result["warnings"]))
        files["Last.cs"] = ("public class Last { public int Read() { "
                           + " ".join(f"Missing{index}();" for index in range(20)) + " return 1; } }")
        result = self.analyze({}, files)
        self.assertEqual(sum("semantic incomplete" in warning for warning in result["warnings"]), 10)
        self.assertTrue(any("additional compiler diagnostics omitted" in warning for warning in result["warnings"]))
        files["Last.cs"] = "public class Last { public int Read() => ; }"
        result = self.analyze({}, files)
        self.assertTrue(any("syntax error" in warning for warning in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
