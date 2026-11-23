"""Deterministic Go graph extraction from saved source text.

This intentionally does not invoke ``go list`` or compile packages: imports and
calls are linked only when their declarations are present in the saved snapshot.
Call edges are emitted only when the target can be resolved.
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
_IDENTIFIER = re.compile(r"[A-Za-z_]\w*")
_SCALAR_TYPES = set(
    "bool string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 "
    "uintptr byte rune float32 float64 complex64 complex128".split()
)
_CONTROL_KEYWORDS = {"if", "for", "switch", "select", "return", "go", "defer"}
_KEYWORDS = _CONTROL_KEYWORDS | {"make", "new",
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


def _delimiter_end(masked: str, opening: int) -> int:
    left = masked[opening]
    right = {"(": ")", "{": "}", "[": "]"}[left]
    depth = 0
    for index in range(opening, len(masked)):
        if masked[index] == left:
            depth += 1
        elif masked[index] == right:
            depth -= 1
            if depth == 0:
                return index + 1
    return len(masked)


def _split_fields(text: str, separators: str = ",") -> list[str]:
    fields = []
    depth, start = 0, 0
    for index, char in enumerate(text):
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif not depth and char in separators:
            fields.append(text[start:index])
            start = index + 1
    fields.append(text[start:])
    return fields


def _nested_signature_end(text: str, opening: int) -> int:
    # Skip result-type syntax, including nested function types, without resolving types.
    end = _delimiter_end(text, opening)
    token = ")"
    while end < len(text):
        char = text[end]
        if char.isspace():
            if char == "\n" and token not in {"func", "map", "chan", "struct", "interface", "*", ".", "<-"}:
                break
            end += 1
            continue
        identifier = _IDENTIFIER.match(text, end)
        if identifier:
            token = identifier.group()
            end = identifier.end()
        elif char in "([":
            end = _delimiter_end(text, end)
            token = text[end - 1]
        elif char == "{" and token in {"struct", "interface"}:
            end = _delimiter_end(text, end)
            token = "}"
        elif char in "*." or text.startswith("<-", end):
            token = "<-" if text.startswith("<-", end) else char
            end += len(token)
        else:
            break
    return end


def _parameter_names(text: str) -> set[str]:
    names = set()
    for field in _split_fields(text):
        match = re.match(r"\s*([A-Za-z_]\w*)(.*)", field, re.DOTALL)
        if not match:
            continue
        name, tail = match.groups()
        rest = tail.lstrip()
        if (not rest or rest.startswith(("*", "(", "<-", "..."))
                or (tail[0].isspace() and not rest.startswith("."))):
            names.add(name)
    return names


def _signature_names(signature: str, opening: int = 0) -> set[str]:
    end = _delimiter_end(signature, opening)
    names = _parameter_names(signature[opening + 1:end - 1])
    while end < len(signature) and signature[end].isspace():
        end += 1
    if end < len(signature) and signature[end] == "(":
        names.update(_parameter_names(signature[end + 1:_delimiter_end(signature, end) - 1]))
    return names


def _container_function_type(text: str, start: int) -> bool:
    end, pointer = start, False
    while end and (text[end - 1].isspace() or text[end - 1] == "*"):
        pointer |= text[end - 1] == "*"
        end -= 1
    if not end or text[end - 1] != "]":
        return False
    if not pointer:
        return True
    # Before '*', the bracket may instead belong to an indexed expression.
    while end and text[end - 1] == "]":
        opening, depth = end - 1, 1
        while opening and depth:
            opening -= 1
            if text[opening] == "[":
                depth -= 1
            elif text[opening] == "]":
                depth += 1
        if depth:
            return False
        end = opening
        while end and text[end - 1].isspace():
            end -= 1
    if end and text[end - 1] in ")]}":
        return False
    start = end
    while start and (text[start - 1].isalnum() or text[start - 1] == "_"):
        start -= 1
    return start == end or text[start:end] in {
        "map", "return", "go", "defer", "case", "range", "if", "for", "switch",
    }


def _parameter_types(text: str) -> dict[str, str]:
    types = {}
    pending = []
    for field in _split_fields(text):
        match = re.match(r"\s*([A-Za-z_]\w*)(.*)", field, re.DOTALL)
        if not match:
            pending.clear()
            continue
        name, tail = match.groups()
        if not tail.strip():
            pending.append(name)
            continue
        if tail[0].isspace() or tail.startswith("*"):
            declared = re.sub(r"\s+", "", tail)
            if re.fullmatch(r"\*?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?", declared):
                for parameter in [*pending, name]:
                    if parameter != "_":
                        types[parameter] = declared.removeprefix("*")
        pending.clear()
    return types


def _call_bindings(signature: str, receiver: str | None,
                   body: str) -> tuple[set[str], dict[str, str]]:
    # Over-approximate bindings across the callable instead of guessing lexical scopes.
    parameters = _signature_names(signature) | _parameter_names(receiver or "")
    types = _parameter_types(signature[1:_delimiter_end(signature, 0) - 1])
    types.update(_parameter_types(receiver or ""))
    type_parameters = set()
    for arguments in re.findall(r"\[([^\]]*)\]", receiver or ""):
        type_parameters.update(re.findall(r"[A-Za-z_]\w*", arguments))
    names = set()
    signature_end = 0
    for match in re.finditer(r"\bfunc\s*(?=\()", body):
        if match.start() < signature_end:
            continue
        signature_end = _nested_signature_end(body, match.end())
        opening = signature_end
        while opening < len(body) and body[opening] in " \t\r":
            opening += 1
        if (body[opening:opening + 1] == "{"
                and not _container_function_type(body, match.start())):
            names.update(_signature_names(body, match.end()))
    for match in re.finditer(":=", body):
        end = match.start()
        while end:
            while end and body[end - 1].isspace():
                end -= 1
            start = end
            while start and (body[start - 1].isalnum() or body[start - 1] == "_"):
                start -= 1
            name = body[start:end]
            if not _IDENTIFIER.fullmatch(name):
                break
            names.add(name)
            end = start
            while end and body[end - 1].isspace():
                end -= 1
            if not end or body[end - 1] != ",":
                break
            end -= 1
    for match in re.finditer(r"\b(?:var|const|type)\s+", body):
        declaration = body[match.end():]
        fields = (_split_fields(declaration[1:_delimiter_end(declaration, 0) - 1], ";\r\n")
                  if declaration.startswith("(") else [declaration])
        for field in fields:
            declared = re.match(r"\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)", field)
            if declared:
                names.update(re.findall(r"[A-Za-z_]\w*", declared.group(1)))
    types = {name: declared for name, declared in types.items()
             if name not in names and declared.split(".", 1)[0] not in type_parameters}
    return parameters | type_parameters | names, types


def _receiver(value: str | None) -> str | None:
    if not value:
        return None
    fields = value.split()
    candidate = fields[-1] if fields else value
    candidate = candidate.rsplit("*", 1)[-1]
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
        end = _delimiter_end(masked, opening)
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
        bindings, receiver_types = _call_bindings(
            match.group(3), match.group(1), masked[opening + 1:end - 1])
        covered.append((opening, end, symbol, bindings, receiver_types))
    depth, previous = 0, 0
    for match in _TYPE.finditer(masked):
        for brace in re.finditer(r"[{}]", masked[previous:match.start()]):
            depth += 1 if brace.group() == "{" else -1
        previous = match.start()
        if depth:
            continue
        opening = masked.find("{", match.start(), match.end())
        end = _delimiter_end(masked, opening) if opening >= 0 else source.find("\n", match.start())
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
                                 "explicit_alias": alias is not None,
                                 "line": _line(source, block.start(1) + item.start())})
    for item in _IMPORT_ONE.finditer(source):
        if any(block.start() <= item.start() < block.end() for block in _IMPORT_BLOCK.finditer(source)):
            continue
        alias, target = item.groups()
        file.imports.append({"alias": alias or target.rsplit("/", 1)[-1], "target": target,
                             "explicit_alias": alias is not None,
                             "line": _line(source, item.start())})
    for opening, end, owner, bindings, receiver_types in covered:
        for call in _CALL.finditer(masked, opening + 1, end - 1):
            prefix = call.group("prefix")
            receiver_type = receiver_types.get(prefix) if prefix else None
            if (call.group("name") in _CONTROL_KEYWORDS
                    or call.group("name") in _KEYWORDS and receiver_type is None):
                continue
            previous = call.start() - 1
            while previous > opening and masked[previous].isspace():
                previous -= 1
            if masked[previous] == ".":
                continue
            if (prefix or call.group("name")) in bindings and not receiver_type:
                continue
            file.calls.append({"owner": owner["id"], "prefix": prefix,
                               "name": call.group("name"), "line": _line(source, call.start()),
                               "receiver_type": receiver_type})
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
        raw["signature_base"] = before.get("signature") if before else None
        raw["signature_current"] = after.get("signature") if after else None
        raw["complexity_base"] = before.get("complexity") if before else None
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

    def side_edges(files: dict[str, GoFile], declared: set[str],
                   side_roots: dict[str, str]) -> list[dict[str, Any]]:
        edges = []
        side_functions: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
        side_methods: dict[tuple[str, str, str], list[str]] = defaultdict(list)
        side_types: dict[tuple[str, str], list[bool]] = defaultdict(list)
        side_packages: dict[str, set[str]] = defaultdict(set)
        for parsed in files.values():
            if not parsed.path.endswith("_test.go"):
                side_packages[_import_for_package(parsed.package, side_roots)].add(parsed.package)
            for symbol in parsed.symbols:
                if symbol["kind"] == "function":
                    side_functions[parsed.package][symbol["name"]].append(symbol["id"])
                elif symbol["kind"] == "method":
                    side_methods[(parsed.package, symbol["receiver"], symbol["name"])].append(symbol["id"])
                else:
                    signature_text = _masked(symbol["signature"])
                    signature = signature_text.split()
                    concrete = (symbol["kind"] == "struct" and "[" not in signature_text
                                or len(signature) == 3 and signature[2] in _SCALAR_TYPES)
                    side_types[(parsed.package, symbol["name"])].append(concrete)
        for path, file in files.items():
            aliases = {item["alias"]: item["target"] for item in file.imports if item["alias"] not in ("_", ".")}
            receiver_aliases: dict[str, set[str]] = defaultdict(set)
            for item in file.imports:
                packages = side_packages.get(item["target"], set())
                if item["alias"] not in ("_", ".") and len(packages) == 1:
                    package = next(iter(packages))
                    alias = (item["alias"] if item["explicit_alias"]
                             else package.rsplit(":", 1)[-1])
                    receiver_aliases[alias].add(package)
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
                if call["receiver_type"]:
                    qualifier, separator, type_name = call["receiver_type"].rpartition(".")
                    if not separator:
                        type_name = call["receiver_type"]
                    else:
                        packages = receiver_aliases.get(qualifier, set())
                        if len(packages) != 1:
                            continue
                        target_package = next(iter(packages))
                        if not call["name"][0].isupper():
                            continue
                    if side_types.get((target_package, type_name)) != [True]:
                        continue
                    candidates = side_methods.get((target_package, type_name, call["name"]), [])
                elif call["prefix"] is not None:
                    if call["prefix"] not in aliases:
                        continue
                    target_package = import_packages.get(aliases[call["prefix"]])
                    candidates = side_functions.get(target_package, {}).get(call["name"], [])
                else:
                    candidates = side_functions.get(target_package, {}).get(call["name"], [])
                if len(candidates) == 1:
                    edges.append({"kind": "calls", "source": call["owner"], "target": candidates[0],
                                  "path": path, "line": call["line"],
                                  "detail": f"{call['prefix'] + '.' if call['prefix'] else ''}{call['name']}"})
        return edges
    before_edges = side_edges(baseline, baseline_declared, _module_path(baseline_files))
    after_edges = side_edges(current, current_declared, _module_path(current_files))
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
