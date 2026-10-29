from __future__ import annotations

import posixpath
import re
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

from review_model import stable_id

MAX_DOCUMENTS = 1000
MAX_LINES = 20000
MAX_TOTAL_LINES = 100000
MAX_RELATIONSHIPS = 10000
MAX_LOADER_BYTES = 250000
MAX_TOTAL_LOADER_BYTES = 2000000
INSTRUCTION_NAMES = {"agents.md", "claude.md", "gemini.md", "skill.md", "copilot-instructions.md"}


def _literal_loader_lines(text):
    """Mask comments and template literals without interpreting reviewed code."""
    state, escaped = None, False
    result = []
    index = 0
    while index < len(text):
        char, pair = text[index], text[index:index + 2]
        if state in {"'", '"', "`"}:
            result.append(char if state != "`" or char == "\n" else " ")
            if char == "\n" and state != "`":
                result.append(state)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == state:
                state = None
        elif state in {"//", "/*"}:
            result.append("\n" if char == "\n" else " ")
            if state == "//" and char == "\n":
                state = None
            elif state == "/*" and pair == "*/":
                result.append(" ")
                index += 1
                state = None
        elif pair in {"//", "/*"}:
            state = pair
            result.extend("  ")
            index += 1
        elif char in {"'", '"', "`"}:
            state = char
            result.append(" " if char == "`" else char)
        else:
            result.append(char)
        index += 1
    return "".join(result).splitlines()


def _prescribes(prefix):
    directive = re.search(r"\b(?:follow|apply|obey|adhere to)\s+(?:the\s+)?(?:rules\s+(?:in|of)\s+)?[^.;:]*$", prefix, re.I)
    if not directive:
        return False
    preceding = prefix[:directive.start()].replace("\u2019", "'")
    if re.search(r"\b(?:not|never|don't|mustn't|shouldn't|cannot|can't)\b", preceding, re.I):
        return False
    return not (prefix.count('"') % 2 or prefix.count("'") % 2 or prefix.count("`") % 2
                or prefix.count("\u201c") > prefix.count("\u201d")
                or prefix.count("\u2018") > prefix.count("\u2019"))


def _anchor(text):
    return re.sub(r"[^\w\- ]", "", text.lower()).replace(" ", "-")


def parse_document(path, text, max_lines=MAX_LINES):
    lines = text.splitlines()
    blocks, links, tools, attributes = [], [], [], {}
    definitions = {}
    anchors = {}
    counts = {}
    fence = None
    example_depth = None
    html_comment = False
    frontmatter = bool(lines and lines[0] == "---")
    for index, line in enumerate(lines[:max_lines]):
        number = index + 1
        kind = "paragraph"
        if html_comment or line.lstrip().startswith("<!--"):
            kind = "quoted"
            html_comment = "-->" not in line
        elif frontmatter:
            kind = "frontmatter"
            field = re.match(r"^([\w-]+):\s*(.*)$", line)
            if field and len(attributes) < 40:
                attributes[field[1]] = field[2].strip("\"'")[:2000]
            if index and line == "---":
                frontmatter = False
        elif fence:
            kind = "example"
            if re.match(rf"^ {{0,3}}{re.escape(fence[0])}{{{len(fence)},}}\s*$", line):
                fence = None
        else:
            opening = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
            if opening:
                fence = opening[1]
                kind = "example"
            elif re.match(r"^(?: {4}|\t| {0,3}>)", line):
                kind = "quoted"
            elif re.match(r"^ {0,3}#{1,6}\s+", line):
                kind = "heading"
            elif re.match(r"^\s*(?:[-*+]|\d+[.)])\s+", line):
                kind = "list"
            elif index + 1 < len(lines) and re.match(r"^ {0,3}(?:=+|-+)\s*$", lines[index + 1]) and line.strip():
                kind = "heading"
        if not line.strip():
            continue
        if kind == "heading":
            title = re.sub(r"^ {0,3}#{1,6}\s+|\s+#+\s*$", "", line).strip()
            depth = len(re.match(r"^ {0,3}(#+)", line)[1]) if line.lstrip().startswith("#") else 1
            if example_depth is not None and depth <= example_depth:
                example_depth = None
            if re.match(r"^(?:examples?|quoted (?:text|instructions?))\b", title, re.I):
                example_depth = depth
            anchor = _anchor(title)
            occurrence = counts.get(anchor, 0)
            counts[anchor] = occurrence + 1
            anchors[f"{anchor}-{occurrence}" if occurrence else anchor] = number
        elif example_depth is not None:
            kind = "example"
        identity = (kind, line.strip())
        occurrence = counts.get(identity, 0)
        counts[identity] = occurrence + 1
        blocks.append({"id": stable_id("markdown-block", path, kind, line.strip(), occurrence),
                       "kind": kind, "line": number, "end_line": number})
        if kind in {"example", "quoted", "frontmatter"} or example_depth is not None:
            continue
        definition = re.match(r'^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?', line)
        if definition:
            definitions[definition[1].casefold()] = definition[2]
            continue
        found = []
        for match in re.finditer(r'(?<!!)\[([^\]]+)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)', line):
            found.append((match[2] or match[3], match[1], line[:match.start()]))
        for match in re.finditer(r'(?<!!)\[([^\]]+)\](?!\()(?:(?:\[([^\]]*)\]))?', line):
            links.append({"label": (match[2] or match[1]).casefold(), "line": number, "text": line, "prefix": line[:match.start()],
                          "reference_definition": True})
        for target, label, prefix in found:
            links.append({"target": target, "label": label, "line": number, "text": line, "prefix": prefix})
        # Backticked local paths are common in instruction prose, including script invocations.
        for match in re.finditer(r"`([^\s`]+\.(?:md|py|mjs|cjs|js|ts|sh|json|ya?ml)(?:#[^`\s]+)?)`", line):
            if not any(item[0] == match[1] for item in found):
                links.append({"target": match[1], "line": number, "text": line, "prefix": line[:match.start()], "mention": True})
        for match in re.finditer(r"\b(?:tool|tools)\s*(?::|named)?\s+`([\w.-]+)`", line, re.I):
            if len(tools) < 100:
                tools.append({"name": match[1], "line": number, "status": "unverified",
                              "reason": "Mention only; no authoritative tool inventory was supplied."})
    resolved = []
    for link in links:
        if link.get("reference_definition"):
            target = definitions.get(link["label"])
            if not target:
                continue
            link["target"] = target
        resolved.append(link)
    name = PurePosixPath(path).name.lower()
    conventional = name in INSTRUCTION_NAMES or (
        path.startswith(".github/instructions/") and name.endswith(".instructions.md"))
    return {"path": path, "role": "instructions" if conventional else "documentation",
            "root": conventional, "classification": {
                "line": 1, "reason": f"Recognized instruction entry point: {name}." if conventional
                else "No instruction entry-point convention or prescribed incoming reference established."},
            "frontmatter": attributes, "blocks": blocks, "anchors": anchors, "links": resolved,
            "tools": tools, "limited": len(lines) > max_lines, "parsed_lines": min(len(lines), max_lines)}


def resolve_reference(source, target, files, documents):
    try:
        decoded = unquote(target, errors="strict")
        # Reject nested encodings rather than interpreting them differently at another layer.
        if "%" in decoded or "\\" in decoded or any(ord(char) < 32 for char in decoded):
            return {"status": "unsafe"}
        parsed = urlsplit(decoded)
    except (ValueError, UnicodeError):
        return {"status": "unsafe"}
    if parsed.scheme or parsed.netloc or decoded.startswith("//"):
        return {"status": "external", "reason": "External references are never fetched."}
    if parsed.path.startswith("/") or parsed.query:
        return {"status": "unsafe"}
    path = posixpath.normpath(posixpath.join(posixpath.dirname(source), parsed.path)) if parsed.path else source
    if path == ".." or path.startswith("../"):
        return {"status": "unsafe"}
    result = {"path": path, "fragment": parsed.fragment, "status": "resolved" if path in files else "missing"}
    if result["status"] == "resolved" and parsed.fragment and path in documents:
        if parsed.fragment not in documents[path]["anchors"]:
            result["status"] = "missing_anchor"
    return result


def analyze_side(files):
    paths = sorted(path for path in files if path.lower().endswith(".md"))
    documents, relationships, gaps = {}, [], []
    remaining_lines = MAX_TOTAL_LINES
    if len(paths) > MAX_DOCUMENTS:
        gaps.append({"reason": f"Markdown document limit ({MAX_DOCUMENTS}) exceeded."})
    for path in paths[:MAX_DOCUMENTS]:
        try:
            text = files[path].decode("utf-8")
        except UnicodeDecodeError:
            gaps.append({"path": path, "reason": "Markdown source is not UTF-8."})
            continue
        documents[path] = parse_document(path, text, min(MAX_LINES, remaining_lines))
        remaining_lines -= documents[path]["parsed_lines"]
        if documents[path]["limited"]:
            gaps.append({"path": path, "reason": "Markdown per-document or total line budget exceeded."})
    for path, document in documents.items():
        for link in document.pop("links"):
            if len(relationships) >= MAX_RELATIONSHIPS:
                break
            relation = {"id": stable_id("markdown-reference", path, link["line"], link["target"]),
                        "from": path, "line": link["line"], "target": link["target"],
                        "kind": "references", **resolve_reference(path, link["target"], files, documents)}
            # A directive must govern this reference, not merely occur elsewhere in the paragraph.
            prefix = link["prefix"]
            if _prescribes(prefix):
                relation["kind"] = "prescribes"
            if link.get("mention") and relation["kind"] != "prescribes":
                relation["kind"] = "mentions"
                if "/" not in link["target"] and relation["status"] in {"missing", "missing_anchor"}:
                    relation["status"] = "unverified"
                    relation["reason"] = "Bare filename mention; a relative reference contract is not established."
            relationships.append(relation)
    # This deliberately recognizes only module-relative literal URLs, not arbitrary
    # readFile calls whose working directory or dynamic path cannot be established.
    remaining_loader_bytes = MAX_TOTAL_LOADER_BYTES
    for path in sorted(files):
        if not path.endswith((".mjs", ".js", ".ts", ".cjs")):
            continue
        budget = min(MAX_LOADER_BYTES, remaining_loader_bytes)
        if len(files[path]) > budget:
            gaps.append({"path": path, "reason": "Literal loader scan byte budget exceeded."})
        if not budget:
            break
        text = files[path][:budget].decode("utf-8", errors="replace")
        remaining_loader_bytes -= min(len(files[path]), budget)
        if "new URL(" not in text:
            continue
        code = _literal_loader_lines(text)
        imports = set()
        for line in code:
            imported = re.match(r"""^import\s*\{([^}]+)\}\s*from\s*["']node:fs(?:/promises)?["']""", line)
            if imported:
                imports.update(name.strip() for name in imported[1].split(",") if " as " not in name)
        for index, line in enumerate(code[:MAX_LINES]):
            match = re.search(
                r"""^\s*(?:(?:const|let)\s+\w+\s*=\s*)?(instructions\s*:\s*)?(?:await\s+)?"""
                r"""(readFile|readFileSync|copyFile|copyFileSync)\(\s*"""
                r"""new URL\(\s*["']([^"']+\.md)["']\s*,\s*import\.meta\.url\s*\)""", line)
            if not match or len(relationships) >= MAX_RELATIONSHIPS:
                continue
            is_supply = bool(match[1])
            if match[2] not in imports or (is_supply and not match[2].startswith("readFile")) or (not is_supply and not match[2].startswith("copyFile")):
                continue
            resolution = resolve_reference(path, match[3], files, documents)
            kind = "supplies_instructions" if is_supply else "packages"
            relation = {"id": stable_id("markdown-loader", path, index + 1, match[3]), "from": path,
                        "line": index + 1, "target": match[3], "kind": kind, **resolution}
            relationships.append(relation)
            target = documents.get(resolution.get("path"))
            if target and resolution["status"] == "resolved" and kind == "supplies_instructions":
                target.update({"root": True, "role": "instructions", "classification": {
                    "path": path, "line": index + 1,
                    "reason": "Literal module-relative file read assigned to an instructions field; intended supply, not observed agent compliance."}})
    if len(relationships) >= MAX_RELATIONSHIPS:
        gaps.append({"reason": f"Markdown relationship limit ({MAX_RELATIONSHIPS}) reached."})
    # Monotonic propagation terminates even when references form a cycle.
    for _ in range(len(documents)):
        changed = False
        for relation in relationships:
            source, target = documents.get(relation["from"]), documents.get(relation.get("path"))
            if not source or not target or target["root"] or relation["status"] != "resolved":
                continue
            role = "instructions" if source["role"] == "instructions" and relation["kind"] == "prescribes" else "supporting"
            if source["role"] in {"instructions", "supporting"} and target["role"] == "documentation":
                target["role"] = role
                target["classification"] = {"path": source["path"], "line": relation["line"],
                                            "reason": "Explicit prescribed use." if role == "instructions" else "Referenced material; instruction authority is not established."}
                changed = True
            elif role == "instructions" and target["role"] == "supporting":
                target["role"] = role
                target["classification"] = {"path": source["path"], "line": relation["line"], "reason": "Explicit prescribed use."}
                changed = True
        if not changed:
            break
    return {"documents": documents, "relationships": relationships, "gaps": gaps,
            "observed_behavior": {"available": False, "reason": "No controlled agent evaluation was supplied."},
            "precedence": "Unknown unless an explicit host or loading contract is supplied.",
            "limits": {"documents": MAX_DOCUMENTS, "lines_per_document": MAX_LINES,
                       "total_lines": MAX_TOTAL_LINES, "relationships": MAX_RELATIONSHIPS,
                       "loader_bytes_per_file": MAX_LOADER_BYTES, "total_loader_bytes": MAX_TOTAL_LOADER_BYTES}}


class MarkdownAdapter:
    id = "markdown"
    graph_phase = "markdown"
    graph_message = "Parsing Markdown instructions and snapshot-local references"

    def applies(self, paths):
        return any(path.lower().endswith(".md") for path in paths)

    def dependencies(self, snapshot, warnings):
        return {"baseline": [], "current": [], "changes": []}

    def scan(self, snapshot, model, dependencies, progress):
        model.instruction_documents = {"version": 1, "base": analyze_side(snapshot.baseline),
                                       "current": analyze_side(snapshot.current)}
        for side in ("base", "current"):
            facts = model.instruction_documents[side]
            for relation in facts["relationships"]:
                relation["evidence_id"] = model.add_evidence("markdown_reference", {
                    **{key: value for key, value in relation.items() if key not in {"id", "kind"}},
                    "reference_id": relation["id"], "relationship_kind": relation["kind"],
                    "path": relation["from"], "side": side,
                    "evidence_type": "deterministic", "claim": "Explicit source reference, not observed agent behavior."})
            for gap in facts["gaps"]:
                model.warnings.append(f"Markdown {side}: {gap.get('path', '')} {gap['reason']}")
        progress("Markdown document roles and references saved", 65)

    def resolve_package_usage(self, model, dependencies):
        pass

    def coverage(self, snapshot):
        return {"available": False, "files": [], "changed_lines": {}}


MARKDOWN_ADAPTER = MarkdownAdapter()
