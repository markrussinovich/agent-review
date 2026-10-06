"""Static links from changed behavioral decisions to the tests that reach them.

Everything here is inferred from source: a test "reaches" a changed function when
it calls it (or one of its production callers), and an assertion "matches" a
decision when its kind fits the decision's outcome. Only an explicit test run
can confirm which decision a test actually executes.
"""
from __future__ import annotations

import ast
import re
from typing import Any

MAX_TESTS = 200
MAX_TESTS_PER_DECISION = 5
LEVELS = ["none", "possible", "reachable", "exercised", "asserted"]
NONE_CHECK = re.compile(
    r"\bis None\b|== None\b|assertIsNone|\bis False\b|assertFalse|== False\b|\(None, \[\], None\)|"
    r"assertEqual\([^,]+, None\)")
ASSERT_CALL = re.compile(r"^(?:self\.)?assert[A-Z_]\w*$|^assert_\w+$")
RAISES_CALL = {"raises", "assertRaises", "assertRaisesRegex", "assertRaisesRegexp"}


def short(text: str, limit: int = 120) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else f"{text[:limit - 1]}…"


def last_name(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Call):
        return last_name(node.func)
    return None


class TestFacts:
    def __init__(self, node: ast.FunctionDef | ast.AsyncFunctionDef, test_id: str, path: str,
                 added_lines: set[int] | None = None) -> None:
        self.id = test_id
        self.path = path
        self.name = node.name
        self.line = node.lineno
        end = getattr(node, "end_lineno", node.lineno) or node.lineno
        self.changed = bool(added_lines) and any(line in added_lines for line in range(node.lineno, end + 1))
        self.calls: set[str] = set()
        self.assertions: list[dict[str, Any]] = []
        self.raises: dict[str, dict[str, Any]] = {}
        self.injected: set[str] = set()
        for child in ast.walk(node):
            if isinstance(child, ast.Call):
                name = last_name(child.func)
                if name:
                    self.calls.add(name)
                if name in RAISES_CALL and child.args:
                    for exception in self.exception_names(child.args[0]):
                        self.raises.setdefault(exception, {"line": child.lineno, "text": short(ast.unparse(child)), "kind": "raises"})
                elif name and ASSERT_CALL.match(name):
                    self.assertions.append({"line": child.lineno, "text": short(ast.unparse(child)), "kind": "assert"})
                for keyword in child.keywords:
                    if keyword.arg == "side_effect":
                        self.injected.update(self.exception_names(keyword.value))
            elif isinstance(child, ast.Assert):
                self.assertions.append({"line": child.lineno, "text": short(ast.unparse(child.test)), "kind": "assert"})
            elif isinstance(child, ast.Raise) and child.exc is not None:
                self.injected.update(self.exception_names(child.exc))
            elif isinstance(child, ast.Assign) and any(isinstance(target, ast.Attribute) and target.attr == "side_effect"
                                                       for target in child.targets):
                self.injected.update(self.exception_names(child.value))

    @staticmethod
    def exception_names(node: ast.AST) -> set[str]:
        nodes = node.elts if isinstance(node, (ast.Tuple, ast.List)) else [node]
        return {name for item in nodes if (name := last_name(item)) and name[:1].isupper()}

    def none_assertion(self) -> dict[str, Any] | None:
        return next((item for item in self.assertions if NONE_CHECK.search(item["text"])), None)

    def value_assertion(self) -> dict[str, Any] | None:
        explicit = next((item for item in self.assertions
                         if re.search(r"\bis not None\b|assertIsNotNone|assertTrue", item["text"])), None)
        if explicit or self.none_assertion():
            # A test that checks for no result is a negative test; its other checks don't show a returned value.
            return explicit
        return next((item for item in self.assertions if not NONE_CHECK.search(item["text"])), None)


def file_facts(path: str, tree: ast.Module, added_lines: set[int] | None = None) -> tuple[list[TestFacts], set[str], set[str]]:
    tests: list[TestFacts] = []
    imported: set[str] = set()
    identifiers: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.update(alias.asname or alias.name for alias in node.names)
            if node.module:
                identifiers.update(node.module.split("."))
        elif isinstance(node, ast.Import):
            for alias in node.names:
                identifiers.update(alias.name.split("."))
                imported.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.Name):
            identifiers.add(node.id)
        elif isinstance(node, ast.Attribute):
            identifiers.add(node.attr)

    def visit(nodes: list[ast.stmt], scope: list[str]) -> None:
        for node in nodes:
            if isinstance(node, ast.ClassDef) and (node.name.startswith("Test") or any(
                    last_name(base) in ("TestCase", "IsolatedAsyncioTestCase") for base in node.bases)):
                visit(node.body, [*scope, node.name])
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test"):
                tests.append(TestFacts(node, "::".join([path, *scope, node.name]), path, added_lines))

    visit(tree.body, [])
    return tests, imported, identifiers


def anchored(target: dict[str, Any], imported: set[str], identifiers: set[str]) -> bool:
    if target.get("owner"):
        return target["owner"] in identifiers
    module_tail = (target.get("module") or "").rsplit(".", 1)[-1]
    return target["name"] in imported or (bool(module_tail) and module_tail in identifiers)


def outcome_match(decision: dict[str, Any], test: TestFacts) -> tuple[str, dict[str, Any] | None] | None:
    outcome = decision["outcome"]
    if outcome == "raise":
        exception = re.match(r"[A-Za-z_][\w.]*", decision.get("value") or "")
        name = exception.group().rsplit(".", 1)[-1] if exception else None
        return ("raises", test.raises[name]) if name in test.raises else None
    if outcome in ("empty", "false"):
        assertion = test.none_assertion()
        return ("no-result", assertion) if assertion else None
    if outcome in ("value", "true"):
        assertion = test.value_assertion()
        return ("result", assertion) if assertion else None
    if outcome == "handled":
        error = (decision.get("on_error") or "").rsplit(".", 1)[-1]
        broad = error in ("Exception", "BaseException", "exception")
        if test.injected and (error in test.injected or broad):
            injected = error if error in test.injected else sorted(test.injected)[0]
            return ("error", {"line": test.line, "text": f"injects {injected}", "kind": "injects"})
    return None


def link_tests(request: dict[str, Any], results: list[dict[str, Any]], parse,
               all_current: dict[Any, list[dict[str, Any]]] | None = None) -> dict[str, Any]:
    """Annotate decision entries with static test evidence and return the linked-test index."""
    facts: list[tuple[TestFacts, set[str], set[str], bool]] = []
    for item in request.get("tests", []):
        tree = parse(item.get("current"), item["path"], [])
        if tree is None:
            continue
        tests, imported, identifiers = file_facts(item["path"], tree, set(item.get("added_lines") or ()))
        facts.extend((test, imported, identifiers, test.changed) for test in tests)
    targets = {target["id"]: target for file in request.get("files", []) for target in file.get("callables", [])}
    linked: dict[str, dict[str, Any]] = {}
    for result in results:
        target = targets.get(result["id"])
        if not target:
            continue
        name = result["qualname"].rsplit(".", 1)[-1]
        owner = target.get("owner")
        own = {"name": name, "owner": owner, "module": target.get("module")}
        links: list[tuple[TestFacts, str, str | None, bool]] = []
        for test, imported, identifiers, changed in facts:
            calls_own = name in test.calls or (name == "__init__" and owner in test.calls)
            if calls_own and anchored(own, imported, identifiers):
                links.append((test, "direct", None, changed))
                continue
            caller = next((caller for caller in target.get("callers", [])
                           if caller["name"] in test.calls and anchored(caller, imported, identifiers)), None)
            if caller:
                label = f"{caller['owner']}.{caller['name']}" if caller.get("owner") else caller["name"]
                links.append((test, "via", label, changed))
            elif calls_own:
                links.append((test, "name-only", None, changed))
        # Ambiguity counts every current exit, including unchanged ones the diff does not list.
        current_decisions = (all_current or {}).get(result["id"]) or [
            entry["decision"] for entry in result["entries"] if entry["status"] != "removed"]
        for entry in result["entries"]:
            if entry["status"] == "removed":
                entry["evidence"] = None
                continue
            decision = entry["decision"]
            records: list[tuple[str, dict[str, Any]]] = []
            for test, link, via, changed in links:
                # Assertions through a caller cannot be attributed to one exit; only direct calls can assert.
                match = outcome_match(decision, test) if link == "direct" else None
                level = ("asserted" if match else "exercised") if link == "direct" else "reachable" if link == "via" else "possible"
                record: dict[str, Any] = {"id": test.id, "path": test.path, "line": test.line, "link": link}
                if via:
                    record["via"] = via
                if changed:
                    record["changed"] = True
                if match:
                    category, assertion = match
                    record["match"] = category
                    record["assertion"] = assertion
                    same = sum(1 for other in current_decisions
                               if (other_match := outcome_match(other, test)) and other_match[1] == assertion)
                    if same > 1:
                        record["ambiguous"] = same
                records.append((level, record))
                summary = linked.setdefault(test.id, {"id": test.id, "path": test.path, "line": test.line, "name": test.name,
                                                      "link": link, "via": via, "changed": changed, "callables": set(),
                                                      "callable_ids": set(), "matches": 0})
                if LEVELS.index({"direct": "exercised", "via": "reachable"}.get(link, "possible")) > LEVELS.index(
                        {"direct": "exercised", "via": "reachable"}.get(summary["link"], "possible")):
                    summary.update(link=link, via=via)
                summary["callables"].add(result["qualname"])
                summary["callable_ids"].add(result["id"])
                if match:
                    summary["matches"] += 1
            level = max((item[0] for item in records), key=LEVELS.index, default="none")
            if level != "possible":
                records = [item for item in records if item[0] != "possible"]
            records.sort(key=lambda item: (-LEVELS.index(item[0]), not item[1].get("changed"), item[1]["id"]))
            entry["evidence"] = {"level": level, "tests": [record for _, record in records[:MAX_TESTS_PER_DECISION]],
                                 "omitted_tests": max(0, len(records) - MAX_TESTS_PER_DECISION)}
    order = {"direct": 0, "via": 1}
    index = sorted(linked.values(), key=lambda item: (order.get(item["link"], 2), not item["changed"], -item["matches"], item["id"]))
    for item in index:
        item["callables"] = sorted(item["callables"])
        item["callable_ids"] = sorted(str(value) for value in item["callable_ids"])
    return {"tests": index[:MAX_TESTS], "omitted_tests": max(0, len(index) - MAX_TESTS),
            "test_files_examined": len(request.get("tests", [])), "limited": bool(request.get("tests_limited"))}