from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any


MAX_BYTES = 128 * 1024 * 1024
MAX_ENTRY_BYTES = 4 * 1024 * 1024
MAX_ENTRIES = 8192


class FileScanCache:
    def __init__(
        self, directory: Path, namespace: str, *,
        max_bytes: int = MAX_BYTES, max_entry_bytes: int = MAX_ENTRY_BYTES,
        max_entries: int = MAX_ENTRIES, on_warning: Callable[[str], None] | None = None,
    ) -> None:
        if min(max_bytes, max_entry_bytes, max_entries) <= 0:
            raise ValueError("File cache limits must be positive.")
        self.namespace = namespace
        self.max_bytes = max_bytes
        self.max_entry_bytes = min(max_entry_bytes, max_bytes)
        self.max_entries = max_entries
        self.on_warning = on_warning
        self.connection: sqlite3.Connection | None = None
        self.pending: dict[str, bytes] = {}
        self.touched: set[str] = set()
        self.pending_bytes = 0
        self.hits = self.misses = self.writes = self.skipped = 0
        try:
            directory.mkdir(parents=True, exist_ok=True)
            self.connection = sqlite3.connect(directory / "file-scans.sqlite3", timeout=1)
            self.connection.execute("PRAGMA auto_vacuum=FULL")
            self.connection.execute("PRAGMA cache_size=-1024")
            self.connection.execute(
                "CREATE TABLE IF NOT EXISTS scans "
                "(key TEXT PRIMARY KEY, payload BLOB NOT NULL, digest TEXT NOT NULL, "
                "size INTEGER NOT NULL, touched INTEGER NOT NULL)"
            )
            self.connection.execute("CREATE INDEX IF NOT EXISTS scans_lru ON scans(touched, key)")
            self.connection.commit()
            with self.connection:
                self._prune()
        except (OSError, sqlite3.Error) as error:
            self._disable(error)

    def _key(self, path: str, data: bytes) -> str:
        value = json.dumps([self.namespace, path, hashlib.sha256(data).hexdigest()], separators=(",", ":"))
        return hashlib.sha256(value.encode()).hexdigest()

    def _warning(self, message: str) -> None:
        if self.on_warning:
            self.on_warning(message)
        else:
            print(f"agent-review file cache: {message}", file=sys.stderr)

    def _disable(self, error: OSError | sqlite3.Error) -> None:
        self._warning(f"Python file cache unavailable; scanning fresh: {error}")
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        self.pending.clear()
        self.touched.clear()
        self.pending_bytes = 0

    def get(self, path: str, data: bytes) -> dict[str, Any] | None:
        if self.connection is None:
            self.misses += 1
            return None
        key = self._key(path, data)
        try:
            pending = self.pending.get(key)
            row = (
                (pending, hashlib.sha256(pending).hexdigest(), len(pending)) if pending is not None
                else self.connection.execute(
                    "SELECT CASE WHEN length(payload)<=? THEN payload ELSE NULL END, digest, size "
                    "FROM scans WHERE key=?", (self.max_entry_bytes, key),
                ).fetchone()
            )
            if row is None:
                self.misses += 1
                return None
            payload, digest, size = row
            if not isinstance(payload, bytes) or not isinstance(size, int) or not 0 <= size <= self.max_entry_bytes:
                raise ValueError("invalid cached payload size")
            if len(payload) != size or hashlib.sha256(payload).hexdigest() != digest:
                raise ValueError("cached payload checksum mismatch")
            record = json.loads(payload)
            if not isinstance(record, dict):
                raise ValueError("cached payload must be an object")
            self.touched.add(key)
            if len(self.touched) >= 32:
                self.flush()
            self.hits += 1
            return record
        except (UnicodeDecodeError, ValueError) as error:
            self.discard(path, data, str(error))
            self.misses += 1
            return None
        except sqlite3.Error as error:
            self._disable(error)
            self.misses += 1
            return None

    def discard(self, path: str, data: bytes, reason: str) -> None:
        self._warning(f"Discarded invalid Python file cache entry for {path}; scanning fresh: {reason}")
        if self.connection is None:
            return
        key = self._key(path, data)
        self.pending_bytes -= len(self.pending.pop(key, b""))
        self.touched.discard(key)
        try:
            self.connection.execute("DELETE FROM scans WHERE key=?", (key,))
            self.connection.commit()
        except sqlite3.Error as error:
            self._disable(error)

    def put(self, path: str, data: bytes, record: dict[str, Any]) -> None:
        if self.connection is None:
            return
        payload = json.dumps(record, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode()
        if len(payload) > self.max_entry_bytes:
            self.skipped += 1
            return
        key = self._key(path, data)
        if self.pending_bytes + len(payload) > 2 * 1024 * 1024:
            self.flush()
        if self.connection is None:
            return
        self.pending_bytes -= len(self.pending.get(key, b""))
        self.pending[key] = payload
        self.pending_bytes += len(payload)
        if len(self.pending) >= 32 or self.pending_bytes >= 2 * 1024 * 1024:
            self.flush()

    def _prune(self) -> None:
        if self.connection is None:
            return
        size, count = self.connection.execute("SELECT COALESCE(SUM(length(payload)),0), COUNT(*) FROM scans").fetchone()
        if size <= self.max_bytes and count <= self.max_entries:
            return
        for key, entry_size in self.connection.execute("SELECT key, length(payload) FROM scans ORDER BY touched, key").fetchall():
            if size <= self.max_bytes and count <= self.max_entries:
                break
            self.connection.execute("DELETE FROM scans WHERE key=?", (key,))
            size -= entry_size
            count -= 1

    def flush(self) -> None:
        if self.connection is None or not (self.pending or self.touched):
            return
        try:
            with self.connection:
                stamp = time.time_ns()
                self.connection.executemany("UPDATE scans SET touched=? WHERE key=?",
                                            ((stamp, key) for key in sorted(self.touched)))
                self.connection.executemany(
                    "INSERT OR REPLACE INTO scans VALUES (?,?,?,?,?)",
                    ((key, payload, hashlib.sha256(payload).hexdigest(), len(payload), stamp)
                     for key, payload in self.pending.items()),
                )
                self._prune()
            self.writes += len(self.pending)
            self.pending.clear()
            self.touched.clear()
            self.pending_bytes = 0
        except sqlite3.Error as error:
            self._disable(error)

    def close(self) -> None:
        self.flush()
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def __enter__(self) -> FileScanCache:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
