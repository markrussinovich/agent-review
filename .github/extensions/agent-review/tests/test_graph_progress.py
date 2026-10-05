from __future__ import annotations

import itertools
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from python_graph import analyze_python
from review_model import ReviewModel


class GraphProgressTests(unittest.TestCase):
    def test_progress_reports_files_relationships_and_syntax_nodes_without_changing_results(self) -> None:
        files = {
            "pkg/core.py": b"def run():\n    return 1\n" + b"run()\n" * 300,
            "pkg/invalid.py": b"def invalid(\n",
            "notes.txt": b"not Python",
        }
        expected = ReviewModel({})
        analyze_python(files, files, expected, set())
        actual = ReviewModel({})
        updates: list[tuple[str, int]] = []
        with patch("python_graph.time.monotonic", side_effect=itertools.count()):
            analyze_python(files, files, actual, set(), on_progress=lambda message, percent: updates.append((message, percent)))
        self.assertEqual(expected.to_dict(), actual.to_dict())
        messages = [message for message, _ in updates]
        self.assertTrue(any("Parsing baseline Python files: 1 of 2" in message for message in messages))
        self.assertTrue(any("Reusing current Python files: 2 of 2" in message for message in messages))
        self.assertTrue(any("Resolving current calls and imports: module 1 of 1" in message for message in messages))
        self.assertTrue(any("Resolving baseline calls and imports: module 1 of 1" in message for message in messages))
        self.assertTrue(any("syntax nodes processed" in message for message in messages))
        self.assertTrue(any("Comparing 300 current and 300 baseline relationships" in message for message in messages))
        self.assertFalse(any("notes.txt" in message for message in messages))
        percentages = [percent for _, percent in updates]
        self.assertEqual(sorted(percentages), percentages)
        self.assertEqual(67, percentages[-1])

    def test_empty_graph_has_valid_progress(self) -> None:
        updates: list[tuple[str, int]] = []
        analyze_python({}, {}, ReviewModel({}), set(), on_progress=lambda message, percent: updates.append((message, percent)))
        self.assertTrue(updates)
        self.assertTrue(all(42 <= percent <= 67 for _, percent in updates))


if __name__ == "__main__":
    unittest.main()
