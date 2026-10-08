from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

from review_model import ReviewModel


@dataclass(frozen=True)
class AnalysisSnapshot:
    repo: Path
    baseline: dict[str, bytes]
    current: dict[str, bytes]
    base_commit: str | None
    historical: bool
    use_cache: bool
    head_commit: str | None = None


class LanguageAdapter(Protocol):
    """Adapters contribute snapshot facts, never restore dependencies or execute project code."""

    id: str
    graph_phase: str
    graph_message: str

    def applies(self, paths: set[str]) -> bool: ...

    def dependencies(self, snapshot: AnalysisSnapshot, warnings: list[str]) -> dict[str, Any]: ...

    def scan(
        self, snapshot: AnalysisSnapshot, model: ReviewModel,
        dependencies: dict[str, Any], progress: Callable[[str, int], None],
    ) -> None: ...

    def resolve_package_usage(self, model: ReviewModel, dependencies: dict[str, Any]) -> None: ...

    def coverage(self, snapshot: AnalysisSnapshot) -> dict[str, Any]: ...


def active_adapters(
    snapshot: AnalysisSnapshot, adapters: Sequence[LanguageAdapter] | None = None,
) -> tuple[LanguageAdapter, ...]:
    paths = set(snapshot.baseline) | set(snapshot.current)
    if adapters is None:
        from python_adapter import PYTHON_ADAPTER

        adapters = (PYTHON_ADAPTER,)
        if any(path.lower().endswith((".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"))
               or path.rsplit("/", 1)[-1] in {"package.json", "package-lock.json", "npm-shrinkwrap.json"}
               for path in paths):
            from node_adapter import NODE_ADAPTER

            adapters += (NODE_ADAPTER,)
        if any(path.lower().endswith((".cs", ".csproj", ".sln", ".slnx"))
               for path in paths):
            from dotnet_adapter import DOTNET_ADAPTER

            adapters = (*adapters, DOTNET_ADAPTER)
        if any(path.lower().endswith(".rs") or PurePosixPath(path).name in {"Cargo.toml", "Cargo.lock"}
               for path in paths):
            from rust_adapter import RUST_ADAPTER

            adapters = (*adapters, RUST_ADAPTER)
    ids = [adapter.id for adapter in adapters]
    if len(ids) != len(set(ids)):
        raise ValueError("Language adapters must have unique IDs.")
    return tuple(adapter for adapter in adapters if adapter.applies(paths))


def merge_coverage(reports: list[dict[str, Any]]) -> dict[str, Any]:
    available = [report for report in reports if report.get("available")]
    if not available:
        return {"available": False, "files": [], "changed_lines": {}}
    if len(available) == 1:
        return available[0]
    files: dict[str, dict[str, Any]] = {}
    changed: dict[str, Any] = {}
    for report in available:
        for file in report["files"]:
            if file["path"] in files:
                raise ValueError(f"Multiple coverage adapters claimed {file['path']}.")
            files[file["path"]] = file
        for path, value in report["changed_lines"].items():
            if path in changed:
                raise ValueError(f"Multiple coverage adapters claimed changed lines for {path}.")
            changed[path] = value
    return {
        "available": True, "sources": [report.get("source") for report in available],
        "files": [files[path] for path in sorted(files)], "changed_lines": changed,
    }
