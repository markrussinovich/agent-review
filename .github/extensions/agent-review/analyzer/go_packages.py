"""Go module dependency evidence from saved go.mod/go.sum files only."""
from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Any


_VERSION = re.compile(r"^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?$")
_PSEUDO = re.compile(r"^v\d+\.\d+\.\d+-\d{14}-[0-9a-f]{12,}$")


def _text(raw: bytes | str) -> str:
    return raw.decode("utf-8-sig") if isinstance(raw, bytes) else raw.lstrip("\ufeff")


def _exact(version: str) -> bool:
    return bool(_VERSION.fullmatch(version) or _PSEUDO.fullmatch(version))


def _module_files(files: dict[str, bytes | str]) -> list[str]:
    return sorted(path for path in files if PurePosixPath(path).name == "go.mod"
                  and ".git" not in PurePosixPath(path).parts)


def _sum_index(files: dict[str, bytes | str], root: PurePosixPath,
               warnings: list[str]) -> dict[tuple[str, str], dict[str, Any]]:
    path = str(root / "go.sum")
    raw = files.get(path)
    if raw is None and str(root) == ".":
        raw = files.get("go.sum")
        path = "go.sum"
    result: dict[tuple[str, str], dict[str, Any]] = {}
    if raw is None:
        return result
    try:
        text = _text(raw)
    except UnicodeDecodeError as error:
        warnings.append(f"{path}: invalid UTF-8 Go checksum file: {error}")
        return result
    for line_number, line in enumerate(text.splitlines(), 1):
        fields = line.split()
        if len(fields) != 3 or not fields[2].startswith("h1:"):
            if line.strip():
                warnings.append(f"{path}:{line_number}: malformed go.sum entry ignored.")
            continue
        name, version, checksum = fields
        module_version = version.removesuffix("/go.mod")
        key = (name, module_version)
        entry = result.setdefault(key, {"sum_source": path, "sum_line": line_number})
        entry["go_mod_checksum" if version.endswith("/go.mod") else "module_checksum"] = checksum
    return result


def _tokens(text: str) -> list[tuple[int, list[str]]]:
    result = []
    for line_number, raw in enumerate(text.splitlines(), 1):
        indirect = bool(re.search(r"//\s*indirect\s*$", raw))
        line = raw.split("//", 1)[0].strip()
        if line:
            fields = line.replace("(", " ( ").replace(")", " ) ").split()
            result.append((line_number, [*fields, *(["indirect"] if indirect else [])]))
    return result


def parse_go_packages(files: dict[str, bytes | str],
                      warnings: list[str] | None = None) -> list[dict[str, Any]]:
    warnings = warnings if warnings is not None else []
    result: list[dict[str, Any]] = []
    for source in _module_files(files):
        try:
            text = _text(files[source])
        except UnicodeDecodeError as error:
            warnings.append(f"{source}: invalid UTF-8 go.mod: {error}")
            continue
        root = PurePosixPath(source).parent
        sums = _sum_index(files, root, warnings)
        requires: list[dict[str, Any]] = []
        replacements: dict[str, tuple[list[str], int]] = {}
        excludes: set[tuple[str, str]] = set()
        block: str | None = None
        module_path: str | None = None
        for line_number, fields in _tokens(text):
            if fields == [")"]:
                block = None
                continue
            directive = fields[0] if block is None else block
            values = fields[1:] if block is None else fields
            if values == ["("]:
                block = directive
                continue
            if directive == "module" and values:
                module_path = values[0]
            elif directive == "require" and len(values) >= 2:
                name, version = values[:2]
                requires.append({
                    "name": name, "specifier": version, "resolved_version": version if _exact(version) else None,
                    "ecosystem": "gomod", "language": "go", "source": source, "line": line_number,
                    "declaration_line": line_number, "group": "indirect" if "indirect" in fields else "runtime",
                    "module_root": str(root), "project_module": module_path,
                })
            elif directive == "replace" and "=>" in values:
                split = values.index("=>")
                if split >= 1:
                    replacements[values[0]] = (values[split + 1:], line_number)
            elif directive == "exclude" and len(values) >= 2:
                excludes.add((values[0], values[1]))
        for item in requires:
            replacement = replacements.get(item["name"])
            if replacement:
                values, line_number = replacement
                item["replace_source"] = source
                item["replace_line"] = line_number
                item["replacement"] = " ".join(values)
                if len(values) == 1 or values[0].startswith((".", "/")):
                    item["local"] = True
                    item["resolved_version"] = None
                elif len(values) >= 2 and _exact(values[1]):
                    item["replacement_name"] = values[0]
                    item["resolved_version"] = values[1]
                else:
                    item["resolution_error"] = (
                        f"{source}:{line_number}: replacement for {item['name']} has no exact module version"
                    )
                    item["resolved_version"] = None
            if (item["name"], item["specifier"]) in excludes:
                item["excluded"] = True
                item["resolution_error"] = (
                    f"{source}:{item['line']}: required version {item['specifier']} is also excluded"
                )
                item["resolved_version"] = None
            version = item.get("resolved_version")
            checksum_name = item.get("replacement_name", item["name"])
            if version and (checksum := sums.get((checksum_name, version))):
                item.update(checksum)
                item["checksum_verified"] = bool(checksum.get("module_checksum") or checksum.get("go_mod_checksum"))
            elif version:
                item["checksum_verified"] = False
                warnings.append(
                    f"{source}:{item['line']}: {item['name']}@{version} has no matching saved go.sum checksum; "
                    "the exact declaration is retained but downloaded content is not verified."
                )
            result.append(item)
    return result


def go_package_diff(baseline: list[dict[str, Any]],
                    current: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def grouped(items: list[dict[str, Any]]) -> dict[str, set[tuple[Any, ...]]]:
        values: dict[str, set[tuple[Any, ...]]] = {}
        for item in items:
            values.setdefault(item["name"], set()).add((
                item.get("specifier"), item.get("resolved_version"), item.get("replacement"),
                item.get("group"), item.get("checksum_verified"),
            ))
        return values
    before, after = grouped(baseline), grouped(current)
    result = []
    for name in sorted(set(before) | set(after)):
        if before.get(name) == after.get(name):
            continue
        kind = "added" if name not in before else "removed" if name not in after else "version_changed"
        result.append({"name": name, "ecosystem": "gomod", "language": "go", "kind": kind,
                       "baseline": sorted(before.get(name, set()), key=str),
                       "current": sorted(after.get(name, set()), key=str)})
    return result
