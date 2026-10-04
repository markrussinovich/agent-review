from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from git_snapshot import run_git


def analyze_churn(repo: Path) -> list[dict[str, Any]]:
    head_time = run_git(repo, "show", "-s", "--format=%cI", "HEAD", check=False).strip()
    if not head_time:
        return []
    end = datetime.fromisoformat(head_time)
    start = end - timedelta(days=90)
    output = run_git(
        repo,
        "log",
        f"--since={start.isoformat()}",
        f"--until={end.isoformat()}",
        "--format=commit:%H",
        "--numstat",
        "--no-renames",
        check=False,
    )
    stats: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"commits": set(), "additions": 0, "deletions": 0}
    )
    commit = ""
    for line in output.splitlines():
        if line.startswith("commit:"):
            commit = line[7:]
            continue
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        added, deleted, path = parts
        if added.isdigit():
            stats[path]["additions"] += int(added)
        if deleted.isdigit():
            stats[path]["deletions"] += int(deleted)
        if commit:
            stats[path]["commits"].add(commit)
    return [
        {
            "path": path,
            "commits": len(value["commits"]),
            "additions": value["additions"],
            "deletions": value["deletions"],
        }
        for path, value in sorted(stats.items())
    ]
