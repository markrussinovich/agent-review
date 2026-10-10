from __future__ import annotations

import json
import shutil
import subprocess
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from pathlib import Path, PurePosixPath
from typing import Any

from language_adapters import AnalysisSnapshot
from node_packages import package_diff, parse_packages
from review_model import ReviewModel


EXTENSIONS = {".js", ".ts", ".jsx", ".tsx", ".cjs", ".mjs", ".mts", ".cts"}
MANIFESTS = {"package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock",
             "pnpm-lock.yaml", "bun.lock", "bun.lockb", "tsconfig.json", "jsconfig.json"}


def _reviewed_path(path: str) -> PurePosixPath | None:
    pure = PurePosixPath(path.replace("\\", "/"))
    ignored = {".git", "node_modules", ".agent-review"} & set(pure.parts)
    generated = any(part.startswith((".agent-review-node-tests-", ".node-runner-fixture-",
                                    ".coverage-import-fixture-")) for part in pure.parts)
    return None if ignored or generated else pure


def _has_sources(files: dict[str, bytes]) -> bool:
    return any(pure and pure.suffix.lower() in EXTENSIONS
               for path in files if (pure := _reviewed_path(path)))


def _texts(files: dict[str, bytes]) -> dict[str, str]:
    return {path: value.decode("utf-8-sig", errors="replace") if isinstance(value, bytes) else value
            for path, value in files.items()}


class NodeAdapter:
    """Each graph scan starts a fresh CLI; fact caching never persists across reviews."""

    id = "node"
    graph_phase = "node_graph"
    graph_message = "Resolving JavaScript and TypeScript symbols with the TypeScript compiler"
    heartbeat_seconds = 5

    def applies(self, paths: set[str]) -> bool:
        for path in paths:
            pure = _reviewed_path(path)
            if pure is None:
                continue
            if (pure.suffix.lower() in EXTENSIONS or pure.name in MANIFESTS
                    or (pure.name.startswith("tsconfig.") and pure.suffix == ".json")):
                return True
        return False

    def dependencies(self, snapshot: AnalysisSnapshot, warnings: list[str]) -> dict[str, Any]:
        baseline = parse_packages(snapshot.baseline, warnings)
        current = parse_packages(snapshot.current, warnings)
        return {"baseline": baseline, "current": current, "changes": package_diff(baseline, current)}

    def _invoke(
        self, script: str, payload: dict[str, Any],
        on_wait: Callable[[float], None] | None = None,
    ) -> dict[str, Any]:
        executable = shutil.which("node")
        if not executable:
            raise RuntimeError("Node.js is unavailable; Node analysis is unknown.")
        arguments = [executable, str(Path(__file__).parent.parent / script)]
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="agent-review-node") as executor:
            future = executor.submit(
                subprocess.run, arguments,
                input=json.dumps(payload), capture_output=True, text=True, encoding="utf-8",
                timeout=180, check=False,
            )
            started = time.monotonic()
            while True:
                try:
                    result = future.result(timeout=self.heartbeat_seconds)
                    break
                except FutureTimeout:
                    if on_wait:
                        on_wait(time.monotonic() - started)
        if result.returncode:
            raise RuntimeError(f"{script} failed: {result.stderr.strip() or result.stdout.strip()}")
        report = json.loads(result.stdout)
        if not isinstance(report, dict):
            raise ValueError(f"{script} returned a non-object report")
        return report

    def scan(
        self, snapshot: AnalysisSnapshot, model: ReviewModel,
        dependencies: dict[str, Any], progress: Callable[[str, int], None],
    ) -> None:
        if self.applies(set(snapshot.baseline) | set(snapshot.current)):
            model.repository["node_loc"] = sum(
                len((content.decode("utf-8", errors="replace") if isinstance(content, bytes)
                     else content).splitlines())
                for path, content in snapshot.current.items()
                if (pure := _reviewed_path(path)) and pure.suffix.lower() in EXTENSIONS
            )
        if not (_has_sources(snapshot.baseline) or _has_sources(snapshot.current)):
            progress("Node dependency declarations analyzed; no source graph to compile", 67)
            return
        progress(self.graph_message, 42)
        try:
            source_count = len({
                path for path in set(snapshot.baseline) | set(snapshot.current)
                if (pure := _reviewed_path(path)) and pure.suffix.lower() in EXTENSIONS
            })
            facts = self._invoke("node-compiler.mjs", {
                "baseline": _texts(snapshot.baseline), "current": _texts(snapshot.current),
                "use_cache": snapshot.use_cache,
            }, on_wait=lambda elapsed: progress(
                f"TypeScript compiler is still resolving {source_count:,} saved source "
                f"file{'s' if source_count != 1 else ''} · {round(elapsed):,}s elapsed",
                66,
            ))
            for key in ("symbols", "edges", "evidence", "warnings"):
                getattr(model, key).extend(facts.get(key, []))
            for key, values in facts.get("aggregates", {}).items():
                model.aggregates.setdefault(key, []).extend(values)
            progress(f"Resolved {len(facts.get('symbols', [])):,} Node symbols", 67)
        except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as error:
            model.warnings.append(f"Node compiler analysis unavailable: {error}")
            progress(model.warnings[-1], 67)

    def resolve_package_usage(self, model: ReviewModel, dependencies: dict[str, Any]) -> None:
        evidence = {item["id"]: item for item in model.evidence}
        usage: dict[str, set[str]] = {}
        for edge in model.edges:
            if edge.get("kind") != "uses_package" or edge.get("change") == "removed":
                continue
            locations = usage.setdefault(edge["target"], set())
            for identifier in edge["evidence_ids"]:
                item = evidence.get(identifier, {})
                if item.get("path"):
                    locations.add(f"{item['path']}:{item.get('line', 1)}")
        for package in dependencies["current"]:
            package["used_by"] = sorted(usage.get(f"package:npm:{package['name']}", set()))

    def coverage(self, snapshot: AnalysisSnapshot) -> dict[str, Any]:
        if not _has_sources(snapshot.current):
            return {"available": False, "files": [], "changed_lines": {}}
        try:
            return self._invoke("node-coverage.mjs", {
                "repo": str(snapshot.repo), "baseline": _texts(snapshot.baseline),
                "current": _texts(snapshot.current), "historical": snapshot.historical,
            })
        except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as error:
            return {"available": False, "files": [], "changed_lines": {},
                    "warnings": [f"Node coverage unavailable: {error}"]}


NODE_ADAPTER = NodeAdapter()
