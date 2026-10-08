"""Deterministic Go graph extraction from saved source text.

This intentionally does not invoke ``go list`` or compile packages: imports and
calls are linked only when their declarations are present in the saved snapshot.
"""
from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any

from review_model import ReviewModel, stable_id


_FUNC = re.compile(
    r"(?m)^[ \t]*func[ \t]+(?:\(\s*([^)]+?)\s*\)\s*)?"
    r"([A-Za-z_]\w*)\s*(\([^{};]*?\)(?:\s*\([^{}]*?\)|\s+[A-Za-z_][\w.\[\]*]*)?)\s*\{"
)
_TYPE = re.compile(r"(?m)^[ \t]*type[ \t]+([A-Za-z_]\w*)(?:\s*\[[^\]]+\])?\s+"
                   r"(struct|interface)?\s*(\{|[^\r\n]+)")
_IMPORT_BLOCK = re.compile(r"(?ms)^[ \t]*import\s*\((.*?)^\s*\)")
_IMPORT_ONE = re.compile(r'(?m)^[ \t]*import\s+(?:(\.|_|[A-Za-z_]\w*)\s+)?"([^"]+)"')
_IMPORT_ITEM = re.compile(r'(?m)^[ \t]*(?:(\.|_|[A-Za-z_]\w*)\s+)?"([^"]+)"')
_CALL = re.compile(r"\b(?:(?P<prefix>[A-Za-z_]\w*)\s*\.\s*)?(?P<name>[A-Za-z_]\w*)\s*\(")
_KEYWORDS = {"if", "for", "switch", "select", "return", "go", "defer", "make", "new",
             "len", "cap", "append", "copy", "delete", "close", "panic", "recover",
             "print", "println", "complex", "real", "imag"}


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _masked(source: str) -> str:
    """Blank comments/string contents while preserving offsets and newlines."""
    out = list(source)
    index, state = 0, None
    while index < len(source):
        pair = source[index:index + 2]
        char = source[index]
        if state == "line":
            if char in "\r\n":
                state = None
            else:
                out[index] = " "
        elif state == "block":
            if pair == "*/":
                out[index:index + 2] = "  "
                index += 1
                state = None
            elif char not in "\r\n":
                out[index] = " "
        elif state in ('"', "'", "`"):
            if state != "`" and char == "\\":
                out[index] = " "
                if index + 1 < len(source) and source[index + 1] not in "\r\n":
                    out[index + 1] = " "
                index += 1
            elif char == state:
                out[index] = " "
                state = None
            elif char not in "\r\n":
                out[index] = " "
        elif pair == "//":
            out[index:index + 2] = "  "
            index += 1
            state = "line"
        elif pair == "/*":
            out[index:index + 2] = "  "
            index += 1
            state = "block"
        elif char in ('"', "'", "`"):
            out[index] = " "
            state = char
        index += 1
    return "".join(out)


def _syntax_normalized(source: str) -> str:
    """Remove comments and insignificant whitespace while retaining literals."""
    result: list[str] = []
    index, state = 0, None
    while index < len(source):
        pair, char = source[index:index + 2], source[index]
        if state == "line":
            if char in "\r\n":
                state = None
        elif state == "block":
            if pair == "*/":
                index += 1
                state = None
        elif state in ('"', "'", "`"):
            result.append(char)
            if state != "`" and char == "\\" and index + 1 < len(source):
                index += 1
                result.append(source[index])
            elif char == state:
                state = None
        elif pair == "//":
            index += 1
            state = "line"
        elif pair == "/*":
            index += 1
            state = "block"
        elif char in ('"', "'", "`"):
            result.append(char)
            state = char
        elif not char.isspace():
            result.append(char)
        index += 1
    return "".join(result)


def _line(source: str, offset: int) -> int:
    return source.count("\n", 0, offset) + 1


def _brace_end(masked: str, opening: int) -> int:
    depth = 0
    for index in range(opening, len(masked)):
        if masked[index] == "{":
            depth += 1
        elif masked[index] == "}":
            depth -= 1
            if depth == 0:
                return index + 1
    return len(masked)


def _receiver(value: str | None) -> str | None:
    if not value:
        return None
    fields = value.split()
    candidate = fields[-1] if fields else value
    return re.sub(r"[^A-Za-z0-9_]", "", candidate.split("[", 1)[0]) or None


def _package(path: str, source: str) -> str | None:
    match = re.search(r"(?m)^[ \t]*package[ \t]+([A-Za-z_]\w*)", _masked(source))
    if not match:
        return None
    directory = str(PurePosixPath(path).parent)
    return f"{directory}:{match.group(1)}"


@dataclass
class GoFile:
    path: str
    source: str
    package: str
    package_name: str
    symbols: list[dict[str, Any]] = field(default_factory=list)
    imports: list[dict[str, Any]] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)


def parse_go(path: str, raw: bytes) -> tuple[GoFile | None, str | None]:
    try:
        source = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        return None, f"{path}: cannot decode Go source: {error}"
    masked = _masked(source)
    package = _package(path, source)
    if package is None:
        return None, f"{path}: no Go package clause; file graph omitted."
    file = GoFile(path, source, package, package.rsplit(":", 1)[-1])
    covered = []
    for match in _FUNC.finditer(masked):
        opening = match.end() - 1
        end = _brace_end(masked, opening)
        owner = _receiver(match.group(1))
        name = match.group(2)
        qualname = f"{owner}.{name}" if owner else name
        identity = f"go:{package}:{qualname}"
        segment = source[match.start():end]
        signature = re.sub(r"\s+", " ", source[match.start():opening].strip()).removeprefix("func ")
        kind = "method" if owner else "function"
        complexity = 1 + len(re.findall(r"\b(?:if|for|case)\b|&&|\|\|", masked[opening:end]))
        symbol = {
            "id": stable_id("symbol", identity), "identity": identity, "name": name,
            "qualname": qualname, "kind": kind, "module": f"go:file:{path}", "path": path,
            "language": "go", "ecosystem": "gomod", "receiver": owner, "go_package": package,
            "range": {"start_line": _line(source, match.start()), "end_line": _line(source, end)},
            "signature": signature, "source_hash": _hash(segment),
            "normalized_ast_hash": _hash(_syntax_normalized(segment)),
            "complexity": complexity,
        }
        file.symbols.append(symbol)
        covered.append((match.start(), end, symbol))
    for match in _TYPE.finditer(masked):
        opening = masked.find("{", match.start(), match.end())
        end = _brace_end(masked, opening) if opening >= 0 else source.find("\n", match.start())
        end = len(source) if end < 0 else end
        name, declared = match.group(1), match.group(2)
        kind = declared or "type"
        identity = f"go:{package}:{name}"
        segment = source[match.start():end]
        file.symbols.append({
            "id": stable_id("symbol", identity), "identity": identity, "name": name,
            "qualname": name, "kind": kind, "module": f"go:file:{path}", "path": path,
            "language": "go", "ecosystem": "gomod", "go_package": package,
            "range": {"start_line": _line(source, match.start()), "end_line": _line(source, end)},
            "signature": re.sub(r"\s+", " ", source[match.start():min(end, match.end())].strip()),
            "source_hash": _hash(segment), "normalized_ast_hash": _hash(_syntax_normalized(segment)),
            "complexity": None,
        })
    for block in _IMPORT_BLOCK.finditer(source):
        for item in _IMPORT_ITEM.finditer(block.group(1)):
            alias, target = item.groups()
            file.imports.append({"alias": alias or target.rsplit("/", 1)[-1], "target": target,
                                 "line": _line(source, block.start(1) + item.start())})
    for item in _IMPORT_ONE.finditer(source):
        if any(block.start() <= item.start() < block.end() for block in _IMPORT_BLOCK.finditer(source)):
            continue
        alias, target = item.groups()
        file.imports.append({"alias": alias or target.rsplit("/", 1)[-1], "target": target,
                             "line": _line(source, item.start())})
    for start, end, owner in covered:
        for call in _CALL.finditer(masked, start, end):
            if call.start() < masked.find("{", start, end) or call.group("name") in _KEYWORDS:
                continue
            file.calls.append({"owner": owner["id"], "prefix": call.group("prefix"),
                               "name": call.group("name"), "line": _line(source, call.start())})
    return file, None


def _module_path(files: dict[str, bytes]) -> dict[str, str]:
    roots: dict[str, str] = {}
    for path, raw in files.items():
        if PurePosixPath(path).name != "go.mod":
            continue
        match = re.search(r"(?m)^\s*module\s+(\S+)", raw.decode("utf-8-sig", errors="replace"))
        if match:
            roots[str(PurePosixPath(path).parent)] = match.group(1)
    return roots


def _import_for_package(package: str, roots: dict[str, str]) -> str:
    directory = package.rsplit(":", 1)[0]
    pure = PurePosixPath(directory)
    best = None
    for root, module in roots.items():
        root_path = PurePosixPath(root)
        try:
            relative = pure.relative_to(root_path)
        except ValueError:
            continue
        if best is None or len(root_path.parts) > best[0]:
            suffix = "" if str(relative) == "." else f"/{relative.as_posix()}"
            best = (len(root_path.parts), f"{module}{suffix}")
    return best[1] if best else directory


def analyze_go(baseline_files: dict[str, bytes], current_files: dict[str, bytes],
               model: ReviewModel, current_declared: set[str],
               baseline_declared: set[str] | None = None) -> None:
    baseline_declared = baseline_declared if baseline_declared is not None else current_declared
    def parse(files: dict[str, bytes]) -> dict[str, GoFile]:
        parsed = {}
        for path, raw in sorted(files.items()):
            if not path.lower().endswith(".go") or "/vendor/" in f"/{path.lower()}/":
                continue
            item, warning = parse_go(path, raw)
            if warning:
                model.warnings.append(warning)
            elif item:
                parsed[path] = item
        return parsed
    baseline, current = parse(baseline_files), parse(current_files)
    roots = _module_path({**baseline_files, **current_files})
    all_files = {**baseline, **current}
    for path in set(baseline) & set(current):
        if baseline[path].package != current[path].package:
            model.warnings.append(
                f"{path}: Go package clause changed from {baseline[path].package_name} to "
                f"{current[path].package_name}; removed symbols remain attached to the current file node."
            )
    all_packages = {item.package for item in baseline.values()} | {item.package for item in current.values()}
    package_imports = {package: _import_for_package(package, roots)
                       for package in all_packages}
    import_packages = {value: key for key, value in package_imports.items()}
    module_ids = {path: stable_id("module", "go", path) for path in all_files}
    base_symbols = {item["identity"]: item for file in baseline.values() for item in file.symbols}
    now_symbols = {item["identity"]: item for file in current.values() for item in file.symbols}
    for identity in sorted(set(base_symbols) | set(now_symbols)):
        before, after = base_symbols.get(identity), now_symbols.get(identity)
        raw = (after or before).copy()
        raw["classification"] = ("added" if before is None else "removed" if after is None else
                                 "unchanged" if before["normalized_ast_hash"] == after["normalized_ast_hash"]
                                 else "modified")
        raw["signature_baseline"] = before.get("signature") if before else None
        raw["signature_current"] = after.get("signature") if after else None
        raw["complexity_baseline"] = before.get("complexity") if before else None
        raw["complexity_current"] = after.get("complexity") if after else None
        model.symbols.append(raw)
    for symbol in model.symbols:
        if symbol.get("language") == "go" and symbol.get("receiver"):
            symbol["parent_identity"] = f"go:{symbol['go_package']}:{symbol['receiver']}"
    component_ids = {package: stable_id("component", "go", package)
                     for package in sorted(all_packages)}
    for path, file in sorted(all_files.items()):
        states = {symbol["classification"] for symbol in model.symbols if symbol.get("path") == path
                  and symbol.get("language") == "go"}
        change = "added" if path not in baseline else "removed" if path not in current else (
            "modified" if states - {"unchanged"} else "unchanged")
        model.aggregates["modules"].append({
            "id": module_ids[path], "name": f"go:file:{path}", "display_name": path,
            "path": path, "component": package_imports[file.package], "change": change,
            "language": "go", "ecosystem": "gomod",
            "symbol_ids": sorted(symbol["id"] for symbol in model.symbols
                                 if symbol.get("path") == path and symbol.get("language") == "go"),
        })
    for package, component_id in component_ids.items():
        model.aggregates["components"].append({
            "id": component_id, "name": package_imports[package], "display_name": package_imports[package],
            "module_ids": sorted(module_ids[path] for path, file in all_files.items() if file.package == package),
            "language": "go", "ecosystem": "gomod", "kind": "package",
        })

    def side_edges(files: dict[str, GoFile], declared: set[str]) -> list[dict[str, Any]]:
        edges = []
        side_symbols: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
        for parsed in files.values():
            for symbol in parsed.symbols:
                side_symbols[parsed.package][symbol["name"]].append(symbol["id"])
        for path, file in files.items():
            aliases = {item["alias"]: item["target"] for item in file.imports if item["alias"] not in ("_", ".")}
            for item in file.imports:
                target_package = import_packages.get(item["target"])
                local_targets = sorted(module_ids[candidate] for candidate, parsed in files.items()
                                       if parsed.package == target_package)
                target = local_targets[0] if local_targets else None
                kind = "imports"
                if target is None:
                    dependency = next((name for name in sorted(declared, key=len, reverse=True)
                                       if item["target"] == name or item["target"].startswith(name + "/")), None)
                    if dependency:
                        target, kind = f"package:gomod:{dependency}", "uses_package"
                if target:
                    edges.append({"kind": kind, "source": module_ids[path], "target": target,
                                  "path": path, "line": item["line"], "detail": item["target"]})
            for call in file.calls:
                target_package = file.package
                if call["prefix"] in aliases:
                    target_package = import_packages.get(aliases[call["prefix"]])
                candidates = side_symbols.get(target_package, {}).get(call["name"], [])
                if len(candidates) == 1:
                    edges.append({"kind": "calls", "source": call["owner"], "target": candidates[0],
                                  "path": path, "line": call["line"],
                                  "detail": f"{call['prefix'] + '.' if call['prefix'] else ''}{call['name']}"})
        return edges
    before_edges = side_edges(baseline, baseline_declared)
    after_edges = side_edges(current, current_declared)
    before_keys = {(edge["kind"], edge["source"], edge["target"], edge["path"], edge["line"]) for edge in before_edges}
    after_keys = {(edge["kind"], edge["source"], edge["target"], edge["path"], edge["line"]) for edge in after_edges}
    for edge in [*after_edges, *(item for item in before_edges if (
            item["kind"], item["source"], item["target"], item["path"], item["line"]) not in after_keys)]:
        key = (edge["kind"], edge["source"], edge["target"], edge["path"], edge["line"])
        change = "added" if key not in before_keys else "removed" if key not in after_keys else "unchanged"
        evidence = model.add_evidence("go_relationship", {
            "path": edge["path"], "line": edge["line"], "detail": edge["detail"],
            "language": "go", "resolution": "saved-snapshot-static",
        })
        model.edges.append({**edge, "id": stable_id("edge", "go", *key, change),
                            "change": change, "confidence": 0.9, "evidence_ids": [evidence]})
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    component_groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    symbol_module = {symbol["id"]: module_ids[symbol["path"]] for symbol in model.symbols
                     if symbol.get("language") == "go"}
    component_by_module = {module_ids[path]: component_ids[file.package]
                           for path, file in all_files.items()}
    for edge in model.edges:
        if not edge["id"].startswith("edge:"):
            continue
        source = symbol_module.get(edge["source"], edge["source"])
        target = symbol_module.get(edge["target"], edge["target"])
        if source in module_ids.values() and target in module_ids.values() and source != target:
            groups[(edge["kind"], source, target)].append(edge)
            source_component, target_component = component_by_module[source], component_by_module[target]
            if source_component != target_component:
                component_groups[(edge["kind"], source_component, target_component)].append(edge)
    for (kind, source, target), edges in groups.items():
        model.aggregates["edges"].append({
            "id": stable_id("aggregate_edge", "go", kind, source, target), "level": "module",
            "kind": kind, "source": source, "target": target,
            "underlying_edge_ids": sorted(edge["id"] for edge in edges),
            "count": sum(edge["change"] != "removed" for edge in edges),
            "added_count": sum(edge["change"] == "added" for edge in edges),
            "removed_count": sum(edge["change"] == "removed" for edge in edges),
        })
    for (kind, source, target), edges in component_groups.items():
        model.aggregates["edges"].append({
            "id": stable_id("aggregate_edge", "go", "component", kind, source, target),
            "level": "component", "kind": kind, "source": source, "target": target,
            "underlying_edge_ids": sorted(edge["id"] for edge in edges),
            "count": sum(edge["change"] != "removed" for edge in edges),
            "added_count": sum(edge["change"] == "added" for edge in edges),
            "removed_count": sum(edge["change"] == "removed" for edge in edges),
        })
