"""Cobertura coverage for C# from current snapshot bytes, never the checkout."""
from __future__ import annotations

import difflib
import posixpath
import re
from pathlib import PurePosixPath
from typing import Any
from xml.parsers import expat

from dotnet_packages import _xml_document


def _path(value: str) -> str:
    return posixpath.normpath(value.replace("\\", "/")).removeprefix("./")


def _match(filename: str, sources: list[str], report: str, paths: list[str], projects: list[str]) -> tuple[str | None, bool]:
    filename = _path(filename)

    def suffix_matches(value: str) -> set[str]:
        matches = {
            path for path in paths
            if value == path or value.endswith("/" + path)
            or ("/" in value and path.endswith("/" + value))
        }
        depth = max((path.count("/") for path in matches), default=0)
        return {path for path in matches if path.count("/") == depth}

    # Sources disambiguate project-relative filenames, including absolute paths
    # from a different build machine. No absolute path is ever opened.
    sourced = set()
    for source in sources:
        sourced.update(suffix_matches(_path(source.rstrip("/\\") + "/" + filename)))
    if sourced:
        return (next(iter(sourced)), False) if len(sourced) == 1 else (None, True)
    if "/" in filename:
        exact = [path for path in paths if path == filename]
        if exact:
            return exact[0], False
    parent = PurePosixPath(report).parent
    for directory in (parent, *parent.parents):
        if any(PurePosixPath(project).parent == directory for project in projects):
            candidate = _path(str(directory) + "/" + filename)
            if candidate in paths:
                return candidate, False
            break
    if "/" in filename:
        matched = suffix_matches(filename)
        if matched:
            return (next(iter(matched)), False) if len(matched) == 1 else (None, True)
        return None, False
    basenames = [path for path in paths if PurePosixPath(path).name == PurePosixPath(filename).name]
    return (basenames[0], False) if len(basenames) == 1 else (None, len(basenames) > 1)


def _branches(line: Any) -> tuple[int, int] | None:
    if line.get("branch", "").lower() != "true":
        return None
    value = line.get("condition-coverage", "")
    match = re.search(r"\((\d+)\s*/\s*(\d+)\)", value)
    if match:
        covered, total = map(int, match.groups())
        if covered > total or total == 0:
            raise ValueError("invalid condition-coverage branch counts")
        return covered, total
    conditions = line.findall("./conditions/condition")
    if conditions:
        values = [float(condition.get("coverage", "").removesuffix("%")) for condition in conditions]
        if any(value < 0 or value > 100 for value in values):
            raise ValueError("invalid branch condition percentage")
        return sum(value == 100 for value in values), len(values)
    raise ValueError("branch line lacks condition-coverage counts; export Cobertura branch evidence")


def load_dotnet_coverage(snapshot: Any) -> dict[str, Any]:
    """Load only ``snapshot.current`` XML and diff against ``snapshot.baseline``.

    Compatible with the Python coverage DTO; ``branch_lines`` retains per-line
    covered/total branch evidence. Warnings explain malformed, stale, ambiguous,
    and unmatched report evidence. No coverage is inferred from missing reports.
    """
    current = {_path(path): raw for path, raw in snapshot.current.items()}
    baseline = {_path(path): raw for path, raw in snapshot.baseline.items()}
    paths = sorted(path for path in current if path.lower().endswith(".cs"))
    projects = [path for path in current if path.lower().endswith(".csproj")]
    warnings: list[str] = []
    records: dict[str, dict[int, tuple[bool, tuple[int, int] | None]]] = {}
    reports = []
    for report, raw in sorted(current.items()):
        if not report.lower().endswith(".xml"):
            continue
        # Ignore unrelated XML, but diagnose broken coverage-looking reports.
        named_report = "coverage" in PurePosixPath(report).name.lower() or "cobertura" in report.lower()
        looks_report = re.search(br"<(?:[A-Za-z0-9_]+:)?coverage(?:\s|/?>|$)", raw.replace(b"\0", b"")) is not None
        try:
            root, _ = _xml_document(raw)
            if root.tag != "coverage":
                if named_report:
                    warnings.append(f"{report}: expected a Cobertura <coverage> report; export Cobertura XML.")
                continue
            looks_report = True
            sources = [(node.text or "").strip() for node in root.findall("./sources/source") if (node.text or "").strip()]
            pending: dict[str, dict[int, tuple[bool, tuple[int, int] | None]]] = {}
            for node in root.findall(".//class"):
                filename = node.get("filename", "")
                if not filename.lower().endswith(".cs"):
                    continue
                path, ambiguous = _match(filename, sources, report, paths, projects)
                if path is None:
                    reason = "ambiguous" if ambiguous else "not present"
                    warnings.append(f"{report}: {filename}: source path is {reason} in the current snapshot; export project-relative filenames and matching Cobertura sources.")
                    continue
                count = len(current[path].decode("utf-8", errors="replace").splitlines())
                for line in node.findall("./lines/line"):
                    number, hits = int(line.get("number", "")), int(line.get("hits", ""))
                    if number < 1 or hits < 0:
                        raise ValueError("line numbers must be positive and hits nonnegative")
                    branch = _branches(line)
                    if number > count:
                        warnings.append(f"{report}: {path}:{number}: coverage exceeds saved source length; include a report generated for this revision.")
                        continue
                    previous = pending.setdefault(path, {}).get(number)
                    if previous:
                        branch = max((value for value in (previous[1], branch) if value is not None), key=lambda value: (value[1], value[0]), default=None)
                    pending[path][number] = (hits > 0 or bool(previous and previous[0]), branch)
            if not any(pending.values()):
                warnings.append(f"{report}: no matching C# line evidence; include saved .cs files and matching Cobertura sources.")
                continue
            reports.append(report)
            for path, lines in pending.items():
                target = records.setdefault(path, {})
                for number, (covered, branch) in lines.items():
                    previous = target.get(number)
                    if previous:
                        branch = max((value for value in (previous[1], branch) if value is not None), key=lambda value: (value[1], value[0]), default=None)
                    target[number] = (covered or bool(previous and previous[0]), branch)
        except (expat.ExpatError, ValueError, TypeError) as error:
            if named_report or looks_report:
                warnings.append(f"{report}: malformed Cobertura evidence: {error}; regenerate a valid Cobertura XML report for the saved revision.")
    files = []
    changed_summary = {}
    for path, lines in sorted(records.items()):
        covered = {number for number, (hit, _) in lines.items() if hit}
        executable = set(lines)
        after = current[path].decode("utf-8", errors="replace").splitlines()
        before = baseline.get(path, b"").decode("utf-8", errors="replace").splitlines()
        changed = set()
        for tag, _, _, start, end in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
            if tag in ("insert", "replace"):
                changed.update(range(start + 1, end + 1))
        branches = [
            {"line": number, "covered": branch[0], "total": branch[1]}
            for number, (_, branch) in sorted(lines.items()) if branch is not None
        ]
        changed_branches = [branch for branch in branches if branch["line"] in changed]
        executable_changed = executable & changed
        changed_covered = covered & changed
        files.append({
            "path": path, "line_count": len(after), "covered_lines": sorted(covered),
            "executable_lines": sorted(executable), "branch_lines": branches,
            "branches_total": sum(branch["total"] for branch in branches),
            "branches_covered": sum(branch["covered"] for branch in branches),
        })
        changed_summary[path] = {
            "total": len(executable_changed), "covered": len(changed_covered),
            "percent": round(100 * len(changed_covered) / len(executable_changed), 2) if executable_changed else None,
            "covered_lines": sorted(changed_covered),
            "uncovered_lines": sorted(executable_changed - covered),
            "branch_lines": changed_branches,
            "branches_total": sum(branch["total"] for branch in changed_branches),
            "branches_covered": sum(branch["covered"] for branch in changed_branches),
        }
    return {
        "available": bool(files), "files": files, "changed_lines": changed_summary,
        "source": reports[0] if reports else None, "sources": reports,
        "warnings": sorted(set(warnings)),
    }
