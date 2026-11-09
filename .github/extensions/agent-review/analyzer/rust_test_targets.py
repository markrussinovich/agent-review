"""Resolve libtest selectors from saved Cargo targets and Rust mod declarations."""
from __future__ import annotations

import json
import posixpath
import re
import tomllib
from collections import defaultdict
from pathlib import PurePosixPath
from typing import Any


def _relative(directory: str, path: str) -> str | None:
    if not path or path.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", path):
        return None
    value = posixpath.normpath(posixpath.join(directory, path.replace("\\", "/")))
    return None if value == ".." or value.startswith("../") else value


def _targets(files: dict[str, bytes]) -> list[dict[str, Any]]:
    targets = []
    manifests = {}
    for manifest, raw in sorted(files.items()):
        if PurePosixPath(manifest).name != "Cargo.toml":
            continue
        try:
            manifests[manifest] = tomllib.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, tomllib.TOMLDecodeError):
            # Invalid manifests are reported by the dependency adapter, never guessed here.
            continue
    for manifest, data in manifests.items():
        package = data.get("package", {})
        name = package.get("name")
        if not isinstance(name, str):
            continue
        manifest_directory = PurePosixPath(manifest).parent
        directory = str(manifest_directory)
        edition = package.get("edition", "2015")
        if isinstance(edition, dict):
            edition = None
            for parent in (manifest_directory, *manifest_directory.parents):
                workspace = manifests.get(str(parent / "Cargo.toml"), {}).get("workspace", {})
                inherited = workspace.get("package", {}).get("edition")
                if isinstance(inherited, str):
                    edition = inherited
                    break
        auto = (isinstance(edition, str) and edition != "2015") or not any(
            kind in data for kind in ("lib", "bin", "test", "example", "bench"))
        for kind, folder, auto_key in (
            ("lib", "src", "autolib"), ("bin", "src/bin", "autobins"),
            ("test", "tests", "autotests"), ("example", "examples", "autoexamples"),
            ("bench", "benches", "autobenches"),
        ):
            inferred: dict[str, list[str]] = defaultdict(list)
            if kind in {"lib", "bin"}:
                root = _relative(directory, f"src/{'lib' if kind == 'lib' else 'main'}.rs")
                if root in files:
                    inferred[name.replace("-", "_") if kind == "lib" else name].append(root)
            if kind != "lib":
                base = PurePosixPath(directory) / folder
                for path in sorted(files):
                    try:
                        parts = PurePosixPath(path).relative_to(base).parts
                    except ValueError:
                        continue
                    if len(parts) == 1 and parts[0].endswith(".rs"):
                        inferred[PurePosixPath(parts[0]).stem].append(path)
                    elif len(parts) == 2 and parts[1] == "main.rs":
                        inferred[parts[0]].append(path)
            explicit = [data[kind]] if kind == "lib" and kind in data else data.get(kind, [])
            declared = set()
            declared_roots = set()
            for settings in explicit:
                target_name = settings.get("name", name.replace("-", "_") if kind == "lib" else None)
                if not isinstance(target_name, str):
                    continue
                declared.add(target_name)
                roots = ([_relative(directory, settings["path"])] if isinstance(settings.get("path"), str)
                         else inferred.get(name.replace("-", "_") if kind == "lib" else target_name, []))
                declared_roots.update(roots)
                error = ("Cargo target does not use the libtest harness."
                         if settings.get("harness") is False else
                         "Cargo target requires features not selected by this runner."
                         if settings.get("required-features") else None)
                for root in roots:
                    if root in files:
                        targets.append({"kind": kind, "name": target_name, "path": root,
                                        "manifest": manifest, "error": error or (
                                            "Cargo target has ambiguous inferred source roots."
                                            if len(roots) != 1 else None)})
            if package.get(auto_key, True if kind == "lib" else auto) and not (kind == "lib" and explicit):
                for target_name, roots in inferred.items():
                    if target_name in declared:
                        continue
                    for root in roots:
                        if root in declared_roots:
                            continue
                        targets.append({"kind": kind, "name": target_name, "path": root,
                                        "manifest": manifest, "error": (
                                            "Cargo target has ambiguous inferred source roots."
                                            if len(roots) != 1 else None)})
    return targets


def _path_attribute(attributes: str) -> tuple[str | None, str | None]:
    if re.search(r"#\s*\[\s*cfg_attr\b", attributes):
        return None, "Conditional module attributes cannot be resolved from saved syntax."
    declarations = re.findall(r"#\s*\[\s*path\s*=\s*(.*?)\s*\]", attributes, re.S)
    if not declarations:
        return None, None
    if len(declarations) != 1:
        return None, "Multiple module path attributes are ambiguous."
    literal = declarations[0]
    raw = re.fullmatch(r'r(#{0,255})"(.*)"\1', literal, re.S)
    if raw:
        return raw.group(2), None
    try:
        value = json.loads(literal)
        if isinstance(value, str):
            return value, None
    except (ValueError, TypeError):
        pass
    return None, "Module path is not a supported literal."


def resolve_test_selectors(
    files: dict[str, bytes], parsed: list[dict[str, Any]], tests: list[dict[str, Any]],
) -> None:
    if not tests:
        return
    by_path = {file["path"]: file for file in parsed}
    test_symbols = {(test["path"], test["symbol_id"]) for test in tests}
    candidates: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    children = {}
    for file in parsed:
        scopes: dict[int | None, list[dict[str, Any]]] = defaultdict(list)
        depth, depths = 0, {}
        offsets = {item["kind_start"] for item in file["items"]}
        offsets.update(item["open"] for item in file["items"] if item["open"] is not None)
        for offset, char in enumerate(file["masked"]):
            if offset in offsets:
                depths[offset] = depth
            depth += (char == "{") - (char == "}")
        for item in file["items"]:
            parent = item["parent"]
            expected = depths[parent["open"]] + 1 if parent and parent["open"] is not None else 0
            # Do not interpret macro/block contents as crate-level mod declarations.
            if depths[item["kind_start"]] == expected:
                scopes[parent["start"] if parent else None].append(item)
        children[file["path"]] = scopes

    visits = 0
    limited = False

    def walk(path: str, scope: int | None, prefix: list[str], directory: str,
             target: dict[str, Any], ancestry: list[str], error: str | None = None) -> None:
        nonlocal visits, limited
        visits += 1
        if visits > 10000 or len(ancestry) > 100 or len(prefix) > 100:
            limited = True
            return
        file = by_path[path]
        for item in children[path].get(scope, []):
            logical = [*prefix, item["name"]]
            if item["kind"] == "fn" and (path, item.get("id")) in test_symbols:
                candidates[(path, item["id"])].append({
                    "name": "::".join(logical), "cargo_target": {
                        key: target[key] for key in ("kind", "name", "path")},
                    "manifest": target["manifest"], "selector_error": error or target["error"],
                })
            if item["kind"] != "mod":
                continue
            custom, attribute_error = _path_attribute(item["attributes"])
            if attribute_error:
                # Inline tests remain visible but cannot be offered a guessed selector.
                if item["open"] is not None:
                    walk(path, item["start"], logical, directory, target, ancestry, attribute_error)
                continue
            if item["open"] is not None:
                base = str(PurePosixPath(path).parent) if custom is not None and scope is None else directory
                nested = _relative(base, custom if custom is not None else item["name"].removeprefix("r#"))
                if nested is not None:
                    walk(path, item["start"], logical, nested, target, ancestry, error)
                continue
            # An outer #[path] is relative to the physical file, not foo.rs's
            # implicit foo/ child directory; inline modules use their own directory.
            base = directory if scope is not None else str(PurePosixPath(path).parent)
            roots = ([_relative(base, custom)] if custom is not None else [
                _relative(directory, f"{item['name'].removeprefix('r#')}.rs"),
                _relative(directory, f"{item['name'].removeprefix('r#')}/mod.rs"),
            ])
            roots = [root for root in roots if root in by_path]
            for root in roots:
                if root in ancestry:
                    continue
                pure = PurePosixPath(root)
                nested = str(pure.parent if custom is not None or pure.name == "mod.rs" else pure.with_suffix(""))
                walk(root, None, logical, nested, target, [*ancestry, root],
                     error or ("Module has both file.rs and file/mod.rs sources."
                               if len(roots) != 1 else None))

    for target in _targets(files):
        root = target["path"]
        if root in by_path:
            walk(root, None, [], str(PurePosixPath(root).parent), target, [root])
    if limited:
        for test in tests:
            test["selector_error"] = "Cargo/module resolution exceeded the saved-syntax limit."
        return
    executable_ids: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for test in tests:
        mappings = candidates[(test["path"], test["symbol_id"])]
        if len(mappings) != 1:
            test["selector_error"] = (
                "Test belongs to multiple Cargo targets or module paths; an exact selector is ambiguous."
                if mappings else "No saved Cargo target and declared module path reaches this test.")
            continue
        test.update(mappings[0])
        target = test["cargo_target"]
        executable_ids[(test["manifest"], target["kind"], target["name"], test["name"])].append(test)
    for colliding in executable_ids.values():
        if len(colliding) > 1:
            for test in colliding:
                test["selector_error"] = "Multiple source tests resolve to the same Cargo exact selector."
