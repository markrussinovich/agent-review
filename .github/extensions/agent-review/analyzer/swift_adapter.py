"""Swift facts from the bundled parser; never evaluates a SwiftPM manifest."""
from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any

from git_snapshot import text_lines
from language_adapters import AnalysisSnapshot
from node_adapter import NODE_ADAPTER
from review_model import ReviewModel


def swift_input(path: str) -> bool:
    return path.lower().endswith(".swift") or PurePosixPath(path).name == "Package.resolved"


class SwiftAdapter:
    id = "swift"
    graph_phase = "swift_graph"
    graph_message = "Parsing saved Swift syntax and literal SwiftPM evidence"

    def applies(self, paths: set[str]) -> bool:
        return any(swift_input(path) for path in paths)

    def dependencies(self, snapshot: AnalysisSnapshot, warnings: list[str]) -> dict[str, Any]:
        trees: dict[str, dict[str, str]] = {"baseline": {}, "current": {}}
        invalid = set()
        for side, files in (("baseline", snapshot.baseline), ("current", snapshot.current)):
            for path, raw in files.items():
                if not swift_input(path):
                    continue
                try:
                    trees[side][path] = raw.decode("utf-8-sig")
                except UnicodeDecodeError:
                    invalid.add(path)
                    warnings.append(f"{path}: Swift input is not UTF-8; syntax/dependency evidence is unavailable.")
        for path in invalid:
            trees["baseline"].pop(path, None)
            trees["current"].pop(path, None)
        facts = NODE_ADAPTER._invoke("swift-analyzer.mjs", trees)
        # Per-review staging avoids reparsing both snapshots in scan().
        return {**facts.pop("dependencies"), "_analysis": facts, "_trees": trees}

    def scan(self, snapshot: AnalysisSnapshot, model: ReviewModel, dependencies: dict[str, Any], progress) -> None:
        trees, facts = dependencies.pop("_trees"), dependencies.pop("_analysis")
        for path in sorted(set(trees["baseline"]) | set(trees["current"])):
            model.source_files.setdefault(path, {}).update({
                "baseline": trees["baseline"].get(path), "current": trees["current"].get(path),
            })
        for key in ("symbols", "edges", "evidence", "warnings"):
            getattr(model, key).extend(facts[key])
        for key, values in facts["aggregates"].items():
            model.aggregates[key].extend(values)
        model.code_paths["swift"] = facts["code_paths"]
        model.repository["swift_loc"] = sum(len(text_lines(text)) for path, text in trees["current"].items()
                                           if path.lower().endswith(".swift"))
        progress(f"Analyzed {len(trees['current']):,} saved Swift inputs and {len(facts['symbols']):,} symbols", 67)

    def resolve_package_usage(self, model: ReviewModel, dependencies: dict[str, Any]) -> None:
        pass

    def coverage(self, snapshot: AnalysisSnapshot) -> dict[str, Any]:
        from lcov_coverage import load_snapshot_lcov

        return load_snapshot_lcov(snapshot, name="swift", language="Swift", extensions=(".swift",),
                                  strip_bom=True, strict_snapshot=True, additional_inputs=("Package.resolved",))


SWIFT_ADAPTER = SwiftAdapter()
