"""Deterministic behavioral decision maps for changed Python callables.

Runs after analysis on saved snapshot text, outside the repository scan, so it
never adds work to scanning or the file cache. For each changed function it
extracts exits, error handling, and name-based wiring with their governing
conditions, then compares baseline and current decisions.
"""
from __future__ import annotations

import argparse
import ast
import difflib
import json
import re
import subprocess
import sys
import time
from collections import defaultdict, deque
from typing import Any

MAX_TEXT = 160
MAX_DECISIONS_PER_CALLABLE = 300
MAX_ENTRIES_PER_CALLABLE = 60
MAX_TOTAL_ENTRIES = 2000
MAX_CALLABLES = 400
MAX_SOURCE_BYTES = 6 * 1024 * 1024
TIME_BUDGET_SECONDS = 20.0
EMPTY_CALLS = {"list", "dict", "set", "tuple", "frozenset"}
INVERSE_OPS = {
    ast.Eq: ast.NotEq, ast.NotEq: ast.Eq, ast.Lt: ast.GtE, ast.GtE: ast.Lt, ast.Gt: ast.LtE,
    ast.LtE: ast.Gt, ast.Is: ast.IsNot, ast.IsNot: ast.Is, ast.In: ast.NotIn, ast.NotIn: ast.In,
}
VERBS = {
    "empty": "returns no result", "false": "returns False", "true": "returns True", "value": "returns",
    "raise": "raises", "reraise": "re-raises", "skip": "skips", "stop": "stops loop",
    "handled": "handles error and continues", "wired": "wires by name",
}


def shorten(text: str, limit: int = MAX_TEXT) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else f"{text[:limit - 1]}…"


def unparse(node: ast.AST) -> str:
    return shorten(ast.unparse(node))


def is_presence(node: ast.AST) -> bool:
    """A positive truthiness check that only gates on a value being present."""
    if isinstance(node, (ast.Name, ast.Attribute, ast.Subscript)):
        return True
    if isinstance(node, ast.Call):
        func = node.func
        return (isinstance(func, ast.Name) and func.id in {"getattr", "hasattr"}) or (
            isinstance(func, ast.Attribute) and func.attr == "get")
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.IsNot):
        return isinstance(node.comparators[0], ast.Constant) and node.comparators[0].value is None
    if isinstance(node, ast.BoolOp) and isinstance(node.op, ast.And):
        return all(is_presence(value) for value in node.values)
    return False


def negate(node: ast.AST) -> ast.AST:
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return node.operand
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in INVERSE_OPS:
        return ast.Compare(node.left, [INVERSE_OPS[type(node.ops[0])]()], node.comparators)
    if isinstance(node, ast.BoolOp):
        return ast.BoolOp(ast.Or() if isinstance(node.op, ast.And) else ast.And(), [negate(value) for value in node.values])
    return ast.UnaryOp(ast.Not(), node)


def thresholds(node: ast.AST | None) -> list[str]:
    found: list[str] = []
    for child in ast.walk(node) if node is not None else ():
        if isinstance(child, ast.Compare) and any(isinstance(op, (ast.Lt, ast.LtE, ast.Gt, ast.GtE)) for op in child.ops):
            for operand in [child.left, *child.comparators]:
                value = operand.operand if isinstance(operand, ast.UnaryOp) and isinstance(operand.op, ast.USub) else operand
                if isinstance(value, ast.Constant) and isinstance(value.value, (int, float)) and not isinstance(value.value, bool):
                    text = ast.unparse(operand)
                    if text not in found:
                        found.append(text)
    return found


def is_empty_value(node: ast.AST | None) -> bool:
    if node is None:
        return True
    if isinstance(node, ast.Constant):
        return node.value is None or node.value == ""
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return all(is_empty_value(element) for element in node.elts)
    if isinstance(node, ast.Dict):
        return not node.keys
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in EMPTY_CALLS and not node.args


def classify_return(node: ast.Return) -> tuple[str, str | None]:
    value = node.value
    if isinstance(value, ast.Constant) and value.value is False:
        return "false", "False"
    if isinstance(value, ast.Constant) and value.value is True:
        return "true", "True"
    if is_empty_value(value):
        return "empty", unparse(value) if value is not None else "None"
    return "value", unparse(value)


def terminates(statements: list[ast.stmt]) -> bool:
    """Whether a block always leaves the function (return/raise) rather than falling through."""
    return any(statement_terminates(statement) for statement in statements)


def statement_terminates(node: ast.stmt) -> bool:
    if isinstance(node, (ast.Return, ast.Raise)):
        return True
    if isinstance(node, ast.If):
        return bool(node.orelse) and terminates(node.body) and terminates(node.orelse)
    if isinstance(node, (ast.With, ast.AsyncWith)):
        return terminates(node.body)
    if isinstance(node, (ast.Try, getattr(ast, "TryStar", ast.Try))):
        if terminates(node.finalbody):
            return True
        return terminates(node.body + node.orelse) and all(terminates(handler.body) for handler in node.handlers)
    if isinstance(node, ast.While):
        constant = isinstance(node.test, ast.Constant) and bool(node.test.value)
        return constant and not any(isinstance(child, ast.Break) for child in loop_body_nodes(node.body))
    if isinstance(node, ast.Match) and node.cases:
        last = node.cases[-1]
        irrefutable = last.guard is None and (
            (isinstance(last.pattern, ast.MatchAs) and last.pattern.pattern is None))
        return irrefutable and all(terminates(case.body) for case in node.cases)
    return False


def loop_body_nodes(statements: list[ast.stmt]):
    """Nodes in a loop body, excluding nested loops and definitions whose break targets differ."""
    stack: list[ast.AST] = list(statements)
    while stack:
        node = stack.pop()
        yield node
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, (ast.For, ast.AsyncFor, ast.While, ast.FunctionDef, ast.AsyncFunctionDef,
                                      ast.ClassDef, ast.Lambda)):
                stack.append(child)


class Frame:
    __slots__ = ("kind", "test", "label")

    def __init__(self, kind: str, test: ast.AST | None = None, label: str | None = None) -> None:
        self.kind = kind
        self.test = test
        self.label = label


class DecisionCollector:
    def __init__(self, function: ast.FunctionDef | ast.AsyncFunctionDef, known: dict[str, Any]) -> None:
        self.function = function
        self.known_classes: dict[str, list[str]] = known.get("classes", {})
        self.known_modules: set[str] = set(known.get("modules", ()))
        self.decisions: list[dict[str, Any]] = []
        self.loops = 0
        self.truncated = False

    def collect(self) -> list[dict[str, Any]]:
        self.block(self.function.body, [])
        body = self.function.body
        returns_value = any(isinstance(node, ast.Return) and node.value is not None for node in self.walk(body))
        yields = any(isinstance(node, (ast.Yield, ast.YieldFrom)) for node in self.walk(body))
        if returns_value and not yields and body and not terminates(body):
            self.add("exit", "empty", "None (falls through)", [], body[-1], end=True)
        self.wiring()
        # Order and neighbor labels must follow source position, not traversal order.
        self.decisions.sort(key=lambda decision: (decision["line"], decision["column"]))
        return self.decisions

    def walk(self, statements: list[ast.stmt]):
        stack: list[ast.AST] = list(reversed(statements))
        while stack:
            node = stack.pop()
            yield node
            children = [child for child in ast.iter_child_nodes(node)
                        if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda))]
            stack.extend(reversed(children))

    def block(self, statements: list[ast.stmt], frames: list[Frame]) -> None:
        for statement in statements:
            self.statement(statement, frames)

    def statement(self, node: ast.stmt, frames: list[Frame]) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return
        if isinstance(node, ast.If):
            self.block(node.body, [*frames, Frame("if", node.test)])
            if node.orelse:
                self.block(node.orelse, [*frames, Frame("else", node.test)])
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            label = f"for {ast.unparse(node.target)} in {ast.unparse(node.iter)}"
            self.loops += 1
            self.block(node.body, [*frames, Frame("loop", label=shorten(label, 100))])
            self.loops -= 1
            if node.orelse:
                self.block(node.orelse, [*frames, Frame("loop-else", label="loop finished without break")])
        elif isinstance(node, ast.While):
            self.loops += 1
            self.block(node.body, [*frames, Frame("loop", node.test, shorten(f"while {ast.unparse(node.test)}", 100))])
            self.loops -= 1
            if node.orelse:
                self.block(node.orelse, [*frames, Frame("loop-else", label="loop finished without break")])
        elif isinstance(node, (ast.Try, getattr(ast, "TryStar", ast.Try))):
            self.block(node.body, frames)
            for handler in node.handlers:
                caught = unparse(handler.type) if handler.type is not None else "any exception"
                handler_frames = [*frames, Frame("except", label=caught)]
                self.block(handler.body, handler_frames)
                if not any(isinstance(item, (ast.Return, ast.Raise, ast.Continue, ast.Break))
                           for item in self.walk(handler.body)):
                    summary = "; ".join(shorten(ast.unparse(item), 80) for item in handler.body[:2]
                                        if not isinstance(item, ast.Pass)) or "pass"
                    self.add("handler", "handled", summary, handler_frames, handler)
            if node.orelse:
                self.block(node.orelse, [*frames, Frame("try-else", label="no exception raised")])
            self.block(node.finalbody, frames)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            self.block(node.body, frames)
        elif isinstance(node, ast.Match):
            for case in node.cases:
                pattern = ast.unparse(case.pattern) + (f" if {ast.unparse(case.guard)}" if case.guard else "")
                self.block(case.body, [*frames, Frame("case", label=shorten(f"case {pattern}", 100))])
        elif isinstance(node, ast.Return):
            outcome, value = classify_return(node)
            self.add("exit", outcome, value, frames, node)
        elif isinstance(node, ast.Raise):
            if node.exc is None:
                self.add("exit", "reraise", None, frames, node)
            else:
                self.add("exit", "raise", unparse(node.exc), frames, node)
        elif isinstance(node, ast.Assert):
            self.add("exit", "raise", "AssertionError", [*frames, Frame("else", node.test)], node)
        elif isinstance(node, (ast.Continue, ast.Break)) and self.loops:
            self.add("exit", "skip" if isinstance(node, ast.Continue) else "stop", None, frames, node)

    def add(self, kind: str, outcome: str, value: str | None, frames: list[Frame], node: ast.AST, end: bool = False) -> None:
        if len(self.decisions) >= MAX_DECISIONS_PER_CALLABLE:
            self.truncated = True
            return
        decisive_index = next((index for index in range(len(frames) - 1, -1, -1)
                               if frames[index].kind in ("if", "else")), None)
        boundary = max((index for index, frame in enumerate(frames) if frame.kind in ("loop", "except", "case")), default=-1)
        if decisive_index is not None and decisive_index < boundary:
            decisive_index = None
        when: list[str] = []
        mode = "none"
        only_if: list[str] = []
        context: list[str] = []
        threshold_nodes: list[ast.AST] = []
        if decisive_index is not None:
            frame = frames[decisive_index]
            test = frame.test if frame.kind == "if" else negate(frame.test)
            threshold_nodes.append(test)
            if isinstance(test, ast.BoolOp) and isinstance(test.op, ast.And):
                values = list(test.values)
                while len(values) > 1 and is_presence(values[0]):
                    only_if.append(unparse(values.pop(0)))
                when = [unparse(value) for value in values]
                mode = "all" if len(values) > 1 else "one"
            elif isinstance(test, ast.BoolOp):
                when = [unparse(value) for value in test.values]
                mode = "any"
            else:
                when = [unparse(test)]
                mode = "one"
        loop = None
        on_error = None
        case = None
        for index, frame in enumerate(frames):
            if index == decisive_index:
                continue
            if frame.kind in ("if", "else"):
                test = frame.test if frame.kind == "if" else negate(frame.test)
                threshold_nodes.append(test)
                (only_if if frame.kind == "if" and is_presence(frame.test) else context).append(unparse(test))
            elif frame.kind == "loop":
                loop = frame.label
            elif frame.kind == "except":
                on_error = frame.label
            elif frame.kind == "case":
                case = frame.label
            else:
                context.append(frame.label)
        found_thresholds: list[str] = []
        for test in threshold_nodes:
            for threshold in thresholds(test):
                if threshold not in found_thresholds:
                    found_thresholds.append(threshold)
        line = getattr(node, "end_lineno", node.lineno) if end else node.lineno
        self.decisions.append({
            "kind": kind, "outcome": outcome, "value": value, "when": when, "when_mode": mode,
            "only_if": only_if, "context": context + ([case] if case else []), "loop": loop,
            "on_error": on_error, "thresholds": found_thresholds,
            "line": line, "end_line": getattr(node, "end_lineno", line) or line,
            "column": 10**6 if end else node.col_offset,
            "implicit": end,
        })

    def wiring(self) -> None:
        for node in self.walk(self.function.body):
            if not isinstance(node, ast.Call):
                continue
            strings = [argument.value for argument in [*node.args, *(keyword.value for keyword in node.keywords)]
                       if isinstance(argument, ast.Constant) and isinstance(argument.value, str)]
            via = shorten(ast.unparse(node.func), 80)
            for text in strings:
                if text in self.known_classes:
                    modules = self.known_classes[text]
                    module = next((candidate for candidate in modules
                                   if candidate.rsplit(".", 1)[-1] in strings or candidate in strings), None)
                    value = f"{text} from {module}" if module else text
                    self.add("wiring", "wired", value, [], node)
                    self.decisions[-1]["via"] = via
                elif text in self.known_modules:
                    self.add("wiring", "wired", text, [], node)
                    self.decisions[-1]["via"] = via


def decision_key(decision: dict[str, Any], skeleton: bool = False) -> str:
    fields = [decision["kind"], decision["outcome"], decision.get("value"), decision["when"], decision["only_if"],
              decision["context"], decision.get("loop"), decision.get("on_error")]
    text = json.dumps(fields, ensure_ascii=False)
    if skeleton:
        text = re.sub(r"(?<![\w.])-?\d+(?:\.\d+)?(?:e-?\d+)?", "#", text)
        text = re.sub(r"'[^'\\]*'", "'…'", text)
    return text


def describe(decision: dict[str, Any]) -> str:
    if decision["outcome"] == "handled":
        text = f"handles `{shorten(decision.get('on_error') or 'error', 40)}` and continues"
    else:
        text = VERBS.get(decision["outcome"], decision["outcome"])
        if decision["outcome"] in ("value", "raise", "wired") and decision.get("value"):
            text += f" `{shorten(decision['value'], 60)}`"
        if decision.get("on_error"):
            text = f"on `{shorten(decision['on_error'], 40)}` {text}"
    if decision["when"]:
        joiner = " or " if decision["when_mode"] == "any" else " and "
        text += f" when `{shorten(joiner.join(decision['when']), 70)}`"
    return text


def longest_increasing(values: list[int]) -> set[int]:
    """Indexes (into values) of one longest strictly increasing subsequence."""
    tails: list[int] = []
    previous = [-1] * len(values)
    for index, value in enumerate(values):
        low, high = 0, len(tails)
        while low < high:
            middle = (low + high) // 2
            if values[tails[middle]] < value:
                low = middle + 1
            else:
                high = middle
        previous[index] = tails[low - 1] if low else -1
        if low == len(tails):
            tails.append(index)
        else:
            tails[low] = index
    result: set[int] = set()
    index = tails[-1] if tails else -1
    while index >= 0:
        result.add(index)
        index = previous[index]
    return result


def diff_decisions(base: list[dict[str, Any]], current: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pairs: list[tuple[int, int, str]] = []
    remaining_current = list(range(len(current)))
    remaining_base = set(range(len(base)))
    for skeleton, status in ((False, "same"), (True, "changed")):
        pending: dict[str, deque[int]] = defaultdict(deque)
        for index in sorted(remaining_base):
            pending[decision_key(base[index], skeleton)].append(index)
        unmatched = []
        for index in remaining_current:
            queue = pending.get(decision_key(current[index], skeleton))
            if queue:
                base_index = queue.popleft()
                remaining_base.discard(base_index)
                pairs.append((base_index, index, status))
            else:
                unmatched.append(index)
        remaining_current = unmatched
    unmatched = []
    for index in remaining_current:
        candidate = current[index]
        best, best_ratio = None, 0.0
        for base_index in sorted(remaining_base):
            previous = base[base_index]
            if (previous["kind"], previous["outcome"]) != (candidate["kind"], candidate["outcome"]):
                continue
            ratio = difflib.SequenceMatcher(None, decision_key(previous), decision_key(candidate)).ratio()
            if ratio > best_ratio:
                best, best_ratio = base_index, ratio
        if best is not None and best_ratio >= 0.72:
            remaining_base.discard(best)
            pairs.append((best, index, "changed"))
        else:
            unmatched.append(index)
    pairs.sort(key=lambda pair: pair[1])
    stable = longest_increasing([pair[0] for pair in pairs])
    matched_current = {pair[1]: (position, pair) for position, pair in enumerate(pairs)}
    entries: list[dict[str, Any]] = []
    for position, (base_index, current_index, status) in enumerate(pairs):
        moved = position not in stable
        if status == "same" and not moved:
            continue
        entry = {"status": "moved" if status == "same" else "changed", "decision": current[current_index]}
        if status == "changed":
            entry["base"] = base[base_index]
            entry["changed_fields"] = [name for name in ("value", "when", "only_if", "context", "loop", "on_error", "thresholds")
                                       if base[base_index].get(name) != current[current_index].get(name)]
        if moved:
            entry["moved"] = True
        entries.append(entry)
    ordered_current = sorted(matched_current)
    for index in unmatched:
        before = next((value for value in reversed(ordered_current) if value < index), None)
        after = next((value for value in ordered_current if value > index), None)
        entry: dict[str, Any] = {"status": "added", "decision": current[index]}
        if before is not None:
            entry["after"] = {"line": current[before]["line"], "label": describe(current[before])}
        if after is not None:
            entry["before"] = {"line": current[after]["line"], "label": describe(current[after])}
        entries.append(entry)
    for index in sorted(remaining_base):
        entries.append({"status": "removed", "decision": base[index]})
    entries.sort(key=lambda entry: (entry["decision"]["line"] if entry["status"] != "removed" else -1,
                                    entry["decision"]["line"]))
    return entries


def callables(tree: ast.Module) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    result: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}

    def visit(nodes: list[ast.stmt], scope: list[str]) -> None:
        for node in nodes:
            if isinstance(node, ast.ClassDef):
                visit(node.body, [*scope, node.name])
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qualname = ".".join([*scope, node.name])
                result[qualname] = node
                visit(node.body, [*scope, node.name])
            else:
                for field in ("body", "orelse", "finalbody", "handlers"):
                    children = getattr(node, field, None)
                    if isinstance(children, list):
                        visit([child for child in children if isinstance(child, ast.stmt)]
                              + [item for child in children if isinstance(child, ast.ExceptHandler) for item in child.body],
                              scope)

    visit(tree.body, [])
    return result


def read_base_files(repo: str, base_sha: str | None, paths: list[str]) -> dict[str, str | None]:
    if not base_sha or not paths:
        return {path: None for path in paths}
    request = "".join(f"{base_sha}:{path}\n" for path in paths).encode("utf-8")
    # A fixed header format keeps paths (which may contain spaces) out of size parsing.
    output = subprocess.run(["git", "-C", repo, "cat-file", "--batch=%(objectname) %(objecttype) %(objectsize)"],
                            input=request, capture_output=True, check=True).stdout
    result: dict[str, str | None] = {}
    offset = 0
    for path in paths:
        newline = output.index(b"\n", offset)
        line = output[offset:newline]
        offset = newline + 1
        header = line.split()
        if line.endswith(b" missing") or len(header) != 3 or not header[2].isdigit():
            result[path] = None
            continue
        size = int(header[2])
        content = output[offset:offset + size]
        offset += size + 1
        if header[1] != b"blob":
            result[path] = None
            continue
        try:
            result[path] = content.decode("utf-8")
        except UnicodeDecodeError:
            result[path] = None
    return result


def parse(text: str | None, label: str, warnings: list[str]) -> ast.Module | None:
    if text is None:
        return None
    try:
        return ast.parse(text.removeprefix("\ufeff"))
    except (SyntaxError, ValueError) as error:
        warnings.append(f"{label}: cannot parse ({error.__class__.__name__}); decisions unavailable.")
        return None


def extract(function: ast.FunctionDef | ast.AsyncFunctionDef | None, known: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    if function is None:
        return [], False
    collector = DecisionCollector(function, known)
    return collector.collect(), collector.truncated


def build_decision_map(request: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    warnings: list[str] = []
    files = request.get("files", [])
    known = {"classes": request.get("known_classes", {}), "modules": request.get("known_modules", [])}
    limited = False
    budget = MAX_SOURCE_BYTES
    selected = []
    callable_count = 0
    for item in files:
        size = len((item.get("current") or "").encode("utf-8"))
        if callable_count >= MAX_CALLABLES or size > budget:
            limited = True
            continue
        budget -= size
        callable_count += len(item.get("callables", []))
        selected.append(item)
    base_files = read_base_files(request.get("repo") or ".", request.get("base_sha"), [item["path"] for item in selected])
    results: list[dict[str, Any]] = []
    totals = defaultdict(int)
    for item in selected:
        if time.perf_counter() - started > TIME_BUDGET_SECONDS:
            limited = True
            warnings.append("Decision extraction stopped at its time budget; remaining files were skipped.")
            break
        path = item["path"]
        base_tree = parse(base_files.get(path), f"{path} (base)", warnings)
        current_tree = parse(item.get("current"), path, warnings)
        base_callables = callables(base_tree) if base_tree else {}
        current_callables = callables(current_tree) if current_tree else {}
        for target in item.get("callables", [])[:MAX_CALLABLES]:
            qualname = target["qualname"]
            base_function = base_callables.get(qualname)
            current_function = current_callables.get(qualname)
            base_decisions, base_truncated = extract(base_function, known)
            current_decisions, current_truncated = extract(current_function, known)
            if current_function is None and base_function is None:
                continue
            if base_function is None:
                entries = [{"status": "added", "decision": decision} for decision in current_decisions]
            elif current_function is None:
                entries = [{"status": "removed", "decision": decision} for decision in base_decisions]
            else:
                entries = diff_decisions(base_decisions, current_decisions)
            counts = {status: sum(1 for entry in entries if entry["status"] == status)
                      for status in ("added", "removed", "changed", "moved")}
            for status, count in counts.items():
                totals[status] += count
            totals["callables"] += 1
            if any(counts.values()):
                totals["callables_changed"] += 1
            allowed = min(MAX_ENTRIES_PER_CALLABLE, max(0, MAX_TOTAL_ENTRIES - totals["shown"]))
            shown = entries[:allowed]
            totals["shown"] += len(shown)
            if len(entries) > allowed and allowed < MAX_ENTRIES_PER_CALLABLE:
                limited = True
            results.append({
                "id": target.get("id"), "qualname": qualname, "path": path, "change": target.get("change"),
                "line": current_function.lineno if current_function else None,
                "base_line": base_function.lineno if base_function else None,
                "decisions_base": len(base_decisions), "decisions_current": len(current_decisions),
                "counts": counts, "entries": shown, "omitted_entries": len(entries) - len(shown),
                "truncated": base_truncated or current_truncated,
            })
    totals.pop("shown", None)
    return {
        "callables": results,
        "totals": dict(totals),
        "files_examined": len(selected),
        "limited": limited,
        "warnings": warnings,
        "elapsed_ms": round((time.perf_counter() - started) * 1000),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Extract behavioral decision changes for changed Python callables")
    parser.add_argument("--input", required=True, help="JSON request file")
    args = parser.parse_args(argv)
    try:
        with open(args.input, encoding="utf-8") as handle:
            request = json.load(handle)
        result = build_decision_map(request)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"agent-review decisions: {error}", file=sys.stderr)
        return 2
    # ASCII escapes keep the JSON intact regardless of the console code page.
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
