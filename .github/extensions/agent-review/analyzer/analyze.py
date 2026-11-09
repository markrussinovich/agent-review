from __future__ import annotations

import argparse
import gzip
import io
import json
import sys
from typing import Any, TextIO

from churn import analyze_churn
from codeboarding_adapter import load_codeboarding
from generated_sources import generated_paths
from git_snapshot import create_snapshot, discover_base, discover_repo, run_git
from language_adapters import AnalysisSnapshot, active_adapters, merge_coverage
from review_model import ReviewModel


def progress(phase: str, message: str, percent: int) -> None:
    payload = {"phase": phase, "message": message, "percent": percent}
    print(f"AGENT_REVIEW_PROGRESS {json.dumps(payload, separators=(',', ':'))}", file=sys.stderr, flush=True)


def build_review(
    repo_arg: str | None, base_arg: str | None, excludes: tuple[str, ...],
    current_arg: str | None = None, *, use_cache: bool = True,
) -> ReviewModel:
    progress("repository", "Resolving repository and comparison base", 5)
    repo = discover_repo(repo_arg)
    base_ref = base_arg if current_arg else discover_base(repo, base_arg)
    head = run_git(repo, "rev-parse", current_arg or "HEAD", check=False).strip() or None
    base_commit = (
        (run_git(repo, "rev-parse", base_ref).strip() if current_arg else
         run_git(repo, "merge-base", "HEAD", base_ref, check=False).strip())
        if base_ref
        else None
    )
    if base_ref and not base_commit:
        base_commit = run_git(repo, "rev-parse", f"{base_ref}^{{commit}}").strip()
    progress("snapshot", f"Reading base and current snapshots against {base_ref or 'empty base'}", 15)
    snapshot = create_snapshot(
        repo, base_commit, excludes, current_arg,
        on_progress=lambda message: progress("snapshot", message, 15),
    )
    generated_at = (
        run_git(repo, "show", "-s", "--format=%cI", head, check=False).strip()
        if head else None
    )
    model = ReviewModel(
        {
            "root": str(repo),
            "head": head,
            "base_ref": base_ref,
            "base_commit": base_commit,
            "generated_at": generated_at,
            **({"snapshot_exclusions": {
                "changed_files": sum(int(rule["count"]) for rule in snapshot.excluded_changes),
                "rules": list(snapshot.excluded_changes),
            }} if snapshot.excluded_changes else {}),
            "python_loc": sum(
                len(content.decode("utf-8", errors="replace").splitlines())
                for path, content in snapshot.current.items() if path.endswith(".py")
            ),
        }
    )
    progress("changes", "Computing changed files and line totals", 25)
    model.changes = snapshot.changes()
    generated = generated_paths(snapshot.baseline, snapshot.current)
    for change in model.changes:
        if change["path"] in generated:
            change["generated"] = True
    model.source_files = snapshot.source_files(model.changes, generated)
    # Language adapters see only hand-written source; generated bundles stay reviewable as files.
    analysis_snapshot = AnalysisSnapshot(repo, {path: value for path, value in snapshot.baseline.items() if path not in generated},
                                         {path: value for path, value in snapshot.current.items() if path not in generated},
                                         base_commit, bool(current_arg), use_cache, head)
    if generated:
        changed = sorted(change["path"] for change in model.changes if change["path"] in generated and change["status"] != "unchanged")
        model.warnings.append(
            f"{len(generated):,} generated or minified file{'s' if len(generated) != 1 else ''} (built bundles, *.min.*, source maps) "
            f"{'were' if len(generated) != 1 else 'was'} not parsed for symbols"
            + (f"; {len(changed):,} changed, e.g. {changed[0]}, remain reviewable as files." if changed else "; none changed in this review.")
        )
    adapters = active_adapters(analysis_snapshot)
    progress("dependencies", "Comparing package declarations and project version pins", 32)
    dependencies = {}
    for adapter in adapters:
        declarations = adapter.dependencies(analysis_snapshot, model.warnings)
        dependencies[adapter.id] = declarations
        for key in ("baseline", "current", "changes"):
            model.packages[key].extend(declarations[key])
    graph_percent = 42
    for adapter in adapters:
        progress(adapter.graph_phase, adapter.graph_message, graph_percent)

        def graph_progress(message: str, percent: int) -> None:
            nonlocal graph_percent
            graph_percent = max(graph_percent, percent)
            progress(adapter.graph_phase, message, graph_percent)

        adapter.scan(analysis_snapshot, model, dependencies[adapter.id], graph_progress)
    if any(adapter.id != "python" for adapter in adapters):
        model.repository["review_languages"] = [adapter.id for adapter in adapters]
    progress("relationships", "Resolving package usage and aggregate architecture edges", 68)
    for adapter in adapters:
        adapter.resolve_package_usage(model, dependencies[adapter.id])
    progress("coverage", "Loading coverage and changed executable-line data", 76)
    coverage_reports = [adapter.coverage(analysis_snapshot) for adapter in adapters]
    model.coverage = merge_coverage(coverage_reports)
    for report in coverage_reports:
        model.warnings.extend(report.get("warnings", []))
    if current_arg:
        model.warnings.append("Worktree coverage is not applicable to a historical commit or PR snapshot.")
    progress("churn", "Calculating 90-day Git churn and impact metrics", 84)
    model.churn = analyze_churn(repo, current_arg or "HEAD")
    progress("architecture", "Loading CodeBoarding enrichment or path-derived components", 91)
    model.codeboarding = load_codeboarding(repo, snapshot.current if current_arg else None)
    progress("review_model", "Assembling evidence, findings, and semantic zoom levels", 97)
    return model


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description="Build a deterministic Agent Review model")
    value.add_argument("--repo", help="Path within the git repository")
    value.add_argument("--base-ref", help="Git revision used as the baseline")
    value.add_argument("--current-ref", help="Analyze a committed tree instead of the worktree")
    value.add_argument("--gzip", action="store_true", help="Write the complete JSON result as a gzip stream")
    value.add_argument("--no-cache", action="store_true", help="Scan Python files fresh without reading or writing the file cache")
    value.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="Glob or path segment to exclude; may be repeated",
    )
    return value


def write_review_json(result: dict[str, Any], output: TextIO) -> None:
    encoder = json.JSONEncoder(sort_keys=True, separators=(",", ":"))
    output.write("{")
    for index, (key, value) in enumerate(sorted(result.items())):
        if index:
            output.write(",")
        output.write(encoder.encode(key) + ":")
        if isinstance(value, dict):
            output.write("{")
            for child_index, (child_key, child) in enumerate(sorted(value.items())):
                if child_index:
                    output.write(",")
                output.write(encoder.encode(child_key) + ":" + encoder.encode(child))
            output.write("}")
        elif isinstance(value, list):
            output.write("[")
            for child_index, child in enumerate(value):
                if child_index:
                    output.write(",")
                output.write(encoder.encode(child))
            output.write("]")
        else:
            output.write(encoder.encode(value))
    output.write("}\n")


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        model = build_review(args.repo, args.base_ref, tuple(args.exclude), args.current_ref, use_cache=not args.no_cache)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"agent-review analyzer: {error}", file=sys.stderr)
        return 2
    progress("serialization", "Writing the complete saved review result", 98)
    result = model.to_dict()
    if args.gzip:
        with gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb", compresslevel=1, mtime=0) as compressed:
            with io.TextIOWrapper(compressed, encoding="utf-8", newline="\n") as output:
                write_review_json(result, output)
    else:
        write_review_json(result, sys.stdout)
    progress("complete", "Analysis complete", 100)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
