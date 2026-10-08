from __future__ import annotations

from collections.abc import Callable
from pathlib import PurePosixPath
from typing import Any

from language_adapters import AnalysisSnapshot
from review_model import ReviewModel
from rust_graph import analyze_rust
from rust_packages import cargo_package_diff, parse_cargo_packages


class RustAdapter:
    id = "rust"
    graph_phase = "rust_graph"
    graph_message = "Parsing saved Rust crates, modules, symbols, imports, and calls"

    def applies(self, paths: set[str]) -> bool:
        return any(path.lower().endswith(".rs")
                   or PurePosixPath(path).name in {"Cargo.toml", "Cargo.lock"} for path in paths)

    def dependencies(self, snapshot: AnalysisSnapshot, warnings: list[str]) -> dict[str, Any]:
        baseline = parse_cargo_packages(snapshot.baseline, warnings)
        current = parse_cargo_packages(snapshot.current, warnings, strict=True)
        return {"baseline": baseline, "current": current,
                "changes": cargo_package_diff(baseline, current)}

    def scan(self, snapshot: AnalysisSnapshot, model: ReviewModel, dependencies: dict[str, Any],
             progress: Callable[[str, int], None]) -> None:
        for path in sorted(set(snapshot.baseline) | set(snapshot.current)):
            if not path.lower().endswith(".rs") and PurePosixPath(path).name not in {"Cargo.toml", "Cargo.lock"}:
                continue
            saved = model.source_files.setdefault(path, {})
            saved["baseline"] = (snapshot.baseline[path].decode("utf-8-sig", errors="replace")
                                 if path in snapshot.baseline else None)
            saved["current"] = (snapshot.current[path].decode("utf-8-sig", errors="replace")
                                if path in snapshot.current else None)
        model.repository["rust_loc"] = sum(
            len(raw.decode("utf-8", errors="replace").splitlines())
            for path, raw in snapshot.current.items() if path.lower().endswith(".rs")
        )
        facts = analyze_rust(snapshot.baseline, snapshot.current, model,
                             dependencies["baseline"], dependencies["current"])
        model.repository["rust_tests"] = facts["tests"]
        model.warnings.append(
            "Rust saved-syntax analysis does not expand macros, evaluate cfg/build scripts, "
            "or perform type-directed/dynamic trait dispatch; unresolved relationships remain unknown."
        )
        progress(f"Analyzed {len([path for path in snapshot.current if path.endswith('.rs')])} saved Rust files", 67)

    def resolve_package_usage(self, model: ReviewModel, dependencies: dict[str, Any]) -> None:
        evidence = {item["id"]: item for item in model.evidence}
        usage: dict[str, set[str]] = {}
        for edge in model.edges:
            if edge.get("kind") != "uses_package" or not edge["target"].startswith("package:cargo:"):
                continue
            locations = usage.setdefault(edge["target"][14:], set())
            for identifier in edge["evidence_ids"]:
                item = evidence.get(identifier, {})
                if item.get("path"):
                    locations.add(f"{item['path']}:{item.get('line', 1)}")
        for package in dependencies["current"]:
            package["used_by"] = sorted(usage.get(package["name"], set()))

    def coverage(self, snapshot: AnalysisSnapshot) -> dict[str, Any]:
        from rust_coverage import load_rust_coverage

        return load_rust_coverage(snapshot)


RUST_ADAPTER = RustAdapter()
