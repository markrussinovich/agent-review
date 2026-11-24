from __future__ import annotations

import fnmatch
import difflib
import json
import os
import re
import subprocess
import tempfile
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path


DEFAULT_EXCLUDES = tuple(json.loads(
    Path(__file__).with_name("snapshot-excludes.json").read_text(encoding="utf-8")
))
SELF_REPOSITORY_MARKERS = tuple(json.loads(
    Path(__file__).with_name("self-repository-markers.json").read_text(encoding="utf-8")
))
EXTENSION_SOURCE = ".github/extensions/agent-review"
LINE_BREAK = re.compile(r"\r\n|\r|\n")
# SequenceMatcher is quadratic on repeated lines; larger files are matched by Git.
LARGE_DIFF_LINES = 5000


def text_lines(data: bytes | str | None) -> list[str]:
    """The one line definition for counts, diffs and coverage: only CRLF, CR and LF end
    a line, as in Git and the review page, so checkout line endings never change counts."""
    if data is None:
        return []
    text = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else data
    lines = LINE_BREAK.split(text)
    return lines[:-1] if lines[-1] == "" else lines


def _git_line_diff(path: str, before: list[str], after: list[str]) -> str:
    with tempfile.TemporaryDirectory(prefix="agent-review-diff-") as directory:
        root = Path(directory)
        (root / "before").write_text("".join(f"{line}\n" for line in before), encoding="utf-8", newline="\n")
        (root / "after").write_text("".join(f"{line}\n" for line in after), encoding="utf-8", newline="\n")
        process = subprocess.run(
            ["git", "-c", "core.autocrlf=false", "diff", "--no-index", "--no-ext-diff",
             "--no-textconv", "--text", "--unified=4", "--", "before", "after"],
            cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
    if process.returncode not in (0, 1):
        raise RuntimeError(process.stderr.decode("utf-8", errors="replace").strip()
                           or f"Unable to diff saved source: {path}")
    patch = []
    in_hunk = False
    output = process.stdout.decode("utf-8", errors="replace").split("\n")
    for line in output[:-1] if output[-1] == "" else output:
        in_hunk = in_hunk or line.startswith("@@ ")
        if not in_hunk:
            if line.startswith(("diff --git ", "index ")):
                continue
            if line.startswith("--- "):
                line = f"--- a/{path}"
            elif line.startswith("+++ "):
                line = f"+++ b/{path}"
        patch.append(f"{line}\n")
    return "".join(patch)


def line_delta(before: list[str], after: list[str], path: str = "file") -> tuple[list[int], list[int], str | None]:
    """Added and removed 1-based line numbers, plus Git's patch when the file is large."""
    added: list[int] = []
    removed: list[int] = []
    if max(len(before), len(after)) > LARGE_DIFF_LINES:
        patch = _git_line_diff(path, before, after)
        old_line = new_line = None
        for line in patch.split("\n"):
            if line.startswith("@@ "):
                old_range, new_range = line.split()[1:3]
                old_line = int(old_range[1:].split(",")[0])
                new_line = int(new_range[1:].split(",")[0])
            elif old_line is None:
                continue
            elif line.startswith("-"):
                removed.append(old_line)
                old_line += 1
            elif line.startswith("+"):
                added.append(new_line)
                new_line += 1
            elif line.startswith(" "):
                old_line += 1
                new_line += 1
        return added, removed, patch
    for tag, old_start, old_end, new_start, new_end in difflib.SequenceMatcher(
        None, before, after, autojunk=False
    ).get_opcodes():
        if tag in ("insert", "replace"):
            added.extend(range(new_start + 1, new_end + 1))
        if tag in ("delete", "replace"):
            removed.extend(range(old_start + 1, old_end + 1))
    return added, removed, None


def default_excludes(repo: Path, refs: tuple[str, ...] = ()) -> tuple[str, ...]:
    # The tracked product layout distinguishes a source checkout from an install,
    # including offline forks and arbitrarily named worktrees.
    tracked = set(run_git(repo, "ls-files", "--cached", "-z", "--",
                          *(f":(top,literal){marker}" for marker in SELF_REPOSITORY_MARKERS)).split("\0"))
    head = run_git(repo, "rev-parse", "--verify", "--quiet", "HEAD", check=False).strip()
    for ref in dict.fromkeys((*refs, *([head] if head else []))):
        tracked.update(run_git(repo, "ls-tree", "-r", "--name-only", "-z", ref, "--",
                               *SELF_REPOSITORY_MARKERS).split("\0"))
    if all(marker in tracked for marker in SELF_REPOSITORY_MARKERS):
        return tuple(pattern for pattern in DEFAULT_EXCLUDES if pattern != EXTENSION_SOURCE)
    return DEFAULT_EXCLUDES


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


def _snapshot_regular_file(repo: Path, name: str) -> bool:
    path = repo
    for part in Path(name).parts:
        path /= part
        if path.is_symlink():
            return False
    return path.is_file()


def current_files(
    repo: Path, excludes: tuple[str, ...], on_progress: Callable[[str], None] | None = None,
    *, defaults: tuple[str, ...] | None = None,
) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    defaults = default_excludes(repo) if defaults is None else defaults
    patterns = defaults + excludes
    last_update = time.monotonic()
    total_bytes = 0
    if on_progress:
        on_progress("Listing tracked and non-ignored working-tree files")
    pathspecs = [":/"]
    for pattern in defaults:
        prefix = "**/" if "/" not in pattern and not any(char in pattern for char in "*?[") else ""
        pathspecs.extend((f":(exclude,glob){prefix}{pattern}", f":(exclude,glob){prefix}{pattern}/**"))
    paths = [
        repo / name
        for name in sorted(set(run_git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *pathspecs).split("\0")))
        if name and not _excluded(name, patterns) and _snapshot_regular_file(repo, name)
    ]
    # Limit concurrent opens and queued content while overlapping filesystem latency.
    with ThreadPoolExecutor(max_workers=8) as readers:
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
    *, defaults: tuple[str, ...] | None = None,
) -> dict[str, bytes]:
    if not base_ref:
        return {}
    patterns = (default_excludes(repo, (base_ref,)) if defaults is None else defaults) + excludes
    if on_progress:
        on_progress(f"Listing tracked files in {base_ref}")
    entries: list[tuple[str, str]] = []
    for record in run_git(repo, "ls-tree", "-r", "-z", base_ref).split("\0"):
        if not record:
            continue
        metadata, name = record.split("\t", 1)
        mode, kind, object_id = metadata.split()
        if kind == "blob" and mode != "120000" and not _excluded(name, patterns):
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
    _large_diffs: dict[str, str] = field(default_factory=dict, compare=False, repr=False)
    excluded_changes: tuple[dict[str, object], ...] = ()

    def source_files(self, changes: list[dict[str, object]], generated: set[str] | frozenset[str] = frozenset()) -> dict[str, dict[str, object]]:
        result: dict[str, dict[str, object]] = {}
        retain_baseline = any(
            path.lower().endswith((".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".go", ".rs", ".md",
                                  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".ipp", ".tpp", ".inl", ".swift"))
            or path.rsplit("/", 1)[-1] in {"package.json", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "Package.resolved"}
            for path in set(self.baseline) | set(self.current)
        )
        for change in changes:
            path = str(change["path"])
            before, after = self.baseline.get(path), self.current.get(path)
            # An unchanged generated bundle is context nobody reads; its text is omitted to keep the review bounded.
            if path in generated and change["status"] == "unchanged":
                result[path] = {"generated": True, "omitted": True}
                continue
            try:
                base = before.decode("utf-8") if before is not None else ""
                current = after.decode("utf-8") if after is not None else None
            except UnicodeDecodeError:
                result[path] = {"binary": True}
                continue
            if change["status"] == "unchanged":
                diff = ""
            elif path in self._large_diffs:
                diff = self._large_diffs[path]
            elif not base or not current:
                diff = _complete_file_diff(path, current or base, added=not base)
            else:
                old_lines, new_lines = text_lines(base), text_lines(current)
                diff = _git_line_diff(path, old_lines, new_lines) if max(len(old_lines), len(new_lines)) > LARGE_DIFF_LINES \
                    else "".join(difflib.unified_diff(
                        [f"{line}\n" for line in old_lines], [f"{line}\n" for line in new_lines],
                        fromfile=f"a/{path}", tofile=f"b/{path}", n=4,
                    ))
            result[path] = {"current": current, "diff": diff}
            if path in generated:
                result[path]["generated"] = True
            if retain_baseline:
                # Identical text is sent once; the extension restores `baseline` from `current` when it reads the model.
                if change["status"] == "unchanged" and before is not None:
                    result[path]["baseline_same"] = True
                else:
                    result[path]["baseline"] = base if before is not None else None
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
            before_lines = text_lines(before)
            after_lines = before_lines if before is not None and before == after else text_lines(after)
            added_lines: list[int] = []
            removed_lines: list[int] = []
            if status == "added":
                added_lines = list(range(1, len(after_lines) + 1))
            elif status == "deleted":
                removed_lines = list(range(1, len(before_lines) + 1))
            elif status == "modified":
                added_lines, removed_lines, patch = line_delta(before_lines, after_lines, path)
                if patch is not None:
                    self._large_diffs[path] = patch
            records.append(
                {
                    "path": path,
                    "status": status,
                    "baseline_size": len(before) if before is not None else None,
                    "current_size": len(after) if after is not None else None,
                    "baseline_lines": len(before_lines),
                    "current_lines": len(after_lines),
                    "lines_added": len(added_lines),
                    "lines_removed": len(removed_lines),
                    "added_lines": added_lines,
                    "removed_lines": removed_lines,
                }
            )
        return records


def _complete_file_diff(path: str, text: str, *, added: bool) -> str:
    lines = text_lines(text)
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
    defaults = default_excludes(repo, tuple(ref for ref in (base_ref, current_ref) if ref))
    if base_ref:
        names = run_git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-renames",
                        "--name-only", "-z", base_ref, *([current_ref] if current_ref else []), "--").split("\0")
    elif current_ref:
        names = run_git(repo, "ls-tree", "-r", "--name-only", "-z", current_ref).split("\0")
    else:
        names = run_git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0")
        names = [name for name in names if name and _snapshot_regular_file(repo, name)]
    if not current_ref and base_ref:
        names += run_git(repo, "ls-files", "-z", "--others", "--exclude-standard").split("\0")
    counts: dict[tuple[str, str], int] = {}
    for name in set(names) - {""}:
        for reason, patterns in (("user", excludes), ("default", defaults)):
            pattern = next((pattern for pattern in patterns if _excluded(name, (pattern,))), None)
            if pattern is not None:
                key = (reason, pattern)
                counts[key] = counts.get(key, 0) + 1
                break
    return Snapshot(
        repo,
        base_ref,
        baseline_files(repo, base_ref, excludes, on_progress, defaults=defaults),
        baseline_files(repo, current_ref, excludes, on_progress, defaults=defaults) if current_ref else current_files(
            repo, excludes, on_progress, defaults=defaults),
        excluded_changes=tuple({"reason": reason, "pattern": pattern, "count": count}
                               for (reason, pattern), count in sorted(counts.items())),
    )


def changed_lines(repo: Path, base_ref: str | None, path: str) -> set[int]:
    content = repo.joinpath(path)
    if not content.exists():
        return set()
    after = text_lines(content.read_bytes())
    before = text_lines(run_git(repo, "show", f"{base_ref}:{path}", check=False)) if base_ref else []
    return set(line_delta(before, after, path)[0])
