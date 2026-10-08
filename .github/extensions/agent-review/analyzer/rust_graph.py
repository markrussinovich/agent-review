"""Deterministic, snapshot-only Rust structure and relationship analysis.

This intentionally implements a bounded syntax scanner rather than invoking
Cargo, rustc, procedural macros, build scripts, or repository binaries.
"""
from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from pathlib import PurePosixPath
from typing import Any

from review_model import ReviewModel, stable_id


ITEM = re.compile(
    r"(?m)^[ \t]*(?:#\s*\[[^\n]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?"
    r"(?:(?:const|async|unsafe)\s+|extern(?:\s+\"[^\"]+\")?\s+)*"
    r"(?P<kind>struct|enum|trait|fn|mod|impl)\s+"
    r"(?P<head>[^{;\n]+)(?P<terminal>[{;])"
)
USE = re.compile(r"(?m)^[ \t]*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+);")
CALL = re.compile(r"(?<![\w])(?P<path>(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)\s*(?P<macro>!)?\s*\(")
KEYWORDS = {"if", "while", "for", "loop", "match", "return", "Some", "Ok", "Err",
            "Box", "Vec", "String", "assert", "assert_eq", "assert_ne", "format", "vec"}


def _mask(source: str) -> str:
    chars = list(source)
    index = 0
    while index < len(chars):
        if source.startswith("//", index):
            end = source.find("\n", index)
            end = len(chars) if end < 0 else end
            for offset in range(index, end):
                chars[offset] = " "
            index = end
        elif source.startswith("/*", index):
            depth, end = 1, index + 2
            while end < len(chars) and depth:
                if source.startswith("/*", end):
                    depth += 1
                    end += 2
                elif source.startswith("*/", end):
                    depth -= 1
                    end += 2
                else:
                    end += 1
            for offset in range(index, min(end, len(chars))):
                if chars[offset] != "\n":
                    chars[offset] = " "
            index = end
        elif chars[index] in {'"', "'"}:
            quote = chars[index]
            # A Rust lifetime is not a character literal.
            if quote == "'" and index + 1 < len(chars) and re.match(r"[A-Za-z_]", chars[index + 1]):
                index += 1
                continue
            end = index + 1
            while end < len(chars):
                if chars[end] == "\\":
                    end += 2
                    continue
                if chars[end] == quote:
                    end += 1
                    break
                end += 1
            for offset in range(index, min(end, len(chars))):
                if chars[offset] != "\n":
                    chars[offset] = " "
            index = end
        else:
            index += 1
    return "".join(chars)


def _line(source: str, offset: int) -> int:
    return source.count("\n", 0, offset) + 1


def _brace_pairs(masked: str) -> dict[int, int]:
    stack: list[int] = []
    pairs: dict[int, int] = {}
    for index, char in enumerate(masked):
        if char == "{":
            stack.append(index)
        elif char == "}" and stack:
            pairs[stack.pop()] = index
    return pairs


def _module_name(path: str, crate: str) -> str:
    pure = PurePosixPath(path)
    parts = list(pure.with_suffix("").parts)
    if "src" in parts:
        parts = parts[parts.index("src") + 1:]
    if parts and parts[-1] in {"lib", "main", "mod"}:
        parts.pop()
    return "::".join([crate.replace("-", "_"), *parts])


def _crates(files: dict[str, bytes]) -> list[tuple[PurePosixPath, str, str]]:
    result = []
    for path, raw in files.items():
        if PurePosixPath(path).name != "Cargo.toml":
            continue
        text = raw.decode("utf-8-sig", errors="replace")
        match = re.search(r'(?ms)^\[package\]\s*(.*?)(?=^\[|\Z)', text)
        name = re.search(r'(?m)^\s*name\s*=\s*"([^"]+)"', match.group(1)) if match else None
        if name:
            result.append((PurePosixPath(path).parent, name.group(1), path))
    return sorted(result, key=lambda item: len(item[0].parts), reverse=True)


def _crate_for(path: str, crates: list[tuple[PurePosixPath, str, str]]) -> tuple[str, str | None]:
    pure = PurePosixPath(path)
    for directory, name, manifest in crates:
        try:
            pure.relative_to(directory)
            return name, manifest
        except ValueError:
            pass
    return "crate", None


def _name(kind: str, head: str) -> str:
    if kind == "impl":
        value = re.sub(r"<[^>]*>", "", head).strip()
        value = value.split(" where ", 1)[0].strip()
        return value.split(" for ")[-1].strip().split("::")[-1]
    return re.match(r"(?:r#)?[A-Za-z_]\w*", head.strip()).group(0)


def _scan_side(files: dict[str, bytes], dependencies: list[dict[str, Any]]) -> dict[str, Any]:
    crates = _crates(files)
    symbols: dict[str, dict[str, Any]] = {}
    modules: dict[str, dict[str, Any]] = {}
    raw_edges: list[dict[str, Any]] = []
    tests: list[dict[str, Any]] = []
    dependency_names = {item.get("import_name", item["name"].replace("-", "_")): item["name"]
                        for item in dependencies}
    module_aliases: dict[str, str] = {}
    parsed: list[dict[str, Any]] = []

    for path, raw in sorted(files.items()):
        if not path.lower().endswith(".rs"):
            continue
        source = raw.decode("utf-8-sig", errors="replace")
        masked = _mask(source)
        pairs = _brace_pairs(masked)
        crate, manifest = _crate_for(path, crates)
        module = _module_name(path, crate)
        module_id = stable_id("module", "rust", module, path)
        modules[module] = {
            "id": module_id, "name": module, "display_name": module, "path": path,
            "component": f"Rust crate: {crate}", "language": "rust", "ecosystem": "cargo",
            "crate": crate, "manifest": manifest, "symbol_ids": [],
        }
        module_aliases[module.split("::")[-1]] = module_id
        items: list[dict[str, Any]] = []
        for match in ITEM.finditer(masked):
            kind, head = match.group("kind"), match.group("head").strip()
            open_brace = match.end("terminal") - 1 if match.group("terminal") == "{" else None
            end_offset = pairs.get(open_brace, match.end()) if open_brace is not None else match.end()
            parent = None
            for candidate in items:
                if candidate["open"] is not None and candidate["open"] < match.start() < candidate["end"]:
                    if parent is None or candidate["open"] > parent["open"]:
                        parent = candidate
            if kind == "impl":
                item = {"kind": kind, "name": _name(kind, head), "head": head, "start": match.start(),
                        "open": open_brace, "end": end_offset, "parent": parent}
                items.append(item)
                continue
            symbol_kind = {"fn": "method" if parent and parent["kind"] in {"impl", "trait"} else "function",
                           "mod": "module"}.get(kind, kind)
            name = _name(kind, head)
            ancestors = []
            cursor = parent
            while cursor:
                if cursor["kind"] in {"mod", "impl", "trait"}:
                    ancestors.append(cursor["name"])
                cursor = cursor.get("parent")
            qualname = "::".join([*reversed(ancestors), name])
            identity = f"rust:{crate}:{module}:{symbol_kind}:{qualname}"
            identifier = stable_id("symbol", identity)
            signature_end = open_brace if open_brace is not None else match.end()
            signature = " ".join(source[match.start():signature_end].split())
            snippet = source[match.start():end_offset + (1 if open_brace is not None else 0)]
            attributes = source[max(0, source.rfind("\n", 0, match.start() - 1)):match.start()]
            record = {
                "id": identifier, "identity": identity, "kind": symbol_kind, "name": name,
                "qualname": qualname, "module": module, "path": path,
                "range": {"start_line": _line(source, match.start()), "end_line": _line(source, end_offset)},
                "signature": signature, "digest": hashlib.sha256(snippet.encode()).hexdigest(),
                "complexity": 1 + len(re.findall(r"\b(?:if|match|while|for|loop)\b|&&|\|\|", snippet)),
                "language": "rust", "ecosystem": "cargo", "crate": crate,
                "parent_identity": parent.get("identity") if parent else None,
                "_start": match.start(), "_open": open_brace, "_end": end_offset, "_source": source,
            }
            if parent and parent["kind"] in {"impl", "trait"}:
                owner = parent["name"]
                owner_identity = next((value["identity"] for value in symbols.values()
                                       if value["module"] == module and value["name"] == owner
                                       and value["kind"] in {"struct", "enum", "trait"}), None)
                record["parent_identity"] = owner_identity
            symbols[identity] = record
            modules[module]["symbol_ids"].append(identifier)
            item = {"kind": kind, "name": name, "head": head, "start": match.start(), "open": open_brace,
                    "end": end_offset, "parent": parent, "identity": identity, "id": identifier}
            items.append(item)
            if symbol_kind in {"function", "method"}:
                attribute_source = source[max(0, match.start() - 300):match.start("kind")]
                is_test = bool(re.search(r"#\s*\[\s*(?:tokio::)?test(?:\s*\([^]]*\))?\s*\]",
                                         attribute_source))
                record["test"] = is_test
                if is_test:
                    tests.append({"id": f"{path}::{qualname}", "name": qualname, "path": path,
                                  "symbol_id": identifier, "manifest": manifest, "crate": crate,
                                  "source_hash": hashlib.sha256(source.encode()).hexdigest()})
        parsed.append({"path": path, "source": source, "masked": masked, "module": module,
                       "module_id": module_id, "items": items, "crate": crate})

    for file in parsed:
        local_modules = {
            name.split("::")[-1]: module["id"] for name, module in modules.items()
            if name.split("::")[0] == file["module"].split("::")[0]
        }
        for use in USE.finditer(file["masked"]):
            value = " ".join(use.group(1).split())
            segments = re.findall(r"(?:r#)?([A-Za-z_]\w*)", value.split("::{", 1)[0])
            if not segments:
                continue
            root = segments[0]
            kind = "uses_package" if root in dependency_names else "imports"
            target = f"package:cargo:{dependency_names[root]}" if kind == "uses_package" else None
            if target is None and root == "crate" and len(segments) > 1:
                target = local_modules.get(segments[1])
            elif target is None and root == "self" and len(segments) > 1:
                target = local_modules.get(segments[1])
            elif target is None and root == "super":
                parent = file["module"].rsplit("::", 1)[0]
                target = modules.get(parent, {}).get("id")
                if len(segments) > 1:
                    target = local_modules.get(segments[1], target)
            elif target is None:
                target = local_modules.get(root) or module_aliases.get(root)
            if target:
                raw_edges.append({"kind": kind, "source": file["module_id"], "target": target,
                                  "path": file["path"], "line": _line(file["source"], use.start()),
                                  "detail": value})
        for item in file["items"]:
            if item["kind"] == "mod" and item["open"] is None and item["name"] in local_modules:
                raw_edges.append({"kind": "imports", "source": file["module_id"],
                                  "target": local_modules[item["name"]], "path": file["path"],
                                  "line": _line(file["source"], item["start"]),
                                  "detail": f"mod {item['name']}"})

    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for symbol in symbols.values():
        by_name[symbol["name"]].append(symbol)
    for file in parsed:
        for item in file["items"]:
            if item["kind"] != "fn" or not item.get("id") or item["open"] is None:
                continue
            body = file["masked"][item["open"] + 1:item["end"]]
            for call in CALL.finditer(body):
                name = call.group("path").split("::")[-1]
                if name in KEYWORDS or call.group("macro"):
                    continue
                candidates = [candidate for candidate in by_name.get(name, [])
                              if candidate.get("_open") is not None]
                local = [candidate for candidate in candidates if candidate["module"] == file["module"]]
                candidates = local or candidates
                if len(candidates) == 1 and candidates[0]["id"] != item["id"]:
                    raw_edges.append({
                        "kind": "calls", "source": item["id"], "target": candidates[0]["id"],
                        "path": file["path"], "line": _line(file["source"], item["open"] + 1 + call.start()),
                        "detail": call.group("path"),
                    })
    return {"symbols": symbols, "modules": modules, "edges": raw_edges, "tests": tests}


def analyze_rust(
    baseline: dict[str, bytes], current: dict[str, bytes], model: ReviewModel,
    baseline_dependencies: list[dict[str, Any]], current_dependencies: list[dict[str, Any]],
) -> dict[str, Any]:
    before = _scan_side(baseline, baseline_dependencies)
    after = _scan_side(current, current_dependencies)
    all_identities = set(before["symbols"]) | set(after["symbols"])
    id_for_identity = {identity: (after["symbols"].get(identity) or before["symbols"][identity])["id"]
                       for identity in all_identities}
    classifications: dict[str, str] = {}
    for identity in sorted(all_identities):
        old, new = before["symbols"].get(identity), after["symbols"].get(identity)
        classification = "added" if old is None else "removed" if new is None else (
            "modified" if old["digest"] != new["digest"] else "unchanged")
        classifications[identity] = classification
        chosen = dict(new or old)
        for private in [key for key in chosen if key.startswith("_")]:
            chosen.pop(private)
        chosen.update({
            "classification": classification,
            "signature_base": old["signature"] if old else None,
            "signature_current": new["signature"] if new else None,
            "complexity_base": old["complexity"] if old else None,
            "complexity_current": new["complexity"] if new else None,
        })
        model.symbols.append(chosen)

    changed_paths = {item["path"]: {"deleted": "removed"}.get(item["status"], item["status"])
                     for item in model.changes}
    all_modules = set(before["modules"]) | set(after["modules"])
    component_modules: dict[str, list[str]] = defaultdict(list)
    symbol_module_ids: dict[str, str] = {}
    for name in sorted(all_modules):
        old, new = before["modules"].get(name), after["modules"].get(name)
        module = dict(new or old)
        state = "added" if old is None else "removed" if new is None else changed_paths.get(module["path"], "unchanged")
        module["change"] = state
        module["symbol_ids"] = sorted({*(old or {}).get("symbol_ids", []), *(new or {}).get("symbol_ids", [])})
        model.aggregates["modules"].append(module)
        component_modules[module["component"]].append(module["id"])
        for identifier in module["symbol_ids"]:
            symbol_module_ids[identifier] = module["id"]
    for component, module_ids in sorted(component_modules.items()):
        model.aggregates["components"].append({
            "id": stable_id("component", "rust", component), "name": component,
            "module_ids": sorted(module_ids), "language": "rust", "ecosystem": "cargo",
        })

    def edge_key(edge: dict[str, Any]) -> tuple[str, str, str, str]:
        return edge["kind"], edge["source"], edge["target"], edge.get("detail", "")

    old_edges = {edge_key(edge): edge for edge in before["edges"]}
    new_edges = {edge_key(edge): edge for edge in after["edges"]}
    graph_edges = []
    for key in sorted(set(old_edges) | set(new_edges)):
        old, new = old_edges.get(key), new_edges.get(key)
        raw = new or old
        change = "added" if old is None else "removed" if new is None else "unchanged"
        evidence = model.add_evidence("rust_relationship", {
            "path": raw["path"], "line": raw["line"], "detail": raw["detail"],
            "language": "rust", "resolution": "saved Rust syntax",
        })
        edge = {
            **raw, "id": stable_id("edge", "rust", *key, change), "change": change,
            "confidence": 0.9 if raw["kind"] == "calls" else 0.85, "evidence_ids": [evidence],
        }
        model.edges.append(edge)
        graph_edges.append(edge)
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for edge in graph_edges:
        source = symbol_module_ids.get(edge["source"], edge["source"] if edge["source"] in {
            module["id"] for module in model.aggregates["modules"]} else None)
        target = symbol_module_ids.get(edge["target"], edge["target"] if edge["target"] in {
            module["id"] for module in model.aggregates["modules"]} else None)
        if source and target and source != target:
            grouped[(edge["kind"], source, target)].append(edge)
    for (kind, source, target), edges in grouped.items():
        model.aggregates["edges"].append({
            "id": stable_id("aggregate_edge", "rust", kind, source, target),
            "level": "module", "kind": kind, "source": source, "target": target,
            "underlying_edge_ids": sorted(edge["id"] for edge in edges),
            "count": sum(edge["change"] != "removed" for edge in edges),
            "added_count": sum(edge["change"] == "added" for edge in edges),
            "removed_count": sum(edge["change"] == "removed" for edge in edges),
        })
    return {"tests": after["tests"], "classifications": classifications}
