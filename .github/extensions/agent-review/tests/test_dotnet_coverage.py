from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "analyzer"))

from dotnet_coverage import load_dotnet_coverage


def report(filename: str, lines: str, sources: str = "") -> bytes:
    return f'<coverage><sources>{sources}</sources><packages><package><classes><class filename="{filename}"><lines>{lines}</lines></class></classes></package></packages></coverage>'.encode()


class DotnetCoverageTests(unittest.TestCase):
    def test_saved_changed_lines_and_branch_evidence_never_read_checkout(self) -> None:
        snapshot = SimpleNamespace(
            repo=Path("this-checkout-does-not-exist"), base_ref="saved",
            baseline={"App/Code.cs": b"old\nsame\n"},
            current={
                "App/Code.cs": b"new\nsame\nthird\n",
                "coverage.cobertura.xml": report("Code.cs", '<line number="1" hits="1" branch="true" condition-coverage="50% (1/2)"/><line number="2" hits="1"/><line number="3" hits="0"/>', '<source>C:\\build\\repo\\App</source>'),
            },
        )
        with patch("pathlib.Path.read_bytes", side_effect=AssertionError("live bytes")), patch("pathlib.Path.read_text", side_effect=AssertionError("live text")), patch("subprocess.run", side_effect=AssertionError("git")):
            coverage = load_dotnet_coverage(snapshot)
        self.assertTrue(coverage["available"])
        self.assertEqual(3, coverage["files"][0]["line_count"])
        changed = coverage["changed_lines"]["App/Code.cs"]
        self.assertEqual((2, 1, 50.0), (changed["total"], changed["covered"], changed["percent"]))
        self.assertEqual([3], changed["uncovered_lines"])
        self.assertEqual([{"line": 1, "covered": 1, "total": 2}], changed["branch_lines"])
        self.assertEqual((2, 1), (changed["branches_total"], changed["branches_covered"]))

    def test_ambiguous_basename_is_rejected(self) -> None:
        coverage = load_dotnet_coverage(SimpleNamespace(
            baseline={},
            current={"A/Code.cs": b"x\n", "B/Code.cs": b"x\n", "coverage.xml": report("Code.cs", '<line number="1" hits="1"/>')},
        ))
        self.assertFalse(coverage["available"])
        self.assertTrue(any("ambiguous" in warning for warning in coverage["warnings"]))

    def test_sources_disambiguate_identical_project_relative_paths(self) -> None:
        coverage = load_dotnet_coverage(SimpleNamespace(
            baseline={},
            current={
                "A/Models/Code.cs": b"x\n", "B/Models/Code.cs": b"x\n",
                "coverage.xml": report("Models/Code.cs", '<line number="1" hits="1"/>', "<source>C:/build/repo/B</source>"),
            },
        ))
        self.assertEqual(["B/Models/Code.cs"], [item["path"] for item in coverage["files"]])

    def test_project_relative_report_directory_and_absolute_filename(self) -> None:
        for filename, report_path in (("Models/Code.cs", "App/TestResults/coverage.xml"), ("C:\\old\\repo\\App\\Models\\Code.cs", "coverage.xml")):
            coverage = load_dotnet_coverage(SimpleNamespace(
                baseline={},
                current={
                    "App/App.csproj": b"<Project/>", "App/Models/Code.cs": b"x\n",
                    "Other/Models/Code.cs": b"x\n",
                    report_path: report(filename, '<line number="1" hits="1"/>'),
                },
            ))
            self.assertEqual("App/Models/Code.cs", coverage["files"][0]["path"])

    def test_renamed_deleted_added_and_newline_only_changes(self) -> None:
        coverage = load_dotnet_coverage(SimpleNamespace(
            baseline={"Gone.cs": b"old\n", "Unchanged.cs": b"x\r\n"},
            current={
                "New.cs": b"a\nb\n", "Unchanged.cs": b"x\n",
                "coverage.xml": b'<coverage><packages><package><classes><class filename="New.cs"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class><class filename="Gone.cs"><lines><line number="1" hits="1"/></lines></class><class filename="Unchanged.cs"><lines><line number="1" hits="0"/></lines></class></classes></package></packages></coverage>',
            },
        ))
        self.assertEqual(["New.cs", "Unchanged.cs"], [item["path"] for item in coverage["files"]])
        self.assertEqual(2, coverage["changed_lines"]["New.cs"]["total"])
        self.assertEqual(0, coverage["changed_lines"]["Unchanged.cs"]["total"])

    def test_only_current_reports_are_loaded(self) -> None:
        coverage = load_dotnet_coverage(SimpleNamespace(
            baseline={"Code.cs": b"x", "coverage.xml": report("Code.cs", '<line number="1" hits="1"/>')},
            current={"Code.cs": b"x"},
        ))
        self.assertFalse(coverage["available"])
        self.assertEqual([], coverage["warnings"])

    def test_malformed_reports_have_actionable_warnings_and_no_partial_data(self) -> None:
        for raw in (
            b"<coverage>",
            b'<!DOCTYPE coverage [<!ENTITY x "bad">]><coverage/>',
            report("Code.cs", '<line number="1" hits="1"/><line number="2" hits="oops"/>'),
            report("Code.cs", '<line number="0" hits="1"/>'),
            report("Code.cs", '<line number="1" hits="-1"/>'),
            report("Code.cs", '<line number="1" hits="1" branch="true" condition-coverage="50% (3/2)"/>'),
            report("Code.cs", '<line number="1" hits="1" branch="true"/>'),
        ):
            with self.subTest(raw=raw):
                coverage = load_dotnet_coverage(SimpleNamespace(baseline={}, current={"Code.cs": b"a\nb\n", "coverage.xml": raw}))
                self.assertFalse(coverage["available"])
                self.assertTrue(any("regenerate" in warning for warning in coverage["warnings"]))

    def test_stale_lines_and_non_cobertura_named_report_warn(self) -> None:
        for raw in (report("Code.cs", '<line number="4" hits="1"/>'), b"<not-coverage/>"):
            coverage = load_dotnet_coverage(SimpleNamespace(baseline={}, current={"Code.cs": b"x\n", "coverage.xml": raw}))
            self.assertFalse(coverage["available"])
            self.assertTrue(coverage["warnings"])

    def test_duplicate_classes_and_multiple_reports_do_not_double_count(self) -> None:
        coverage = load_dotnet_coverage(SimpleNamespace(
            baseline={},
            current={
                "Code.cs": b"x\n",
                "coverage.xml": report("Code.cs", '<line number="1" hits="0" branch="true" condition-coverage="0% (0/2)"/>'),
                "other.xml": report("Code.cs", '<line number="1" hits="1" branch="true" condition-coverage="50% (1/2)"/>'),
            },
        ))
        self.assertEqual(2, len(coverage["sources"]))
        self.assertEqual([1], coverage["files"][0]["covered_lines"])
        self.assertEqual((2, 1), (coverage["files"][0]["branches_total"], coverage["files"][0]["branches_covered"]))

    def test_unrelated_xml_ignored_and_conditions_retained(self) -> None:
        coverage = load_dotnet_coverage(SimpleNamespace(
            baseline={},
            current={
                "Code.cs": b"x\n", "unrelated.xml": b"<invalid",
                "coverage.xml": report("Code.cs", '<line number="1" hits="1" branch="true"><conditions><condition coverage="100%"/><condition coverage="0%"/></conditions></line>'),
            },
        ))
        self.assertEqual([], coverage["warnings"])
        self.assertEqual([{"line": 1, "covered": 1, "total": 2}], coverage["files"][0]["branch_lines"])

    def test_qualified_missing_path_is_not_guessed_from_unique_basename(self) -> None:
        coverage = load_dotnet_coverage(SimpleNamespace(
            baseline={},
            current={"App/Code.cs": b"x\n", "coverage.xml": report("Wrong/Code.cs", '<line number="1" hits="1"/>')},
        ))
        self.assertFalse(coverage["available"])
        self.assertTrue(any("not present" in warning for warning in coverage["warnings"]))

    def test_sources_prefer_full_project_path_over_root_basename(self) -> None:
        coverage = load_dotnet_coverage(SimpleNamespace(
            baseline={},
            current={
                "Code.cs": b"x\n", "App/Code.cs": b"x\n",
                "coverage.xml": report("Code.cs", '<line number="1" hits="1"/>', "<source>C:/build/repo/App</source>"),
            },
        ))
        self.assertEqual(["App/Code.cs"], [item["path"] for item in coverage["files"]])

    def test_utf16_report_and_utf16_dtd_are_handled_without_live_reads(self) -> None:
        raw = report("Code.cs", '<line number="1" hits="1"/>').decode().encode("utf-16")
        coverage = load_dotnet_coverage(SimpleNamespace(baseline={}, current={"Code.cs": b"x\n", "report.xml": raw}))
        self.assertTrue(coverage["available"])
        malicious = '<!DOCTYPE coverage [<!ENTITY x "unsafe">]><coverage/>'.encode("utf-16")
        coverage = load_dotnet_coverage(SimpleNamespace(baseline={}, current={"Code.cs": b"x\n", "report.xml": malicious}))
        self.assertFalse(coverage["available"])
        self.assertTrue(any("DTD" in warning for warning in coverage["warnings"]))

    def test_one_malformed_report_does_not_discard_valid_saved_report(self) -> None:
        coverage = load_dotnet_coverage(SimpleNamespace(
            baseline={},
            current={
                "Code.cs": b"x\n", "bad-coverage.xml": b"<coverage>",
                "good.xml": report("Code.cs", '<line number="1" hits="1"/>'),
            },
        ))
        self.assertTrue(coverage["available"])
        self.assertEqual(["good.xml"], coverage["sources"])
        self.assertTrue(any("bad-coverage.xml" in warning for warning in coverage["warnings"]))


if __name__ == "__main__":
    unittest.main()
