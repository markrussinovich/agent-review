from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

ANALYZER = Path(__file__).parents[1] / "analyzer"
sys.path.insert(0, str(ANALYZER))
from file_cache import FileScanCache
from python_graph import analyze_python, parse_module
from review_model import ReviewModel


class FileCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def graph(self, before, after, namespace="repo:parser", declared=None):
        model = ReviewModel({})
        with FileScanCache(self.directory, namespace, on_warning=model.warnings.append) as cache:
            analyze_python(before, after, model, declared or set(), set(), cache=cache)
            counts = (cache.hits, cache.misses)
        return model.to_dict(), counts

    def test_warm_graph_is_identical_and_does_not_parse_again(self) -> None:
        before = {
            "pkg/base.py": b"class Base:\n    def run(self):\n        return 1\n",
            "pkg/caller.py": b"from .base import Base\nclass Child(Base):\n    def run(self):\n        return super().run()\n",
            "pkg/invalid.py": b"def broken(\n",
            "pkg/bytes.py": b"\xff",
        }
        after = {**before, "pkg/new.py": b"from .caller import Child\n\ndef use():\n    return Child().run()\n"}
        expected = ReviewModel({})
        analyze_python(before, after, expected, set(), set())
        cold, counts = self.graph(before, after)
        self.assertEqual((0, 5), counts)
        self.assertEqual(expected.to_dict(), cold)
        with patch("python_graph.parse_module", side_effect=AssertionError("cached files must not be parsed")):
            warm, counts = self.graph(before, after)
        self.assertEqual((5, 0), counts)
        self.assertEqual(cold, warm)

    def test_changes_recompute_relationships_and_package_usage_without_rescanning_callers(self) -> None:
        caller = b"from pkg.target import execute\nimport yaml\n\ndef run():\n    return execute()\n"
        before = {"pkg/caller.py": caller, "pkg/target.py": b"def execute():\n    return 1\n"}
        self.graph(before, before, declared={"yaml"})
        after = {**before, "pkg/target.py": b"def renamed():\n    return 2\n"}
        with patch("python_graph.parse_module", wraps=parse_module) as parse:
            actual, counts = self.graph(before, after)
        self.assertEqual((2, 1), counts)
        self.assertEqual(["pkg/target.py"], [call.args[0] for call in parse.call_args_list])
        expected = ReviewModel({})
        analyze_python(before, after, expected, set(), set())
        self.assertEqual(expected.to_dict(), actual)
        self.assertTrue(any(edge["type"] == "calls" and edge["change"] == "removed" for edge in actual["edges"]))
        self.assertFalse(any(edge["type"] == "uses_package" for edge in actual["edges"]))

    def test_path_repository_parser_and_byte_changes_invalidate(self) -> None:
        original = {"original.py": b"class Example:\n    field: str\n    def run(self):\n        return 'caf\xc3\xa9'\n"}
        self.graph({}, original)
        variants = [
            ("repo:parser", {"renamed.py": original["original.py"]}),
            ("other-repo:parser", original),
            ("repo:changed-parser", original),
            ("repo:parser", {"original.py": original["original.py"].replace(b"\n", b"\r\n")}),
            ("repo:parser", {"original.py": b"\xef\xbb\xbf" + original["original.py"]}),
        ]
        for namespace, files in variants:
            with self.subTest(namespace=namespace, files=list(files)):
                with patch("python_graph.parse_module", wraps=parse_module) as parse:
                    actual, counts = self.graph({}, files, namespace)
                self.assertEqual((0, 1), counts)
                self.assertEqual(1, parse.call_count)
                expected = ReviewModel({})
                analyze_python({}, files, expected, set(), set())
                self.assertEqual(expected.to_dict(), actual)

    def test_checksum_and_valid_json_with_invalid_schema_are_discarded_explicitly(self) -> None:
        files = {"main.py": b"def run():\n    return 1\n"}
        expected, _ = self.graph({}, files)
        database = self.directory / "file-scans.sqlite3"
        for payload, digest in [(b"broken", "wrong"), (b'{"path":"incorrect"}', None)]:
            with self.subTest(payload=payload):
                with closing(sqlite3.connect(database)) as connection:
                    with connection:
                        connection.execute("UPDATE scans SET payload=?, digest=?, size=?",
                                           (payload, digest or hashlib.sha256(payload).hexdigest(), len(payload)))
                with patch("python_graph.parse_module", wraps=parse_module) as parse:
                    actual, counts = self.graph({}, files)
                self.assertEqual(1, parse.call_count)
                self.assertEqual((0, 1), counts)
                self.assertTrue(any("Discarded invalid" in warning for warning in actual["warnings"]))
                actual["warnings"] = expected["warnings"]
                self.assertEqual(expected, actual)
                self.assertEqual(expected, self.graph({}, files)[0], "fresh replacement repairs the entry")

    def test_lru_payload_entry_and_count_bounds(self) -> None:
        with FileScanCache(self.directory, "scope", max_bytes=160, max_entry_bytes=100) as cache:
            for path in ("a", "b"):
                cache.put(path, b"data", {"value": "x" * 60})
                cache.flush()
            self.assertIsNotNone(cache.get("a", b"data"))
            cache.flush()
            cache.put("c", b"data", {"value": "x" * 60})
            cache.flush()
            self.assertIsNone(cache.get("b", b"data"), "least recently used entry is evicted")
            self.assertIsNotNone(cache.get("a", b"data"))
            self.assertIsNotNone(cache.get("c", b"data"))
            cache.put("large", b"data", {"value": "x" * 200})
            self.assertEqual(1, cache.skipped)
            self.assertIsNone(cache.get("large", b"data"))
            size, count = cache.connection.execute("SELECT SUM(size), COUNT(*) FROM scans").fetchone()
            self.assertLessEqual(size, 160)
            self.assertEqual(2, count)
            self.assertEqual(1, cache.connection.execute("PRAGMA auto_vacuum").fetchone()[0])
        with FileScanCache(self.directory, "another-scope", max_bytes=10000, max_entries=1) as cache:
            cache.put("d", b"data", {"value": "new"})
            cache.flush()
            self.assertEqual(1, cache.connection.execute("SELECT COUNT(*) FROM scans").fetchone()[0])

    def test_pending_reads_are_fresh_and_do_not_share_mutable_records(self) -> None:
        with FileScanCache(self.directory, "scope") as cache:
            cache.put("a", b"data", {"symbols": [{"name": "original"}]})
            first = cache.get("a", b"data")
            first["symbols"][0]["name"] = "mutated"
            self.assertEqual("original", cache.get("a", b"data")["symbols"][0]["name"])

    def test_unavailable_cache_warns_and_scans_fresh(self) -> None:
        bad = self.directory / "not-a-directory"
        bad.write_text("owned fixture")
        model = ReviewModel({})
        with FileScanCache(bad, "scope", on_warning=model.warnings.append) as cache:
            analyze_python({}, {"main.py": b"value = 1\n"}, model, set(), cache=cache)
        self.assertTrue(any("cache unavailable" in warning for warning in model.warnings))
        self.assertTrue(model.aggregates["modules"])

    def test_concurrent_processes_keep_entries_and_budgets(self) -> None:
        script = (
            "import sys; from pathlib import Path; "
            f"sys.path.insert(0, {str(ANALYZER)!r}); from file_cache import FileScanCache\n"
            "with FileScanCache(Path(sys.argv[1]), 'scope') as cache:\n"
            "    for i in range(50): cache.put(sys.argv[2] + str(i), b'data', {'value': i})\n"
        )
        children = [subprocess.Popen([sys.executable, "-c", script, str(self.directory), name],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE) for name in ("first", "second")]
        for child in children:
            stdout, stderr = child.communicate(timeout=30)
            self.assertEqual(0, child.returncode, (stdout, stderr))
            self.assertEqual(b"", stderr)
        with closing(sqlite3.connect(self.directory / "file-scans.sqlite3")) as connection:
            self.assertEqual(100, connection.execute("SELECT COUNT(*) FROM scans").fetchone()[0])

    def test_cli_reuses_cache_between_commit_worktree_and_linked_worktree(self) -> None:
        repo = self.directory / "repo"
        repo.mkdir()
        def git(*args):
            return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.STDOUT).decode().strip()
        git("init", "-q")
        git("config", "user.name", "Test")
        git("config", "user.email", "test@example.invalid")
        git("config", "core.autocrlf", "false")
        git("config", "core.eol", "lf")
        (repo / "main.py").write_bytes(b"def run():\n    return 1\n")
        git("add", ".")
        git("commit", "-qm", "base")
        base = git("rev-parse", "HEAD")
        (repo / "main.py").write_bytes(b"def run():\n    return 2\n")
        git("commit", "-qam", "feature")
        cache_dir = self.directory / "cache"
        env = {**os.environ, "AGENT_REVIEW_CACHE_DIR": str(cache_dir)}
        def analyze(path, *args):
            result = subprocess.run([sys.executable, str(ANALYZER / "analyze.py"), "--repo", str(path),
                                     "--base-ref", base, *args], capture_output=True, env=env, check=True)
            return json.loads(result.stdout), result.stderr.decode()
        cold, progress = analyze(repo, "--current-ref", "HEAD")
        self.assertIn("0 reused, 2 scanned", progress)
        warm, progress = analyze(repo, "--current-ref", "HEAD")
        self.assertEqual(cold, warm)
        self.assertIn("2 reused, 0 scanned", progress)
        fresh, _ = analyze(repo, "--current-ref", "HEAD", "--no-cache")
        self.assertEqual(warm, fresh)
        worktree, progress = analyze(repo)
        self.assertIn("2 reused, 0 scanned", progress)
        self.assertEqual(worktree, analyze(repo, "--no-cache")[0])
        linked = self.directory / "linked"
        git("worktree", "add", "-q", "--detach", str(linked), "HEAD")
        try:
            _, progress = analyze(linked)
            self.assertIn("2 reused, 0 scanned", progress)
        finally:
            git("worktree", "remove", "--force", str(linked))


if __name__ == "__main__":
    unittest.main()
