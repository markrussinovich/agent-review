from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from git_snapshot import changed_lines


def _xml(path: Path) -> dict[str, dict[str, set[int]]] | None:
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError):
        return None
    result: dict[str, dict[str, set[int]]] = {}
    for class_node in root.findall(".//class"):
        filename = class_node.get("filename")
        if not filename:
            continue
        lines = class_node.findall("./lines/line")
        result[filename.replace("\\", "/")] = {
            "executable": {int(line.get("number", "0")) for line in lines},
            "covered": {
                int(line.get("number", "0"))
                for line in lines if int(line.get("hits", "0")) > 0
            },
        }
    return result or None


def _json_coverage(path: Path) -> dict[str, dict[str, set[int]]] | None:
    try:
        raw = path.read_bytes()
        if not raw.lstrip().startswith((b"{", b"[")):
            return None
        data = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    files = data.get("files", {}) if isinstance(data, dict) else {}
    result: dict[str, dict[str, set[int]]] = {}
    for filename, record in files.items():
        if isinstance(record, dict):
            executed = record.get("executed_lines", record.get("lines", []))
            missing = record.get("missing_lines", [])
            if isinstance(executed, list) and isinstance(missing, list):
                covered = {int(line) for line in executed}
                result[str(filename).replace("\\", "/")] = {
                    "covered": covered,
                    "executable": covered | {int(line) for line in missing},
                }
    return result or None


def load_coverage(repo: Path, base_ref: str | None, python_paths: list[str]) -> dict[str, Any]:
    candidates = [repo / "coverage.json", repo / "coverage.xml", repo / ".coverage"]
    coverage: dict[str, dict[str, set[int]]] | None = None
    source: str | None = None
    for candidate in candidates:
        if not candidate.is_file():
            continue
        parsed = _xml(candidate) if candidate.suffix == ".xml" else _json_coverage(candidate)
        if parsed:
            coverage, source = parsed, candidate.name
            break
    if not coverage:
        return {"available": False, "files": [], "changed_lines": {}}
    files: list[dict[str, Any]] = []
    changed_summary: dict[str, dict[str, Any]] = {}
    for path in sorted(python_paths):
        record = coverage.get(path)
        if record is None:
            record = coverage.get(str((repo / path).resolve()).replace("\\", "/"))
        if record is None:
            continue
        covered_lines = record["covered"]
        executable_lines = record["executable"]
        total_lines = len((repo / path).read_text(errors="replace").splitlines())
        files.append({
            "path": path,
            "covered_lines": sorted(covered_lines),
            "executable_lines": sorted(executable_lines),
            "line_count": total_lines,
        })
        changed = changed_lines(repo, base_ref, path)
        executable_changed = changed & executable_lines
        covered = executable_changed & covered_lines
        changed_summary[path] = {
            "total": len(executable_changed),
            "covered": len(covered),
            "percent": round(100 * len(covered) / len(executable_changed), 2)
            if executable_changed
            else None,
            "covered_lines": sorted(covered),
            "uncovered_lines": sorted(executable_changed - covered),
        }
    return {
        "available": True,
        "source": source,
        "files": files,
        "changed_lines": changed_summary,
    }
