"""SQLite-backed message bus + persistent memory.

One database file is shared by every agent process. There is no
coordinator: each agent reads the bus with its own cursor, decides for
itself whether to react, and writes its replies back to the bus.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

SHARED = "_shared"  # owner name for team-wide memories

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   INTEGER,
    parent_id   INTEGER,
    sender      TEXT    NOT NULL,
    recipients  TEXT    NOT NULL,          -- JSON list, ["all"] = broadcast
    content     TEXT    NOT NULL,
    hop         INTEGER NOT NULL DEFAULT 0, -- agent-to-agent depth, loop guard
    created_at  REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

CREATE TABLE IF NOT EXISTS cursors(
    agent   TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner      TEXT NOT NULL,              -- agent name or '_shared'
    content    TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(owner);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, content='memories', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
"""


@dataclass
class Message:
    id: int
    thread_id: int
    parent_id: int | None
    sender: str
    recipients: list[str]
    content: str
    hop: int
    created_at: float

    def is_for(self, name: str) -> bool:
        return name in self.recipients or "all" in self.recipients


@dataclass
class Memory:
    id: int
    owner: str
    content: str
    created_at: float


class Store:
    def __init__(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), timeout=30, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=30000")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # ------------------------------------------------------------- messages
    def post(self, sender: str, recipients: list[str], content: str,
             parent: Message | None = None) -> Message:
        recipients = sorted({r.strip().lower() for r in recipients if r.strip()}) or ["all"]
        hop = parent.hop + 1 if parent else 0
        now = time.time()
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO messages(thread_id, parent_id, sender, recipients, content, hop, created_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (parent.thread_id if parent else None, parent.id if parent else None,
                 sender, json.dumps(recipients), content, hop, now),
            )
            mid = cur.lastrowid
            thread_id = parent.thread_id if parent else mid
            if not parent:
                self.conn.execute("UPDATE messages SET thread_id=? WHERE id=?", (mid, mid))
        return Message(mid, thread_id, parent.id if parent else None, sender,
                       recipients, content, hop, now)

    def _row(self, r: sqlite3.Row) -> Message:
        return Message(r["id"], r["thread_id"], r["parent_id"], r["sender"],
                       json.loads(r["recipients"]), r["content"], r["hop"], r["created_at"])

    def messages_after(self, last_id: int, limit: int = 200) -> list[Message]:
        rows = self.conn.execute(
            "SELECT * FROM messages WHERE id>? ORDER BY id LIMIT ?", (last_id, limit)).fetchall()
        return [self._row(r) for r in rows]

    def thread(self, thread_id: int, limit: int = 30) -> list[Message]:
        rows = self.conn.execute(
            "SELECT * FROM (SELECT * FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT ?)"
            " ORDER BY id", (thread_id, limit)).fetchall()
        return [self._row(r) for r in rows]

    def recent(self, limit: int = 50) -> list[Message]:
        rows = self.conn.execute(
            "SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id",
            (limit,)).fetchall()
        return [self._row(r) for r in rows]

    def last_id(self) -> int:
        r = self.conn.execute("SELECT COALESCE(MAX(id),0) FROM messages").fetchone()
        return r[0]

    # -------------------------------------------------------------- cursors
    def get_cursor(self, agent: str) -> int | None:
        r = self.conn.execute("SELECT last_id FROM cursors WHERE agent=?", (agent,)).fetchone()
        return r[0] if r else None

    def set_cursor(self, agent: str, last_id: int) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO cursors(agent,last_id) VALUES(?,?)"
                " ON CONFLICT(agent) DO UPDATE SET last_id=excluded.last_id", (agent, last_id))

    # ------------------------------------------------------------- memories
    def remember(self, owner: str, content: str) -> Memory:
        now = time.time()
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO memories(owner, content, created_at) VALUES (?,?,?)",
                (owner, content.strip(), now))
        return Memory(cur.lastrowid, owner, content.strip(), now)

    def forget(self, owners: list[str], memory_id: int) -> bool:
        q = f"DELETE FROM memories WHERE id=? AND owner IN ({','.join('?' * len(owners))})"
        with self.conn:
            cur = self.conn.execute(q, (memory_id, *owners))
        return cur.rowcount > 0

    def recall(self, owners: list[str], query: str = "", limit: int = 8) -> list[Memory]:
        ph = ",".join("?" * len(owners))
        terms = re.findall(r"\w+", query or "")
        if terms:
            fts = " OR ".join(f'"{t}"' for t in terms)
            rows = self.conn.execute(
                f"SELECT m.* FROM memories_fts f JOIN memories m ON m.id=f.rowid"
                f" WHERE memories_fts MATCH ? AND m.owner IN ({ph})"
                f" ORDER BY bm25(memories_fts) LIMIT ?", (fts, *owners, limit)).fetchall()
        else:
            rows = self.conn.execute(
                f"SELECT * FROM memories WHERE owner IN ({ph}) ORDER BY id DESC LIMIT ?",
                (*owners, limit)).fetchall()
        return [Memory(r["id"], r["owner"], r["content"], r["created_at"]) for r in rows]
