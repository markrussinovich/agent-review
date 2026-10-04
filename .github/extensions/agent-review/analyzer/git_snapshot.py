from __future__ import annotations

import fnmatch
import difflib
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path


DEFAULT_EXCLUDES = (
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    "node_modules",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".github/extensions/agent-review",
    ".agent-review.json",
)


def _content_equal(before: bytes, after: bytes) -> bool:
    if before == after:
        return True
    try:
        before.decode("utf-8")
        after.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return (
        before.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        == after.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    )


def run_git(repo: Path, *args: str, check: bool = True) -> str:
    process = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and process.returncode:
        raise RuntimeError(process.stderr.strip() or "git command failed")
    return process.stdout


def discover_repo(explicit: str | None) -> Path:
    candidate = (
        explicit
        or os.environ.get("COPILOT_WORKSPACE_PATH")
        or os.environ.get("COPILOT_ROOT_PATH")
        or os.getcwd()
    )
    root = run_git(Path(candidate).resolve(), "rev-parse", "--show-toplevel").strip()
    return Path(root).resolve()


def discover_base(repo: Path, explicit: str | None) -> str | None:
    if explicit:
        candidates = [explicit]
        if not explicit.startswith(("refs/", "origin/")):
            candidates.extend((f"origin/{explicit}", f"refs/remotes/origin/{explicit}"))
        for candidate in candidates:
            if run_git(repo, "rev-parse", "--verify", f"{candidate}^{{commit}}", check=False).strip():
                return candidate
        raise RuntimeError(f"base ref does not resolve to a commit: {explicit}")
    candidates = [
        os.environ.get("COPILOT_DEFAULT_BRANCH"),
        "origin/HEAD",
        "origin/main",
        "origin/master",
        "main",
        "master",
        "HEAD",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        if candidate == "origin/HEAD":
            value = run_git(repo, "symbolic-ref", "--quiet", "--short", candidate, check=False).strip()
            candidate = value or candidate
        if run_git(repo, "rev-parse", "--verify", f"{candidate}^{{commit}}", check=False).strip():
            return candidate
    return None


def _excluded(path: str, patterns: tuple[str, ...]) -> bool:
    normalized = path.replace("\\", "/")
    parts = normalized.split("/")
    return any(
        pattern in parts
        or fnmatch.fnmatch(normalized, pattern)
        or fnmatch.fnmatch(normalized, f"{pattern.rstrip('/')}/*")
        for pattern in patterns
    )


def current_files(repo: Path, excludes: tuple[str, ...]) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    patterns = DEFAULT_EXCLUDES + excludes
    for path in repo.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(repo).as_posix()
        if not _excluded(relative, patterns):
            try:
                result[relative] = path.read_bytes()
            except OSError:
                # Files may disappear between traversal and read in active worktrees.
                continue
    return result


def baseline_files(repo: Path, base_ref: str | None, excludes: tuple[str, ...]) -> dict[str, bytes]:
    if not base_ref:
        return {}
    patterns = DEFAULT_EXCLUDES + excludes
    names = run_git(repo, "ls-tree", "-r", "--name-only", "-z", base_ref).split("\0")
    result: dict[str, bytes] = {}
    for name in names:
        if not name or _excluded(name, patterns):
            continue
        process = subprocess.run(
            ["git", "-C", str(repo), "show", f"{base_ref}:{name}"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        if process.returncode == 0:
            result[name] = process.stdout
    return result


@dataclass(frozen=True)
class Snapshot:
    repo: Path
    base_ref: str | None
    baseline: dict[str, bytes]
    current: dict[str, bytes]

    def changes(self) -> list[dict[str, object]]:
        records: list[dict[str, object]] = []
        for path in sorted(set(self.baseline) | set(self.current)):
            before = self.baseline.get(path)
            after = self.current.get(path)
            status = (
                "added"
                if before is None
                else "deleted"
                if after is None
                else "unchanged"
                if _content_equal(before, after)
                else "modified"
            )
            before_lines = before.decode("utf-8", errors="replace").splitlines() if before is not None else []
            after_lines = after.decode("utf-8", errors="replace").splitlines() if after is not None else []
            added = removed = 0
            added_lines: list[int] = []
            removed_lines: list[int] = []
            for tag, old_start, old_end, new_start, new_end in difflib.SequenceMatcher(
                None, before_lines, after_lines, autojunk=False
            ).get_opcodes():
                if tag in ("insert", "replace"):
                    added += new_end - new_start
                    added_lines.extend(range(new_start + 1, new_end + 1))
                if tag in ("delete", "replace"):
                    removed += old_end - old_start
                    removed_lines.extend(range(old_start + 1, old_end + 1))
            records.append(
                {
                    "path": path,
                    "status": status,
                    "baseline_size": len(before) if before is not None else None,
                    "current_size": len(after) if after is not None else None,
                    "baseline_lines": len(before_lines),
                    "current_lines": len(after_lines),
                    "lines_added": added,
                    "lines_removed": removed,
                    "added_lines": added_lines,
                    "removed_lines": removed_lines,
                }
            )
        return records


def create_snapshot(repo: Path, base_ref: str | None, excludes: tuple[str, ...]) -> Snapshot:
    return Snapshot(
        repo,
        base_ref,
        baseline_files(repo, base_ref, excludes),
        current_files(repo, excludes),
    )


def changed_lines(repo: Path, base_ref: str | None, path: str) -> set[int]:
    if not base_ref:
        content = repo.joinpath(path)
        if not content.exists():
            return set()
        return set(range(1, len(content.read_text(errors="replace").splitlines()) + 1))
    output = run_git(
        repo, "diff", "--unified=0", "--no-ext-diff", base_ref, "--", path, check=False
    )
    result: set[int] = set()
    for line in output.splitlines():
        if not line.startswith("@@"):
            continue
        new_range = line.split(" ")[2][1:]
        start_text, _, count_text = new_range.partition(",")
        start = int(start_text)
        count = int(count_text or "1")
        result.update(range(start, start + count))
    if not run_git(repo, "ls-tree", "--name-only", base_ref, "--", path, check=False).strip() and repo.joinpath(path).exists():
        count = len(repo.joinpath(path).read_text(errors="replace").splitlines())
        result.update(range(1, count + 1))
    return result
