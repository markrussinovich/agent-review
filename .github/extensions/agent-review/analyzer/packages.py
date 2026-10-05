from __future__ import annotations

from bisect import bisect_right
import re
import tomllib
from pathlib import PurePosixPath
from typing import Any


NAME = re.compile(r"^\s*([A-Za-z0-9_.-]+)")
DISTRIBUTION_IMPORT_ALIASES = {"pyyaml": "yaml"}


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def import_name(name: str) -> str:
    canonical = normalize(name)
    return DISTRIBUTION_IMPORT_ALIASES.get(canonical, canonical.replace("-", "_"))


def _requirement(value: str, source: str, group: str = "runtime") -> dict[str, Any] | None:
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


def _location(text: str, start: int, end: int) -> dict[str, int]:
    """Report saved-text coordinates: 1-based lines, half-open codepoint columns.

    Short report keys are canonical; declaration_* aliases remain compatible.
    """
    starts = [0] + [match.end() for match in re.finditer("\n", text)]
    first, last = bisect_right(starts, start) - 1, bisect_right(starts, end) - 1
    return {
        "line": first + 1,
        "end_line": last + 1,
        "start_column": start - starts[first],
        "end_column": end - starts[last],
        "declaration_line": first + 1,
        "declaration_end_line": last + 1,
        "declaration_column_start": start - starts[first],
        "declaration_column_end": end - starts[last],
    }


def _toml_declaration_tokens(text: str) -> dict[tuple[Any, ...], tuple[int, int]]:
    """Index string values by TOML key/array path, never by name text search.

    tomllib remains authoritative for dependency values. This lexical walk only
    retains their original spans, including quoted/dotted keys and inline tables.
    """
    tokens: list[tuple[str, int, int]] = []
    index = 0
    while index < len(text):
        start = index
        char = text[index]
        if char in " \t\r":
            index += 1
            continue
        if char == "#":
            index = text.find("\n", index)
            if index == -1:
                break
            continue
        if char in "\"'":
            quote = char * (3 if text.startswith(char * 3, index) else 1)
            index += len(quote)
            while index < len(text):
                if char == '"' and text[index] == "\\":
                    index += 2
                elif text.startswith(quote, index):
                    index += len(quote)
                    # Four/five quotes can terminate a multiline TOML string.
                    if len(quote) == 3:
                        while index < len(text) and text[index] == char:
                            index += 1
                    break
                else:
                    index += 1
        elif char in "\n[]=,.{}":
            index += 1
        else:
            while index < len(text) and text[index] not in " \t\r\n#[]=,.{}\"'":
                index += 1
        tokens.append((text[start:index], start, index))

    spans: dict[tuple[Any, ...], tuple[int, int]] = {}
    cursor = 0
    table: tuple[Any, ...] = ()

    def skip_newlines() -> None:
        nonlocal cursor
        while cursor < len(tokens) and tokens[cursor][0] == "\n":
            cursor += 1

    def key() -> tuple[str, ...]:
        nonlocal cursor
        parts = []
        while cursor < len(tokens):
            raw = tokens[cursor][0]
            parts.append(tomllib.loads("key = " + raw)["key"] if raw[0] in "\"'" else raw)
            cursor += 1
            if cursor >= len(tokens) or tokens[cursor][0] != ".":
                break
            cursor += 1
        return tuple(parts)

    def value(path: tuple[Any, ...]) -> None:
        nonlocal cursor
        if cursor >= len(tokens):
            return
        raw, start, end = tokens[cursor]
        cursor += 1
        if raw[0] in "\"'":
            spans[path] = (start, end)
        elif raw == "[":
            element = 0
            skip_newlines()
            while cursor < len(tokens) and tokens[cursor][0] != "]":
                value(path + (element,))
                element += 1
                skip_newlines()
                if cursor < len(tokens) and tokens[cursor][0] == ",":
                    cursor += 1
                skip_newlines()
            cursor += 1
        elif raw == "{":
            while cursor < len(tokens) and tokens[cursor][0] != "}":
                child = key()
                cursor += 1  # equals
                value(path + child)
                if cursor < len(tokens) and tokens[cursor][0] == ",":
                    cursor += 1
            cursor += 1
        else:
            while cursor < len(tokens) and tokens[cursor][0] not in (",", "]", "}", "\n"):
                cursor += 1

    while cursor < len(tokens):
        skip_newlines()
        if cursor >= len(tokens):
            break
        if tokens[cursor][0] == "[":
            cursor += 1
            array_table = cursor < len(tokens) and tokens[cursor][0] == "["
            if array_table:
                cursor += 1
            table = key()
            if array_table:
                table += (None,)
        else:
            path = table + key()
            if cursor < len(tokens) and tokens[cursor][0] == "=":
                cursor += 1
                value(path)
        while cursor < len(tokens) and tokens[cursor][0] != "\n":
            cursor += 1
    return spans


def _toml_location(text: str, span: tuple[int, int], value: str) -> dict[str, int]:
    start, end = span
    token = text[start:end]
    quote_length = 3 if token.startswith(('"""', "'''")) else 1
    raw = token[quote_length:-quote_length]
    match, decoded_match = NAME.match(raw), NAME.match(value)
    if match and decoded_match and match.group(1) == decoded_match.group(1):
        start += quote_length + match.start(1)
        end = start + len(match.group(1))
    # Escaped names retain the full quoted requirement token instead of a
    # misleading partial package name.
    return _location(text, start, end)


def parse_packages(
    files: dict[str, bytes], warnings: list[str] | None = None
) -> list[dict[str, Any]]:
    records: dict[tuple[str, str, str], dict[str, Any]] = {}
    pyproject = files.get("pyproject.toml")
    if pyproject:
        try:
            text = pyproject.decode("utf-8")
            data = tomllib.loads(text)
            spans = _toml_declaration_tokens(text)
            project = data.get("project", {})
            for index, value in enumerate(project.get("dependencies", [])):
                item = _requirement(value, "pyproject.toml")
                if item:
                    span = spans.get(("project", "dependencies", index))
                    if span is not None:
                        item.update(_toml_location(text, span, value))
                    records[(item["name"], item["source"], item["group"])] = item
            for group, values in project.get("optional-dependencies", {}).items():
                for index, value in enumerate(values):
                    item = _requirement(value, "pyproject.toml", str(group))
                    if item:
                        span = spans.get(("project", "optional-dependencies", group, index))
                        if span is not None:
                            item.update(_toml_location(text, span, value))
                        records[(item["name"], item["source"], item["group"])] = item
        except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
            if warnings is not None:
                warnings.append(f"pyproject.toml: unable to parse dependencies: {error}")
    for path, content in sorted(files.items()):
        filename = PurePosixPath(path).name.lower()
        if not (filename.startswith("requirements") and filename.endswith(".txt")):
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as error:
            if warnings is not None:
                warnings.append(f"{path}: unable to parse requirements: {error}")
            continue
        offset = 0
        for line in text.splitlines(keepends=True):
            requirement = line.lstrip("\ufeff") if offset == 0 else line
            item = _requirement(requirement, path, PurePosixPath(path).stem)
            if item:
                match = NAME.match(requirement)
                assert match is not None
                start = offset + len(line) - len(requirement) + match.start(1)
                item.update(_location(text, start, start + len(match.group(1))))
                records[(item["name"], item["source"], item["group"])] = item
            offset += len(line)
    return sorted(records.values(), key=lambda item: (item["name"], item["source"], item["group"]))


def resolve_declared_versions(packages: list[dict[str, Any]], warnings: list[str]) -> None:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for package in packages:
        package.pop("resolved_version", None)
        package.pop("resolution_error", None)
        grouped.setdefault(package["name"], []).append(package)
    for name, declarations in grouped.items():
        pins = {
            match.group(1)
            for item in declarations
            if (match := re.fullmatch(r"(?:===|==)\s*([^*,;<>=\s]+)", item["specifier"]))
        }
        if len(pins) == 1:
            version = next(iter(pins))
            for item in declarations:
                item["resolved_version"] = version
        elif len(pins) > 1:
            message = f"{name}: conflicting project version pins ({', '.join(sorted(pins))}); vulnerability assessment requires an unambiguous version."
            if message not in warnings:
                warnings.append(message)
            for item in declarations:
                item["resolution_error"] = message


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
