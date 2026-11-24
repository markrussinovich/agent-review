from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from git_snapshot import Snapshot
from language_adapters import AnalysisSnapshot, active_adapters
from review_model import ReviewModel
from swift_adapter import SWIFT_ADAPTER


class SwiftAdapterTests(unittest.TestCase):
    def test_production_parser_preserves_swift_model_contract(self):
        before = {"A.swift": b"public actor Store { func read() -> Int { return 1 } }\n"}
        after = {"A.swift": before["A.swift"].replace(b"return 1", b"return 2")}
        snapshot = AnalysisSnapshot(Path("."), before, after, "a" * 40, True, False, "b" * 40)
        self.assertEqual([adapter.id for adapter in active_adapters(snapshot)], ["swift"])
        model = ReviewModel({"root": ".", "head": "b" * 40})
        saved = Snapshot(Path("."), None, before, after)
        model.changes = saved.changes()
        self.assertIn("baseline", saved.source_files(model.changes)["A.swift"])
        dependencies = SWIFT_ADAPTER.dependencies(snapshot, model.warnings)
        SWIFT_ADAPTER.scan(snapshot, model, dependencies, lambda *_: None)
        model.packages = dependencies
        result = model.to_dict()
        self.assertEqual(result["metadata"]["swift_loc"], 1)
        self.assertTrue(any(node["kind"] == "actor" for node in result["nodes"]))
        self.assertEqual(result["code_paths"]["swift"]["callables"][0]["entries"][0]["status"], "changed")
        self.assertEqual(model.source_files["A.swift"]["baseline"], before["A.swift"].decode())

    def coverage(self, *, edit=None, metadata_edit=None, report=None):
        files = {"Sources/Core.swift": b"func f() -> Int {\n return 1\n}\n", "Tests/CoreTests.swift": b"import XCTest\n",
                 "Package.swift": b"let package = Package(name: \"Demo\", targets: [])\n",
                 "Package.resolved": b'{"version":3,"pins":[]}'}
        raw = report if report is not None else b"SF:Sources/Core.swift\nDA:2,1\nend_of_record\n"
        metadata = {"revision": "b" * 40, "report": "lcov.info", "report_sha256": hashlib.sha256(raw).hexdigest(),
                    "source_hashes": {path: hashlib.sha256(data).hexdigest() for path, data in files.items()}}
        if edit:
            edit(files)
        if metadata_edit:
            metadata_edit(metadata)
        files.update({"lcov.info": raw, "swift-coverage.json": json.dumps(metadata).encode()})
        return SWIFT_ADAPTER.coverage(AnalysisSnapshot(Path("."), {}, files, "a" * 40, True, False, "b" * 40))

    def test_coverage_accepts_exact_snapshot_aggregate_evidence_only(self):
        report = self.coverage()
        self.assertTrue(report["available"])
        self.assertEqual(report["files"][0]["covered_lines"], [2])
        self.assertNotIn("tests", report)
        normalized = self.coverage(edit=lambda files: files.update({
            "Sources/Core.swift": b"\xef\xbb\xbf" + files["Sources/Core.swift"].replace(b"\n", b"\r\n")}))
        self.assertTrue(normalized["available"])

    def test_coverage_rejects_revision_report_source_test_and_manifest_mismatches(self):
        cases = [
            self.coverage(metadata_edit=lambda meta: meta.update(revision="c" * 40)),
            self.coverage(metadata_edit=lambda meta: meta.pop("report_sha256")),
            self.coverage(metadata_edit=lambda meta: meta.update(report_sha256="0" * 64)),
            self.coverage(metadata_edit=lambda meta: meta["source_hashes"].pop("Tests/CoreTests.swift")),
            self.coverage(edit=lambda files: files.update({"Sources/Added.swift": b"func added() {}"})),
        ]
        for path in ("Sources/Core.swift", "Tests/CoreTests.swift", "Package.swift", "Package.resolved"):
            cases.append(self.coverage(edit=lambda files, path=path: files.update({path: files[path] + b" "})))
        for report in cases:
            with self.subTest(warnings=report["warnings"]):
                self.assertFalse(report["available"])
                self.assertEqual(report["files"], [])

    def test_coverage_rejects_absolute_paths_unknown_records_and_invalid_line_ranges(self):
        for raw in (b"SF:/other/Sources/Core.swift\nDA:2,1\nend_of_record\n",
                    b"SF:Unknown.swift\nDA:2,1\nend_of_record\n",
                    b"SF:Sources/Core.swift\nDA:0,1\nend_of_record\n",
                    b"SF:Sources/Core.swift\nDA:99,1\nend_of_record\n",
                    b"SF:Sources/Core.swift\nDA:2,-1\nend_of_record\n",
                    b"SF:Sources/Core.swift\nDA:2,1\n",
                    b"DA:2,1\nend_of_record\n"):
            with self.subTest(raw=raw):
                self.assertFalse(self.coverage(report=raw)["available"])


if __name__ == "__main__":
    unittest.main()
