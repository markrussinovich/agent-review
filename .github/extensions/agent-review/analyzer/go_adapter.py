from __future__ import annotations

from collections.abc import Callable
from pathlib import PurePosixPath
from typing import Any

from go_coverage import load_go_coverage
from go_graph import analyze_go
from go_packages import go_package_diff, parse_go_packages
from language_adapters import AnalysisSnapshot
from review_model import ReviewModel


class GoAdapter:
    id = "go"
    graph_phase = "go_graph"
    graph_message = "Parsing saved Go packages, files, types, callables, imports, and calls"

    def applies(self, paths: set[str]) -> bool:
        return any(path.lower().endswith(".go") or PurePosixPath(path).name in {"go.mod", "go.sum"}
                   for path in paths)

    def dependencies(self, snapshot: AnalysisSnapshot, warnings: list[str]) -> dict[str, Any]:
        baseline = parse_go_packages(snapshot.baseline, warnings)
        current = parse_go_packages(snapshot.current, warnings)
        return {"baseline": baseline, "current": current,
                "changes": go_package_diff(baseline, current)}

    def scan(self, snapshot: AnalysisSnapshot, model: ReviewModel,
             dependencies: dict[str, Any], progress: Callable[[str, int], None]) -> None:
        paths = set(snapshot.baseline) | set(snapshot.current)
        for path in sorted(paths):
            if not (path.lower().endswith(".go") or PurePosixPath(path).name in {
                    "go.mod", "go.sum", "coverage.out", "cover.out", "coverage.txt",
                    "coverage.sources.json", "coverage.out.sources.json"}):
                continue
            saved = model.source_files.setdefault(path, {})
            for key, files in (("baseline", snapshot.baseline), ("current", snapshot.current)):
                raw = files.get(path)
                saved[key] = raw.decode("utf-8-sig", errors="replace") if raw is not None else None
        model.repository["go_loc"] = sum(
            len(raw.decode("utf-8", errors="replace").splitlines())
            for path, raw in snapshot.current.items() if path.lower().endswith(".go")
        )
        model.warnings.append(
            "Go saved-source analysis does not evaluate build tags, cgo, generated code, "
            "interface dispatch, reflection, or generic type inference; unresolved relationships remain unknown."
        )
        analyze_go(snapshot.baseline, snapshot.current, model,
                   {item["name"] for item in dependencies["current"]},
                   {item["name"] for item in dependencies["baseline"]})
        progress(f"Parsed {sum(path.lower().endswith('.go') for path in paths)} saved Go files", 66)

    def resolve_package_usage(self, model: ReviewModel, dependencies: dict[str, Any]) -> None:
        evidence = {item["id"]: item for item in model.evidence}
        usage: dict[str, set[str]] = {}
        for edge in model.edges:
            if edge.get("kind") != "uses_package" or edge.get("change") == "removed":
                continue
            locations = usage.setdefault(edge["target"], set())
            for identifier in edge.get("evidence_ids", []):
                item = evidence.get(identifier, {})
                if item.get("path"):
                    locations.add(f"{item['path']}:{item.get('line', 1)}")
        for package in dependencies["current"]:
            package["used_by"] = sorted(usage.get(f"package:gomod:{package['name']}", set()))

    def coverage(self, snapshot: AnalysisSnapshot) -> dict[str, Any]:
        return load_go_coverage(snapshot)


GO_ADAPTER = GoAdapter()
