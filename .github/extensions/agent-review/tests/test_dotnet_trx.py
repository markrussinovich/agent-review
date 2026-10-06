from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from dotnet_trx import parse_trx


class DotnetTrxTests(unittest.TestCase):
    def test_framework_reports_preserve_individual_results_without_path_claims(self):
        template = """<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
<TestDefinitions><UnitTest id="one"><TestMethod className="Demo.Tests" name="Run"/></UnitTest></TestDefinitions>
<Results><UnitTestResult testId="one" testName="Demo.Tests.Run" outcome="{outcome}"/></Results></TestRun>"""
        with tempfile.TemporaryDirectory(prefix="agent-review-trx-") as directory:
            root = Path(directory)
            (root / "net9.trx").write_text(template.format(outcome="Passed"))
            (root / "net10.trx").write_text(template.format(outcome="Failed"))
            trace = parse_trx(root, ["Demo.Tests.Run"])
        self.assertFalse(trace["per_test_path_evidence"])
        self.assertEqual(len(trace["tests"]), 2)
        self.assertEqual({record["outcome"] for record in trace["tests"].values()}, {"passed", "failed"})
        self.assertTrue(all(record["lines"] == {} for record in trace["tests"].values()))

    def test_no_matched_result_is_explicit_failure(self):
        with tempfile.TemporaryDirectory(prefix="agent-review-trx-") as directory:
            with self.assertRaisesRegex(ValueError, "no TRX results matching"):
                parse_trx(Path(directory), ["Demo.Tests.Run"])


if __name__ == "__main__":
    unittest.main()
