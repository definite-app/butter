#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb==1.5.2"]
# ///
"""Persistent JSON-line search backend for Butter's conversation search.

Reads one JSON request per line on stdin, writes one JSON response per line on
stdout. Backed by ~/mike3/data/cc_sessions/cc.duckdb (opened read-only, fresh
connection per request so the skill's loader can still take a write lock).

Requests:
  {"id": 1, "op": "search", "query": "saturn", "limit": 30}
  {"id": 2, "op": "fetch",  "session_id": "...", "mode": "match", "query": "saturn"}
  {"id": 3, "op": "fetch",  "session_id": "...", "mode": "thread"}

Responses mirror the request id and always carry either a result payload or an
"error" string.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import duckdb

DB_PATH = Path.home() / "mike3" / "data" / "cc_sessions" / "cc.duckdb"

# Top 3 most-recent matching messages per session, newest sessions first.
SEARCH_SQL = """
WITH matched AS (
    SELECT
        m.session_id,
        m.ts,
        m.role,
        m.text,
        s.project_dir,
        s.cwd,
        s.git_branch,
        s.file_path,
        COALESCE(NULLIF(s.custom_title, ''), NULLIF(s.ai_title, '')) AS title,
        ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.ts DESC) AS rn,
        COUNT(*)     OVER (PARTITION BY m.session_id)                   AS match_count
    FROM messages m
    JOIN sessions s USING (session_id)
    WHERE m.text ILIKE ?
      AND m.role IN ('user', 'assistant')
      AND NOT COALESCE(s.is_agent_session, FALSE)
)
SELECT
    session_id,
    ANY_VALUE(project_dir)  AS project_dir,
    ANY_VALUE(cwd)          AS cwd,
    ANY_VALUE(git_branch)   AS git_branch,
    ANY_VALUE(file_path)    AS file_path,
    ANY_VALUE(title)        AS title,
    MAX(ts)                 AS latest_match,
    ANY_VALUE(match_count)  AS match_count,
    ARRAY_AGG({'role': role, 'ts': ts, 'text': text} ORDER BY ts DESC)
        FILTER (WHERE rn <= 3) AS snippets
FROM matched
GROUP BY session_id
ORDER BY latest_match DESC
LIMIT ?
"""

FETCH_THREAD_SQL = """
SELECT ts, role, text
FROM messages
WHERE session_id = ?
  AND role IN ('user', 'assistant')
  AND text IS NOT NULL AND text <> ''
ORDER BY ts
"""

FETCH_MATCH_SQL = """
SELECT ts, role, text
FROM messages
WHERE session_id = ?
  AND role IN ('user', 'assistant')
  AND text IS NOT NULL AND text <> ''
  AND text ILIKE ?
ORDER BY ts
"""

SEP = "\n\n" + "─" * 40 + "\n\n"


def connect() -> duckdb.DuckDBPyConnection:
    return duckdb.connect(str(DB_PATH), read_only=True)


def db_age_min() -> float | None:
    if not DB_PATH.exists():
        return None
    return round((time.time() - DB_PATH.stat().st_mtime) / 60.0, 1)


def make_snippet(text: str, query: str, around: int = 110) -> str:
    """~220-char window centred on the first case-insensitive match."""
    if not text:
        return ""
    idx = text.lower().find(query.lower())
    if idx < 0:
        return text[:240].replace("\n", " ").strip()
    start = max(0, idx - around)
    end = min(len(text), idx + len(query) + around)
    snip = text[start:end].replace("\n", " ").strip()
    if start > 0:
        snip = "…" + snip
    if end < len(text):
        snip = snip + "…"
    return snip


def do_search(query: str, limit: int) -> dict:
    t0 = time.time()
    con = connect()
    try:
        rows = con.execute(SEARCH_SQL, [f"%{query}%", limit]).fetchall()
    finally:
        con.close()

    results = []
    for sid, project_dir, cwd, branch, file_path, title, latest, count, snippets in rows:
        out_snips = []
        for m in (snippets or [])[:3]:
            ts = m.get("ts")
            out_snips.append(
                {
                    "role": m.get("role"),
                    "ts": ts.isoformat() if ts else None,
                    "text": make_snippet(m.get("text") or "", query),
                }
            )
        results.append(
            {
                "session_id": sid,
                "project_dir": project_dir,
                "cwd": cwd,
                "git_branch": branch,
                "file_path": file_path,
                "title": title,
                "latest_match": latest.isoformat() if latest else None,
                "match_count": count,
                "snippets": out_snips,
            }
        )

    return {
        "results": results,
        "elapsed_ms": round((time.time() - t0) * 1000),
        "db_age_min": db_age_min(),
    }


def format_transcript(rows: list) -> str:
    parts = []
    for ts, role, text in rows:
        when = ts.strftime("%Y-%m-%d %H:%M") if ts else "—"
        label = "USER" if role == "user" else "ASSISTANT"
        parts.append(f"[{label} · {when}]\n{text}")
    return SEP.join(parts)


def do_fetch(session_id: str, mode: str, query: str) -> dict:
    con = connect()
    try:
        if mode == "match":
            if not query:
                raise ValueError("match fetch requires a query")
            rows = con.execute(FETCH_MATCH_SQL, [session_id, f"%{query}%"]).fetchall()
        elif mode == "thread":
            rows = con.execute(FETCH_THREAD_SQL, [session_id]).fetchall()
        else:
            raise ValueError(f"unknown fetch mode: {mode}")
    finally:
        con.close()
    return {"mode": mode, "count": len(rows), "text": format_transcript(rows)}


def handle(req: dict) -> dict:
    rid = req.get("id")
    op = req.get("op", "search")

    if not DB_PATH.exists():
        return {"id": rid, "op": op, "error": f"Database not found: {DB_PATH}"}

    if op == "search":
        query = (req.get("query") or "").strip()
        limit = max(1, min(int(req.get("limit") or 30), 100))
        if len(query) < 2:
            return {"id": rid, "op": op, "query": query, "results": [],
                    "elapsed_ms": 0, "db_age_min": None}
        return {"id": rid, "op": op, "query": query, **do_search(query, limit)}

    if op == "fetch":
        session_id = (req.get("session_id") or "").strip()
        if not session_id:
            return {"id": rid, "op": op, "error": "fetch requires session_id"}
        mode = (req.get("mode") or "thread").strip()
        query = (req.get("query") or "").strip()
        return {"id": rid, "op": op, "session_id": session_id,
                **do_fetch(session_id, mode, query)}

    return {"id": rid, "op": op, "error": f"unknown op: {op}"}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            resp = handle(req)
        except Exception as exc:  # noqa: BLE001
            resp = {"id": req.get("id"), "op": req.get("op"), "error": str(exc)}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
