"""
db.py — single shared SQLite connection helper used by both api.py and auth.py.
All callers import `connect_db` and `db_lock` from here.
"""
from pathlib import Path
from threading import Lock
import sqlite3

DB_PATH = Path(__file__).resolve().parent / "jobs.db"
db_lock = Lock()


def connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn
