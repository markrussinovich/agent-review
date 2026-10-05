from __future__ import annotations

import fnmatch
import difflib
import os
import subprocess
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
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
    ".agent-review",
    ".coverage",
    ".coverage.*",
    "coverage.json",
    "coverage.xml",
    "htmlcov",
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


def _read_worktree_file(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except OSError:
        # Files may disappear between traversal and read in active worktrees.
        return None


def current_files(
    repo: Path, excludes: tuple[str, ...], on_progress: Callable[[str], None] | None = None,
) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    patterns = DEFAULT_EXCLUDES + excludes
    last_update = time.monotonic()
    total_bytes = 0
    if on_progress:
        on_progress("Reading working-tree files; excluded directories are skipped")
    # Limit concurrent opens and queued content while overlapping filesystem latency.
    with ThreadPoolExecutor(max_workers=8) as readers:
        for directory, directories, filenames in os.walk(repo):
            parent = Path(directory)
            directories[:] = [
                name for name in directories
                if not _excluded((parent / name).relative_to(repo).as_posix(), patterns)
            ]
            paths = [
                parent / filename for filename in filenames
                if not _excluded((parent / filename).relative_to(repo).as_posix(), patterns)
                and (parent / filename).is_file()
            ]
            for offset in range(0, len(paths), 64):
                batch = paths[offset:offset + 64]
                for path, content in zip(batch, readers.map(_read_worktree_file, batch)):
                    if content is None:
                        continue
                    relative = path.relative_to(repo).as_posix()
                    result[relative] = content
                    total_bytes += len(content)
                    if on_progress and time.monotonic() - last_update >= .25:
                        on_progress(f"Working tree: {len(result):,} files, {total_bytes / 1048576:.1f} MiB read · {relative}")
                        last_update = time.monotonic()
    if on_progress:
        on_progress(f"Working tree complete: {len(result):,} files, {total_bytes / 1048576:.1f} MiB")
    return result


def baseline_files(
    repo: Path, base_ref: str | None, excludes: tuple[str, ...],
    on_progress: Callable[[str], None] | None = None,
) -> dict[str, bytes]:
    if not base_ref:
        return {}
    patterns = DEFAULT_EXCLUDES + excludes
    if on_progress:
        on_progress(f"Listing tracked files in {base_ref}")
    entries: list[tuple[str, str]] = []
    for record in run_git(repo, "ls-tree", "-r", "-z", base_ref).split("\0"):
        if not record:
            continue
        metadata, name = record.split("\t", 1)
        _, kind, object_id = metadata.split()
        if kind == "blob" and not _excluded(name, patterns):
            entries.append((name, object_id))
    result: dict[str, bytes] = {}
    total_bytes = 0
    started = time.monotonic()
    # Bound each batch so progress remains visible and temporary output stays small.
    for offset in range(0, len(entries), 100):
        batch = entries[offset:offset + 100]
        if on_progress:
            on_progress(f"Snapshot {base_ref[:12]}: reading files {offset + 1:,}–{offset + len(batch):,} of {len(entries):,}; {total_bytes / 1048576:.1f} MiB read")
        process = subprocess.run(
            ["git", "-C", str(repo), "cat-file", "--batch"],
            input="".join(f"{object_id}\n" for _, object_id in batch).encode("ascii"),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        if process.returncode:
            raise RuntimeError(process.stderr.decode("utf-8", errors="replace").strip() or "Git snapshot batch failed")
        position = 0
        for name, object_id in batch:
            header_end = process.stdout.find(b"\n", position)
            header = process.stdout[position:header_end].split() if header_end >= 0 else []
            if len(header) != 3 or header[0] != object_id.encode("ascii") or header[1] != b"blob":
                raise RuntimeError(f"Invalid Git snapshot response for {name}")
            size = int(header[2])
            start = header_end + 1
            end = start + size
            if size < 0 or end >= len(process.stdout) or process.stdout[end:end + 1] != b"\n":
                raise RuntimeError(f"Incomplete Git snapshot response for {name}")
            result[name] = process.stdout[start:end]
            total_bytes += size
            position = end + 1
        if position != len(process.stdout):
            raise RuntimeError("Unexpected trailing data in Git snapshot batch")
    if on_progress:
        on_progress(f"Snapshot complete: {len(result):,} files, {total_bytes / 1048576:.1f} MiB in {time.monotonic() - started:.1f}s")
    return result


@dataclass(frozen=True)
class Snapshot:
    repo: Path
    base_ref: str | None
    baseline: dict[str, bytes]
    current: dict[str, bytes]

    def source_files(self, changes: list[dict[str, object]]) -> dict[str, dict[str, object]]:
        result: dict[str, dict[str, object]] = {}
        for change in changes:
            path = str(change["path"])
            before, after = self.baseline.get(path), self.current.get(path)
            try:
                base = before.decode("utf-8") if before is not None else ""
                current = after.decode("utf-8") if after is not None else None
            except UnicodeDecodeError:
                result[path] = {"binary": True}
                continue
            if change["status"] == "unchanged":
                diff = ""
            elif not base or not current:
                diff = _complete_file_diff(path, current or base, added=not base)
            else:
                diff = "".join(difflib.unified_diff(
                    [f"{line}\n" for line in base.splitlines()], [f"{line}\n" for line in current.splitlines()],
                    fromfile=f"a/{path}", tofile=f"b/{path}", n=4,
                ))
            result[path] = {"current": current, "diff": diff}
        return result

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
            after_lines = (
                before_lines if before is not None and before == after
                else after.decode("utf-8", errors="replace").splitlines() if after is not None else []
            )
            added = removed = 0
            added_lines: list[int] = []
            removed_lines: list[int] = []
            if status == "added":
                added = len(after_lines)
                added_lines = list(range(1, added + 1))
            elif status == "deleted":
                removed = len(before_lines)
                removed_lines = list(range(1, removed + 1))
            elif status == "modified":
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


def _complete_file_diff(path: str, text: str, *, added: bool) -> str:
    lines = text.splitlines()
    if not lines:
        return ""
    extent = "1" if len(lines) == 1 else f"1,{len(lines)}"
    old_range, new_range = ("0,0", extent) if added else (extent, "0,0")
    prefix = "+" if added else "-"
    return (
        f"--- a/{path}\n+++ b/{path}\n@@ -{old_range} +{new_range} @@\n"
        + "".join(f"{prefix}{line}\n" for line in lines)
    )


def create_snapshot(
    repo: Path, base_ref: str | None, excludes: tuple[str, ...], current_ref: str | None = None,
    on_progress: Callable[[str], None] | None = None,
) -> Snapshot:
    return Snapshot(
        repo,
        base_ref,
        baseline_files(repo, base_ref, excludes, on_progress),
        baseline_files(repo, current_ref, excludes, on_progress) if current_ref else current_files(repo, excludes, on_progress),
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
