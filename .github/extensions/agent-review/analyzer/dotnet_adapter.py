from __future__ import annotations

import json
import os
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Any

from language_adapters import AnalysisSnapshot
from review_model import ReviewModel, stable_id


def dotnet_input_path(path: str) -> bool:
    name = PurePosixPath(path).name.lower()
    return (name.endswith((".cs", ".csproj", ".sln", ".slnx", ".props", ".targets"))
            or name in {"directory.build.props", "directory.build.targets",
                        "directory.packages.props", "global.json", "nuget.config", ".editorconfig"})


def helper_path() -> Path:
    configured = os.environ.get("AGENT_REVIEW_DOTNET_HELPER")
    return Path(configured) if configured else (
        Path(__file__).parent.parent / "dotnet-analyzer" / "bin" / "Release"
        / "net10.0" / "AgentReview.Dotnet.dll"
    )


def run_dotnet_helper(payload: dict[str, Any]) -> dict[str, Any]:
    helper = helper_path()
    if not helper.is_file():
        raise RuntimeError(
            f"C# analysis requires the prepared Roslyn helper: {helper}. "
            "Install .NET SDK 10 and build the extension's trusted "
            "dotnet-analyzer\\AgentReview.DotnetAnalyzer.csproj with dotnet build -c Release "
            "(outside the reviewed project), or set AGENT_REVIEW_DOTNET_HELPER. "
            "Scanning never builds or restores the reviewed project."
        )
    with tempfile.TemporaryDirectory(prefix="agent-review-dotnet-") as directory:
        request = Path(directory) / "request.json"
        request.write_text(json.dumps(payload), encoding="utf-8")
        environment = os.environ.copy()
        if payload.get("use_cache") is False:
            environment["AGENT_REVIEW_DOTNET_CACHE"] = ""
        elif "AGENT_REVIEW_DOTNET_CACHE" not in environment:
            cache_root = Path(environment.get("AGENT_REVIEW_CACHE_DIR")
                              or Path.home() / ".copilot" / "agent-review" / "file-cache")
            environment["AGENT_REVIEW_DOTNET_CACHE"] = str(cache_root / "dotnet-facts")
        try:
            result = subprocess.run(
                [os.environ.get("AGENT_REVIEW_DOTNET", "dotnet"), str(helper), "--input", str(request)],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
                env=environment,
            )
        except FileNotFoundError as error:
            raise RuntimeError("C# analysis requires dotnet on PATH or AGENT_REVIEW_DOTNET; "
                               "install a local .NET 10 runtime/SDK. No reviewed code was executed.") from error
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("Roslyn snapshot analysis exceeded 120 seconds; reduce snapshot scope.") from error
        if result.returncode:
            raise RuntimeError(f"Roslyn snapshot analysis failed (exit {result.returncode}): "
                               f"{result.stderr[-6000:]}")
        try:
            value = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"Roslyn helper returned invalid JSON: {result.stderr[-2000:]}") from error
        if not isinstance(value, dict):
            raise RuntimeError("Roslyn helper output must be a JSON object.")
        return value


class DotnetAdapter:
    id = "csharp"
    graph_phase = "csharp_graph"
    graph_message = "Compiling saved C# syntax and resolving snapshot-scoped relationships with Roslyn"

    def applies(self, paths: set[str]) -> bool:
        return any(path.lower().endswith((".cs", ".csproj", ".sln", ".slnx")) for path in paths)

    def dependencies(self, snapshot: AnalysisSnapshot, warnings: list[str]) -> dict[str, Any]:
        from dotnet_packages import dotnet_package_diff, parse_dotnet_packages

        for side, files in (("baseline", snapshot.baseline), ("current", snapshot.current)):
            for path, data in files.items():
                if not (path.lower().endswith(".csproj")
                        or PurePosixPath(path).name.lower() == "directory.packages.props"):
                    continue
                try:
                    root = ET.fromstring(data)
                except ET.ParseError as error:
                    raise ValueError(f"Cannot compare NuGet declarations: {side} manifest {path} "
                                     f"contains invalid XML ({error}). Use a valid manifest/comparison "
                                     "before assessing dependency changes.") from error
                if root.tag.rsplit("}", 1)[-1] != "Project":
                    raise ValueError(f"Cannot compare NuGet declarations: {side} manifest {path} "
                                     "must have a Project XML root.")
        baseline = parse_dotnet_packages(snapshot.baseline, warnings)
        current = parse_dotnet_packages(snapshot.current, warnings)
        return {"baseline": baseline, "current": current,
                "changes": dotnet_package_diff(baseline, current)}

    def scan(self, snapshot: AnalysisSnapshot, model: ReviewModel,
             dependencies: dict[str, Any], progress: Callable[[str, int], None]) -> None:
        trees = {
            side: {path: data.decode("utf-8-sig", errors="replace")
                   for path, data in files.items() if dotnet_input_path(path)}
            for side, files in (("baseline", snapshot.baseline), ("current", snapshot.current))
        }
        for path in sorted(set(trees["baseline"]) | set(trees["current"])):
            saved = model.source_files.setdefault(path, {})
            saved["baseline"] = trees["baseline"].get(path)
            saved["current"] = trees["current"].get(path)
        facts = run_dotnet_helper({**trees, "mode": "graph", "use_cache": snapshot.use_cache})
        model.warnings.extend(facts.get("warnings", []))
        model.repository["csharp_loc"] = sum(len(data.splitlines()) for path, data in trees["current"].items()
                                             if path.lower().endswith(".cs"))
        model.repository["review_languages"] = sorted({"csharp", *(
            ["python"] if any(path.endswith(".py") for path in set(snapshot.baseline) | set(snapshot.current)) else []
        )})
        modules: dict[str, dict[str, Any]] = {}
        symbol_modules: dict[str, str] = {}
        component_id = stable_id("component", "csharp", "root")
        changed = {item["path"]: item["status"] for item in model.changes}
        for raw in facts.get("symbols", []):
            compiler_scope = raw["id"].split("::", 1)[0]
            module_name = raw.get("module") or f"csharp:{compiler_scope}:{raw['path']}"
            if module_name not in modules:
                modules[module_name] = {
                    "id": stable_id("module", "csharp", module_name),
                    "name": module_name, "path": raw["path"], "component": "C# / .NET",
                    "display_name": f"{raw['path']} [{compiler_scope}]",
                    "change": {"deleted": "removed"}.get(changed.get(raw["path"]), changed.get(raw["path"], "unchanged")),
                    "language": "csharp", "ecosystem": "nuget", "symbol_ids": [],
                }
            modules[module_name]["symbol_ids"].append(raw["id"])
            model.symbols.append({
                **raw, "module": module_name, "identity": raw["id"],
                "compiler_scope": compiler_scope,
                "range": {"start_line": raw["line"], "end_line": raw["end_line"]},
            })
            symbol_modules[raw["id"]] = modules[module_name]["id"]
        classifications = {raw["id"]: raw["classification"] for raw in facts.get("symbols", [])}
        for module in modules.values():
            states = {classifications[identifier] for identifier in module["symbol_ids"]}
            if states == {"added"}:
                module["change"] = "added"
            elif states == {"removed"}:
                module["change"] = "removed"
            elif states - {"unchanged"}:
                module["change"] = "modified"
        model.aggregates["modules"].extend(modules.values())
        if modules:
            model.aggregates["components"].append({
                "id": component_id, "name": "C# / .NET", "module_ids": sorted(m["id"] for m in modules.values()),
                "language": "csharp", "ecosystem": "nuget",
            })
        graph_edges = []
        for raw in facts.get("edges", []):
            evidence = model.add_evidence("csharp_relationship", {
                "path": raw.get("path"), "line": raw.get("line"),
                "detail": raw["kind"], "language": "csharp",
                "resolution": raw.get("resolution", "roslyn"),
            })
            edge = {
                **raw, "id": stable_id("edge", "csharp", raw["source"], raw["target"], raw["kind"],
                                      raw.get("path"), raw.get("line"), raw.get("change", "unchanged")),
                "confidence": raw.get("confidence", 0.8), "evidence_ids": [evidence],
            }
            graph_edges.append(edge)
            model.edges.append(edge)
        groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
        for edge in graph_edges:
            source, target = symbol_modules.get(edge["source"]), symbol_modules.get(edge["target"])
            if source and target and source != target:
                groups.setdefault((edge["kind"], source, target), []).append(edge)
        for (kind, source, target), edges in groups.items():
            model.aggregates["edges"].append({
                "id": stable_id("aggregate_edge", "csharp", "module", kind, source, target),
                "level": "module", "kind": kind, "source": source, "target": target,
                "underlying_edge_ids": sorted({edge["id"] for edge in edges}),
                "count": sum(edge.get("change") != "removed" for edge in edges),
                "added_count": sum(edge.get("change") == "added" for edge in edges),
                "removed_count": sum(edge.get("change") == "removed" for edge in edges),
            })
        progress(f"Roslyn analyzed {len(trees['current'])} saved source/configuration files", 65)

    def resolve_package_usage(self, model: ReviewModel, dependencies: dict[str, Any]) -> None:
        # Namespace spelling is not a reliable NuGet-to-assembly mapping.
        for package in dependencies["current"]:
            package.setdefault("used_by", [])

    def coverage(self, snapshot: AnalysisSnapshot) -> dict[str, Any]:
        from dotnet_coverage import load_dotnet_coverage

        return load_dotnet_coverage(snapshot)


DOTNET_ADAPTER = DotnetAdapter()
