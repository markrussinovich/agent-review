from __future__ import annotations

import argparse
import json
import sys

from churn import analyze_churn
from codeboarding_adapter import load_codeboarding
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
            "python_loc": sum(
                len(content.decode("utf-8", errors="replace").splitlines())
                for path, content in snapshot.current.items() if path.endswith(".py")
            ),
        }
    )
    progress("changes", "Computing changed files and line totals", 25)
    model.changes = snapshot.changes()
    model.source_files = snapshot.source_files(model.changes)
    analysis_snapshot = AnalysisSnapshot(repo, snapshot.baseline, snapshot.current, base_commit,
                                         bool(current_arg), use_cache, head)
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
    value.add_argument("--no-cache", action="store_true", help="Scan Python files fresh without reading or writing the file cache")
    value.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="Glob or path segment to exclude; may be repeated",
    )
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        model = build_review(args.repo, args.base_ref, tuple(args.exclude), args.current_ref, use_cache=not args.no_cache)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"agent-review analyzer: {error}", file=sys.stderr)
        return 2
    progress("complete", "Analysis complete", 100)
    json.dump(model.to_dict(), sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
