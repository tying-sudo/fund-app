"""Thread-safe in-memory read database for high-frequency grid responses."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Callable, TypeVar


T = TypeVar("T")


class MemoryReadDatabase:
    """A small SQLite :memory: read model with TTL and request coalescing.

    The grid's positions remain in durable storage. This database only holds
    derived valuation and strategy snapshots, so a process restart can never
    discard a user transaction while cache hits return in milliseconds.
    """

    def __init__(self) -> None:
        self._connection = sqlite3.connect(":memory:", check_same_thread=False)
        self._connection.execute(
            """
            CREATE TABLE snapshots (
                cache_key TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                expires_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        self._connection.commit()
        self._lock = threading.RLock()
        self._inflight: dict[str, threading.Event] = {}
        self._hits = 0
        self._misses = 0
        self._coalesced = 0

    def get_or_compute(self, cache_key: str, ttl_ms: int, factory: Callable[[], T]) -> T:
        """Return a fresh snapshot or coalesce concurrent callers into one compute."""
        ttl_seconds = max(0.001, ttl_ms / 1000)

        while True:
            with self._lock:
                row = self._connection.execute(
                    "SELECT payload FROM snapshots WHERE cache_key = ? AND expires_at > ?",
                    (cache_key, time.monotonic()),
                ).fetchone()
                if row:
                    self._hits += 1
                    return json.loads(row[0])

                inflight = self._inflight.get(cache_key)
                if inflight is None:
                    inflight = threading.Event()
                    self._inflight[cache_key] = inflight
                    self._misses += 1
                    owner = True
                else:
                    self._coalesced += 1
                    owner = False

            if owner:
                break
            inflight.wait(timeout=10)

        try:
            value = factory()
            payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            now = time.monotonic()
            with self._lock:
                self._connection.execute(
                    """
                    INSERT INTO snapshots(cache_key, payload, expires_at, updated_at)
                    VALUES(?, ?, ?, ?)
                    ON CONFLICT(cache_key) DO UPDATE SET
                        payload = excluded.payload,
                        expires_at = excluded.expires_at,
                        updated_at = excluded.updated_at
                    """,
                    (cache_key, payload, now + ttl_seconds, now),
                )
                self._connection.commit()
            return json.loads(payload)
        finally:
            with self._lock:
                waiter = self._inflight.pop(cache_key, None)
                if waiter:
                    waiter.set()

    def invalidate(self, prefix: str = "") -> int:
        """Invalidate a group of derived responses after a write operation."""
        with self._lock:
            if prefix:
                cursor = self._connection.execute(
                    "DELETE FROM snapshots WHERE cache_key LIKE ?", (f"{prefix}%",)
                )
            else:
                cursor = self._connection.execute("DELETE FROM snapshots")
            self._connection.commit()
            return cursor.rowcount

    def stats(self) -> dict[str, int]:
        with self._lock:
            size = self._connection.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
            return {
                "entries": int(size),
                "hits": self._hits,
                "misses": self._misses,
                "coalesced": self._coalesced,
                "inflight": len(self._inflight),
            }
