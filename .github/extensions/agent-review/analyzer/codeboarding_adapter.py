from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_codeboarding(repo: Path) -> dict[str, Any]:
    candidates = (
        repo / ".codeboarding" / "components.json",
        repo / ".codeboarding" / "codeboarding.json",
        repo / "codeboarding.json",
    )
    for path in candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        raw = data.get("components", data if isinstance(data, list) else [])
        if not isinstance(raw, list):
            continue
        components: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict) or not item.get("name"):
                continue
            paths = item.get("paths", item.get("files", []))
            components.append(
                {
                    "name": str(item["name"]),
                    "paths": sorted(str(value).replace("\\", "/") for value in paths),
                    "description": str(item.get("description", "")),
                }
            )
        return {
            "available": True,
            "source": path.relative_to(repo).as_posix(),
            "components": sorted(components, key=lambda item: item["name"]),
        }
    return {"available": False, "components": []}
