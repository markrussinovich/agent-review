from __future__ import annotations

import subprocess
import difflib
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "analyzer"))
from git_snapshot import Snapshot, baseline_files, current_files, create_snapshot, SELF_REPOSITORY_MARKERS


class SnapshotTests(unittest.TestCase):
    def test_self_source_policy_is_tracked_and_stable_for_saved_and_worktree_pairs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="arbitrary-fork-name-") as directory:
            repo = Path(directory)
            def git(*args: str) -> str:
                return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE).decode().strip()
            git("init", "-q")
            git("config", "user.name", "Test")
            git("config", "user.email", "test@example.invalid")
            git("config", "core.autocrlf", "false")
            source = ".github/extensions/agent-review/analyzer/source.py"
            for name in (*SELF_REPOSITORY_MARKERS, source):
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"value = 1\n")
            # Merely installing the complete layout without tracking it cannot opt in.
            self.assertNotIn(source, current_files(repo, ()))
            git("add", ".")
            git("commit", "-qm", "source checkout")
            base = git("rev-parse", "HEAD")
            (repo / source).write_bytes(b"value = 2\n")
            cache = repo / ".github/extensions/agent-review/node_modules/cache.py"
            cache.parent.mkdir()
            cache.write_text("do not collect\n")
            snapshot = create_snapshot(repo, base, ())
            self.assertEqual("modified", next(change["status"] for change in snapshot.changes() if change["path"] == source))
            self.assertNotIn(cache.relative_to(repo).as_posix(), snapshot.current)
            for marker in SELF_REPOSITORY_MARKERS[:-1]:
                git("rm", marker)
            git("mv", SELF_REPOSITORY_MARKERS[-1], ".github/extensions/agent-review/renamed-manifest.json")
            # Index-only detection would re-exclude all source after staged deletion.
            self.assertIn(source, current_files(repo, ()))
            self.assertIn(source, create_snapshot(repo, base, ()).baseline)
            git("add", source)
            git("commit", "-qm", "remove markers and modify source")
            head = git("rev-parse", "HEAD")
            saved = create_snapshot(repo, base, (), head)
            self.assertEqual(b"value = 1\n", saved.baseline[source])
            self.assertEqual(b"value = 2\n", saved.current[source])
            worktree = create_snapshot(repo, base, ())
            self.assertIn(source, worktree.current)
            explicit = create_snapshot(repo, base, (".github/extensions/agent-review",), head)
            self.assertNotIn(source, explicit.baseline)
            self.assertNotIn(source, explicit.current)
            self.assertEqual("user", explicit.excluded_changes[0]["reason"])
            self.assertEqual(3, explicit.excluded_changes[0]["count"])

    def test_foreign_tracked_install_stays_excluded_and_reports_changed_count(self) -> None:
        with tempfile.TemporaryDirectory(prefix="agent-review-") as directory:
            repo = Path(directory)
            def git(*args: str) -> str:
                return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE).decode().strip()
            git("init", "-q")
            git("config", "user.name", "Test")
            git("config", "user.email", "test@example.invalid")
            source = ".github/extensions/agent-review/source.py"
            (repo / source).parent.mkdir(parents=True)
            (repo / source).write_text("value = 1\n")
            (repo / SELF_REPOSITORY_MARKERS[-1]).write_text("{}")
            git("add", ".")
            git("commit", "-qm", "foreign tracked install")
            base = git("rev-parse", "HEAD")
            (repo / source).write_text("value = 2\n")
            (repo / ".github/extensions/agent-review/untracked.py").write_text("new\n")
            snapshot = create_snapshot(repo, base, ())
            self.assertEqual({}, snapshot.current)
            self.assertEqual(({"reason": "default", "pattern": ".github/extensions/agent-review", "count": 2},),
                             snapshot.excluded_changes)
            git("add", ".")
            git("commit", "-qm", "installed source edits")
            saved = create_snapshot(repo, base, (), git("rev-parse", "HEAD"))
            self.assertEqual({}, saved.baseline)
            self.assertEqual({}, saved.current)
            self.assertEqual(snapshot.excluded_changes, saved.excluded_changes)

    def test_large_repetitive_diff_uses_saved_bytes_and_preserves_late_change(self) -> None:
        lines = [b"// repeated context\n"] * 20000
        before = b"".join(lines) + b"-- old value\n"
        after = b"".join(lines) + b"++ new value\n"
        snapshot = Snapshot(Path("not-the-live-worktree"), "base",
                            {"large.js": before}, {"large.js": after})
        started = time.monotonic()
        changes = snapshot.changes()
        self.assertLess(time.monotonic() - started, 10, "large repetitive diffs must not use quadratic matching")
        self.assertEqual([20001], changes[0]["added_lines"])
        self.assertEqual([20001], changes[0]["removed_lines"])
        self.assertEqual(1, changes[0]["lines_added"])
        self.assertEqual(1, changes[0]["lines_removed"])
        with patch("git_snapshot.subprocess.run", side_effect=AssertionError("diff must be reused")):
            source = snapshot.source_files(changes)["large.js"]
        self.assertIn("@@ -19997,5 +19997,5 @@", source["diff"])
        self.assertIn("--- old value\n", source["diff"])
        self.assertIn("+++ new value\n", source["diff"])
        self.assertIn("--- a/large.js\n+++ b/large.js\n", source["diff"])

    def test_generated_bundles_stay_files_but_unchanged_text_is_sent_once_or_omitted(self) -> None:
        from generated_sources import generated_paths, is_generated_source
        bundle = b"!function(){" + b"var a=1;" * 1000 + b"}();\n"
        self.assertTrue(is_generated_source("static/assets/index-CO33IrX7.js", bundle), "a 8 KB single-line bundle")
        self.assertTrue(is_generated_source("assets/core-D8n9Wfto.js", b"import{a as e}from'./x.js';" + b"e(1);" * 300),
                        "a small one-line chunk is still minified output")
        self.assertTrue(is_generated_source("vendor/lib.min.js", b"x\n"))
        self.assertTrue(is_generated_source("app.js.map", b"{}"))
        self.assertFalse(is_generated_source("src/app.js", b"export function run() {\n  return 1;\n}\n"))
        self.assertFalse(is_generated_source("src/big.py", b"x = '" + b"a" * 9000 + b"'\n"), "only bundle languages")
        snapshot = Snapshot(Path("unused"), "base", {
            "src/app.ts": b"export const a = 1;\n", "assets/old-1a2b3c4d.js": bundle, "assets/kept-9z8y7x6w.js": bundle,
        }, {
            "src/app.ts": b"export const a = 1;\n", "assets/new-5e6f7g8h.js": bundle, "assets/kept-9z8y7x6w.js": bundle,
        })
        generated = generated_paths(snapshot.baseline, snapshot.current)
        self.assertEqual({"assets/old-1a2b3c4d.js", "assets/new-5e6f7g8h.js", "assets/kept-9z8y7x6w.js"}, generated)
        sources = snapshot.source_files(snapshot.changes(), generated)
        self.assertEqual({"generated": True, "omitted": True}, sources["assets/kept-9z8y7x6w.js"], "unchanged bundles carry no text")
        self.assertTrue(sources["assets/new-5e6f7g8h.js"]["generated"])
        self.assertIn("var a=1;", sources["assets/new-5e6f7g8h.js"]["current"], "a changed bundle stays reviewable")
        self.assertEqual({"current", "diff", "baseline_same"}, set(sources["src/app.ts"]), "unchanged text is not duplicated")

    def test_node_saved_sources_retain_both_trees_without_changing_python_only_shape(self) -> None:
        snapshot = Snapshot(Path("unused"), "base", {
            "main.ts": b"export function run() { return 1; }\n",
            "gone.js": b"export function gone() {}\n",
            "tsconfig.json": b'{"compilerOptions":{"strict":false}}',
        }, {
            "main.ts": b"export function run() { return 2; }\n",
            "new.tsx": b"export const view = () => <div />;\n",
            "tsconfig.json": b'{"compilerOptions":{"strict":true}}',
        })
        sources = snapshot.source_files(snapshot.changes())
        self.assertIn("return 1", sources["main.ts"]["baseline"])
        self.assertIn("return 2", sources["main.ts"]["current"])
        self.assertIsNone(sources["new.tsx"]["baseline"])
        self.assertIsNone(sources["gone.js"]["current"])
        self.assertIn("false", sources["tsconfig.json"]["baseline"])
        python = Snapshot(Path("unused"), "base", {"main.py": b"value=1\n"}, {"main.py": b"value=2\n"})
        self.assertEqual({"current", "diff"}, set(python.source_files(python.changes())["main.py"]))

    def test_batches_preserve_exact_blob_bytes_and_report_progress(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            def git(*args: str) -> bytes:
                return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE)
            git("init", "-q")
            git("config", "user.name", "Test")
            git("config", "user.email", "test@example.invalid")
            git("config", "core.autocrlf", "false")
            expected = {f"file {index}.py": f"value = {index}\r\n".encode() for index in range(105)}
            expected["binary.bin"] = b"\x00\xffblob\n123\x00\n"
            expected["empty.txt"] = b""
            expected["unicod\u00e9.txt"] = "caf\u00e9".encode()
            for name, content in expected.items():
                (repo / name).write_bytes(content)
            git("add", ".")
            git("commit", "-qm", "fixture")
            updates: list[str] = []
            real_run = subprocess.run
            with patch("git_snapshot.subprocess.run", wraps=real_run) as calls:
                actual = baseline_files(repo, "HEAD", (), updates.append)
            self.assertEqual(expected, actual)
            self.assertEqual(expected, current_files(repo, ()))
            self.assertEqual(2, sum("--batch" in call.args[0] for call in calls.call_args_list),
                             "two cat-file batches, not one process per file")
            self.assertTrue(any("of 108" in update for update in updates))
            self.assertIn("Snapshot complete", updates[-1])
            self.assertEqual({}, baseline_files(repo, None, ()))
            self.assertNotIn("binary.bin", baseline_files(repo, "HEAD", ("*.bin",)))

    def test_worktree_prunes_excluded_directories_before_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.check_call(["git", "-C", str(repo), "init", "-q"])
            (repo / "source.py").write_bytes(b"source\n")
            for folder in ("node_modules", ".venv", ".git", "nested/node_modules"):
                path = repo / folder
                path.mkdir(parents=True, exist_ok=True)
                (path / "excluded.py").write_bytes(b"excluded\n")
            visited: list[str] = []
            import os
            real_walk = os.walk
            def record_walk(path: Path):
                for entry in real_walk(path):
                    visited.append(Path(entry[0]).relative_to(repo).as_posix())
                    yield entry
            updates: list[str] = []
            with patch("git_snapshot.os.walk", side_effect=record_walk):
                self.assertEqual({"source.py": b"source\n"}, current_files(repo, (), updates.append))
            self.assertEqual([], visited, "Git enumerates files without walking excluded trees")
            self.assertIn("Working tree complete: 1 files", updates[-1])

    def test_batch_failures_are_explicit(self) -> None:
        repo = Path("unused")
        with patch("git_snapshot.run_git", return_value="100644 blob abc\tfile.py\0"):
            for output in (b"abc missing\n", b"abc blob 8\nshort", b"wrong blob 0\n\n"):
                with self.subTest(output=output):
                    with patch("git_snapshot.subprocess.run", return_value=subprocess.CompletedProcess([], 0, output, b"")):
                        with self.assertRaisesRegex(RuntimeError, "Git snapshot response"):
                            baseline_files(repo, "HEAD", ())
            with patch("git_snapshot.subprocess.run", return_value=subprocess.CompletedProcess([], 1, b"", b"repository error")):
                with self.assertRaisesRegex(RuntimeError, "repository error"):
                    baseline_files(repo, "HEAD", ())

    def test_worktree_parallel_reads_are_bounded_and_keep_content_associated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.check_call(["git", "-C", str(repo), "init", "-q"])
            expected = {f"file {index}.py": f"value = {index}\r\n".encode() for index in range(130)}
            for name, content in expected.items():
                (repo / name).write_bytes(content)
            lock = threading.Lock()
            active = 0
            maximum = 0

            def read_file(path: Path) -> bytes:
                nonlocal active, maximum
                with lock:
                    active += 1
                    maximum = max(maximum, active)
                try:
                    time.sleep(.005 if int(path.stem.split()[1]) % 2 else .01)
                    return path.read_bytes()
                finally:
                    with lock:
                        active -= 1

            with patch("git_snapshot._read_worktree_file", side_effect=read_file):
                actual = current_files(repo, ())
            self.assertEqual(expected, actual)
            self.assertGreater(maximum, 1, "working-tree reads should overlap")
            self.assertLessEqual(maximum, 8, "the reader pool must stay bounded")

    def test_disappearing_worktree_files_do_not_break_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.check_call(["git", "-C", str(repo), "init", "-q"])
            (repo / "removed.py").write_bytes(b"removed\n")
            (repo / "remaining.py").write_bytes(b"remaining\n")

            def read_file(path: Path) -> bytes | None:
                if path.name == "removed.py":
                    path.unlink()
                    return None
                return path.read_bytes()

            with patch("git_snapshot._read_worktree_file", side_effect=read_file):
                self.assertEqual({"remaining.py": b"remaining\n"}, current_files(repo, ()))

    def test_git_ignore_rules_skip_untracked_artifacts_but_preserve_tracked_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            def git(*args: str) -> None:
                subprocess.check_call(["git", "-C", str(repo), *args], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            git("init", "-q")
            (repo / "tracked.json").write_text("tracked")
            git("add", "tracked.json")
            (repo / ".gitignore").write_text("*.json\nbuild/\n!keep.json\n")
            (repo / "nested").mkdir()
            (repo / "nested" / ".gitignore").write_text("*.tmp\n!keep.tmp\n")
            (repo / ".git" / "info" / "exclude").write_text("local.txt\n")
            global_ignore = repo / ".git" / "global-ignore"
            global_ignore.write_text("global.txt\n")
            git("config", "core.excludesFile", str(global_ignore))
            files = {
                "tracked.json": "modified tracked file",
                "report.20261004.json": "ignored diagnostic",
                "keep.json": "negated ignore",
                "nested/ignored.tmp": "ignored nested file",
                "nested/keep.tmp": "negated nested ignore",
                "build/generated.py": "ignored directory",
                "local.txt": "local exclude",
                "global.txt": "global exclude",
                "unicod\u00e9 name.py": "valid source",
            }
            for path, content in files.items():
                target = repo / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            with patch("git_snapshot._read_worktree_file", wraps=lambda path: path.read_bytes()) as reader:
                actual = current_files(repo, ())
            self.assertEqual({".gitignore", "nested/.gitignore", "tracked.json", "keep.json",
                              "nested/keep.tmp", "unicod\u00e9 name.py"}, set(actual))
            self.assertEqual(b"modified tracked file", actual["tracked.json"])
            read_paths = {call.args[0].relative_to(repo).as_posix() for call in reader.call_args_list}
            self.assertEqual(set(actual), read_paths, "ignored contents are never opened")

    def test_fast_line_deltas_match_sequence_matcher_for_all_statuses(self) -> None:
        snapshot = Snapshot(Path("unused"), "HEAD", {
            "same.txt": b"same\nline\n",
            "newlines.txt": b"same\r\nline\r\n",
            "deleted.txt": b"gone\nagain\n",
            "modified.txt": b"one\nold\n",
            "empty.txt": b"",
            "binary.bin": b"\xff\n\x00",
        }, {
            "same.txt": b"same\nline\n",
            "newlines.txt": b"same\nline\n",
            "added.txt": b"new\nagain\n",
            "modified.txt": b"one\nnew\n",
            "empty.txt": b"",
            "binary.bin": b"\xff\n\x00",
        })
        with patch("git_snapshot.difflib.SequenceMatcher", wraps=difflib.SequenceMatcher) as matcher:
            records = snapshot.changes()
        self.assertEqual(1, matcher.call_count, "only modified files require line matching")
        for record in records:
            path = record["path"]
            before = snapshot.baseline.get(path)
            after = snapshot.current.get(path)
            old_lines = before.decode(errors="replace").splitlines() if before is not None else []
            new_lines = after.decode(errors="replace").splitlines() if after is not None else []
            added, removed = [], []
            for tag, start, end, new_start, new_end in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes():
                if tag in ("insert", "replace"):
                    added.extend(range(new_start + 1, new_end + 1))
                if tag in ("delete", "replace"):
                    removed.extend(range(start + 1, end + 1))
            self.assertEqual(added, record["added_lines"], path)
            self.assertEqual(removed, record["removed_lines"], path)
            self.assertEqual(len(added), record["lines_added"], path)
            self.assertEqual(len(removed), record["lines_removed"], path)
            self.assertEqual(len(old_lines), record["baseline_lines"], path)
            self.assertEqual(len(new_lines), record["current_lines"], path)

    def test_source_diffs_skip_unchanged_files_and_preserve_exact_text(self) -> None:
        snapshot = Snapshot(Path("unused"), "HEAD", {
            "same.py": b"value = 1\r\n",
            "modified.py": b"value = 1\n",
            "binary.bin": b"\xff",
        }, {
            "same.py": b"value = 1\n",
            "modified.py": b"value = 2\n",
            "binary.bin": b"\xff",
        })
        changes = snapshot.changes()
        with patch("git_snapshot.difflib.unified_diff", wraps=difflib.unified_diff) as diff:
            files = snapshot.source_files(changes)
        self.assertEqual(1, diff.call_count)
        self.assertEqual({"current": "value = 1\n", "diff": ""}, files["same.py"])
        self.assertEqual({"binary": True}, files["binary.bin"])
        expected = "".join(difflib.unified_diff(["value = 1\n"], ["value = 2\n"], fromfile="a/modified.py", tofile="b/modified.py", n=4))
        self.assertEqual(expected, files["modified.py"]["diff"])

    def test_complete_file_diffs_match_unified_diff_exactly(self) -> None:
        samples = ("", "\n", "one", "one\n", "one\r\ntwo\r\n", "caf\u00e9\n\u2028tail", "\ufeffone\n")
        for text in samples:
            for added in (False, True):
                with self.subTest(text=text, added=added):
                    before = b"" if added else text.encode()
                    after = text.encode() if added else b""
                    snapshot = Snapshot(Path("unused"), "HEAD", {"path name.txt": before}, {"path name.txt": after})
                    changes = snapshot.changes()
                    expected = "".join(difflib.unified_diff(
                        [f"{line}\n" for line in before.decode().splitlines()],
                        [f"{line}\n" for line in after.decode().splitlines()],
                        fromfile="a/path name.txt", tofile="b/path name.txt", n=4,
                    ))
                    with patch("git_snapshot.difflib.unified_diff", side_effect=AssertionError("no matching needed for an empty side")):
                        actual = snapshot.source_files(changes)
                    self.assertEqual(expected, actual["path name.txt"]["diff"])


if __name__ == "__main__":
    unittest.main()
