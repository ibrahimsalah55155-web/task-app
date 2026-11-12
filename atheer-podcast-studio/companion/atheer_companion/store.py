"""SQLite store: paired clients and the analysis cache.

The cache key is (absolute path, size, mtime) plus the analyser version, so an
unchanged file is never analysed twice and a changed or replaced file always is.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  token_hash TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  created_at REAL NOT NULL,
  last_used_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS analysis_cache (
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  analyser_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at REAL NOT NULL,
  PRIMARY KEY (kind, path, size, mtime_ns, analyser_version)
);
"""


class Store:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        with self._lock:
            self._db.executescript(_SCHEMA)
            row = self._db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if row is None:
                self._db.execute(
                    "INSERT INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),)
                )
            elif int(row[0]) > SCHEMA_VERSION:
                raise RuntimeError(
                    f"Database {db_path} was written by a newer companion (schema {row[0]}). "
                    "Update the companion or move the database aside."
                )

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ---- clients -----------------------------------------------------------

    def add_client(self, token_hash: str, client_name: str) -> None:
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO clients(token_hash, client_name, created_at, last_used_at) "
                "VALUES (?, ?, ?, ?)",
                (token_hash, client_name, now, now),
            )

    def touch_client(self, token_hash: str) -> bool:
        with self._lock:
            cur = self._db.execute(
                "UPDATE clients SET last_used_at=? WHERE token_hash=?", (time.time(), token_hash)
            )
            return cur.rowcount == 1

    def list_clients(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT client_name, created_at, last_used_at FROM clients ORDER BY created_at"
            ).fetchall()
        return [{"client": r[0], "createdAt": r[1], "lastUsedAt": r[2]} for r in rows]

    def revoke_all_clients(self) -> int:
        with self._lock:
            return self._db.execute("DELETE FROM clients").rowcount

    # ---- analysis cache ----------------------------------------------------

    def cache_get(self, kind: str, path: str, size: int, mtime_ns: int, version: str) -> Any | None:
        with self._lock:
            row = self._db.execute(
                "SELECT result_json FROM analysis_cache WHERE kind=? AND path=? AND size=? "
                "AND mtime_ns=? AND analyser_version=?",
                (kind, path, size, mtime_ns, version),
            ).fetchone()
        return json.loads(row[0]) if row else None

    def cache_put(self, kind: str, path: str, size: int, mtime_ns: int, version: str, result: Any) -> None:
        with self._lock:
            # Keep one entry per (kind, path): stale versions of a file are useless.
            self._db.execute("DELETE FROM analysis_cache WHERE kind=? AND path=?", (kind, path))
            self._db.execute(
                "INSERT INTO analysis_cache(kind, path, size, mtime_ns, analyser_version, result_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (kind, path, size, mtime_ns, version, json.dumps(result), time.time()),
            )

    def cache_clear(self) -> int:
        with self._lock:
            return self._db.execute("DELETE FROM analysis_cache").rowcount
