"""Exercise the installed CLI transport with an isolated simulated app responder.

Run: python3 -m unittest discover -s scripts -p test_session_cli.py
This tests IPC, not the Butter webview or an actual agent launch.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


class SessionCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        (self.home / "bin").mkdir()
        self.queue = self.home / "session-requests"
        self.queue.mkdir(mode=0o700)
        self.cli = self.home / "bin/butter-session-cli"
        shutil.copyfile(Path(__file__).resolve().parents[1] / "src-tauri/scripts/session-cli.py", self.cli)
        (self.queue / "runtime.json").write_text(json.dumps({"run_id": "test-run", "pid": os.getpid()}))
        self.args = [sys.executable, str(self.cli), "create", "--directory", str(self.home), "--agent", "codex"]

    def test_stdin_round_trip_waits_for_confirmation(self):
        prompt = "Review 'quotes' and $(echo literal)\nwith Unicode: café"
        process = subprocess.Popen(self.args + ["--prompt-stdin"], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        process.stdin.write(prompt)
        process.stdin.close()
        process.stdin = None
        deadline = time.monotonic() + 5
        request = None
        while time.monotonic() < deadline:
            request = next(self.queue.glob("*.request.json"), None)
            if request:
                break
            time.sleep(.02)
        self.assertIsNotNone(request)
        payload = json.loads(request.read_text())
        self.assertEqual(payload["prompt"], prompt)
        self.assertEqual(payload["run_id"], "test-run")
        self.assertEqual(payload["directory"], str(self.home.resolve()))
        self.assertEqual(request.stat().st_mode & 0o777, 0o600)
        self.assertIsNone(process.poll(), "Must wait for app confirmation")
        response = self.queue / (payload["id"] + ".response.json")
        response.write_text(json.dumps({"status": "started", "session_id": payload["id"], "pid": 123}))
        request.unlink()
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(json.loads(stdout)["session_id"], payload["id"])
        self.assertFalse(response.exists())

    def test_timeout_cancels_pending_request_without_retry(self):
        result = subprocess.run(self.args + ["--timeout", "1"], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertIn("session_id", json.loads(result.stderr))
        self.assertEqual(list(self.queue.glob("*.request.json")), [])

    def test_reject_invalid_prompt_before_queueing(self):
        result = subprocess.run(self.args + ["--prompt-stdin"], input="\0", capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.queue.glob("*.request.json")), [])


if __name__ == "__main__":
    unittest.main()
