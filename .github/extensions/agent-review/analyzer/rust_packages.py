"""Cargo dependency evidence from saved Cargo.toml and Cargo.lock files.

The parser never invokes Cargo and never reads outside the supplied snapshot.
"""
from __future__ import annotations

import re
import tomllib
from pathlib import PurePosixPath
from typing import Any


_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
_DEPENDENCY_TABLES = {"dependencies": "runtime", "dev-dependencies": "dev", "build-dependencies": "build"}


def _text(value: bytes | str) -> str:
    return value.decode("utf-8-sig") if isinstance(value, bytes) else value.lstrip("\ufeff")


def _line_for(text: str, table: str, name: str) -> int:
    current = ""
    quoted = re.escape(name)
    for number, line in enumerate(text.splitlines(), 1):
        header = re.match(r"\s*\[([^\]]+)\]\s*(?:#.*)?$", line)
        if header:
            current = header.group(1).strip()
            normalized = current.replace('"', "")
            if normalized == f"{table}.{name}":
                return number
            continue
        if current == table and re.match(rf'\s*(?:"{quoted}"|{quoted})\s*=', line):
            return number
    return 1


def _location_for(text: str, table: str, name: str) -> dict[str, int]:
    line_number = _line_for(text, table, name)
    line = text.splitlines()[line_number - 1] if text.splitlines() else ""
    match = re.search(rf'(?:"({re.escape(name)})"|(?<![\w-])({re.escape(name)})(?![\w-]))\s*=', line)
    start = match.start(1) if match and match.group(1) is not None else (
        match.start(2) if match else max(0, line.rfind(name)))
    return {
        "line": line_number, "end_line": line_number,
        "start_column": start, "end_column": start + len(name),
        "declaration_line": line_number, "declaration_end_line": line_number,
        "declaration_column_start": start, "declaration_column_end": start + len(name),
    }


def _semver(value: str) -> tuple[int, int, int] | None:
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", value)
    return tuple(map(int, match.groups())) if match else None


def _lock_line(text: str, name: str, version: str) -> int:
    start = 1
    block: list[tuple[int, str]] = []
    for number, line in enumerate([*text.splitlines(), "[[package]]"], 1):
        if line.strip() == "[[package]]":
            if any(re.match(rf'\s*name\s*=\s*"{re.escape(name)}"\s*$', value) for _, value in block) \
                    and any(re.match(rf'\s*version\s*=\s*"{re.escape(version)}"\s*$', value)
                            for _, value in block):
                return next((line_number for line_number, value in block
                             if re.match(r"\s*name\s*=", value)), start)
            start, block = number, []
        else:
            block.append((number, line))
    return 1


def _matches(version: str, requirement: str | None) -> bool:
    """Conservative Cargo requirement matching for selecting a saved lock entry."""
    if not requirement or requirement == "*":
        return True
    parsed = _semver(version)
    if not parsed:
        return False
    requirement = requirement.strip()
    if requirement.startswith("="):
        return version == requirement[1:].strip()
    if requirement.startswith((">", "<")):
        for condition in requirement.split(","):
            match = re.match(r"\s*(>=|<=|>|<)\s*(\d+(?:\.\d+){0,2})", condition)
            if not match:
                return False
            parts = tuple(map(int, match.group(2).split(".")))
            wanted = parts + (0,) * (3 - len(parts))
            if not {">": parsed > wanted, ">=": parsed >= wanted, "<": parsed < wanted,
                    "<=": parsed <= wanted}[match.group(1)]:
                return False
        return True
    operator = requirement[0] if requirement[:1] in {"^", "~"} else "^"
    raw = requirement[1:] if requirement[:1] in {"^", "~"} else requirement
    if "*" in raw:
        prefix = tuple(map(int, raw.split("*", 1)[0].rstrip(".").split(".")))
        return parsed[:len(prefix)] == prefix
    parts = tuple(map(int, raw.split("-")[0].split(".")))
    lower = parts + (0,) * (3 - len(parts))
    if parsed < lower:
        return False
    if operator == "~":
        return parsed < (lower[0], lower[1] + 1, 0)
    if lower[0]:
        return parsed < (lower[0] + 1, 0, 0)
    if lower[1]:
        return parsed < (0, lower[1] + 1, 0)
    return parsed < (0, 0, lower[2] + 1)


def _manifest_records(path: str, data: dict[str, Any], text: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    tables: list[tuple[str, dict[str, Any], str]] = []
    for table, group in _DEPENDENCY_TABLES.items():
        values = data.get(table)
        if isinstance(values, dict):
            tables.append((table, values, group))
    for target, target_data in (data.get("target") or {}).items():
        if not isinstance(target_data, dict):
            continue
        for table, group in _DEPENDENCY_TABLES.items():
            values = target_data.get(table)
            if isinstance(values, dict):
                tables.append((f"target.{target}.{table}", values, group))
    for table, values, group in tables:
        for import_name, declaration in sorted(values.items()):
            if isinstance(declaration, str):
                settings: dict[str, Any] = {"version": declaration}
            elif isinstance(declaration, dict):
                settings = declaration
            else:
                continue
            package_name = settings.get("package", import_name)
            if not isinstance(package_name, str):
                continue
            specifier = settings.get("version")
            workspace = settings.get("workspace") is True
            item: dict[str, Any] = {
                "name": package_name, "declared_name": import_name,
                "import_name": import_name.replace("-", "_"),
                "ecosystem": "cargo", "language": "rust", "id": f"package:cargo:{package_name}",
                "specifier": str(specifier) if specifier is not None else "",
                "source": path, "group": group,
                "resolved_version": None,
            }
            item.update(_location_for(text, table, import_name))
            if workspace:
                item["workspace_inherited"] = True
            if settings.get("path") is not None:
                item.update({"local": True, "path_dependency": str(settings["path"])})
            if settings.get("git") is not None:
                item.update({"non_registry": True, "git": str(settings["git"])})
            if settings.get("registry") is not None:
                item["registry"] = str(settings["registry"])
                if item["registry"] != "crates-io":
                    item["non_registry"] = True
            if table.startswith("target."):
                item["target"] = table.split(".", 2)[1]
            records.append(item)
    return records


def parse_cargo_packages(
    files: dict[str, bytes | str], warnings: list[str] | None = None, *, strict: bool = False,
) -> list[dict[str, Any]]:
    warnings = warnings if warnings is not None else []
    manifests: dict[str, tuple[dict[str, Any], str]] = {}
    locks: dict[str, tuple[str, list[dict[str, Any]], str]] = {}
    for path, raw in sorted(files.items()):
        name = PurePosixPath(path).name
        if name not in {"Cargo.toml", "Cargo.lock"}:
            continue
        try:
            text = _text(raw)
            data = tomllib.loads(text)
            if name == "Cargo.toml":
                manifests[path] = (data, text)
            else:
                packages = data.get("package", [])
                if not isinstance(packages, list):
                    raise ValueError("package must be an array")
                locks[str(PurePosixPath(path).parent)] = (path, packages, text)
        except (UnicodeDecodeError, tomllib.TOMLDecodeError, ValueError) as error:
            message = f"{path}: invalid Cargo manifest/lockfile: {error}"
            if strict and name == "Cargo.toml":
                raise ValueError(message) from error
            warnings.append(message)

    workspace_dependencies: dict[str, Any] = {}
    for path, (data, _) in manifests.items():
        workspace = data.get("workspace")
        if isinstance(workspace, dict) and isinstance(workspace.get("dependencies"), dict):
            workspace_dependencies.update(workspace["dependencies"])

    result: list[dict[str, Any]] = []
    for path, (data, text) in manifests.items():
        records = _manifest_records(path, data, text)
        for item in records:
            if item.get("workspace_inherited"):
                inherited = workspace_dependencies.get(item["declared_name"])
                if inherited is None:
                    inherited = workspace_dependencies.get(item["name"])
                if isinstance(inherited, str):
                    item["specifier"] = inherited
                elif isinstance(inherited, dict):
                    if isinstance(inherited.get("package"), str):
                        item["name"] = inherited["package"]
                        item["id"] = f"package:cargo:{item['name']}"
                    item["specifier"] = str(inherited.get("version", ""))
                    if inherited.get("path") is not None:
                        item.update({"local": True, "path_dependency": str(inherited["path"])})
                    if inherited.get("git") is not None:
                        item.update({"non_registry": True, "git": str(inherited["git"])})
                else:
                    item["resolution_error"] = (
                        f"{path}:{item['line']}: workspace dependency {item['name']} has no saved "
                        "[workspace.dependencies] declaration"
                    )
            directory = PurePosixPath(path).parent
            lock = next((locks[str(parent)] for parent in (directory, *directory.parents)
                         if str(parent) in locks), None)
            if lock and not item.get("local"):
                lock_path, packages, lock_text = lock
                candidates = [
                    package for package in packages
                    if package.get("name") == item["name"]
                    and isinstance(package.get("version"), str)
                    and _VERSION.fullmatch(package["version"])
                    and _matches(package["version"], item.get("specifier"))
                ]
                # Registry declarations must not silently select a Git checkout with the same name.
                if not item.get("non_registry"):
                    registry = [package for package in candidates
                                if str(package.get("source", "")).startswith(("registry+", "sparse+"))]
                    candidates = registry or [package for package in candidates if not package.get("source")]
                versions = {package["version"] for package in candidates}
                if len(versions) == 1:
                    selected = next(package for package in candidates if package["version"] in versions)
                    item.update({
                        "resolved_version": selected["version"], "lock_source": lock_path,
                        "lock_line": _lock_line(lock_text, item["name"], selected["version"]),
                        "lock_package_source": selected.get("source"),
                        "lock_checksum": selected.get("checksum"),
                    })
                    lock_source = str(selected.get("source", ""))
                    if lock_source:
                        item["public_registry"] = lock_source in {
                            "registry+https://github.com/rust-lang/crates.io-index",
                            "sparse+https://index.crates.io/",
                            "sparse+https://index.crates.io",
                        }
                elif len(versions) > 1:
                    item["resolution_error"] = (
                        f"{path}:{item['line']}: Cargo.lock contains multiple matching versions for "
                        f"{item['name']} ({', '.join(sorted(versions))}); exact direct resolution is unknown"
                    )
            if item["resolved_version"] is None and _VERSION.fullmatch(item.get("specifier", "")):
                # A plain Cargo version is a caret requirement, not an exact pin. Preserve that distinction.
                item["manifest_version"] = item["specifier"]
            result.append(item)
    return result


def cargo_package_diff(before: list[dict[str, Any]], after: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def grouped(items: list[dict[str, Any]]) -> dict[tuple[str, str, str], list[dict[str, Any]]]:
        values: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
        for item in items:
            values.setdefault((item["name"], item["source"], item["group"]), []).append(item)
        return values

    old, new = grouped(before), grouped(after)
    changes = []
    for key in sorted(set(old) | set(new)):
        left, right = old.get(key, []), new.get(key, [])
        if not left:
            kind = "added"
        elif not right:
            kind = "removed"
        else:
            fields = ("specifier", "resolved_version", "lock_package_source", "local", "git", "target")
            if [{field: item.get(field) for field in fields} for item in left] == [
                    {field: item.get(field) for field in fields} for item in right]:
                continue
            kind = "version_changed"
        item = (right or left)[0]
        changes.append({
            "name": item["name"], "ecosystem": "cargo", "language": "rust", "kind": kind,
            "before": left, "after": right,
            "resolved_before": left[0].get("resolved_version") if left else None,
            "resolved_after": right[0].get("resolved_version") if right else None,
        })
    return changes
