#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_APP_PATH="${SCRIPT_DIR}/../src-tauri/target/release/bundle/macos/Butter.app/Contents/MacOS/butter"
APP_PATH="${BUTTER_APP_PATH:-${DEFAULT_APP_PATH}}"

if [[ ! -x "$APP_PATH" ]]; then
  echo "Smoke test binary not found or not executable: $APP_PATH" >&2
  echo "Build with: cargo tauri build" >&2
  exit 1
fi

"$APP_PATH" --smoke-test
