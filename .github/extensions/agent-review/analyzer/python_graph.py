from __future__ import annotations

import ast
import hashlib
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any, Iterable

from complexity import cyclomatic
from review_model import ReviewModel, stable_id


def _hash(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def module_name(path: str) -> str:
    pure = PurePosixPath(path)
    parts = list(pure.with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def component_name(path: str) -> str:
    parts = PurePosixPath(path).parts
    return parts[0] if len(parts) > 1 else "."


def _unparse(node: ast.AST | None) -> str | None:
    return ast.unparse(node) if node is not None else None


def _signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    args = node.args
    values: list[str] = []
    positional = list(args.posonlyargs) + list(args.args)
    defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
    for index, (arg, default) in enumerate(zip(positional, defaults)):
        text = arg.arg
        if arg.annotation:
            text += f": {_unparse(arg.annotation)}"
        if default:
            text += f" = {_unparse(default)}"
        values.append(text)
        if args.posonlyargs and index + 1 == len(args.posonlyargs):
            values.append("/")
    if args.vararg:
        values.append(f"*{args.vararg.arg}")
    elif args.kwonlyargs:
        values.append("*")
    for arg, default in zip(args.kwonlyargs, args.kw_defaults):
        text = arg.arg
        if arg.annotation:
            text += f": {_unparse(arg.annotation)}"
        if default:
            text += f" = {_unparse(default)}"
        values.append(text)
    if args.kwarg:
        values.append(f"**{args.kwarg.arg}")
    result = f"({', '.join(values)})"
    if node.returns:
        result += f" -> {_unparse(node.returns)}"
    return result


@dataclass
class ParsedModule:
    path: str
    name: str
    source_hash: str
    ast_hash: str
    tree: ast.Module
    source: str
    symbols: list[dict[str, Any]] = field(default_factory=list)
    imports: list[dict[str, Any]] = field(default_factory=list)


class SymbolCollector(ast.NodeVisitor):
    def __init__(self, module: ParsedModule) -> None:
        self.module = module
        self.scope: list[tuple[str, str]] = []

    def _add(self, node: ast.AST, name: str, kind: str, signature: str | None = None) -> None:
        qualname = ".".join([part[0] for part in self.scope] + [name])
        identity = f"{self.module.name}:{qualname}"
        normalized = ast.dump(node, annotate_fields=True, include_attributes=False)
        record = {
            "id": stable_id("symbol", identity),
            "identity": identity,
            "name": name,
            "qualname": qualname,
            "kind": kind,
            "module": self.module.name,
            "path": self.module.path,
            "range": {
                "start_line": node.lineno,
                "start_column": node.col_offset,
                "end_line": getattr(node, "end_lineno", node.lineno),
                "end_column": getattr(node, "end_col_offset", node.col_offset),
            },
            "signature": signature,
            "normalized_ast_hash": _hash(normalized.encode()),
            "source_hash": _hash(
                (ast.get_source_segment(self.module.source, node) or "").encode()
            ),
            "complexity": cyclomatic(node) if kind in ("function", "method") else None,
            "_node": node,
        }
        self.module.symbols.append(record)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._add(node, node.name, "class")
        fields = []
        for child in node.body:
            targets = (
                [child.target] if isinstance(child, ast.AnnAssign)
                else child.targets if isinstance(child, ast.Assign) else []
            )
            for target in targets:
                if isinstance(target, ast.Name):
                    fields.append({"name": target.id, "line": target.lineno})
        self.module.symbols[-1]["fields"] = fields
        self.scope.append((node.name, "class"))
        for child in node.body:
            self.visit(child)
        self.scope.pop()

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        kind = "method" if self.scope and self.scope[-1][1] == "class" else "function"
        self._add(node, node.name, kind, _signature(node))
        self.scope.append((node.name, kind))
        for child in node.body:
            self.visit(child)
        self.scope.pop()

    visit_FunctionDef = _visit_function
    visit_AsyncFunctionDef = _visit_function


def _resolve_relative(current: str, level: int, target: str | None) -> str:
    package = current.split(".")[:-1]
    keep = max(0, len(package) - level + 1)
    prefix = package[:keep]
    return ".".join(prefix + (target.split(".") if target else []))


def parse_module(path: str, data: bytes) -> tuple[ParsedModule | None, str | None]:
    try:
        source = data.decode("utf-8-sig")
        tree = ast.parse(source, filename=path, type_comments=True)
    except (UnicodeDecodeError, SyntaxError) as error:
        return None, f"{path}: {error}"
    normalized = ast.dump(tree, annotate_fields=True, include_attributes=False)
    module = ParsedModule(
        path, module_name(path), _hash(data), _hash(normalized.encode()), tree, source
    )
    SymbolCollector(module).visit(tree)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                module.imports.append(
                    {
                        "local": alias.asname or alias.name.split(".")[0],
                        "target": alias.name,
                        "member": None,
                        "line": node.lineno,
                    }
                )
        elif isinstance(node, ast.ImportFrom):
            base = _resolve_relative(module.name, node.level, node.module) if node.level else node.module or ""
            for alias in node.names:
                module.imports.append(
                    {
                        "local": alias.asname or alias.name,
                        "target": base,
                        "member": alias.name,
                        "line": node.lineno,
                    }
                )
    module.imports.sort(key=lambda item: (item["line"], item["local"], item["target"]))
    return module, None


def _add_edge(
    model: ReviewModel,
    kind: str,
    source: str,
    target: str,
    confidence: float,
    path: str,
    line: int,
    detail: str,
) -> None:
    edge_id = stable_id("edge", kind, source, target, path, line, detail)
    evidence_id = model.add_evidence(
        kind,
        {"path": path, "line": line, "detail": detail, "source": source, "target": target},
    )
    model.edges.append(
        {
            "id": edge_id,
            "kind": kind,
            "type": kind,
            "source": source,
            "target": target,
            "confidence": "resolved" if confidence >= 1.0 else "likely" if confidence >= 0.8 else "unresolved",
            "count": 1,
            "evidence_ids": [evidence_id],
        }
    )


def _containing_symbol(module: ParsedModule, node: ast.AST) -> dict[str, Any] | None:
    line = getattr(node, "lineno", 0)
    candidates = [
        symbol
        for symbol in module.symbols
        if symbol["range"]["start_line"] <= line <= symbol["range"]["end_line"]
    ]
    return max(candidates, key=lambda symbol: symbol["range"]["start_line"], default=None)


def analyze_python(
    baseline_files: dict[str, bytes],
    current_files: dict[str, bytes],
    model: ReviewModel,
    declared_packages: set[str],
    baseline_declared_packages: set[str] | None = None,
) -> None:
    baseline, current = _parse_sets(baseline_files, current_files, model)
    before_symbols = {
        symbol["identity"]: symbol
        for module in baseline.values()
        for symbol in module.symbols
    }
    current_symbols = {
        symbol["identity"]: symbol
        for module in current.values()
        for symbol in module.symbols
    }
    for identity, symbol in current_symbols.items():
        prior = before_symbols.get(identity)
        symbol["classification"] = (
            "added"
            if prior is None
            else "unchanged"
            if prior["normalized_ast_hash"] == symbol["normalized_ast_hash"]
            else "modified"
        )
        symbol["signature_base"] = prior["signature"] if prior else None
        symbol["signature_current"] = symbol["signature"]
        symbol["complexity_base"] = prior["complexity"] if prior else None
        symbol["complexity_current"] = symbol["complexity"]
        model.symbols.append(_public_symbol(symbol))
    for identity, symbol in before_symbols.items():
        if identity not in current_symbols:
            deleted = _public_symbol(symbol)
            deleted["classification"] = "removed"
            deleted["signature_base"] = symbol["signature"]
            deleted["signature_current"] = None
            deleted["complexity_base"] = symbol["complexity"]
            deleted["complexity_current"] = None
            model.symbols.append(deleted)

    module_ids = {name: stable_id("module", name) for name in current}
    symbol_ids = {identity: symbol["id"] for identity, symbol in current_symbols.items()}
    short_symbols: dict[tuple[str, str], str] = {}
    classes: dict[tuple[str, str], str] = {}
    for symbol in current_symbols.values():
        short_symbols[(symbol["module"], symbol["name"])] = symbol["id"]
        short_symbols[(symbol["module"], symbol["qualname"])] = symbol["id"]
        if symbol["kind"] == "class":
            classes[(symbol["module"], symbol["name"])] = symbol["id"]
    for module in current.values():
        _module_edges(model, module, current, module_ids, symbol_ids, short_symbols, classes, declared_packages)
    for edge in model.edges:
        edge["change"] = "added"

    baseline_model = ReviewModel({})
    baseline_module_ids = {name: stable_id("module", name) for name in baseline}
    baseline_symbol_ids = {identity: symbol["id"] for identity, symbol in before_symbols.items()}
    baseline_short: dict[tuple[str, str], str] = {}
    baseline_classes: dict[tuple[str, str], str] = {}
    for symbol in before_symbols.values():
        baseline_short[(symbol["module"], symbol["name"])] = symbol["id"]
        baseline_short[(symbol["module"], symbol["qualname"])] = symbol["id"]
        if symbol["kind"] == "class":
            baseline_classes[(symbol["module"], symbol["name"])] = symbol["id"]
    for module in baseline.values():
        _module_edges(
            baseline_model, module, baseline, baseline_module_ids, baseline_symbol_ids,
            baseline_short, baseline_classes, baseline_declared_packages or set(),
        )
    current_semantic: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    baseline_semantic: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for edge in model.edges:
        current_semantic[(edge["kind"], edge["source"], edge["target"])].append(edge)
    for edge in baseline_model.edges:
        baseline_semantic[(edge["kind"], edge["source"], edge["target"])].append(edge)
    baseline_evidence = {item["id"]: item for item in baseline_model.evidence}
    for key in sorted(set(current_semantic) | set(baseline_semantic)):
        current_edges = sorted(current_semantic.get(key, []), key=lambda edge: edge["id"])
        baseline_edges = sorted(baseline_semantic.get(key, []), key=lambda edge: edge["id"])
        shared_count = min(len(current_edges), len(baseline_edges))
        for edge in current_edges[:shared_count]:
            edge["change"] = "unchanged"
        for edge in baseline_edges[shared_count:]:
            edge["change"] = "removed"
            model.edges.append(edge)
            for evidence_id in edge["evidence_ids"]:
                evidence = baseline_evidence.get(evidence_id)
                if evidence:
                    model.evidence.append(evidence)
    _aggregates(model, baseline, current, baseline_module_ids, module_ids)


def _parse_sets(
    baseline_files: dict[str, bytes], current_files: dict[str, bytes], model: ReviewModel
) -> tuple[dict[str, ParsedModule], dict[str, ParsedModule]]:
    results: list[dict[str, ParsedModule]] = []
    for files in (baseline_files, current_files):
        modules: dict[str, ParsedModule] = {}
        for path, data in sorted(files.items()):
            if not path.endswith(".py"):
                continue
            module, warning = parse_module(path, data)
            if warning:
                model.warnings.append(warning)
            elif module:
                modules[module.name] = module
        results.append(modules)
    return results[0], results[1]


def _public_symbol(symbol: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in symbol.items() if not key.startswith("_")}


def _module_edges(
    model: ReviewModel,
    module: ParsedModule,
    modules: dict[str, ParsedModule],
    module_ids: dict[str, str],
    symbol_ids: dict[str, str],
    short_symbols: dict[tuple[str, str], str],
    classes: dict[tuple[str, str], str],
    declared_packages: set[str],
) -> None:
    aliases = {item["local"]: item for item in module.imports}
    for item in module.imports:
        target_module = item["target"]
        resolved_module = target_module
        if item["member"] and f"{target_module}.{item['member']}" in modules:
            resolved_module = f"{target_module}.{item['member']}"
        item["resolved_target"] = resolved_module
        if resolved_module in module_ids:
            _add_edge(
                model, "imports", module_ids[module.name], module_ids[resolved_module], 1.0,
                module.path, item["line"], f"import {resolved_module}",
            )
        top = target_module.split(".")[0]
        if top and top in declared_packages and target_module not in modules:
            _add_edge(
                model, "uses_package", module_ids[module.name], f"package:{top}", 0.9,
                module.path, item["line"], f"import {target_module}",
            )
    for node in ast.walk(module.tree):
        if isinstance(node, ast.ClassDef):
            source = symbol_ids.get(f"{module.name}:{node.name}")
            if source:
                for base in node.bases:
                    target = _resolve_expr(base, module, aliases, short_symbols, classes, method=False)
                    if target:
                        _add_edge(model, "inherits", source, target[0], target[1], module.path,
                                  node.lineno, ast.unparse(base))
        elif isinstance(node, ast.Call):
            owner = _containing_symbol(module, node)
            source = owner["id"] if owner else module_ids[module.name]
            target = _resolve_expr(node.func, module, aliases, short_symbols, classes, method=True, owner=owner)
            if target:
                _add_edge(model, "calls", source, target[0], target[1], module.path,
                          node.lineno, ast.unparse(node.func))


def _resolve_expr(
    expression: ast.AST,
    module: ParsedModule,
    aliases: dict[str, dict[str, Any]],
    symbols: dict[tuple[str, str], str],
    classes: dict[tuple[str, str], str],
    method: bool,
    owner: dict[str, Any] | None = None,
) -> tuple[str, float] | None:
    if isinstance(expression, ast.Name):
        if (module.name, expression.id) in symbols:
            return symbols[(module.name, expression.id)], 1.0
        imported = aliases.get(expression.id)
        if imported and imported["member"]:
            target = symbols.get((imported["target"], imported["member"]))
            return (target, 1.0) if target else None
    parts = _expression_parts(expression)
    if parts and len(parts) > 1:
        root, attributes = parts[0], parts[1:]
        if root in ("self", "cls") and owner and "." in owner["qualname"]:
            class_name = owner["qualname"].split(".")[0]
            target = symbols.get((module.name, ".".join([class_name, *attributes])))
            return (target, 0.95) if target else None
        local_target = symbols.get((module.name, ".".join(parts)))
        if local_target:
            return local_target, 0.95
        imported = aliases.get(root)
        if imported:
            target_module = imported.get("resolved_target", imported["target"])
            if imported.get("resolved_target") != imported["target"]:
                qualifier = ".".join(attributes)
            elif imported["member"]:
                qualifier = ".".join([imported["member"], *attributes])
            else:
                target_parts = target_module.split(".")
                remaining = attributes
                overlap = min(len(attributes), len(target_parts) - 1)
                if overlap and attributes[:overlap] == target_parts[-overlap:]:
                    remaining = attributes[overlap:]
                qualifier = ".".join(remaining)
            target = symbols.get((target_module, qualifier))
            if target:
                return target, 1.0
            if imported["member"]:
                nested = symbols.get((target_module, imported["member"]))
                if nested and not method:
                    return nested, 0.9
    return None


def _expression_parts(expression: ast.AST) -> list[str] | None:
    parts: list[str] = []
    current = expression
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if not isinstance(current, ast.Name):
        return None
    parts.append(current.id)
    return list(reversed(parts))


def _aggregates(
    model: ReviewModel,
    baseline: dict[str, ParsedModule],
    modules: dict[str, ParsedModule],
    baseline_module_ids: dict[str, str],
    module_ids: dict[str, str],
) -> None:
    all_modules = {**baseline, **modules}
    all_module_ids = {**baseline_module_ids, **module_ids}
    for name, module in all_modules.items():
        before, current = baseline.get(name), modules.get(name)
        change = (
            "added" if before is None else "removed" if current is None
            else "unchanged" if before.ast_hash == current.ast_hash else "modified"
        )
        model.aggregates["modules"].append(
            {
                "id": all_module_ids[module.name],
                "name": module.name,
                "path": module.path,
                "component": component_name(module.path),
                "symbol_ids": sorted(symbol["id"] for symbol in module.symbols),
                "ast_hash": module.ast_hash,
                "source_hash": module.source_hash,
                "change": change,
            }
        )
    component_modules: dict[str, list[str]] = defaultdict(list)
    for module in all_modules.values():
        component_modules[component_name(module.path)].append(all_module_ids[module.name])
    component_ids = {name: stable_id("component", name) for name in component_modules}
    for name, ids in component_modules.items():
        model.aggregates["components"].append(
            {"id": component_ids[name], "name": name, "module_ids": sorted(ids)}
        )
    module_by_id = {value: name for name, value in all_module_ids.items()}
    grouped: dict[tuple[str, str, str, str], list[str]] = defaultdict(list)
    for edge in model.edges:
        source_module = _edge_module(edge["source"], model.symbols, module_by_id)
        target_module = _edge_module(edge["target"], model.symbols, module_by_id)
        if source_module and target_module and source_module != target_module:
            grouped[("module", edge["kind"], all_module_ids[source_module], all_module_ids[target_module])].append(edge["id"])
            source_component = component_ids[component_name(all_modules[source_module].path)]
            target_component = component_ids[component_name(all_modules[target_module].path)]
            if source_component != target_component:
                grouped[("component", edge["kind"], source_component, target_component)].append(edge["id"])
    edges_by_id = {edge["id"]: edge for edge in model.edges}
    for (level, kind, source, target), ids in grouped.items():
        added = sum(edges_by_id[value]["change"] == "added" for value in set(ids))
        removed = sum(edges_by_id[value]["change"] == "removed" for value in set(ids))
        model.aggregates["edges"].append(
            {
                "id": stable_id("aggregate_edge", level, kind, source, target),
                "level": level,
                "kind": kind,
                "source": source,
                "target": target,
                "underlying_edge_ids": sorted(set(ids)),
                "count": len(set(ids)) - removed,
                "added_count": added,
                "removed_count": removed,
            }
        )


def _edge_module(
    identifier: str, symbols: Iterable[dict[str, Any]], module_by_id: dict[str, str]
) -> str | None:
    if identifier in module_by_id:
        return module_by_id[identifier]
    for symbol in symbols:
        if symbol["id"] == identifier:
            return symbol["module"]
    return None
