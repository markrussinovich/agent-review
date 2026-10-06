"""NuGet evidence from saved manifests only; never evaluate MSBuild or restore."""
from __future__ import annotations

import json
import re
from pathlib import PurePosixPath
from typing import Any
from xml.etree.ElementTree import Element
from xml.parsers import expat


_VERSION = re.compile(r"\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")


def _xml_document(raw: bytes) -> tuple[Element, dict[int, int]]:
    """Parse XML without DTD/entity expansion, retaining declaration line numbers."""
    parser = expat.ParserCreate(namespace_separator="}")
    stack: list[Element] = []
    lines: dict[int, int] = {}
    root: Element | None = None

    def start(tag: str, attributes: dict[str, str]) -> None:
        nonlocal root
        node = Element(tag.rsplit("}", 1)[-1], attributes)
        lines[id(node)] = parser.CurrentLineNumber
        if stack:
            stack[-1].append(node)
        else:
            root = node
        stack.append(node)

    def text(value: str) -> None:
        if stack:
            node = stack[-1]
            node.text = (node.text or "") + value

    def reject(*args: Any) -> None:
        raise ValueError("DTD and entity declarations are not supported")

    parser.StartElementHandler = start
    parser.EndElementHandler = lambda tag: stack.pop()
    parser.CharacterDataHandler = text
    parser.StartDoctypeDeclHandler = reject
    parser.EntityDeclHandler = reject
    parser.ExternalEntityRefHandler = reject
    parser.Parse(raw, True)
    if root is None:
        raise ValueError("empty XML document")
    return root, lines


def _exact(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value.startswith("[") and value.endswith("]") and "," not in value:
        value = value[1:-1].strip()
    return value if _VERSION.fullmatch(value) else None


def _entries(root: Element, tag: str) -> list[tuple[Element, bool]]:
    result: list[tuple[Element, bool]] = []

    def visit(node: Element, conditional: bool) -> None:
        conditional = conditional or bool(node.get("Condition")) or node.tag in ("Choose", "When", "Otherwise")
        if node.tag == tag:
            result.append((node, conditional))
        for child in node:
            visit(child, conditional)

    visit(root, False)
    return result


def _metadata(node: Element, key: str) -> tuple[str, bool]:
    children = [child for child in node if child.tag == key]
    if key in node.attrib:
        return node.attrib[key].strip(), bool(children)
    if not children:
        return "", False
    return (children[0].text or "").strip(), len(children) != 1 or bool(children[0].get("Condition"))


def _identity(name: str) -> str:
    # NuGet is case-insensitive, but dots/hyphens/underscores are distinct.
    return name.lower()


def _json_key_lines(raw: bytes) -> dict[str, int]:
    text = raw.decode("utf-8-sig")
    result = {}
    offset, line = 0, 1
    for match in re.finditer(r'"(?:[^"\\]|\\.)*"\s*:', text):
        token = match.group().rsplit(":", 1)[0].strip()
        line += text.count("\n", offset, match.start())
        offset = match.start()
        result.setdefault(json.loads(token), line)
    return result


def parse_dotnet_packages(
    files: dict[str, bytes], warnings: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Return Python-compatible declarations plus NuGet/project identity.

    ``source``/``line`` always identify the saved declaration; central version
    coordinates and lock/assets evidence are retained separately. Unresolved
    declarations have ``resolution_error`` and no ``resolved_version``.
    """
    warnings = warnings if warnings is not None else []
    files = {path.replace("\\", "/"): raw for path, raw in files.items()}
    documents: dict[str, tuple[Element, dict[int, int]]] = {}
    for path, raw in sorted(files.items()):
        if path.lower().endswith(".csproj") or PurePosixPath(path).name.lower() == "directory.packages.props":
            try:
                documents[path] = _xml_document(raw)
                if documents[path][0].tag != "Project":
                    documents.pop(path)
                    raise ValueError("expected a <Project> manifest")
            except (expat.ExpatError, ValueError) as error:
                warnings.append(f"{path}: cannot parse NuGet manifest: {error}; fix the saved XML.")
    projects = sorted(path for path in files if path.lower().endswith(".csproj"))
    records: list[dict[str, Any]] = []

    def problem(item: dict[str, Any], reason: str) -> None:
        message = f"{item['source']}:{item['line']}: {item['name']}: {reason}; provide an unconditional exact NuGet version in the saved manifests."
        item["resolution_error"] = message
        item.pop("resolved_version", None)
        warnings.append(message)

    for project in projects:
        if project not in documents:
            continue
        root, lines = documents[project]
        central_path = None
        for parent in (PurePosixPath(project).parent, *PurePosixPath(project).parent.parents):
            candidates = [path for path in files if PurePosixPath(path).parent == parent and PurePosixPath(path).name.lower() == "directory.packages.props"]
            if candidates:
                central_path = sorted(candidates)[0]
                break
        central: dict[str, list[tuple[Element, bool]]] = {}
        if central_path in documents:
            for node, condition in _entries(documents[central_path][0], "PackageVersion"):
                name = node.get("Include") or node.get("Update") or ""
                central.setdefault(_identity(name), []).append((node, condition))
        settings = _entries(root, "ManagePackageVersionsCentrally")
        if not settings and central_path in documents:
            settings = _entries(documents[central_path][0], "ManagePackageVersionsCentrally")
        central_values = {(node.text or "").strip().lower() for node, _ in settings}
        central_unknown = (
            any(condition for _, condition in settings)
            or len(central_values) > 1
            or bool(central_values - {"true", "false"})
        )
        central_disabled = central_values == {"false"} and not central_unknown
        for node, conditional in _entries(root, "PackageReference"):
            name = node.get("Include") or node.get("Update")
            if not name:
                warnings.append(f"{project}:{lines[id(node)]}: PackageReference has no literal Include; MSBuild evaluation is not performed.")
                continue
            value, version_condition = _metadata(node, "VersionOverride")
            if not value:
                value, version_condition = _metadata(node, "Version")
            item: dict[str, Any] = {
                "name": name, "identity": _identity(name), "ecosystem": "nuget", "language": "csharp",
                "specifier": value, "source": project, "project": project, "group": "runtime",
                "line": lines[id(node)], "declaration_line": lines[id(node)],
            }
            reason = None
            if not value and central_path and not central_disabled:
                candidates = central.get(_identity(name), [])
                if len(candidates) == 1:
                    version_node, central_condition = candidates[0]
                    value, version_condition = _metadata(version_node, "Version")
                    conditional = conditional or central_condition
                    item.update({
                        "specifier": value, "version_source": central_path,
                        "version_line": documents[central_path][1][id(version_node)],
                    })
                elif candidates:
                    reason = "multiple central version declarations are ambiguous"
                elif central_path not in documents:
                    reason = "nearest central manifest is malformed"
                if central_unknown:
                    reason = "central package management is conditional or property-based and unresolved"
            if conditional or version_condition:
                reason = "conditional declarations are unresolved without MSBuild evaluation"
            elif node.get("Update") and not node.get("Include"):
                reason = "PackageReference Update is unresolved without MSBuild evaluation"
            elif not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
                reason = "package identity contains an MSBuild property or unsupported expression"
            elif value and _exact(value) is None:
                reason = "version range, floating version, or MSBuild property is unresolved"
            if reason:
                problem(item, reason)
            elif version := _exact(value):
                item["resolved_version"] = version
            records.append(item)

    for path, raw in sorted(files.items()):
        basename = PurePosixPath(path).name.lower()
        if basename not in ("packages.lock.json", "project.assets.json"):
            continue
        parent = PurePosixPath(path).parent
        if basename == "project.assets.json" and parent.name.lower() == "obj":
            parent = parent.parent
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("expected a JSON object")
            key_lines = _json_key_lines(raw)
            owners = [project for project in projects if PurePosixPath(project).parent == parent]
            if basename == "project.assets.json":
                saved_project = data.get("project", {}).get("restore", {}).get("projectPath")
                if isinstance(saved_project, str):
                    saved_project = saved_project.replace("\\", "/")
                    matches = [project for project in projects if saved_project == project or saved_project.endswith("/" + project)]
                    if len(matches) == 1:
                        owners = matches
            if len(owners) != 1:
                warnings.append(f"{path}: NuGet evidence has no unambiguous snapshot project; include a single matching .csproj or project-specific manifests.")
                continue
            versions: dict[str, tuple[str, set[str], str, int]] = {}
            if basename == "packages.lock.json":
                groups = data.get("dependencies", {})
            else:
                groups = data.get("targets") or {"libraries": data.get("libraries", {})}
            if not isinstance(groups, dict):
                raise ValueError("expected dependency/target objects")
            for dependencies in groups.values():
                if not isinstance(dependencies, dict):
                    raise ValueError("expected a dependency object")
                for key, entry in dependencies.items():
                    if not isinstance(entry, dict):
                        raise ValueError("expected package metadata objects")
                    if basename == "project.assets.json":
                        if entry.get("type") != "package":
                            continue
                        name, separator, version = key.rpartition("/")
                        if not separator:
                            raise ValueError(f"invalid package identity {key}")
                        kind = "transitive"
                    else:
                        if entry.get("type", "").lower() not in ("direct", "transitive"):
                            continue
                        name, version = key, entry.get("resolved")
                        kind = "runtime" if entry.get("type", "").lower() == "direct" else "transitive"
                    exact = _exact(version)
                    if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or exact is None:
                        warnings.append(f"{path}: {name}: non-exact resolved NuGet version ignored.")
                        continue
                    identity = _identity(name)
                    if identity not in versions:
                        versions[identity] = (name, set(), kind, key_lines.get(key, 1))
                    versions[identity][1].add(exact)
            for identity, (name, values, group, line) in sorted(versions.items()):
                declarations = [item for item in records if item["project"] == owners[0] and item["identity"] == identity]
                if not declarations:
                    item = {
                        "name": name, "identity": identity, "ecosystem": "nuget", "language": "csharp",
                        "specifier": "", "source": path, "project": owners[0], "group": group,
                        "line": line, "declaration_line": line,
                    }
                    records.append(item)
                    declarations = [item]
                for item in declarations:
                    if group == "runtime" and item["source"] != item["project"]:
                        item["group"] = "runtime"
                    item.setdefault("resolution_sources", []).append(path)
                    if item.get("resolution_error"):
                        continue
                    pinned = item.get("resolved_version")
                    if len(values) != 1 or (pinned and pinned not in values):
                        problem(item, "saved resolved versions conflict across declarations or target frameworks")
                    else:
                        item["resolved_version"] = next(iter(values))
        except (ValueError, UnicodeDecodeError, TypeError, AttributeError) as error:
            warnings.append(f"{path}: cannot parse NuGet resolved evidence: {error}; regenerate and include valid saved JSON.")
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for item in records:
        grouped.setdefault((item["project"], item["identity"], item["group"]), []).append(item)
        if "resolved_version" not in item and "resolution_error" not in item:
            problem(item, "no exact version evidence was included")
    for declarations in grouped.values():
        values = {item["resolved_version"] for item in declarations if "resolved_version" in item}
        if len(values) > 1:
            for item in declarations:
                problem(item, "multiple project declarations have conflicting exact versions")
    return sorted(records, key=lambda item: (item["project"], item["identity"], item["source"], item["line"]))


def dotnet_package_diff(
    before: list[dict[str, Any]], after: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Compare declarations per project, not globally by package name."""
    def collapse(items: list[dict[str, Any]]) -> dict[tuple[str, str, str], tuple[Any, ...]]:
        grouped: dict[tuple[str, str, str], set[tuple[str, str, bool]]] = {}
        for item in items:
            key = (item["project"], _identity(item["name"]), item["group"])
            grouped.setdefault(key, set()).add((
                item.get("specifier", ""), item.get("resolved_version", ""),
                bool(item.get("resolution_error")),
            ))
        return {key: tuple(sorted(values)) for key, values in grouped.items()}

    old, new = collapse(before), collapse(after)
    names = {
        (item["project"], _identity(item["name"]), item["group"]): item["name"]
        for item in [*before, *after]
    }
    result = []
    for key in sorted(old.keys() | new.keys()):
        if old.get(key) == new.get(key):
            continue
        project, identity, group = key
        result.append({
            "name": names[key], "identity": identity, "ecosystem": "nuget",
            "language": "csharp", "project": project, "group": group,
            "kind": "added" if key not in old else "removed" if key not in new else "version_changed",
            "before": old[key][0][0] or old[key][0][1] if key in old else None,
            "after": new[key][0][0] or new[key][0][1] if key in new else None,
        })
    return result
