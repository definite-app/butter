#!/usr/bin/env bash
set -euo pipefail

payload=${1:-}
if [[ -z "${payload}" ]]; then
  payload="$(cat || true)"
fi
if [[ -z "${payload}" ]]; then
  exit 0
fi

/usr/bin/python3 - <<'PY' "$payload"
import json
import os
import sqlite3
import subprocess
import sys
import time

LOG_PATH = "/tmp/butter-codex-hook.log"
DB_PATH = os.path.expanduser("~/.butter/agent.db")
SHELL_NAMES = {
    "bash",
    "zsh",
    "fish",
    "sh",
    "dash",
    "ksh",
    "tcsh",
    "nu",
}


def log(msg: str) -> None:
    try:
        with open(LOG_PATH, "a") as handle:
            handle.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def parse_payload() -> dict:
    if len(sys.argv) > 1 and sys.argv[1]:
        return json.loads(sys.argv[1])
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    return json.loads(raw)


try:
    payload = parse_payload()
except Exception as exc:
    log(f"invalid json: {exc}")
    sys.exit(0)

if payload.get("type") != "agent-turn-complete":
    sys.exit(0)

def proc_info(pid: int) -> tuple[int, str] | None:
    try:
        out = subprocess.check_output(
            ["ps", "-o", "ppid=,comm=", "-p", str(pid)], text=True
        ).strip()
    except Exception:
        return None
    if not out:
        return None
    parts = out.split(None, 1)
    try:
        ppid = int(parts[0])
    except Exception:
        return None
    comm = parts[1] if len(parts) > 1 else ""
    return ppid, comm


ppid = os.getppid()
shell_pid = None
chain: list[tuple[int, int, str]] = []
pid = ppid
for _ in range(8):
    info = proc_info(pid)
    if info is None:
        break
    parent, comm = info
    chain.append((pid, parent, comm))
    if comm in SHELL_NAMES:
        shell_pid = pid
        break
    if parent <= 1 or parent == pid:
        break
    pid = parent

if shell_pid is None:
    # Fallback to grandparent if available, otherwise parent.
    if len(chain) >= 2:
        shell_pid = chain[1][0]
    else:
        shell_pid = ppid
log(
    "process chain: "
    + " -> ".join([f\"{pid}:{comm}\" for pid, _parent, comm in chain])
)

session_id = payload.get("thread-id") or "codex"
timestamp = int(time.time())

if not os.path.exists(DB_PATH):
    log("db missing")
    sys.exit(0)

try:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO hook_events (session_id, shell_pid, hook_event, timestamp) VALUES (?, ?, ?, ?)",
        (session_id, int(shell_pid), "agent-turn-complete", timestamp),
    )
    conn.commit()
    conn.close()
    log(f"inserted event shell_pid={shell_pid} session_id={session_id}")
except Exception as exc:
    log(f"db insert failed: {exc}")
    sys.exit(0)
PY
