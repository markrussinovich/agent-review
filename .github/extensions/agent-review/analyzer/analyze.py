from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from churn import analyze_churn
from codeboarding_adapter import load_codeboarding
from coverage_data import load_coverage
from git_snapshot import create_snapshot, discover_base, discover_repo, run_git
from packages import declared_import_names, installed_versions, package_diff, parse_packages
from python_graph import analyze_python
from review_model import ReviewModel


def progress(phase: str, message: str, percent: int) -> None:
    payload = {"phase": phase, "message": message, "percent": percent}
    print(f"AGENT_REVIEW_PROGRESS {json.dumps(payload, separators=(',', ':'))}", file=sys.stderr, flush=True)


def build_review(
    repo_arg: str | None, base_arg: str | None, excludes: tuple[str, ...],
    current_arg: str | None = None,
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
    snapshot = create_snapshot(repo, base_commit, excludes, current_arg)
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
    progress("dependencies", "Comparing package declarations and installed versions", 32)
    baseline_packages = parse_packages(snapshot.baseline, model.warnings)
    current_packages = parse_packages(snapshot.current, model.warnings)
    installed_versions(current_packages)
    model.packages = {
        "baseline": baseline_packages,
        "current": current_packages,
        "changes": package_diff(baseline_packages, current_packages),
    }
    progress("python_graph", "Parsing Python modules, symbols, imports, calls, and inheritance", 42)
    analyze_python(
        snapshot.baseline,
        snapshot.current,
        model,
        declared_import_names(current_packages),
        declared_import_names(baseline_packages),
    )
    progress("relationships", "Resolving package usage and aggregate architecture edges", 68)
    usage: dict[str, set[str]] = {}
    evidence_by_id = {item["id"]: item for item in model.evidence}
    for edge in model.edges:
        if edge["kind"] == "uses_package" and edge["target"].startswith("package:"):
            locations = usage.setdefault(edge["target"][8:], set())
            for evidence_id in edge["evidence_ids"]:
                evidence = evidence_by_id[evidence_id]
                if evidence.get("path"):
                    locations.add(f"{evidence['path']}:{evidence.get('line', 1)}")
    for package in model.packages["current"]:
        package["used_by"] = sorted(usage.get(package["name"].replace("-", "_"), set()))
    python_paths = sorted(path for path in snapshot.current if path.endswith(".py"))
    progress("coverage", "Loading coverage and changed executable-line data", 76)
    model.coverage = (
        {"available": False, "files": [], "changed_lines": {}}
        if current_arg else load_coverage(repo, base_commit, python_paths)
    )
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
        model = build_review(args.repo, args.base_ref, tuple(args.exclude), args.current_ref)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"agent-review analyzer: {error}", file=sys.stderr)
        return 2
    progress("complete", "Analysis complete", 100)
    json.dump(model.to_dict(), sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
