from __future__ import annotations

import importlib.metadata
import re
import tomllib
from pathlib import PurePosixPath
from typing import Any


NAME = re.compile(r"^\s*([A-Za-z0-9_.-]+)")


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def import_name(name: str) -> str:
    return normalize(name).replace("-", "_")


def _requirement(value: str, source: str, group: str = "runtime") -> dict[str, str] | None:
    value = value.strip()
    if not value or value.startswith(("#", "-", "git+", "http:")):
        return None
    value = value.split(";", 1)[0].strip()
    match = NAME.match(value)
    if not match:
        return None
    name = normalize(match.group(1))
    specifier = value[match.end():].strip()
    if specifier.startswith("["):
        _, _, specifier = specifier.partition("]")
        specifier = specifier.strip()
    return {"name": name, "specifier": specifier, "source": source, "group": group}


def parse_packages(
    files: dict[str, bytes], warnings: list[str] | None = None
) -> list[dict[str, Any]]:
    records: dict[tuple[str, str, str], dict[str, Any]] = {}
    pyproject = files.get("pyproject.toml")
    if pyproject:
        try:
            data = tomllib.loads(pyproject.decode("utf-8"))
            project = data.get("project", {})
            for value in project.get("dependencies", []):
                item = _requirement(value, "pyproject.toml")
                if item:
                    records[(item["name"], item["source"], item["group"])] = item
            for group, values in project.get("optional-dependencies", {}).items():
                for value in values:
                    item = _requirement(value, "pyproject.toml", str(group))
                    if item:
                        records[(item["name"], item["source"], item["group"])] = item
        except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
            if warnings is not None:
                warnings.append(f"pyproject.toml: unable to parse dependencies: {error}")
    for path, content in sorted(files.items()):
        filename = PurePosixPath(path).name.lower()
        if not (filename.startswith("requirements") and filename.endswith(".txt")):
            continue
        try:
            lines = content.decode("utf-8-sig").splitlines()
        except UnicodeDecodeError as error:
            if warnings is not None:
                warnings.append(f"{path}: unable to parse requirements: {error}")
            continue
        for line in lines:
            item = _requirement(line, path, PurePosixPath(path).stem)
            if item:
                records[(item["name"], item["source"], item["group"])] = item
    return sorted(records.values(), key=lambda item: (item["name"], item["source"], item["group"]))


def installed_versions(packages: list[dict[str, Any]]) -> None:
    versions: dict[str, str] = {}
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name")
        if name:
            versions[normalize(name)] = distribution.version
    for package in packages:
        if package["name"] in versions:
            package["resolved_version"] = versions[package["name"]]


def package_diff(
    baseline: list[dict[str, Any]], current: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    def collapse(items: list[dict[str, Any]]) -> dict[tuple[str, str], str]:
        return {(item["name"], item["group"]): item["specifier"] for item in items}

    before, after = collapse(baseline), collapse(current)
    result: list[dict[str, Any]] = []
    for key in sorted(set(before) | set(after)):
        old, new = before.get(key), after.get(key)
        if old == new:
            continue
        kind = "added" if old is None else "removed" if new is None else "version_changed"
        result.append(
            {"name": key[0], "group": key[1], "kind": kind, "before": old, "after": new}
        )
    return result


def declared_import_names(packages: list[dict[str, Any]]) -> set[str]:
    return {import_name(item["name"]) for item in packages}
