from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ANALYZER = Path(__file__).parents[1] / "analyzer"
sys.path.insert(0, str(ANALYZER))
from decisions import build_decision_map

SOURCE = textwrap.dedent('''
    class Checker:
        def __init__(self):
            self.registry = load("ReportsChecker")

        def verify(self, ref):
            if not ref.title:
                return None
            if ref.legacy:
                raise ValueError("legacy")
            try:
                found = lookup(ref)
            except LookupError:
                found = None
            if found:
                return found
            return None

    def public(ref):
        return Checker().verify(ref)
''')


def evidence_by_line(result: dict, qualname: str) -> dict[int, dict]:
    item = next(item for item in result["callables"] if item["qualname"] == qualname)
    return {entry["decision"]["line"]: entry["evidence"] for entry in item["entries"]}


class VerificationLinkTests(unittest.TestCase):
    def request(self, tests: list[dict]) -> dict:
        return {"repo": ".", "base_sha": None, "known_classes": {"ReportsChecker": ["pkg.reports"]}, "known_modules": [],
                "files": [{"path": "pkg/checker.py", "current": SOURCE, "callables": [
                    {"id": "verify", "qualname": "Checker.verify", "change": "added", "owner": "Checker", "module": "pkg.checker",
                     "callers": [{"name": "public", "owner": None, "module": "pkg.checker"}]},
                    {"id": "init", "qualname": "Checker.__init__", "change": "added", "owner": "Checker", "module": "pkg.checker", "callers": []},
                ]}], "tests": tests}

    def test_direct_assertions_raises_and_ambiguity_are_inferred_precisely(self) -> None:
        test = textwrap.dedent('''
            import pytest
            from pkg.checker import Checker

            def test_rejects_missing_title():
                assert Checker().verify(Ref(title="")) is None

            def test_legacy_raises():
                with pytest.raises(ValueError):
                    Checker().verify(Ref(title="x", legacy=True))

            def test_success():
                result = Checker().verify(Ref(title="x"))
                assert result is not None
        ''')
        result = build_decision_map(self.request([{"path": "tests/test_checker.py", "current": test, "added_lines": []}]))
        evidence = evidence_by_line(result, "Checker.verify")
        rejection = evidence[8]
        self.assertEqual(rejection["level"], "asserted")
        self.assertEqual(rejection["tests"][0]["id"], "tests/test_checker.py::test_rejects_missing_title")
        self.assertEqual(rejection["tests"][0]["assertion"]["text"], "Checker().verify(Ref(title='')) is None")
        self.assertEqual(rejection["tests"][0]["ambiguous"], 2, "one None check cannot distinguish the two no-result exits")
        raised = evidence[10]
        self.assertEqual((raised["level"], raised["tests"][0]["match"]), ("asserted", "raises"))
        self.assertEqual(raised["tests"][0]["id"], "tests/test_checker.py::test_legacy_raises")
        success = evidence[16]
        self.assertEqual(success["tests"][0]["assertion"]["text"], "result is not None")
        self.assertEqual(evidence[13]["level"], "exercised", "a swallowed error is not asserted unless a test injects it")
        self.assertEqual(result["verification"]["tests"][0]["link"], "direct")

    def test_negative_tests_do_not_assert_results_and_injected_errors_match_handlers(self) -> None:
        test = textwrap.dedent('''
            from unittest import mock
            from pkg.checker import Checker

            def test_missing():
                data = Checker().verify(Ref(title=""))
                assert data is None
                assert calls == []

            def test_lookup_failure():
                with mock.patch("pkg.checker.lookup", side_effect=LookupError):
                    Checker().verify(Ref(title="x"))
        ''')
        evidence = evidence_by_line(build_decision_map(self.request([{"path": "tests/test_checker.py", "current": test}])), "Checker.verify")
        self.assertNotIn("match", next(record for record in evidence[16]["tests"] if record["id"].endswith("test_missing")),
                         "a negative test's other checks do not demonstrate the success return")
        handler = next(record for record in evidence[13]["tests"] if record["id"].endswith("test_lookup_failure"))
        self.assertEqual((handler["match"], handler["assertion"]["text"]), ("error", "injects LookupError"))

    def test_callers_constructors_name_only_and_changed_tests(self) -> None:
        via = textwrap.dedent('''
            from pkg import checker

            class TestPublic:
                def test_public_path(self):
                    assert checker.public(Ref(title="x")) is not None

            def test_constructs():
                checker.Checker()
        ''')
        unrelated = "def test_other():\n    assert Other().verify(1) is None\n"
        result = build_decision_map(self.request([
            {"path": "tests/test_public.py", "current": via, "added_lines": [5, 6]},
            {"path": "tests/test_other.py", "current": unrelated},
        ]))
        evidence = evidence_by_line(result, "Checker.verify")
        record = evidence[8]["tests"][0]
        self.assertEqual((evidence[8]["level"], record["link"], record["via"]), ("reachable", "via", "public"))
        self.assertNotIn("match", record, "assertions through a caller are never attributed to one exit")
        self.assertTrue(record["changed"])
        self.assertEqual(record["id"], "tests/test_public.py::TestPublic::test_public_path")
        self.assertFalse(any(test["id"].endswith("test_other") for test in evidence[8]["tests"]),
                         "a weaker name-only match is hidden when stronger evidence exists")
        wiring = evidence_by_line(result, "Checker.__init__")[4]
        self.assertEqual((wiring["level"], wiring["tests"][0]["id"]), ("exercised", "tests/test_public.py::test_constructs"))
        index = {test["id"]: test for test in result["verification"]["tests"]}
        self.assertEqual(index["tests/test_other.py::test_other"]["link"], "name-only")
        self.assertFalse(index["tests/test_public.py::test_constructs"]["changed"])

    def test_untested_paths_and_removed_paths(self) -> None:
        result = build_decision_map(self.request([]))
        self.assertTrue(all(evidence["level"] == "none" for evidence in evidence_by_line(result, "Checker.verify").values()))
        self.assertEqual(result["verification"]["tests"], [])
        request = self.request([])
        request["files"][0]["callables"][0]["change"] = "removed"
        request["files"][0]["current"] = "class Checker:\n    pass\n"
        self.assertEqual(build_decision_map(request)["callables"], [], "no base and no current text means nothing to map")


class TraceRangeTests(unittest.TestCase):
    def test_proof_lines_exclude_lines_that_run_when_the_path_is_not_taken(self) -> None:
        sys.path.insert(0, str(ANALYZER))
        from decisions import DecisionCollector
        import ast as syntax
        tree = syntax.parse(textwrap.dedent('''
            def f(x):
                assert x > 0
                if x > 100: raise ValueError("big")
                if x == 5:
                    return (
                        "five"
                    )
                try:
                    g(x)
                except KeyError:
                    log("missing")
                    x = None
                return x
        '''))
        decisions = {decision["line"]: decision for decision in DecisionCollector(tree.body[0], {}).collect()}
        self.assertIsNone(decisions[3]["trace"], "an assert line runs whether or not it raises")
        self.assertIsNone(decisions[4]["trace"], "a one-line guard shares its line with the condition")
        self.assertEqual(decisions[6]["trace"], [6, 8], "a multi-line return is proved by its own lines")
        self.assertEqual(decisions[11]["trace"], [12, 13], "a handler is proved by its body, not the except line")
        one_line = syntax.parse("def g():\n    try:\n        h()\n    except KeyError: log('x')\n    return 1\n")
        handler = next(item for item in DecisionCollector(one_line.body[0], {}).collect() if item["outcome"] == "handled")
        self.assertIsNone(handler["trace"], "a one-line handler body shares the except line")


class AmbiguityAcrossUnchangedTests(unittest.TestCase):
    def test_ambiguity_counts_unchanged_exits_with_the_same_outcome(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            git = lambda *args: subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
            git("init", "-q")
            git("config", "user.email", "t@example.invalid")
            git("config", "user.name", "T")
            git("config", "core.autocrlf", "false")
            (repo / "find.py").write_text("def find(x):\n    if not x:\n        return None\n    return x\n")
            git("add", ".")
            git("commit", "-qm", "base")
            base = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
            current = "def find(x):\n    if not x:\n        return None\n    if x.deleted:\n        return None\n    return x\n"
            result = build_decision_map({"repo": str(repo), "base_sha": base, "known_classes": {}, "known_modules": [], "files": [
                {"path": "find.py", "current": current, "callables": [{"id": "f", "qualname": "find", "change": "modified", "module": "find", "callers": []}]}],
                "tests": [{"path": "tests/test_find.py", "current": "from find import find\n\ndef test_none():\n    assert find(None) is None\n"}]})
            [entry] = result["callables"][0]["entries"]
            self.assertEqual(entry["decision"]["line"], 5)
            self.assertEqual(entry["evidence"]["tests"][0]["ambiguous"], 2, "the unchanged `if not x` exit matches the same check")


class TracePluginTests(unittest.TestCase):
    def test_plugin_records_per_test_lines_for_target_files_only(self) -> None:
        try:
            import pytest  # noqa: F401
        except ImportError:
            self.skipTest("pytest is not installed")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "target.py").write_text("def choose(x):\n    if x:\n        return 'yes'\n    return 'no'\n")
            (root / "other.py").write_text("def helper():\n    return 1\n")
            (root / "test_target.py").write_text(
                "from target import choose\nfrom other import helper\n\n"
                "def test_yes():\n    assert choose(True) == 'yes'\n\n"
                "def test_no():\n    helper()\n    assert choose(False) == 'no'\n")
            output = root / "trace.json"
            env = {**os.environ, "PYTHONPATH": str(ANALYZER / "pytest_trace"), "PYTHONDONTWRITEBYTECODE": "1",
                   "AGENT_REVIEW_TRACE_FILES": json.dumps([str(root / "target.py")]), "AGENT_REVIEW_TRACE_OUTPUT": str(output)}
            completed = subprocess.run([sys.executable, "-m", "pytest", "-p", "agent_review_trace", "-p", "no:cacheprovider", "-q",
                                        "test_target.py"], cwd=root, env=env, capture_output=True, text=True, timeout=120)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            trace = json.loads(output.read_text())
            key = os.path.normcase(str((root / "target.py").resolve()))
            lines = {test.split("::")[-1]: record["lines"] for test, record in trace["tests"].items()}
            self.assertEqual(lines["test_yes"], {key: [2, 3]})
            self.assertEqual(lines["test_no"], {key: [2, 4]}, "only target files are traced; other.py is excluded")
            self.assertEqual({record["outcome"] for record in trace["tests"].values()}, {"passed"})
            self.assertFalse((root / "__pycache__").exists(), "the run does not write bytecode into the repository")


if __name__ == "__main__":
    unittest.main()
