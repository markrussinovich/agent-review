from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from cpp_adapter import CPP_ADAPTER
from language_adapters import AnalysisSnapshot, active_adapters
from review_model import ReviewModel


class CppAdapterTests(unittest.TestCase):
    def test_graph_decisions_and_snapshots_use_the_production_helper(self):
        baseline = {"limit.hpp": b"inline int limit(int n) { if(n>3) return 0; return n; }\n",
                    "app.cpp": b'#include "limit.hpp"\nint run(){return limit(4);}\n'}
        current = {**baseline, "limit.hpp": baseline["limit.hpp"].replace(b">3", b">5")}
        snapshot = AnalysisSnapshot(Path("."), baseline, current, "a" * 40, True, False, "b" * 40)
        self.assertEqual([adapter.id for adapter in active_adapters(snapshot)], ["cpp"])
        model = ReviewModel({"root": ".", "head": "b" * 40})
        model.changes = [{"path": path, "status": "modified" if baseline[path] != raw else "unchanged",
                          "lines_added": 1, "lines_removed": 1, "added_lines": [1], "removed_lines": [1],
                          "current_lines": len(raw.splitlines()), "baseline_lines": len(baseline[path].splitlines())}
                         for path, raw in current.items()]
        CPP_ADAPTER.scan(snapshot, model, {}, lambda *_: None)
        result = model.to_dict()
        self.assertEqual(model.source_files["limit.hpp"]["baseline"], baseline["limit.hpp"].decode())
        self.assertEqual(result["metadata"]["cpp_loc"], 3)
        self.assertGreater(result["summary"]["symbols_changed"], 0)
        self.assertTrue(any(edge["type"] == "calls" for edge in result["edges"]))
        self.assertEqual(result["code_paths"]["cpp"]["callables"][0]["language"], "cpp")

    def test_lcov_is_revision_and_source_matched_including_headers(self):
        source = b"inline int limit(int n) {\n return n;\n}\n"
        files = {"limit.hpp": source, "lcov.info": b"SF:limit.hpp\nDA:2,1\nend_of_record\n"}
        metadata = {"revision": "b" * 40, "report": "lcov.info",
                    "source_hashes": {"limit.hpp": hashlib.sha256(source).hexdigest()}}
        files["cpp-coverage.json"] = json.dumps(metadata).encode()
        snapshot = AnalysisSnapshot(Path("."), {}, files, "a" * 40, True, False, "b" * 40)
        report = CPP_ADAPTER.coverage(snapshot)
        self.assertTrue(report["available"])
        self.assertEqual(report["files"][0]["covered_lines"], [2])
        files["limit.hpp"] = b"\xef\xbb\xbf" + source.replace(b"\n", b"\r\n")
        self.assertTrue(CPP_ADAPTER.coverage(snapshot)["available"])
        files["limit.hpp"] += b"// stale\n"
        self.assertFalse(CPP_ADAPTER.coverage(snapshot)["available"])
        metadata["revision"] = "c" * 40
        files["cpp-coverage.json"] = json.dumps(metadata).encode()
        self.assertIn("revision", CPP_ADAPTER.coverage(snapshot)["warnings"][0])


if __name__ == "__main__":
    unittest.main()
