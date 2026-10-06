from __future__ import annotations

import hashlib
import json
import os
import sys
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Any

from coverage_data import load_coverage
from file_cache import FileScanCache
from git_snapshot import run_git
from language_adapters import AnalysisSnapshot
from packages import declared_import_names, import_name, package_diff, parse_packages, resolve_declared_versions
from python_graph import analyze_python
from review_model import ReviewModel


class PythonAdapter:
    id = "python"
    graph_phase = "python_graph"
    graph_message = "Parsing Python modules, symbols, imports, calls, and inheritance"

    def applies(self, paths: set[str]) -> bool:
        return any(path.endswith(".py") or path == "pyproject.toml"
                   or (PurePosixPath(path).name.lower().startswith("requirements") and path.lower().endswith(".txt"))
                   for path in paths)

    def dependencies(self, snapshot: AnalysisSnapshot, warnings: list[str]) -> dict[str, Any]:
        baseline = parse_packages(snapshot.baseline, warnings)
        current = parse_packages(snapshot.current, warnings)
        resolve_declared_versions(baseline, warnings)
        resolve_declared_versions(current, warnings)
        return {"baseline": baseline, "current": current, "changes": package_diff(baseline, current)}

    def scan(
        self, snapshot: AnalysisSnapshot, model: ReviewModel,
        dependencies: dict[str, Any], progress: Callable[[str, int], None],
    ) -> None:
        # Resolve against this language's symbols only, then merge its contribution.
        facts = ReviewModel(model.repository, changes=model.changes, packages=dependencies)
        cache = None
        if snapshot.use_cache:
            common = Path(run_git(snapshot.repo, "rev-parse", "--git-common-dir").strip())
            common = (snapshot.repo / common).resolve()
            fingerprint = hashlib.sha256(sys.version.encode())
            # Keep the existing namespace: these cached parser facts have not changed.
            for name in ("python_graph.py", "complexity.py", "review_model.py", "file_cache.py"):
                fingerprint.update(Path(__file__).with_name(name).read_bytes())
            namespace = json.dumps([os.path.normcase(str(common)), fingerprint.hexdigest()])
            directory = Path(os.environ.get("AGENT_REVIEW_CACHE_DIR")
                             or Path.home() / ".copilot" / "agent-review" / "file-cache")

            def warning(message: str) -> None:
                facts.warnings.append(message)
                progress(message, 42)

            cache = FileScanCache(directory, namespace, on_warning=warning)
        try:
            analyze_python(
                snapshot.baseline, snapshot.current, facts,
                declared_import_names(dependencies["current"]),
                declared_import_names(dependencies["baseline"]),
                on_progress=progress, cache=cache,
            )
        finally:
            if cache:
                cache.close()
        model.symbols.extend(facts.symbols)
        model.edges.extend(facts.edges)
        model.evidence.extend(facts.evidence)
        model.warnings.extend(facts.warnings)
        for key, values in facts.aggregates.items():
            model.aggregates.setdefault(key, []).extend(values)

    def resolve_package_usage(self, model: ReviewModel, dependencies: dict[str, Any]) -> None:
        usage: dict[str, set[str]] = {}
        evidence_by_id = {item["id"]: item for item in model.evidence}
        for edge in model.edges:
            if edge["kind"] == "uses_package" and edge["target"].startswith("package:"):
                locations = usage.setdefault(edge["target"][8:], set())
                for evidence_id in edge["evidence_ids"]:
                    evidence = evidence_by_id[evidence_id]
                    if evidence.get("path"):
                        locations.add(f"{evidence['path']}:{evidence.get('line', 1)}")
        for package in dependencies["current"]:
            package["used_by"] = sorted(usage.get(import_name(package["name"]), set()))

    def coverage(self, snapshot: AnalysisSnapshot) -> dict[str, Any]:
        if snapshot.historical:
            return {"available": False, "files": [], "changed_lines": {}}
        paths = sorted(path for path in snapshot.current if path.endswith(".py"))
        return load_coverage(snapshot.repo, snapshot.base_commit, paths)


PYTHON_ADAPTER = PythonAdapter()
