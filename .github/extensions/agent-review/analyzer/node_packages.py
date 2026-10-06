from __future__ import annotations

import fnmatch
import json
import re
from pathlib import PurePosixPath
from typing import Any


EXACT_VERSION = re.compile(r"^[v=]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$")
GROUPS = {"dependencies": "runtime", "devDependencies": "dev",
          "optionalDependencies": "optional", "peerDependencies": "peer"}


def _text(value: bytes | str) -> str:
    return value.decode("utf-8-sig") if isinstance(value, bytes) else value.lstrip("\ufeff")


def _json_spans(text: str) -> dict[tuple[str, ...], tuple[int, int]]:
    """Keep declaration key coordinates from the saved JSON, including escaped names."""
    decoder = json.JSONDecoder()
    spans: dict[tuple[str, ...], tuple[int, int]] = {}

    def space(index: int) -> int:
        while index < len(text) and text[index].isspace():
            index += 1
        return index

    def walk(index: int, path: tuple[str, ...]) -> int:
        index = space(index)
        if text[index] == "{":
            index = space(index + 1)
            while text[index] != "}":
                start = index
                key, index = decoder.raw_decode(text, index)
                spans[path + (key,)] = (start + 1, index - 1)
                index = walk(space(index) + 1, path + (key,))
                index = space(index)
                if text[index] == ",":
                    index = space(index + 1)
                else:
                    break
            return index + 1
        if text[index] == "[":
            index = space(index + 1)
            while text[index] != "]":
                index = space(walk(index, path))
                if text[index] == ",":
                    index = space(index + 1)
                else:
                    break
            return index + 1
        return decoder.raw_decode(text, index)[1]

    walk(0, ())
    return spans


def _location(text: str, span: tuple[int, int]) -> dict[str, int]:
    start, end = span
    line = text.count("\n", 0, start) + 1
    end_line = text.count("\n", 0, end) + 1
    column = start - (text.rfind("\n", 0, start) + 1)
    end_column = end - (text.rfind("\n", 0, end) + 1)
    return {
        "line": line, "end_line": end_line, "start_column": column, "end_column": end_column,
        "declaration_line": line, "declaration_end_line": end_line,
        "declaration_column_start": column, "declaration_column_end": end_column,
    }


def parse_packages(
    files: dict[str, bytes | str], warnings: list[str] | None = None,
) -> list[dict[str, Any]]:
    warnings = warnings if warnings is not None else []
    manifests: dict[str, tuple[dict[str, Any], str]] = {}
    locks: dict[str, dict[str, Any]] = {}
    for path, value in sorted(files.items()):
        parts = PurePosixPath(path).parts
        if ({".git", "node_modules", ".agent-review"} & set(parts)
                or any(part.startswith((".agent-review-node-tests-", ".node-runner-fixture-",
                                        ".coverage-import-fixture-")) for part in parts)):
            continue
        name = PurePosixPath(path).name
        if name in {"yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "bun.lock", "bun.lockb"}:
            warnings.append(f"{path}: unsupported Node lockfile; npm package-lock v2/v3 is required for locked versions.")
        if name not in {"package.json", "package-lock.json"}:
            continue
        try:
            text = _text(value)
            data = json.loads(text)
            if not isinstance(data, dict):
                raise ValueError("expected a JSON object")
            if name == "package.json":
                manifests[path] = (data, text)
            elif data.get("lockfileVersion") in (2, 3) and isinstance(data.get("packages"), dict):
                locks[str(PurePosixPath(path).parent)] = data
            else:
                warnings.append(f"{path}: unsupported package-lock version; only npm v2/v3 packages maps are supported.")
        except (UnicodeDecodeError, ValueError) as error:
            warnings.append(f"{path}: invalid Node manifest/lockfile: {error}")

    result = []
    workspace_manifests: dict[str, dict[str, Any]] = {}
    for root_source, (root_manifest, _) in manifests.items():
        workspace_patterns = root_manifest.get("workspaces", [])
        if isinstance(workspace_patterns, dict):
            workspace_patterns = workspace_patterns.get("packages", [])
        if not isinstance(workspace_patterns, list):
            continue
        root = PurePosixPath(root_source).parent
        for candidate_source, (candidate, _) in manifests.items():
            try:
                directory = str(PurePosixPath(candidate_source).parent.relative_to(root))
            except ValueError:
                continue
            if isinstance(candidate.get("name"), str) and any(
                    isinstance(pattern, str) and fnmatch.fnmatchcase(directory, pattern.rstrip("/"))
                    for pattern in workspace_patterns):
                workspace_manifests[candidate["name"]] = candidate
    for source, (manifest, text) in manifests.items():
        directory = PurePosixPath(source).parent
        spans = _json_spans(text)
        for field, group in GROUPS.items():
            declarations = manifest.get(field, {})
            if not isinstance(declarations, dict):
                warnings.append(f"{source}: {field} must be an object.")
                continue
            for declared_name, specifier in sorted(declarations.items()):
                if not isinstance(specifier, str):
                    warnings.append(f"{source}: {declared_name} has a non-string dependency specifier.")
                    continue
                name = declared_name
                alias = re.match(r"^npm:((?:@[^/]+/)?[^@]+)(?:@(.+))?$", specifier)
                version_specifier = specifier
                if alias:
                    name, version_specifier = alias.group(1), alias.group(2) or "*"
                item = {
                    "name": name, "import_name": declared_name, "ecosystem": "npm",
                    "id": f"package:npm:{name}", "specifier": specifier, "source": source,
                    "group": group, "resolved_version": None,
                }
                local_specifier = specifier.startswith(("workspace:", "file:", "link:", "portal:"))
                if local_specifier or name in workspace_manifests:
                    item["local"] = True
                if specifier.startswith("workspace:") or name in workspace_manifests:
                    item["workspace_link"] = True
                    item["workspace"] = True
                if workspace_manifests.get(name, {}).get("private") is True:
                    item["private"] = True
                span = spans.get((field, declared_name))
                if span:
                    item.update(_location(text, span))
                lock_root = next((ancestor for ancestor in (directory, *directory.parents)
                                  if str(ancestor) in locks), None)
                entry = None
                lock_source = None
                if lock_root is not None:
                    packages = locks[str(lock_root)]["packages"]
                    relative = directory.relative_to(lock_root)
                    for ancestor in (relative, *relative.parents):
                        prefix = "" if str(ancestor) == "." else f"{ancestor}/"
                        entry = packages.get(f"{prefix}node_modules/{declared_name}")
                        if isinstance(entry, dict):
                            break
                    if isinstance(entry, dict) and entry.get("link"):
                        target = entry.get("resolved", "")
                        workspace = manifests.get(str(lock_root / target / "package.json"))
                        entry = packages.get(target)
                        if not isinstance(entry, dict):
                            entry = workspace[0] if workspace else None
                        item["workspace"] = True
                        item["workspace_link"] = True
                        item["local"] = True
                        if ((isinstance(entry, dict) and entry.get("private") is True)
                                or (workspace and workspace[0].get("private") is True)):
                            item["private"] = True
                    lock_source = str(lock_root / "package-lock.json")
                version = entry.get("version") if isinstance(entry, dict) else None
                match = EXACT_VERSION.fullmatch(version or "")
                if match:
                    item["resolved_version"] = match.group(1)
                    item["resolution_source"] = lock_source
                elif not isinstance(entry, dict) and (match := EXACT_VERSION.fullmatch(version_specifier)):
                    item["resolved_version"] = match.group(1)
                    item["resolution_source"] = "exact declaration"
                else:
                    item["resolution_error"] = f"{source}: {declared_name} ({specifier}) has no exact snapshot version; version assessment is unknown."
                    warnings.append(item["resolution_error"])
                result.append(item)
    return sorted(result, key=lambda item: (item["name"], item["source"], item["group"]))


def package_diff(baseline: list[dict[str, Any]], current: list[dict[str, Any]]) -> list[dict[str, Any]]:
    before = {(item["name"], item["source"], item["group"]): item for item in baseline}
    after = {(item["name"], item["source"], item["group"]): item for item in current}
    changes = []
    for key in sorted(before.keys() | after.keys()):
        old, new = before.get(key), after.get(key)
        if old and new and (old["specifier"], old.get("resolved_version")) == (new["specifier"], new.get("resolved_version")):
            continue
        changes.append({
            "name": key[0], "source": key[1], "group": key[2], "ecosystem": "npm",
            "kind": "added" if old is None else "removed" if new is None else "version_changed",
            "before": old["specifier"] if old else None, "after": new["specifier"] if new else None,
            "resolved_before": old.get("resolved_version") if old else None,
            "resolved_after": new.get("resolved_version") if new else None,
        })
    return changes
