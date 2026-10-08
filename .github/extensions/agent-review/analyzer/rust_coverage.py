"""Source- and revision-matched Rust LCOV ingestion from saved snapshot bytes."""
from __future__ import annotations

import difflib
import hashlib
import json
import posixpath
from pathlib import PurePosixPath
from typing import Any


def _path(value: str) -> str:
    return posixpath.normpath(value.replace("\\", "/")).removeprefix("./")


def _metadata(snapshot: Any) -> tuple[str, dict[str, Any]] | None:
    names = {".agent-review/rust-coverage.json", "rust-coverage.json"}
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


def load_rust_coverage(snapshot: Any) -> dict[str, Any]:
    found = _metadata(snapshot)
    if not found:
        return {"available": False, "files": [], "changed_lines": {},
                "warnings": ["Rust coverage ignored: add rust-coverage.json with revision, report, and source_hashes evidence."]}
    metadata_path, metadata = found
    warnings: list[str] = []
    revision = metadata.get("revision") or metadata.get("head_sha")
    if not isinstance(revision, str) or revision != snapshot.head_commit:
        return {"available": False, "files": [], "changed_lines": {}, "warnings": [
            f"{metadata_path}: Rust coverage revision does not match the reviewed snapshot; "
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
                "warnings": [f"{metadata_path}: source_hashes are required to prevent stale Rust coverage."]}
    rust_paths = sorted(_path(path) for path in snapshot.current if path.lower().endswith(".rs"))
    valid: set[str] = set()
    for path in rust_paths:
        expected = hashes.get(path)
        actual = hashlib.sha256(snapshot.current[path].replace(b"\r\n", b"\n")).hexdigest()
        if not isinstance(expected, str) or expected.lower() != actual:
            warnings.append(f"{metadata_path}: {path}: source hash is missing or stale; coverage for this file was ignored.")
        else:
            valid.add(path)
    records: dict[str, dict[int, int]] = {}
    current_path: str | None = None
    try:
        for line in raw_report.decode("utf-8-sig").splitlines():
            if line.startswith("SF:"):
                candidate = _path(line[3:].strip())
                matches = [path for path in valid if candidate == path or candidate.endswith("/" + path)]
                current_path = matches[0] if len(matches) == 1 else None
                if len(matches) > 1:
                    warnings.append(f"{report}: ambiguous Rust source path {candidate}; use repository-relative SF paths.")
            elif line.startswith("DA:") and current_path:
                number, hits, *_ = line[3:].split(",")
                records.setdefault(current_path, {})[int(number)] = int(hits)
            elif line == "end_of_record":
                current_path = None
    except (UnicodeDecodeError, ValueError) as error:
        return {"available": False, "files": [], "changed_lines": {},
                "warnings": [f"{report}: malformed Rust LCOV data: {error}"]}
    files, changed_lines = [], {}
    for path, lines in sorted(records.items()):
        executable = sorted(lines)
        covered = sorted(number for number, hits in lines.items() if hits > 0)
        before = snapshot.baseline.get(path, b"").decode("utf-8", errors="replace").splitlines()
        after = snapshot.current[path].decode("utf-8", errors="replace").splitlines()
        changed: set[int] = set()
        for tag, _, _, start, end in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
            if tag in ("insert", "replace"):
                changed.update(range(start + 1, end + 1))
        changed_executable = changed & set(executable)
        changed_covered = sorted(changed_executable & set(covered))
        changed_uncovered = sorted(changed_executable - set(covered))
        files.append({"path": path, "covered_lines": covered, "executable_lines": executable})
        changed_lines[path] = {
            "covered_lines": changed_covered, "uncovered_lines": changed_uncovered,
            "covered": len(changed_covered), "uncovered": len(changed_uncovered),
        }
    if not files:
        warnings.append(f"{report}: no source-matched Rust LCOV records were found.")
    return {"available": bool(files), "source": report, "files": files,
            "changed_lines": changed_lines, "warnings": warnings}
