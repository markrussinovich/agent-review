from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "analyzer"))

from coverage_data import load_coverage
from git_snapshot import create_snapshot


class CoverageTests(unittest.TestCase):
    def test_standard_json_covers_untracked_changes_without_reviewing_report_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            def git(*args: str) -> str:
                return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()
            git("init", "-q")
            git("config", "user.name", "Test")
            git("config", "user.email", "test@example.invalid")
            (repo / "main.py").write_text("value = 1\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            (repo / "feature.py").write_text("first = 1\nsecond = 2\nthird = 3\n", encoding="utf-8")
            (repo / "coverage.json").write_text(json.dumps({
                "files": {"feature.py": {"executed_lines": [1, 2], "missing_lines": [3]}}
            }), encoding="utf-8")
            (repo / ".coverage").write_bytes(b"SQLite format 3\0")
            coverage = load_coverage(repo, base, ["feature.py"])
            self.assertTrue(coverage["available"])
            self.assertEqual("coverage.json", coverage["source"])
            self.assertEqual(3, coverage["changed_lines"]["feature.py"]["total"])
            self.assertEqual([3], coverage["changed_lines"]["feature.py"]["uncovered_lines"])
            snapshot = create_snapshot(repo, base, ())
            self.assertEqual(["feature.py"], [item["path"] for item in snapshot.changes() if item["status"] != "unchanged"])


if __name__ == "__main__":
    unittest.main()
