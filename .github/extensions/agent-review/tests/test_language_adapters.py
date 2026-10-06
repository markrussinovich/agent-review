from __future__ import annotations

import sys
import unittest
from pathlib import Path

ANALYZER = Path(__file__).parents[1] / "analyzer"
sys.path.insert(0, str(ANALYZER))
from language_adapters import AnalysisSnapshot, active_adapters, merge_coverage
from packages import declared_import_names, package_diff, parse_packages, resolve_declared_versions
from python_adapter import PYTHON_ADAPTER
from python_graph import analyze_python
from review_model import ReviewModel


class LanguageAdapterTests(unittest.TestCase):
    def snapshot(self, baseline, current, historical=True):
        return AnalysisSnapshot(Path("."), baseline, current, None, historical, False)

    def test_selects_source_and_manifest_changes_including_deleted_language(self):
        for baseline, current in (
            ({}, {"main.py": b"def run(): return 1"}),
            ({"deleted.py": b"def gone(): pass"}, {}),
            ({}, {"requirements-dev.txt": b"demo==1"}),
            ({}, {"pyproject.toml": b"[project]\ndependencies=[]"}),
        ):
            self.assertEqual(active_adapters(self.snapshot(baseline, current)), (PYTHON_ADAPTER,))
        self.assertEqual(active_adapters(self.snapshot({}, {"app.ts": b"export const x=1;", "app.cs": b"class X {}"})), ())

    def test_duplicate_adapter_ids_fail_explicitly(self):
        with self.assertRaisesRegex(ValueError, "unique IDs"):
            active_adapters(self.snapshot({}, {}), [PYTHON_ADAPTER, PYTHON_ADAPTER])

    def test_python_adapter_keeps_full_model_and_dependency_evidence_identical(self):
        before = {
            "pkg/base.py": b"class Base:\n    def value(self): return 1\n",
            "requirements.txt": b"demo==1.0\n",
            "pkg/client.py": b"from .base import Base\nimport demo\ndef run(): return Base().value()\n",
        }
        after = {**before, "pkg/base.py": b"class Base:\n    def value(self): return 2\n",
                 "pkg/new.py": b"from .base import Base\nclass Child(Base):\n    pass\n",
                 "requirements.txt": b"demo==2.0\n"}
        snapshot = self.snapshot(before, after)
        expected = ReviewModel({})
        baseline = parse_packages(before, expected.warnings)
        current = parse_packages(after, expected.warnings)
        resolve_declared_versions(baseline, expected.warnings)
        resolve_declared_versions(current, expected.warnings)
        expected.packages = {"baseline": baseline, "current": current, "changes": package_diff(baseline, current)}
        analyze_python(before, after, expected, declared_import_names(current), declared_import_names(baseline))
        actual = ReviewModel({})
        actual.packages = PYTHON_ADAPTER.dependencies(snapshot, actual.warnings)
        events = []
        PYTHON_ADAPTER.scan(snapshot, actual, actual.packages, lambda message, percent: events.append((message, percent)))
        self.assertEqual(expected.to_dict(), actual.to_dict())
        self.assertTrue(events)

    def test_graph_contribution_does_not_rewrite_another_adapters_symbols(self):
        model = ReviewModel({})
        sentinel = {"id": "foreign", "change": "unchanged"}
        model.edges.append(sentinel)
        snapshot = self.snapshot({}, {"main.py": b"def run(): return 1\n"})
        dependencies = PYTHON_ADAPTER.dependencies(snapshot, model.warnings)
        PYTHON_ADAPTER.scan(snapshot, model, dependencies, lambda *_: None)
        self.assertEqual(model.edges[0], sentinel)
        self.assertNotIn("classification", sentinel)

    def test_coverage_merges_per_language_and_rejects_overlapping_paths(self):
        first = {"available": True, "source": "coverage.json", "files": [{"path": "main.py"}], "changed_lines": {"main.py": {"covered": 1}}}
        second = {"available": True, "source": "lcov.info", "files": [{"path": "app.ts"}], "changed_lines": {"app.ts": {"covered": 2}}}
        self.assertIs(merge_coverage([first]), first, "single-language report retains the established DTO")
        merged = merge_coverage([first, second])
        self.assertEqual([file["path"] for file in merged["files"]], ["app.ts", "main.py"])
        self.assertEqual(merged["sources"], ["coverage.json", "lcov.info"])
        with self.assertRaisesRegex(ValueError, "Multiple coverage adapters claimed main.py"):
            merge_coverage([first, first])
        self.assertEqual(merge_coverage([]), {"available": False, "files": [], "changed_lines": {}})
        self.assertEqual(PYTHON_ADAPTER.coverage(self.snapshot({}, {"main.py": b"x=1"})),
                         {"available": False, "files": [], "changed_lines": {}})


if __name__ == "__main__":
    unittest.main()
