from __future__ import annotations

import ast
import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ANALYZER = Path(__file__).parents[1] / "analyzer"
sys.path.insert(0, str(ANALYZER))
from decisions import DecisionCollector, build_decision_map, diff_decisions, main

CHECKER = textwrap.dedent('''
    import requests

    class Checker:
        def verify(self, reference):
            title = reference.get("title")
            number = reference.get("number")
            year = reference.get("year")
            if not title or not number or not number.isdigit():
                return None, [], None
            try:
                response = self.session.get(self.url)
            except requests.RequestException as exc:
                return None, [], None
            for row in response.rows:
                if similarity(title, row.title) < 0.95:
                    continue
                if year and str(year) not in row.date:
                    continue
                if reference.get("authors") and row.authors:
                    if not authors_match(reference["authors"], row.authors):
                        continue
                return row.data, [], row.url
            return None, [], None
''')


def decisions_for(source: str, qualname: str, known: dict | None = None) -> list[dict]:
    tree = ast.parse(textwrap.dedent(source))
    stack: list[tuple[list[str], ast.AST]] = [([], tree)]
    while stack:
        scope, node = stack.pop()
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                name = ".".join([*scope, child.name])
                if name == qualname and not isinstance(child, ast.ClassDef):
                    return DecisionCollector(child, known or {}).collect()
                stack.append(([*scope, child.name], child))
    raise AssertionError(f"{qualname} not found")


class DecisionExtractionTests(unittest.TestCase):
    def test_rejections_gates_thresholds_handlers_and_success_are_explicit(self) -> None:
        decisions = decisions_for(CHECKER, "Checker.verify")
        rejection = decisions[0]
        self.assertEqual((rejection["outcome"], rejection["value"], rejection["when_mode"]), ("empty", "(None, [], None)", "any"))
        self.assertEqual(rejection["when"], ["not title", "not number", "not number.isdigit()"])
        self.assertEqual((decisions[1]["on_error"], decisions[1]["when"]), ("requests.RequestException", []))
        threshold = decisions[2]
        self.assertEqual((threshold["outcome"], threshold["value"], threshold["thresholds"]), ("skip", None, ["0.95"]))
        self.assertEqual(threshold["loop"], "for row in response.rows")
        year = decisions[3]
        self.assertEqual((year["when"], year["only_if"]), (["str(year) not in row.date"], ["year"]),
                         "a leading presence check is a conditional gate, not a mandatory requirement")
        authors = decisions[4]
        self.assertEqual(authors["when"], ["not authors_match(reference['authors'], row.authors)"])
        self.assertEqual(authors["only_if"], ["reference.get('authors') and row.authors"])
        success = decisions[5]
        self.assertEqual((success["outcome"], success["value"], success["when"]), ("value", "(row.data, [], row.url)", []))
        self.assertEqual(decisions[-1]["outcome"], "empty")

    def test_swallowed_errors_fall_through_and_else_branches_are_described(self) -> None:
        decisions = decisions_for('''
            def load(path, strict):
                try:
                    data = read(path)
                except OSError:
                    log.debug("failed")
                    data = None
                if data is None:
                    raise ValueError("missing")
                elif strict:
                    return parse(data)
                else:
                    pass
                if len(data) >= 10:
                    return data
        ''', "load")
        handled = decisions[0]
        self.assertEqual((handled["outcome"], handled["on_error"]), ("handled", "OSError"))
        self.assertIn("data = None", handled["value"])
        self.assertEqual((decisions[1]["outcome"], decisions[1]["when"]), ("raise", ["data is None"]))
        self.assertEqual((decisions[2]["when"], decisions[2]["context"]), (["strict"], ["data is not None"]))
        self.assertEqual(decisions[3]["thresholds"], ["10"])
        self.assertEqual((decisions[-1]["value"], decisions[-1]["implicit"]), ("None (falls through)", True))

    def test_name_based_wiring_resolves_known_classes_and_modules(self) -> None:
        decisions = decisions_for('''
            class Hybrid:
                def __init__(self):
                    self.reports = self._initialize("institutional_reports", "ReportsChecker", "reports")
                    self.ignored = self._initialize("Unknown", "label")
        ''', "Hybrid.__init__", {"classes": {"ReportsChecker": ["pkg.checkers.institutional_reports"]}, "modules": []})
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0]["value"], "ReportsChecker from pkg.checkers.institutional_reports")
        self.assertEqual(decisions[0]["via"], "self._initialize")

    def test_fall_through_only_when_the_function_can_actually_fall_through(self) -> None:
        shapes = {
            "if_else": "def f(x):\n    if x:\n        return 1\n    else:\n        return 2\n",
            "with": "def f(p):\n    with open(p) as handle:\n        return handle.read()\n",
            "try": "def f():\n    try:\n        return g()\n    except KeyError:\n        raise ValueError('x')\n",
            "while_true": "def f():\n    while True:\n        try:\n            return compute()\n        except KeyError:\n            raise ValueError('x')\n",
            "match": "def f(x):\n    match x:\n        case 1:\n            return 'one'\n        case _:\n            return 'other'\n",
        }
        for name, source in shapes.items():
            with self.subTest(name):
                self.assertFalse(any(decision["implicit"] for decision in decisions_for(source, "f")))
        for name, source in {
            "if_without_else": "def f(x):\n    if x:\n        return 1\n    log(x)\n",
            "while_with_break": "def f():\n    while True:\n        if done():\n            break\n        return 1\n",
            "refutable_match": "def f(x):\n    match x:\n        case 1:\n            return 'one'\n",
        }.items():
            with self.subTest(name):
                self.assertTrue(decisions_for(source, "f")[-1]["implicit"])

    def test_decisions_follow_source_order_including_nested_blocks_and_wiring(self) -> None:
        known = {"classes": {name: ["pkg.mod"] for name in ("Alpha", "Beta", "Gamma", "Delta")}, "modules": []}
        base = "def f(reg, x):\n    if x:\n        reg.add('Beta')\n        reg.add('Gamma')\n    reg.add('Alpha')\n    reg.flush()\n"
        current = "def f(reg, x):\n    if x:\n        reg.add('Beta')\n        reg.add('Delta')\n        reg.add('Gamma')\n    reg.add('Alpha')\n    if x < 0:\n        raise ValueError(x)\n    reg.flush()\n"
        lines = [decision["line"] for decision in decisions_for(current, "f", known)]
        self.assertEqual(lines, sorted(lines))
        entries = diff_decisions(decisions_for(base, "f", known), decisions_for(current, "f", known))
        delta = next(entry for entry in entries if entry["decision"].get("value") == "Delta")
        self.assertIn("Beta", delta["after"]["label"])
        self.assertIn("Gamma", delta["before"]["label"])
        raised = next(entry for entry in entries if entry["decision"]["outcome"] == "raise")
        self.assertIn("Alpha", raised["after"]["label"])
        self.assertNotIn("before", raised)
        self.assertFalse(any(entry["status"] == "moved" for entry in entries))

    def test_nested_functions_and_lambdas_are_separate_callables(self) -> None:
        decisions = decisions_for('''
            def outer(items):
                def inner(value):
                    return None
                key = lambda value: value or None
                return sorted(items, key=key)
        ''', "outer")
        self.assertEqual([decision["value"] for decision in decisions], ["sorted(items, key=key)"])


class DecisionDiffTests(unittest.TestCase):
    BASE = '''
        def resolve(ref):
            if not ref.title:
                return None
            if ref.complete:
                return primary(ref)
            if ref.partial:
                return ref.partial
            if official(ref):
                return official(ref)
            return None
    '''

    def test_inserted_fallback_reports_preempting_earlier_exit_and_next_step(self) -> None:
        current = self.BASE.replace("            if official(ref):", "            if reports(ref):\n                return reports(ref)\n            if official(ref):")
        entries = diff_decisions(decisions_for(self.BASE, "resolve"), decisions_for(current, "resolve"))
        self.assertEqual([entry["status"] for entry in entries], ["added"])
        added = entries[0]
        self.assertEqual(added["decision"]["when"], ["reports(ref)"])
        self.assertIn("ref.partial", added["after"]["label"])
        self.assertIn("official(ref)", added["before"]["label"])

    def test_threshold_change_is_changed_not_added_and_removed(self) -> None:
        base = "def match(score):\n    if score < 0.9:\n        return False\n    return True\n"
        entries = diff_decisions(decisions_for(base, "match"), decisions_for(base.replace("0.9", "0.95"), "match"))
        self.assertEqual(len(entries), 1)
        self.assertEqual((entries[0]["status"], entries[0]["base"]["thresholds"], entries[0]["decision"]["thresholds"]),
                         ("changed", ["0.9"], ["0.95"]))
        self.assertIn("when", entries[0]["changed_fields"])

    def test_reordering_and_unchanged_decisions(self) -> None:
        base = decisions_for(self.BASE, "resolve")
        self.assertEqual(diff_decisions(base, decisions_for(self.BASE, "resolve")), [],
                         "identical decision structure produces no changes")
        swapped = self.BASE.replace(
            "            if ref.complete:\n                return primary(ref)\n            if ref.partial:\n                return ref.partial\n",
            "            if ref.partial:\n                return ref.partial\n            if ref.complete:\n                return primary(ref)\n")
        entries = diff_decisions(base, decisions_for(swapped, "resolve"))
        self.assertEqual([entry["status"] for entry in entries], ["moved"])

    def test_removed_condition_is_reported(self) -> None:
        current = self.BASE.replace("            if not ref.title:\n                return None\n", "")
        entries = diff_decisions(decisions_for(self.BASE, "resolve"), decisions_for(current, "resolve"))
        self.assertEqual([(entry["status"], entry["decision"]["when"]) for entry in entries], [("removed", ["not ref.title"])])


class DecisionMapTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name)
        git = lambda *args: subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)
        git("init", "-q")
        git("config", "user.email", "test@example.invalid")
        git("config", "user.name", "Test")
        git("config", "core.autocrlf", "false")
        (self.repo / "pkg").mkdir()
        (self.repo / "pkg" / "service.py").write_text(textwrap.dedent(DecisionDiffTests.BASE) + "\ndef gone(x):\n    return x\n")
        (self.repo / "pkg" / "spaced name.py").write_text("def f(a):\n    return a\n")
        git("add", ".")
        git("commit", "-qm", "base")
        self.base = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], check=True,
                                   capture_output=True, text=True).stdout.strip()

    def request(self, current: str) -> dict:
        return {"repo": str(self.repo), "base_sha": self.base, "files": [
            {"path": "pkg/service.py", "current": current, "callables": [
                {"id": "s1", "qualname": "resolve", "change": "modified"},
                {"id": "s2", "qualname": "gone", "change": "removed"},
                {"id": "s3", "qualname": "added", "change": "added"},
            ]},
            {"path": "pkg/spaced name.py", "current": "def f(a):\n    if a:\n        return a\n    return None\n",
             "callables": [{"id": "s4", "qualname": "f", "change": "modified"}]},
            {"path": "pkg/new.py", "current": "def broken(:\n", "callables": [{"id": "s5", "qualname": "broken", "change": "added"}]},
            {"path": "pkg/my tool.py", "current": "def tool(x):\n    if x:\n        return x\n    return None\n",
             "callables": [{"id": "s6", "qualname": "tool", "change": "added"}]},
            {"path": "pkg/bom.py", "current": "\ufeffdef marked(x):\n    if x:\n        raise ValueError(x)\n",
             "callables": [{"id": "s7", "qualname": "marked", "change": "added"}]},
        ], "known_classes": {}, "known_modules": []}

    def test_reads_base_through_git_and_classifies_callables(self) -> None:
        current = textwrap.dedent(DecisionDiffTests.BASE).replace("ref.partial:", "ref.partial and ref.year:") + "\ndef added(v):\n    if v < 0:\n        raise ValueError(v)\n    return v\n"
        result = build_decision_map(self.request(current))
        by_id = {item["id"]: item for item in result["callables"]}
        self.assertEqual(by_id["s1"]["counts"]["changed"], 1)
        changed = by_id["s1"]["entries"][0]
        self.assertEqual((changed["decision"]["only_if"], changed["decision"]["when"]), (["ref.partial"], ["ref.year"]))
        self.assertEqual(by_id["s2"]["counts"]["removed"], 1)
        self.assertEqual(by_id["s2"]["line"], None)
        self.assertEqual(by_id["s3"]["counts"]["added"], 2)
        self.assertEqual(by_id["s4"]["counts"]["added"], 1, "paths with spaces are read from the base snapshot")
        self.assertNotIn("s5", by_id)
        self.assertTrue(any("pkg/new.py: cannot parse" in warning for warning in result["warnings"]))
        self.assertEqual(by_id["s6"]["counts"]["added"], 2, "a missing base path containing a space is an added file")
        self.assertEqual(by_id["s7"]["counts"]["added"], 1, "a UTF-8 byte-order mark does not hide decisions")
        self.assertEqual(result["totals"]["callables"], 6)

    def test_total_entries_are_bounded_and_marked_partial(self) -> None:
        import decisions
        previous = decisions.MAX_TOTAL_ENTRIES
        decisions.MAX_TOTAL_ENTRIES = 3
        self.addCleanup(setattr, decisions, "MAX_TOTAL_ENTRIES", previous)
        request = self.request(textwrap.dedent(DecisionDiffTests.BASE))
        request["base_sha"] = None
        result = build_decision_map(request)
        shown = sum(len(item["entries"]) for item in result["callables"])
        self.assertEqual(shown, 3)
        self.assertTrue(result["limited"])
        self.assertEqual(sum(item["omitted_entries"] for item in result["callables"]) + shown,
                         sum(item["decisions_current"] for item in result["callables"]))
        self.assertNotIn("shown", result["totals"])

    def test_cli_round_trip_and_root_commit_without_base(self) -> None:
        request = self.request(textwrap.dedent(DecisionDiffTests.BASE))
        request["base_sha"] = None
        request["files"][1]["current"] = "def f(a):\n    if a == '" + "café " * 60 + "':\n        return a\n    return None\n"
        path = self.repo / "request.json"
        path.write_text(json.dumps(request), encoding="utf-8")
        from io import StringIO
        from contextlib import redirect_stdout
        output = StringIO()
        with redirect_stdout(output):
            self.assertEqual(main(["--input", str(path)]), 0)
        self.assertTrue(output.getvalue().isascii(), "JSON survives any console code page")
        result = json.loads(output.getvalue())
        condition = next(item for item in result["callables"] if item["id"] == "s4")["entries"][0]["decision"]["when"][0]
        self.assertTrue(condition.startswith("a == 'café") and condition.endswith("…"))
        resolve = next(item for item in result["callables"] if item["id"] == "s1")
        self.assertEqual(resolve["counts"]["added"], resolve["decisions_current"], "no base means every decision is added")


if __name__ == "__main__":
    unittest.main()
