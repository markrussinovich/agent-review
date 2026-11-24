"""Source- and revision-matched LCOV ingestion from saved snapshot bytes."""
from __future__ import annotations

import hashlib
import json
import posixpath
from pathlib import PurePosixPath
from typing import Any

from git_snapshot import line_delta, text_lines


def _path(value: str) -> str:
    return posixpath.normpath(value.replace("\\", "/")).removeprefix("./")


def _metadata(snapshot: Any, name: str) -> tuple[str, dict[str, Any]] | None:
    names = {f".agent-review/{name}-coverage.json", f"{name}-coverage.json"}
    for path, raw in snapshot.current.items():
        if _path(path) not in names:
            continue
        try:
            value = json.loads(raw.decode("utf-8-sig"))
            if not isinstance(value, dict):
                raise ValueError("expected an object")
            return path, value
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            return path, {}
    return None


def load_snapshot_lcov(snapshot: Any, *, name: str, language: str, extensions: tuple[str, ...],
                       strip_bom: bool = False, strict_snapshot: bool = False,
                       additional_inputs: tuple[str, ...] = ()) -> dict[str, Any]:
    found = _metadata(snapshot, name)
    if not found:
        return {"available": False, "files": [], "changed_lines": {},
                "warnings": [f"{language} coverage ignored: add {name}-coverage.json with revision, report, and source_hashes evidence."]}
    metadata_path, metadata = found
    warnings: list[str] = []
    revision = metadata.get("revision") or metadata.get("head_sha")
    if not isinstance(revision, str) or revision != snapshot.head_commit:
        return {"available": False, "files": [], "changed_lines": {}, "warnings": [
            f"{metadata_path}: {language} coverage revision does not match the reviewed snapshot; "
            "regenerate coverage for the exact commit."
        ]}
    report = _path(str(metadata.get("report", "lcov.info")))
    raw_report = snapshot.current.get(report)
    if raw_report is None:
        return {"available": False, "files": [], "changed_lines": {},
                "warnings": [f"{metadata_path}: saved LCOV report {report} is missing."]}
    hashes = metadata.get("source_hashes")
    if not isinstance(hashes, dict):
        return {"available": False, "files": [], "changed_lines": {},
                "warnings": [f"{metadata_path}: source_hashes are required to prevent stale {language} coverage."]}
    source_paths = sorted(_path(path) for path in snapshot.current if path.lower().endswith(extensions))
    if strict_snapshot:
        inputs = set(source_paths) | {path for path in snapshot.current
                                     if PurePosixPath(path).name in additional_inputs}
        reason = None
        if not inputs or set(hashes) != inputs:
            reason = "source_hashes inventory does not match all saved sources and package inputs"
        elif metadata.get("report_sha256") != hashlib.sha256(raw_report).hexdigest():
            reason = "report_sha256 does not match the saved LCOV report"
        else:
            for path in sorted(inputs):
                raw = snapshot.current[path].replace(b"\r\n", b"\n")
                if strip_bom:
                    raw = raw.removeprefix(b"\xef\xbb\xbf")
                if hashes[path] != hashlib.sha256(raw).hexdigest():
                    reason = f"{path}: missing or stale source hash"
                    break
        if reason:
            return {"available": False, "files": [], "changed_lines": {},
                    "warnings": [f"{metadata_path}: {language} coverage rejected: {reason}."]}
    valid: set[str] = set()
    for path in source_paths:
        expected = hashes.get(path)
        source = snapshot.current[path].replace(b"\r\n", b"\n")
        if strip_bom:
            source = source.removeprefix(b"\xef\xbb\xbf")
        actual = hashlib.sha256(source).hexdigest()
        if not isinstance(expected, str) or expected.lower() != actual:
            warnings.append(f"{metadata_path}: {path}: source hash is missing or stale; coverage for this file was ignored.")
        else:
            valid.add(path)
    records: dict[str, dict[int, int]] = {}
    current_path: str | None = None
    try:
        for line in raw_report.decode("utf-8-sig").splitlines():
            if line.startswith("SF:"):
                if strict_snapshot and current_path is not None:
                    raise ValueError("source record started before end_of_record")
                candidate = _path(line[3:].strip())
                matches = [path for path in valid if candidate == path
                           or (not strict_snapshot and candidate.endswith("/" + path))]
                current_path = matches[0] if len(matches) == 1 else None
                if strict_snapshot and current_path is None:
                    raise ValueError(f"source path {candidate} is not an exact saved repository-relative Swift source")
                if len(matches) > 1:
                    warnings.append(f"{report}: ambiguous {language} source path {candidate}; use repository-relative SF paths.")
            elif line.startswith("DA:") and strict_snapshot and current_path is None:
                raise ValueError("line record appears without a saved source record")
            elif line.startswith("DA:") and current_path:
                number, hits, *_ = line[3:].split(",")
                number, hits = int(number), int(hits)
                if strict_snapshot and (number < 1 or number > len(text_lines(snapshot.current[current_path])) or hits < 0):
                    raise ValueError(f"invalid line or hit count for {current_path}")
                record = records.setdefault(current_path, {})
                record[number] = max(record.get(number, 0), hits) if strict_snapshot else hits
            elif line == "end_of_record":
                current_path = None
        if strict_snapshot and current_path is not None:
            raise ValueError("unterminated source record")
    except (UnicodeDecodeError, ValueError) as error:
        return {"available": False, "files": [], "changed_lines": {},
                "warnings": [f"{report}: malformed {language} LCOV data: {error}"]}
    files, changed_lines = [], {}
    for path, lines in sorted(records.items()):
        executable = sorted(lines)
        covered = sorted(number for number, hits in lines.items() if hits > 0)
        changed = set(line_delta(text_lines(snapshot.baseline.get(path)), text_lines(snapshot.current[path]), path)[0])
        changed_executable = changed & set(executable)
        changed_covered = sorted(changed_executable & set(covered))
        changed_uncovered = sorted(changed_executable - set(covered))
        files.append({"path": path, "covered_lines": covered, "executable_lines": executable})
        changed_lines[path] = {
            "covered_lines": changed_covered, "uncovered_lines": changed_uncovered,
            "covered": len(changed_covered), "uncovered": len(changed_uncovered),
        }
    if not files:
        warnings.append(f"{report}: no source-matched {language} LCOV records were found.")
    return {"available": bool(files), "source": report, "files": files,
            "changed_lines": changed_lines, "warnings": warnings}
