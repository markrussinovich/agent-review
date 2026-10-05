from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
import python_graph
from python_graph import SymbolCollector, _parse_sets, analyze_python, parse_module
from review_model import ReviewModel, stable_id


def reference_parse_sets(before, after, model, on_progress=None):
    results = []
    for files in (before, after):
        modules = {}
        for path, data in sorted(files.items()):
            if path.endswith(".py"):
                module, warning = parse_module(path, data)
                if warning:
                    model.warnings.append(warning)
                elif module:
                    modules[module.name] = module
        results.append(modules)
    return tuple(results)


class GraphPerformanceTests(unittest.TestCase):
    def test_cached_source_segments_match_stdlib_for_every_ast_node(self) -> None:
        samples = [
            'class Example:\n    def run(self):\n        return "caf\u00e9"\n',
            'label = "\u00e9"; value = "\U0001f600"\n',
            'def run():\n    text = """line one\nline two\u2028line three\fline four\v"""\n    return text',
            'class Example:\n\f    def run(self):\n        return 1\n',
        ]
        for source in samples:
            for newline in ("\n", "\r\n", "\r"):
                text = source.replace("\n", newline)
                with self.subTest(source=source, newline=newline):
                    module, warning = parse_module("example.py", text.encode())
                    self.assertIsNone(warning)
                    collector = SymbolCollector(module)
                    for node in ast.walk(module.tree):
                        if hasattr(node, "lineno"):
                            expected = (ast.get_source_segment(text, node) or "").encode()
                            self.assertEqual(expected, collector._source_segment(node))

    def test_source_is_split_once_not_rescanned_for_every_symbol(self) -> None:
        source = b"".join(f"def function_{index}():\n    return {index}\n".encode() for index in range(100))
        with patch("python_graph.re.finditer", wraps=python_graph.re.finditer) as split:
            with patch("ast.get_source_segment", side_effect=AssertionError("must use cached lines")):
                module, warning = parse_module("example.py", source)
        self.assertIsNone(warning)
        self.assertEqual(100, len(module.symbols))
        self.assertEqual(1, split.call_count)

    def test_identical_files_parse_once_with_isolated_mutable_records(self) -> None:
        before = {
            "same.py": b"import target\nclass Owner:\n    def run(self):\n        return target.run()\n",
            "changed.py": b"def run():\n    return 1\n",
            "invalid.py": b"def invalid(\n",
        }
        after = {**before, "changed.py": b"def run():\n    return 2\n", "added.py": b"value = 1\n"}
        model = ReviewModel({})
        with patch("python_graph.parse_module", wraps=parse_module) as parse:
            baseline, current = _parse_sets(before, after, model)
        self.assertEqual(5, parse.call_count, "three baseline files, one modified, one added")
        self.assertEqual(2, len(model.warnings), "cached syntax errors still report both snapshots")
        self.assertIs(baseline["same"].tree, current["same"].tree)
        self.assertIsNot(baseline["same"].symbols[0], current["same"].symbols[0])
        self.assertIsNot(baseline["same"].imports[0], current["same"].imports[0])
        current["same"].symbols[0]["classification"] = "modified"
        current["same"].imports[0]["resolved_target"] = "different"
        self.assertNotIn("classification", baseline["same"].symbols[0])
        self.assertNotIn("resolved_target", baseline["same"].imports[0])

    def test_byte_differences_and_module_name_collisions_do_not_reuse_the_wrong_file(self) -> None:
        before = {"pkg.py": b"value = 1\n", "pkg/__init__.py": b"value = 2\n"}
        after = {"pkg.py": b"value = 1\r\n", "pkg/__init__.py": b"value = 2\n"}
        with patch("python_graph.parse_module", wraps=parse_module) as parse:
            baseline, current = _parse_sets(before, after, ReviewModel({}))
        self.assertEqual(3, parse.call_count)
        self.assertEqual("pkg/__init__.py", current["pkg"].path)
        self.assertEqual(baseline["pkg"].source_hash, current["pkg"].source_hash)

    def test_complete_graph_matches_uncached_parsing_and_stdlib_source_hashes(self) -> None:
        before = {
            "pkg/__init__.py": b"",
            "pkg/caller.py": b"from pkg import target\nimport requests\ndef run():\n    return target.execute()\n",
            "pkg/removed.py": b"class Removed:\n    def run(self):\n        return 1\n",
            "pkg/shared.py": "class Shared:\r\n    def run(self):\r\n        return 'caf\u00e9'\r\n".encode(),
        }
        after = {
            "pkg/__init__.py": b"",
            "pkg/caller.py": before["pkg/caller.py"],
            "pkg/target.py": b"def execute():\n    return 2\n",
            "pkg/shared.py": before["pkg/shared.py"],
        }
        expected = ReviewModel({})
        with patch("python_graph._parse_sets", side_effect=reference_parse_sets):
            with patch.object(SymbolCollector, "_source_segment", lambda self, node: (ast.get_source_segment(self.module.source, node) or "").encode()):
                analyze_python(before, after, expected, {"requests"}, set())
        actual = ReviewModel({})
        analyze_python(before, after, actual, {"requests"}, set())
        self.assertEqual(expected.to_dict(), actual.to_dict())

    def test_aggregate_index_preserves_first_symbol_and_unknown_targets(self) -> None:
        first, _ = parse_module("first.py", b"def run():\n    return 1\n")
        second, _ = parse_module("second.py", b"def run():\n    return 2\n")
        modules = {"first": first, "second": second}
        ids = {name: stable_id("module", name) for name in modules}
        model = ReviewModel({})
        model.symbols = [
            {"id": "shared-id", "module": "first"},
            {"id": "shared-id", "module": "second"},
        ]
        model.edges = [
            {"id": "edge", "kind": "calls", "source": "shared-id", "target": ids["second"], "change": "unchanged"},
            {"id": "unknown", "kind": "calls", "source": "missing", "target": ids["second"], "change": "unchanged"},
        ]
        python_graph._aggregates(model, {}, modules, {}, ids)
        self.assertEqual(1, len(model.aggregates["edges"]))
        self.assertEqual(ids["first"], model.aggregates["edges"][0]["source"])
        self.assertEqual(["edge"], model.aggregates["edges"][0]["underlying_edge_ids"])


if __name__ == "__main__":
    unittest.main()
