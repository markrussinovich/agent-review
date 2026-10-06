from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any


def stable_id(kind: str, *parts: object) -> str:
    value = "\0".join([kind, *(str(part) for part in parts)])
    return f"{kind}:{hashlib.sha256(value.encode()).hexdigest()[:16]}"


def package_key(package: dict[str, Any]) -> str:
    ecosystem = package.get("ecosystem")
    return f"{ecosystem}:{package['name']}" if ecosystem and ecosystem != "pypi" else package["name"]


def package_identity(package: dict[str, Any]) -> dict[str, Any]:
    return {"ecosystem": package["ecosystem"]} if package.get("ecosystem") else {}


def resolved_package_version(declarations: list[dict[str, Any]]) -> str | None:
    if any(item.get("ecosystem") == "npm" for item in declarations):
        versions = {item.get("resolved_version") for item in declarations}
        return next(iter(versions)) if len(versions) == 1 else None
    return next((item["resolved_version"] for item in declarations if "resolved_version" in item), None)


@dataclass
class ReviewModel:
    repository: dict[str, Any]
    changes: list[dict[str, Any]] = field(default_factory=list)
    source_files: dict[str, dict[str, object]] = field(default_factory=dict)
    symbols: list[dict[str, Any]] = field(default_factory=list)
    edges: list[dict[str, Any]] = field(default_factory=list)
    aggregates: dict[str, list[dict[str, Any]]] = field(
        default_factory=lambda: {"modules": [], "components": [], "edges": []}
    )
    packages: dict[str, Any] = field(
        default_factory=lambda: {"current": [], "baseline": [], "changes": []}
    )
    coverage: dict[str, Any] = field(
        default_factory=lambda: {"available": False, "files": [], "changed_lines": {}}
    )
    churn: list[dict[str, Any]] = field(default_factory=list)
    codeboarding: dict[str, Any] = field(
        default_factory=lambda: {"available": False, "components": []}
    )
    evidence: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def add_evidence(self, kind: str, data: dict[str, Any]) -> str:
        canonical = json.dumps(data, sort_keys=True, separators=(",", ":"))
        evidence_id = stable_id("evidence", kind, canonical)
        self.evidence.append({"id": evidence_id, "kind": kind, **data})
        return evidence_id

    def to_dict(self) -> dict[str, Any]:
        self._sort()
        nodes = self._nodes()
        for node in nodes:
            node["kind"] = node["type"]
        node_by_id = {node["id"]: node for node in nodes}
        edges = [
            {
                "id": edge["id"],
                "type": edge.get("type", edge["kind"]),
                "source": edge["source"],
                "target": edge["target"],
                "change": edge.get("change", "unchanged"),
                "confidence": edge["confidence"],
                "count": edge.get("count", 1),
                "evidence_ids": edge["evidence_ids"],
                **({"language": edge["language"]} if edge.get("language") else {}),
            }
            for edge in self.edges
        ]
        self._add_attention_evidence(nodes, edges, node_by_id)
        attention = self._attention(nodes, edges, node_by_id)
        changed = [item for item in self.changes if item["status"] != "unchanged"]
        package_changes = self._package_changes()
        for package in package_changes:
            usage_count = len(package["usage_locations"])
            score = 62 if package["change"] == "added" else 48
            if package["change"] == "added" and usage_count == 0:
                score += 12
            attention.append({
                "id": stable_id("attention", "package", package["id"][8:]),
                "type": "package",
                "package_id": package["id"],
                "title": f"Package dependency {package['change']}",
                "message": f"Package dependency {package['change']}",
                "reason": (
                    f"{package['name']} is declared as {self._declared_package_text(package['declared_current']) or 'removed'}; "
                    f"{usage_count} repository usage location{'s' if usage_count != 1 else ''} resolved."
                ),
                "severity": "medium" if score >= 50 else "low",
                "impact_score": score,
                "impact_factors": [
                    f"dependency {package['change']}",
                    f"{usage_count} usage locations",
                ],
                "evidence_ids": package["evidence_ids"],
            })
        attention.sort(key=lambda item: (-int(item.get("impact_score", 0)), item["title"], item["id"]))
        package_dependencies = self._package_dependencies(package_changes)
        changed_symbols = [
            node for node in nodes
            if node["type"] in ("class", "function", "method") and node["change"] != "unchanged"
        ]
        changed_modules = [
            node for node in nodes if node["type"] == "module" and node["change"] != "unchanged"
        ]
        new_architecture = [
            edge for edge in edges
            if edge["change"] == "added" and edge["type"] in ("imports", "inherits")
        ]
        changed_uncovered = [
            node for node in nodes
            if node["type"] in ("function", "method")
            and node["change"] != "removed"
            and node["metrics"]["changed_lines_uncovered"] > 0
        ]
        evidence = {
            item["id"]: {key: value for key, value in item.items() if key != "id"}
            for item in sorted(self.evidence, key=lambda item: item["id"])
        }
        return {
            "source_files": self.source_files,
            "metadata": {
                "schema_version": 1,
                "repo_root": self.repository.get("root"),
                "base_ref": self.repository.get("base_ref"),
                "base_sha": self.repository.get("base_commit"),
                "head_sha": self.repository.get("head"),
                "generated_at": self.repository.get("generated_at"),
                "python_loc": self.repository.get("python_loc", 0),
                **({"node_loc": self.repository["node_loc"]} if "node_loc" in self.repository else {}),
            },
            "summary": {
                "files_changed": len(changed),
                "files_added": sum(item["status"] == "added" for item in changed),
                "files_removed": sum(item["status"] in ("removed", "deleted") for item in changed),
                "files_modified": sum(item["status"] == "modified" for item in changed),
                "lines_added": sum(int(item.get("lines_added", 0)) for item in changed),
                "lines_removed": sum(int(item.get("lines_removed", 0)) for item in changed),
                "modules_changed": len(changed_modules),
                "symbols_changed": len(changed_symbols),
                "symbols_added": sum(node["change"] == "added" for node in changed_symbols),
                "symbols_removed": sum(node["change"] == "removed" for node in changed_symbols),
                "symbols_modified": sum(node["change"] == "modified" for node in changed_symbols),
                "new_arch_edges": len(new_architecture),
                "arch_edges_removed": sum(
                    edge["change"] == "removed" and edge["type"] in ("imports", "inherits")
                    for edge in edges
                ),
                "new_packages": sum(item["change"] == "added" for item in package_changes),
                "packages_removed": sum(item["change"] == "removed" for item in package_changes),
                "packages_modified": sum(item["change"] == "modified" for item in package_changes),
                "changed_functions_uncovered": len(changed_uncovered),
            },
            "nodes": nodes,
            "edges": edges,
            "aggregate_edges": self.aggregates["edges"],
            "package_changes": package_changes,
            "package_dependencies": package_dependencies,
            "attention": attention,
            "evidence": evidence,
            "warnings": sorted(set(self.warnings)),
            # Detailed analyzer data retained as non-authoritative diagnostics.
            "repository": self.repository,
            "changes": self.changes,
            "symbols": self.symbols,
            "aggregates": self.aggregates,
            "packages": self.packages,
            "coverage": self.coverage,
            "churn": self.churn,
            "codeboarding": self.codeboarding,
        }

    def _nodes(self) -> list[dict[str, Any]]:
        churn = {item["path"]: item for item in self.churn}
        changes_by_path = {item["path"]: item for item in self.changes}
        coverage = {item["path"]: item for item in self.coverage["files"]}
        changed_coverage = self.coverage.get("changed_lines", {})
        modules = {item["name"]: item for item in self.aggregates["modules"]}
        component_ids = {
            item["name"]: item["id"] for item in self.aggregates["components"]
        }
        call_edges = [
            edge for edge in self.edges
            if edge["kind"] == "calls" and edge.get("change") != "removed"
        ]
        reverse: dict[str, set[str]] = {}
        for edge in call_edges:
            reverse.setdefault(edge["target"], set()).add(edge["source"])

        def callers(identifier: str) -> tuple[list[str], list[str]]:
            direct = sorted(reverse.get(identifier, set()))
            visited, pending = set(direct), list(direct)
            while pending:
                current = pending.pop()
                for caller in reverse.get(current, set()):
                    if caller not in visited:
                        visited.add(caller)
                        pending.append(caller)
            return direct, sorted(visited - set(direct))

        def metrics(path: str | None, start: int | None = None, end: int | None = None) -> dict[str, Any]:
            file_coverage = coverage.get(path or "", {})
            changed = changed_coverage.get(path or "", {})
            covered_lines = set(changed.get("covered_lines", []))
            uncovered_lines = set(changed.get("uncovered_lines", []))
            if start is not None and end is not None:
                covered_lines = {line for line in covered_lines if start <= line <= end}
                uncovered_lines = {line for line in uncovered_lines if start <= line <= end}
            executable_lines = set(file_coverage.get("executable_lines", []))
            file_covered_lines = set(file_coverage.get("covered_lines", []))
            if start is not None and end is not None:
                executable_lines = {line for line in executable_lines if start <= line <= end}
                file_covered_lines = {line for line in file_covered_lines if start <= line <= end}
            executable_count = len(executable_lines)
            covered_count = len(file_covered_lines)
            file_change = changes_by_path.get(path or "", {})
            added_lines = set(file_change.get("added_lines", []))
            removed_lines = set(file_change.get("removed_lines", []))
            if start is not None and end is not None:
                added_lines = {line for line in added_lines if start <= line <= end}
                removed_lines = {line for line in removed_lines if start <= line <= end}
            return {
                "complexity_base": None,
                "complexity_current": None,
                "signature_base": None,
                "signature_current": None,
                "coverage_percent": round(100 * covered_count / executable_count, 2) if executable_count else None,
                "changed_lines_total": len(covered_lines) + len(uncovered_lines),
                "changed_lines_covered": len(covered_lines),
                "changed_lines_uncovered": len(uncovered_lines),
                "changed_lines_coverage_percent": (
                    round(100 * len(covered_lines) / (len(covered_lines) + len(uncovered_lines)), 2)
                    if covered_lines or uncovered_lines else None
                ),
                "lines_added": len(added_lines),
                "lines_removed": len(removed_lines),
                "lines_changed": len(added_lines) + len(removed_lines),
                "churn_commits_90d": int(churn.get(path or "", {}).get("commits", 0)),
                "churn_additions_90d": int(churn.get(path or "", {}).get("additions", 0)),
                "churn_deletions_90d": int(churn.get(path or "", {}).get("deletions", 0)),
                "direct_callers": 0,
                "transitive_callers": 0,
            }

        result: list[dict[str, Any]] = []
        module_by_id = {item["id"]: item for item in self.aggregates["modules"]}
        for component in self.aggregates["components"]:
            changes = [
                module["change"] for module in self.aggregates["modules"]
                if module["id"] in component["module_ids"]
            ]
            change = "unchanged"
            if changes and all(value == "added" for value in changes):
                change = "added"
            elif changes and all(value == "removed" for value in changes):
                change = "removed"
            elif any(value != "unchanged" for value in changes):
                change = "modified"
            component_metrics = metrics(None)
            component_paths = [
                module_by_id[module_id]["path"]
                for module_id in component["module_ids"]
                if module_id in module_by_id
            ]
            component_metrics["lines_added"] = sum(
                int(changes_by_path.get(path, {}).get("lines_added", 0)) for path in component_paths
            )
            component_metrics["lines_removed"] = sum(
                int(changes_by_path.get(path, {}).get("lines_removed", 0)) for path in component_paths
            )
            component_metrics["lines_changed"] = (
                component_metrics["lines_added"] + component_metrics["lines_removed"]
            )
            result.append({
                "id": component["id"], "type": "component", "name": component["name"],
                "parent_id": None, "module_id": None, "component_id": component["id"],
                "path": None, "start_line": None, "end_line": None, "change": change,
                "metrics": component_metrics, "signatures": {"base": None, "current": None},
            })
        for module in self.aggregates["modules"]:
            component_id = component_ids[module["component"]]
            result.append({
                "id": module["id"], "type": "module", "name": module["name"],
                "parent_id": component_id, "module_id": module["id"],
                "component_id": component_id, "path": module["path"],
                "start_line": 1, "end_line": self._line_count(module["path"]),
                "change": module["change"], "metrics": metrics(module["path"]),
                "signatures": {"base": None, "current": None},
                **({"language": module["language"]} if module.get("language") else {}),
            })
        symbol_ids = {symbol["identity"]: symbol["id"] for symbol in self.symbols}
        for symbol in self.symbols:
            module = modules.get(symbol["module"])
            if not module:
                continue
            component_id = component_ids[module["component"]]
            parent_id = module["id"]
            if "." in symbol["qualname"]:
                parent_identity = f"{symbol['module']}:{symbol['qualname'].rsplit('.', 1)[0]}"
                parent_id = symbol_ids.get(parent_identity, parent_id)
            direct, transitive = callers(symbol["id"])
            value_metrics = metrics(
                symbol["path"], symbol["range"]["start_line"], symbol["range"]["end_line"]
            )
            value_metrics.update({
                "complexity_base": symbol.get("complexity_base"),
                "complexity_current": symbol.get("complexity_current"),
                "signature_base": symbol.get("signature_base"),
                "signature_current": symbol.get("signature_current"),
                "direct_callers": len(direct),
                "transitive_callers": len(transitive),
            })
            result.append({
                "id": symbol["id"], "type": symbol["kind"], "name": symbol["name"],
                "display_name": symbol["qualname"] if symbol["kind"] == "method" else symbol["name"],
                "qualified_name": f"{symbol['module']}.{symbol['qualname']}",
                "parent_id": parent_id, "module_id": module["id"],
                "component_id": component_id, "path": symbol["path"],
                "start_line": symbol["range"]["start_line"],
                "end_line": symbol["range"]["end_line"],
                "change": symbol["classification"], "metrics": value_metrics,
                "fields": symbol.get("fields", []),
                "signatures": {
                    "base": symbol.get("signature_base"),
                    "current": symbol.get("signature_current"),
                },
                **({"language": symbol["language"]} if symbol.get("language") else {}),
            })
        package_names = sorted(
            {package_key(item) for item in self.packages["baseline"]}
            | {package_key(item) for item in self.packages["current"]}
        )
        changes = {package_key(item): item["kind"] for item in self.packages["changes"]}
        declarations = {package_key(item): item for item in self.packages["baseline"] + self.packages["current"]}
        change_map = {"version_changed": "modified", "added": "added", "removed": "removed"}
        for name in package_names:
            result.append({
                "id": f"package:{name}", "type": "package", "name": declarations[name]["name"],
                **package_identity(declarations[name]),
                "parent_id": None, "module_id": None, "component_id": None,
                "path": None, "start_line": None, "end_line": None,
                "change": change_map.get(changes.get(name, ""), "unchanged"),
                "metrics": metrics(None), "signatures": {"base": None, "current": None},
            })
        return sorted(result, key=lambda item: item["id"])

    def _line_count(self, path: str) -> int:
        for item in self.changes:
            if item["path"] == path:
                return int(item.get("current_lines") or item.get("baseline_lines") or 0)
        return 0

    def _package_changes(self) -> list[dict[str, Any]]:
        baseline: dict[str, list[dict[str, Any]]] = {}
        current: dict[str, list[dict[str, Any]]] = {}
        for item in self.packages["baseline"]:
            baseline.setdefault(package_key(item), []).append(item)
        for item in self.packages["current"]:
            current.setdefault(package_key(item), []).append(item)
        change_kind = {package_key(item): item["kind"] for item in self.packages["changes"]}
        result = []
        for name in sorted(set(baseline) | set(current)):
            if name not in change_kind:
                continue
            declaration = (current.get(name) or baseline[name])[0]
            usage = sorted({
                source
                for item in current.get(name, [])
                for source in item.get("used_by", [])
            })
            evidence_ids = sorted({
                evidence
                for edge in self.edges
                if edge["kind"] == "uses_package" and edge["target"] == f"package:{name}"
                for evidence in edge["evidence_ids"]
            })
            if not evidence_ids:
                evidence_ids = [self.add_evidence(
                    "package_change",
                    {
                        "name": declaration["name"],
                        **package_identity(declaration),
                        "change": change_kind.get(name, "unchanged"),
                        "declared_base": baseline.get(name, []),
                        "declared_baseline": baseline.get(name, []),
                        "declared_current": current.get(name, []),
                    },
                )]
            result.append({
                "id": f"package:{name}", "name": declaration["name"],
                **package_identity(declaration),
                "change": {"version_changed": "modified"}.get(
                    change_kind.get(name, "unchanged"), change_kind.get(name, "unchanged")
                ),
                "declared_base": baseline.get(name, []),
                "declared_baseline": baseline.get(name, []),
                "declared_current": current.get(name, []),
                "resolved_current": resolved_package_version(current.get(name, [])),
                "usage_locations": usage,
                "evidence_ids": evidence_ids,
            })
        return result

    @staticmethod
    def _declared_package_text(declarations: list[dict[str, Any]]) -> str:
        return ", ".join(
            f"{item['name']}{item.get('specifier', '')}" for item in declarations
        )

    def _package_dependencies(
        self, package_changes: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        changes = {package_key(item): item for item in package_changes}
        grouped: dict[str, list[dict[str, Any]]] = {}
        baseline: dict[str, list[dict[str, Any]]] = {}
        for item in self.packages["baseline"]:
            baseline.setdefault(package_key(item), []).append(item)
        for item in self.packages["current"]:
            grouped.setdefault(package_key(item), []).append(item)
        result = []
        for name, declarations in sorted(grouped.items()):
            change = changes.get(name)
            result.append({
                "id": f"package:{name}",
                "name": declarations[0]["name"],
                **package_identity(declarations[0]),
                "change": change["change"] if change else "unchanged",
                "declared_current": declarations,
                "declared_baseline": baseline.get(name, []),
                "resolved_current": resolved_package_version(declarations),
                "usage_locations": sorted({
                    source for item in declarations for source in item.get("used_by", [])
                }),
                "evidence_ids": change["evidence_ids"] if change else [],
            })
        return result

    def _add_attention_evidence(
        self, nodes: list[dict[str, Any]], edges: list[dict[str, Any]], node_by_id: dict[str, dict[str, Any]]
    ) -> None:
        for node in nodes:
            metrics = node["metrics"]
            if (
                metrics["complexity_base"] is not None
                and metrics["complexity_current"] is not None
                and metrics["complexity_current"] > metrics["complexity_base"]
            ):
                node["_complexity_evidence"] = self.add_evidence(
                    "complexity", {"path": node["path"], "line": node["start_line"],
                                   "detail": f"{metrics['complexity_base']} -> {metrics['complexity_current']}"}
                )
            elif (
                metrics["complexity_base"] is None
                and metrics["complexity_current"] is not None
                and metrics["complexity_current"] >= 8
            ):
                node["_new_complexity_evidence"] = self.add_evidence(
                    "complexity", {"path": node["path"], "line": node["start_line"],
                                   "detail": f"New callable complexity {metrics['complexity_current']}"}
                )
            if node["signatures"]["base"] != node["signatures"]["current"] and node["change"] == "modified":
                node["_signature_evidence"] = self.add_evidence(
                    "signature", {"path": node["path"], "line": node["start_line"],
                                  "detail": f"{node['signatures']['base']} -> {node['signatures']['current']}"}
                )
            if metrics["changed_lines_uncovered"] > 0 and node["type"] in ("function", "method"):
                node["_coverage_evidence"] = self.add_evidence(
                    "coverage", {"path": node["path"], "line": node["start_line"],
                                 "detail": f"{metrics['changed_lines_uncovered']} changed lines uncovered"}
                )
            caller_count = metrics["direct_callers"] + metrics["transitive_callers"]
            if caller_count >= 3 and node["change"] != "unchanged":
                node["_impact_evidence"] = self.add_evidence(
                    "broad_impact", {"path": node["path"], "line": node["start_line"],
                                     "detail": f"{caller_count} direct/transitive callers"}
                )
            if metrics["lines_changed"] >= 25 and node["type"] in ("module", "class", "function", "method"):
                node["_size_evidence"] = self.add_evidence(
                    "line_delta", {"path": node["path"], "line": node["start_line"],
                                   "detail": f"+{metrics['lines_added']} / -{metrics['lines_removed']} lines"}
                )

    def _attention(
        self, nodes: list[dict[str, Any]], edges: list[dict[str, Any]], node_by_id: dict[str, dict[str, Any]]
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        def append_finding(
            node: dict[str, Any], kind: str, key: str, title: str,
            reason: str, score: int, factors: list[str],
        ) -> None:
            if key not in node:
                return
            test_only = str(node.get("path") or "").startswith(("tests/", "test/"))
            adjusted_score = max(0, score - (15 if test_only else 0))
            adjusted_factors = [*factors, *(["test code"] if test_only else [])]
            severity = "high" if adjusted_score >= 80 else "medium" if adjusted_score >= 50 else "low"
            result.append({
                "id": stable_id("attention", kind, node["id"]),
                "type": kind, "node_id": node["id"], "message": title,
                "title": title, "reason": reason, "severity": severity,
                "impact_score": min(100, adjusted_score), "impact_factors": adjusted_factors,
                "evidence_ids": [node[key]],
            })
            del node[key]
        for node in nodes:
            metrics = node["metrics"]
            callers = metrics["direct_callers"] + metrics["transitive_callers"]
            delta = (
                metrics["complexity_current"] - metrics["complexity_base"]
                if metrics["complexity_base"] is not None and metrics["complexity_current"] is not None
                else 0
            )
            append_finding(
                node, "complexity", "_complexity_evidence", "Cyclomatic complexity increased",
                f"{node['name']} increased from {metrics['complexity_base']} to {metrics['complexity_current']} "
                f"and affects {callers} caller{'s' if callers != 1 else ''}.",
                45 + min(30, delta * 5) + min(18, callers),
                [f"complexity +{delta}", f"{callers} callers"],
            )
            append_finding(
                node, "new_complexity", "_new_complexity_evidence", "Complex new callable added",
                f"New {node['type']} {node['name']} has cyclomatic complexity "
                f"{metrics['complexity_current']} across {metrics['lines_changed']} changed lines.",
                32 + min(44, int(metrics["complexity_current"] or 0) * 4),
                [f"complexity {metrics['complexity_current']}", f"{metrics['lines_changed']} changed lines"],
            )
            append_finding(
                node, "signature", "_signature_evidence", "Public callable contract changed",
                f"{node['name']} changed its signature with {callers} direct or transitive callers to verify.",
                50 + min(32, callers * 3),
                ["signature changed", f"{callers} callers"],
            )
            append_finding(
                node, "uncovered", "_coverage_evidence", "Changed logic lacks coverage",
                f"{node['name']} has {metrics['changed_lines_uncovered']} changed executable lines without coverage.",
                56 + min(34, metrics["changed_lines_uncovered"] * 3),
                [f"{metrics['changed_lines_uncovered']} uncovered changed lines"],
            )
            append_finding(
                node, "broad_impact", "_impact_evidence", "Change has broad caller impact",
                f"{node['name']} is reached by {callers} direct or transitive callers.",
                35 + min(45, callers * 3) + min(12, metrics["lines_changed"] // 10),
                [f"{callers} callers", f"{metrics['lines_changed']} changed lines"],
            )
            append_finding(
                node, "size", "_size_evidence", "Large implementation change",
                f"{node['name']} changes {metrics['lines_changed']} lines.",
                25 + min(55, metrics["lines_changed"] // 5),
                [f"+{metrics['lines_added']} / -{metrics['lines_removed']} lines"],
            )
        for edge in edges:
            source, target = node_by_id.get(edge["source"]), node_by_id.get(edge["target"])
            if (
                edge["change"] == "added" and edge["type"] in ("imports", "inherits")
                and source and target and source["component_id"] != target["component_id"]
            ):
                result.append({
                    "id": stable_id("attention", "architecture", edge["id"]),
                    "type": "architecture", "edge_id": edge["id"],
                    "message": "New cross-component architecture edge",
                    "title": "New cross-component architecture edge",
                    "reason": f"{source['name']} now depends on {target['name']}",
                    "severity": "medium",
                    "impact_score": 65 + min(20, int(edge.get("count", 1)) * 2),
                    "impact_factors": ["new cross-component dependency", f"{edge.get('count', 1)} relationships"],
                    "evidence_ids": edge["evidence_ids"],
                })
        return sorted(
            result,
            key=lambda item: (-int(item.get("impact_score", 0)), item["title"], item["id"]),
        )

    def _sort(self) -> None:
        self.changes.sort(key=lambda item: item["path"])
        self.symbols.sort(key=lambda item: item["id"])
        self.edges.sort(key=lambda item: item["id"])
        self.evidence.sort(key=lambda item: item["id"])
        self.churn.sort(key=lambda item: item["path"])
        for key in ("modules", "components", "edges"):
            self.aggregates[key].sort(key=lambda item: item["id"])
        for key in ("current", "baseline", "changes"):
            self.packages[key].sort(
                key=lambda item: (item.get("name", ""), item.get("kind", ""))
            )
        self.coverage["files"].sort(key=lambda item: item["path"])
