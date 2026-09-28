#!/usr/bin/env python3
"""Create a real Butter terminal session via private, per-run local IPC."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import uuid


def main():
    parser = argparse.ArgumentParser(prog="butter-cli session")
    sub = parser.add_subparsers(dest="action", required=True)
    create = sub.add_parser("create")
    create.add_argument("--directory", required=True)
    create.add_argument("--agent", choices=["claude", "codex"], required=True)
    prompt = create.add_mutually_exclusive_group()
    prompt.add_argument("--prompt")
    prompt.add_argument("--prompt-stdin", action="store_true")
    create.add_argument("--title")
    create.add_argument("--timeout", type=float, default=20)
    args = parser.parse_args()
    directory = Path(args.directory).expanduser().resolve()
    if not directory.is_dir():
        parser.error("directory does not exist")
    text = sys.stdin.read(32769) if args.prompt_stdin else args.prompt
    if text is not None and (not text.strip() or len(text.encode()) > 32768 or '\0' in text):
        parser.error("prompt must contain 1–32768 bytes and no NUL")
    if not 1 <= args.timeout <= 55:
        parser.error("timeout must be between 1 and 55 seconds")
    queue = Path(__file__).resolve().parent.parent / "session-requests"
    runtime_path = queue / "runtime.json"
    if not runtime_path.exists():
        raise RuntimeError("This Butter build does not have session creation running")
    runtime = json.loads(runtime_path.read_text())
    os.kill(runtime["pid"], 0)
    request_id = str(uuid.uuid4())
    payload = dict(id=request_id, run_id=runtime["run_id"], created_at=int(time.time()),
                   directory=str(directory), agent=args.agent, prompt=text, title=args.title)
    request = queue / (request_id + ".request.json")
    response = queue / (request_id + ".response.json")
    tmp = request.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    tmp.replace(request)
    end = time.monotonic() + args.timeout
    while time.monotonic() < end:
        if response.exists():
            result = json.loads(response.read_text())
            response.unlink()
            print(json.dumps(result))
            return 0 if result.get("status") == "started" else 1
        time.sleep(.1)
    # Cancel a still-pending request; never blindly retry a possibly started PTY.
    request.unlink(missing_ok=True)
    print(json.dumps({"error": "No PTY confirmation; inspect this session ID before retrying",
                      "session_id": request_id}), file=sys.stderr)
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
