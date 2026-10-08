"""Changed Rust decision paths and statically linked tests from saved source."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

from rust_graph import _scan_side


MAX_ENTRIES = 60
MAX_TOTAL = 2000
MAX_SECONDS = 20


def _short(value: str, limit: int = 160) -> str:
    value = " ".join(value.split())
    return value if len(value) <= limit else value[:limit - 1] + "…"


def _condition(masked: str, offset: int) -> list[str]:
    prefix = masked[:offset]
    candidates = list(re.finditer(r"\bif\s+([^{\n]+)\{|\bwhile\s+([^{\n]+)\{", prefix))
    if not candidates:
        return []
    match = candidates[-1]
    # Retain a condition only while its block is still open at the decision.
    opening = prefix.find("{", match.start())
    if opening < 0 or prefix[opening:].count("{") <= prefix[opening:].count("}"):
        return []
    return [_short(next(group for group in match.groups() if group is not None))]


def _decisions(symbol: dict[str, Any]) -> list[dict[str, Any]]:
    source = symbol["_source"]
    start, end = symbol["_open"], symbol["_end"]
    if start is None:
        return []
    body = source[start + 1:end]
    from rust_graph import _mask
    masked = _mask(body)
    patterns = [
        ("return", re.compile(r"\breturn(?:\s+([^;]+))?;"), "value"),
        ("panic", re.compile(r"\b(?:panic|todo|unimplemented|unreachable)!\s*\(([^;]*)\)\s*;?"), "raise"),
        ("bail", re.compile(r"\bbail!\s*\(([^;]*)\)\s*;?"), "raise"),
        ("continue", re.compile(r"\bcontinue(?:\s+'[A-Za-z_]\w*)?\s*;"), "skip"),
        ("break", re.compile(r"\bbreak(?:\s+'[A-Za-z_]\w*)?(?:\s+([^;]+))?\s*;"), "stop"),
        ("propagate", re.compile(r"(?P<value>[A-Za-z_][^;\n{}]{0,120})\?(?=\s*[;,.})])"), "propagate"),
    ]
    result = []
    for kind, pattern, outcome in patterns:
        for match in pattern.finditer(masked):
            decision_outcome = outcome
            value = next((group for group in match.groups() if group is not None), None)
            if kind == "return" and not value:
                decision_outcome, value = "empty", "()"
            line = source.count("\n", 0, start + 1 + match.start()) + 1
            result.append({
                "kind": "exit" if kind in {"return", "panic", "bail", "propagate"} else "control",
                "outcome": decision_outcome, "value": _short(value) if value else None,
                "line": line, "end_line": source.count("\n", 0, start + 1 + match.end()) + 1,
                "column": 0, "when": _condition(masked, match.start()),
                "when_mode": "all", "only_if": [], "context": [], "thresholds": re.findall(
                    r"(?<![\w.])-?\d+(?:\.\d+)?", value or ""),
            })
    result.sort(key=lambda item: (item["line"], item["outcome"]))
    return result[:MAX_ENTRIES]


def _key(decision: dict[str, Any], *, condition: bool = True) -> tuple[Any, ...]:
    value = [decision["outcome"], decision.get("value")]
    if condition:
        value.extend([tuple(decision.get("when", [])), tuple(decision.get("thresholds", []))])
    return tuple(value)


def _compare(old: list[dict[str, Any]], new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    old_exact: dict[tuple[Any, ...], deque[dict[str, Any]]] = defaultdict(deque)
    for item in old:
        old_exact[_key(item)].append(item)
    entries, unmatched = [], []
    for index, decision in enumerate(new):
        candidates = old_exact[_key(decision)]
        if candidates:
            base = candidates.popleft()
            moved = old.index(base) != index
            entries.append({"status": "moved" if moved else "unchanged", "decision": decision,
                            **({"base": base, "moved": True} if moved else {})})
        else:
            unmatched.append(decision)
    remaining = [item for queue in old_exact.values() for item in queue]
    for decision in unmatched:
        base = next((item for item in remaining if _key(item, condition=False) == _key(decision, condition=False)), None)
        if base:
            remaining.remove(base)
            entries.append({"status": "changed", "decision": decision, "base": base})
        else:
            entries.append({"status": "added", "decision": decision})
    entries.extend({"status": "removed", "decision": item} for item in remaining)
    return sorted(entries, key=lambda entry: (
        entry["decision"]["line"], ["added", "changed", "moved", "unchanged", "removed"].index(entry["status"])))


def build(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    baseline = {path: text.encode() for path, text in payload.get("baseline", {}).items()}
    current = {path: text.encode() for path, text in payload.get("current", {}).items()}
    old, new = _scan_side(baseline, []), _scan_side(current, [])
    requested = {item["id"]: item for item in payload.get("callables", [])}
    old_by_id = {item["id"]: item for item in old["symbols"].values()}
    new_by_id = {item["id"]: item for item in new["symbols"].values()}
    call_edges = defaultdict(set)
    for edge in new["edges"]:
        if edge["kind"] == "calls":
            call_edges[edge["source"]].add(edge["target"])
    tests_for: dict[str, list[dict[str, Any]]] = defaultdict(list)
    verification_tests = []
    for test in new["tests"]:
        reached: set[str] = set()
        pending = deque([test["symbol_id"]])
        while pending:
            source = pending.popleft()
            for target in call_edges[source]:
                if target not in reached:
                    reached.add(target)
                    pending.append(target)
        linked = sorted(reached & requested.keys())
        if not linked:
            continue
        record = {**test, "callables": linked, "calls": linked, "link": "direct"
                  if any(target in requested for target in call_edges[test["symbol_id"]]) else "via"}
        verification_tests.append(record)
        for identifier in linked:
            tests_for[identifier].append(record)
    callables = []
    total_entries = 0
    limited = False
    for identifier, request in requested.items():
        if time.monotonic() - started > MAX_SECONDS or total_entries >= MAX_TOTAL:
            limited = True
            break
        entries = _compare(_decisions(old_by_id[identifier]) if identifier in old_by_id else [],
                           _decisions(new_by_id[identifier]) if identifier in new_by_id else [])
        for entry in entries:
            if entry["status"] == "removed":
                continue
            tests = tests_for.get(identifier, [])
            entry["evidence"] = {
                "level": "reachable" if tests else "none",
                "tests": [{"id": test["id"], "via": request.get("qualname", request["id"])}
                          for test in tests[:10]],
                "omitted_tests": max(0, len(tests) - 10),
            }
        counts = {status: sum(entry["status"] == status for entry in entries)
                  for status in ("added", "changed", "moved", "removed")}
        symbol = new_by_id.get(identifier) or old_by_id.get(identifier)
        callables.append({
            "id": identifier, "qualname": request.get("qualname") or symbol["qualname"],
            "path": symbol["path"], "line": symbol["range"]["start_line"],
            "language": "rust", "ecosystem": "cargo", "entries": entries, "counts": counts,
            "source_hash": hashlib.sha256(current.get(symbol["path"], b"")).hexdigest()
            if symbol["path"] in current else None,
        })
        total_entries += len(entries)
    totals = {status: sum(item["counts"][status] for item in callables)
              for status in ("added", "changed", "moved", "removed")}
    return {
        "callables": callables, "totals": totals, "limited": limited,
        "warnings": ["Rust paths are syntax-derived; macros, conditional compilation, dynamic dispatch, "
                     "and ? desugaring are not compiler-expanded."],
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "verification": {"tests": verification_tests, "omitted_tests": 0,
                         "test_files_examined": len({test["path"] for test in new["tests"]}),
                         "limited": False},
        "source_hashes": payload.get("source_hashes", {}),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    args = parser.parse_args()
    try:
        payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
        json.dump(build(payload), sys.stdout, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"agent-review Rust decisions: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
