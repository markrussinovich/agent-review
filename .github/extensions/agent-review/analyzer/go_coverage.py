"""Saved Go coverprofile ingestion with exact source-hash proof."""
from __future__ import annotations

import difflib
import hashlib
import json
import posixpath
import re
from pathlib import PurePosixPath
from typing import Any


_ROW = re.compile(r"^(.+):(\d+)\.(\d+),(\d+)\.(\d+)\s+(\d+)\s+(\d+)$")


def _path(value: str) -> str:
    return posixpath.normpath(value.replace("\\", "/")).removeprefix("./")


def _proof(files: dict[str, bytes], report: str) -> dict[str, Any] | None:
    directory = PurePosixPath(report).parent
    candidates = [str(directory / "coverage.sources.json"), str(directory / "coverage.out.sources.json")]
    if str(directory) == ".":
        candidates += ["coverage.sources.json", "coverage.out.sources.json"]
    for candidate in candidates:
        if candidate not in files:
            continue
        try:
            value = json.loads(files[candidate].decode("utf-8-sig"))
            return value if isinstance(value, dict) else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
    return None


def _match(value: str, paths: list[str]) -> tuple[str | None, bool]:
    value = _path(value)
    exact = [path for path in paths if path == value]
    if exact:
        return exact[0], False
    matches = [path for path in paths if value.endswith("/" + path) or path.endswith("/" + value)]
    depth = max((path.count("/") for path in matches), default=-1)
    matches = [path for path in matches if path.count("/") == depth]
    return (matches[0], False) if len(matches) == 1 else (None, len(matches) > 1)


def load_go_coverage(snapshot: Any) -> dict[str, Any]:
    current = {_path(path): raw for path, raw in snapshot.current.items()}
    baseline = {_path(path): raw for path, raw in snapshot.baseline.items()}
    paths = sorted(path for path in current if path.lower().endswith(".go"))
    warnings: list[str] = []
    reports: list[str] = []
    records: dict[str, dict[int, bool]] = {}
    for report, raw in sorted(current.items()):
        if PurePosixPath(report).name.lower() not in {"coverage.out", "cover.out", "coverage.txt"}:
            continue
        try:
            lines = raw.decode("utf-8-sig").splitlines()
        except UnicodeDecodeError as error:
            warnings.append(f"{report}: invalid UTF-8 Go coverprofile: {error}")
            continue
        if not lines or not lines[0].startswith("mode: "):
            warnings.append(f"{report}: expected a Go coverprofile beginning with 'mode:'.")
            continue
        proof = _proof(current, report)
        if not proof:
            warnings.append(
                f"{report}: ignored because coverage.sources.json does not prove exact saved Go source hashes."
            )
            continue
        pending: dict[str, dict[int, bool]] = {}
        invalid = False
        for line_number, line in enumerate(lines[1:], 2):
            match = _ROW.fullmatch(line.strip())
            if not match:
                warnings.append(f"{report}:{line_number}: malformed Go coverprofile row.")
                invalid = True
                break
            filename, start, _, end, _, statements, count = match.groups()
            path, ambiguous = _match(filename, paths)
            if path is None:
                warnings.append(f"{report}:{line_number}: {filename}: source path is "
                                f"{'ambiguous' if ambiguous else 'not present'} in the saved snapshot.")
                continue
            expected = proof.get(path)
            expected_hash = expected.get("sha256") if isinstance(expected, dict) else expected
            actual_hash = hashlib.sha256(current[path]).hexdigest()
            if expected_hash != actual_hash:
                warnings.append(f"{report}: {path}: source hash does not match the saved snapshot; coverage ignored.")
                pending.pop(path, None)
                continue
            start_line, end_line = int(start), int(end)
            if start_line < 1 or end_line < start_line or end_line > len(current[path].splitlines()):
                warnings.append(f"{report}:{line_number}: {path}: range exceeds saved source; coverage ignored.")
                pending.pop(path, None)
                continue
            executable = pending.setdefault(path, {})
            # A Go block count applies to the spanned statements. Marking every source
            # line is conservative for changed-line evidence and never invents a hit.
            for number in range(start_line, end_line + 1):
                executable[number] = executable.get(number, False) or int(count) > 0
        if invalid or not any(pending.values()):
            continue
        reports.append(report)
        for path, lines_by_number in pending.items():
            target = records.setdefault(path, {})
            for number, covered in lines_by_number.items():
                target[number] = target.get(number, False) or covered
    files, changed_lines = [], {}
    for path, lines in sorted(records.items()):
        executable = set(lines)
        covered = {number for number, hit in lines.items() if hit}
        before = baseline.get(path, b"").decode("utf-8", errors="replace").splitlines()
        after = current[path].decode("utf-8", errors="replace").splitlines()
        changed = set()
        for tag, _, _, start, end in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
            if tag in ("insert", "replace"):
                changed.update(range(start + 1, end + 1))
        changed &= executable
        changed_covered = changed & covered
        files.append({"path": path, "line_count": len(after),
                      "executable_lines": sorted(executable), "covered_lines": sorted(covered),
                      "percent": round(100 * len(covered) / len(executable), 2) if executable else None})
        changed_lines[path] = {
            "total": len(changed), "covered": len(changed_covered),
            "uncovered": len(changed - covered), "covered_lines": sorted(changed_covered),
            "uncovered_lines": sorted(changed - covered),
            "percent": round(100 * len(changed_covered) / len(changed), 2) if changed else None,
        }
    return {"available": bool(files), "source": reports[0] if len(reports) == 1 else None,
            "sources": reports, "files": files, "changed_lines": changed_lines, "warnings": warnings}
