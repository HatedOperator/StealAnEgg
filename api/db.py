"""SQLite storage shared by the API and the bot (WAL so two processes coexist)."""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS links (
    discord_id      TEXT PRIMARY KEY,
    roblox_user_id  INTEGER NOT NULL,
    roblox_username TEXT NOT NULL,
    verified_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
    code            TEXT PRIMARY KEY,
    discord_id      TEXT NOT NULL,
    roblox_username TEXT NOT NULL,
    created_at      REAL NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS captures (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    egg          TEXT NOT NULL,
    rarity       TEXT NOT NULL,
    biome        TEXT NOT NULL,
    server_id    TEXT,
    cycle_index  INTEGER NOT NULL,
    source       TEXT NOT NULL,
    spotter      TEXT,
    created_at   REAL NOT NULL,
    UNIQUE(server_id, egg, cycle_index)
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect(db_path: str | Path) -> sqlite3.Connection:
    # check_same_thread=False: FastAPI runs sync routes in worker threads;
    # writes are short transactions and WAL keeps the bot+api processes safe.
    conn = sqlite3.connect(str(db_path), timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    return conn


def get_setting(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    conn.commit()


def cycle_index(ts: float, cycle_seconds: int = 300) -> int:
    return int(ts // cycle_seconds)


def insert_capture(conn: sqlite3.Connection, *, egg: str, rarity: str, biome: str,
                   server_id: str | None, source: str, spotter: str | None,
                   cycle_seconds: int = 300) -> int | None:
    """Insert a capture; returns the row id, or None if it was a duplicate."""
    now = time.time()
    # NULLs are always distinct in SQLite UNIQUE indexes, so unknown servers
    # are stored as "" — that keeps same-cycle dedupe working for every source.
    server_key = server_id or ""
    try:
        cur = conn.execute(
            "INSERT INTO captures(egg, rarity, biome, server_id, cycle_index,"
            " source, spotter, created_at) VALUES(?,?,?,?,?,?,?,?)",
            (egg, rarity, biome, server_key, cycle_index(now, cycle_seconds),
             source, spotter, now),
        )
        conn.commit()
        return cur.lastrowid
    except sqlite3.IntegrityError:
        return None
