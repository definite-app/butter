#!/bin/bash
# Build Butter.app and swap it into /Applications with a backup, safely enough
# to run while Butter is open (even from a terminal inside Butter).
#
#   scripts/install-app.sh              build from this checkout, then install
#   scripts/install-app.sh --dev        same for Butter Dev (com.butter.app.dev)
#   scripts/install-app.sh --ci [RUN]   install the CI artifact (default: latest
#                                       green main build) instead of building
#   scripts/install-app.sh --skip-build install the existing local bundle
#   scripts/install-app.sh --rollback   put the most recent backup back
#
# Options:
#   --wait     wait for busy Claude sessions to finish instead of stopping
#   --force    quit even if agents are busy
#   --dry-run  build and check, but don't quit or install anything
#
# Quitting Butter ends every terminal in it. Restart restores them through the
# reopen picker, and Claude/Codex sessions resume their conversations, but a
# turn that is mid-run is cut off. So the script refuses to quit while a Claude
# session is working (Codex has no busy signal, so it is only listed).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SELF="$REPO/scripts/install-app.sh"
FLAVOR=prod
SOURCE=build
CI_RUN=""
WAIT=0
FORCE=0
DRY_RUN=0
KEEP_BACKUPS=3

while [ $# -gt 0 ]; do
  case "$1" in
    --dev) FLAVOR=dev ;;
    --ci)
      SOURCE=ci
      if [ $# -gt 1 ] && [[ "$2" =~ ^[0-9]+$ ]]; then CI_RUN="$2"; shift; fi
      ;;
    --skip-build) SOURCE=local ;;
    --rollback) SOURCE=rollback ;;
    --wait) WAIT=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    __swap) SOURCE=swap ;;  # internal: detached second stage
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$FLAVOR" = dev ]; then
  APP_NAME="Butter Dev"
  BUNDLE_ID="com.butter.app.dev"
  BUILD_ARGS=(--bundles app --config tauri.dev.conf.json)
else
  APP_NAME="Butter"
  BUNDLE_ID="com.butter.app"
  BUILD_ARGS=(--bundles app)
fi
DEST="/Applications/$APP_NAME.app"
APP_BIN="$DEST/Contents/MacOS/butter"
BUNDLE="$REPO/src-tauri/target/release/bundle/macos/$APP_NAME.app"
BACKUP_PREFIX="$HOME/$APP_NAME.app.bak-"
STAGED="${TMPDIR:-/tmp}/butter-install-$FLAVOR/$APP_NAME.app"
LOG="${TMPDIR:-/tmp}/butter-install-$FLAVOR.log"

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

app_pid() { pgrep -f "^$APP_BIN\$" | head -1 || true; }

# Is this script running inside a terminal of the app it is about to quit?
inside_app() {
  local target p
  target="$(app_pid)"
  [ -n "$target" ] || return 1
  p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    [ "$p" = "$target" ] && return 0
    p="$(ps -o ppid= -p "$p" | tr -d ' ')"
  done
  return 1
}

descendants() {
  local kids k
  kids="$(pgrep -P "$1" || true)"
  for k in $kids; do echo "$k"; descendants "$k"; done
}

# Print one line per agent running in the app; return 1 if a Claude is working.
check_agents() {
  local pid shell kids busy=0 db last
  pid="$(app_pid)"
  [ -n "$pid" ] || return 0
  db="$HOME/.butter/agent.db"
  [ "$FLAVOR" = dev ] && db="$HOME/.butter-dev/agent.db"
  for shell in $(pgrep -P "$pid" || true); do
    kids="$(descendants "$shell" | tr '\n' ',' | sed 's/,$//')"
    [ -n "$kids" ] || continue
    if ps -o command= -p "$kids" | grep -Eq '(^|/)claude( |$)'; then
      last="$(sqlite3 "$db" "SELECT hook_event FROM hook_events WHERE shell_pid = $shell
        AND timestamp > strftime('%s','now') - 1800 ORDER BY timestamp DESC LIMIT 1" 2>/dev/null || true)"
      if [ "$last" = UserPromptSubmit ]; then
        echo "  claude  working  (shell $shell, cwd $(lsof -a -p "$shell" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'))"
        busy=1
      else
        echo "  claude  idle     (shell $shell)"
      fi
    elif ps -o command= -p "$kids" | grep -Eq '(^|/)codex( |$)'; then
      echo "  codex   running  (shell $shell; busy state unknown)"
    fi
  done
  return $busy
}

wait_until_safe() {
  local report
  [ -n "$(app_pid)" ] || return 0
  while true; do
    if report="$(check_agents)"; then
      [ -n "$report" ] && { say "Agents in $APP_NAME (will resume after restart):"; echo "$report"; }
      return 0
    fi
    say "Agents in $APP_NAME:"; echo "$report"
    if [ "$FORCE" = 1 ]; then say "--force: quitting anyway"; return 0; fi
    if [ "$WAIT" = 1 ]; then say "Waiting for Claude to finish (Ctrl+C to stop)..."; sleep 20; continue; fi
    die "a Claude session is working. Re-run with --wait or --force."
  done
}

quit_app() {
  [ -n "$(app_pid)" ] || return 0
  say "Quitting $APP_NAME"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    [ -z "$(app_pid)" ] && return 0
    sleep 1
  done
  die "$APP_NAME did not quit within 30s; nothing was changed."
}

swap_in() {
  local new="$1" backup
  quit_app
  backup="$BACKUP_PREFIX$(date +%Y%m%d-%H%M%S)"
  if [ -d "$DEST" ]; then
    mv "$DEST" "$backup"
    say "Old app saved at $backup"
  fi
  if ! ditto "$new" "$DEST"; then
    [ -d "$backup" ] && mv "$backup" "$DEST"
    die "copy failed; restored the previous app."
  fi
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
  # Keep the newest few backups.
  ls -1d "$BACKUP_PREFIX"* 2>/dev/null | sort -r | tail -n +$((KEEP_BACKUPS + 1)) |
    while IFS= read -r old; do rm -rf "$old"; done
  say "Installed $DEST"
  open "$DEST"
}

bundle_id_of() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true
}

# ---- second stage, detached from the app's terminals -------------------------
if [ "$SOURCE" = swap ]; then
  sleep 1
  swap_in "$STAGED"
  exit 0
fi

# ---- rollback ----------------------------------------------------------------
if [ "$SOURCE" = rollback ]; then
  latest="$(ls -1d "$BACKUP_PREFIX"* 2>/dev/null | sort -r | head -1 || true)"
  [ -n "$latest" ] || die "no backups found at $BACKUP_PREFIX*"
  say "Rolling back to $latest"
  [ "$DRY_RUN" = 1 ] && exit 0
  wait_until_safe
  mkdir -p "$(dirname "$STAGED")"
  rm -rf "$STAGED"
  mv "$latest" "$STAGED"
  SOURCE=staged
fi

# ---- get the new bundle ------------------------------------------------------
case "$SOURCE" in
  build)
    cd "$REPO"
    say "Building $APP_NAME from $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"
    [ -z "$(git status --porcelain)" ] || say "note: working tree has uncommitted changes"
    if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
      npm ci
    fi
    (cd src-tauri && cargo tauri build "${BUILD_ARGS[@]}")
    NEW="$BUNDLE"
    ;;
  local)
    NEW="$BUNDLE"
    [ -d "$NEW" ] || die "no bundle at $NEW; build first."
    ;;
  ci)
    [ "$FLAVOR" = prod ] || die "CI only builds Butter, not Butter Dev."
    command -v gh >/dev/null || die "gh CLI is required for --ci."
    if [ -z "$CI_RUN" ]; then
      # Filter by name: `-w build-macos.yml` also matches an older workflow of
      # the same file name whose artifacts have expired.
      CI_RUN="$(gh run list -R definite-app/butter -b main -e push -s success -L 20 \
        --json databaseId,workflowName \
        -q '[.[] | select(.workflowName == "Build macOS App")][0].databaseId')"
    fi
    [ -n "$CI_RUN" ] || die "no successful main build found."
    say "Downloading CI build $CI_RUN ($(gh run view "$CI_RUN" -R definite-app/butter --json headSha -q .headSha | cut -c1-7))"
    tmp="$(mktemp -d)"
    # `gh run download` can't fetch artifacts uploaded with archive: false
    # (cli/cli#13012), so download through the API. Builds before that change
    # are named Butter-macos-arm64 and wrap Butter.app.zip in a second zip.
    artifact="$(gh api "repos/definite-app/butter/actions/runs/$CI_RUN/artifacts" \
      -q '[.artifacts[] | select(.expired | not) | select(.name | startswith("Butter-macos-arm64"))][0].id')"
    [ -n "$artifact" ] || die "run $CI_RUN has no Butter artifact (expired?)."
    gh api "repos/definite-app/butter/actions/artifacts/$artifact/zip" > "$tmp/artifact.zip"
    ditto -x -k "$tmp/artifact.zip" "$tmp"
    [ -f "$tmp/Butter.app.zip" ] && ditto -x -k "$tmp/Butter.app.zip" "$tmp"
    NEW="$tmp/Butter.app"
    ;;
esac

if [ "$SOURCE" != staged ]; then
  [ "$(bundle_id_of "$NEW")" = "$BUNDLE_ID" ] ||
    die "$NEW has bundle id '$(bundle_id_of "$NEW")', expected $BUNDLE_ID."
  mkdir -p "$(dirname "$STAGED")"
  rm -rf "$STAGED"
  ditto "$NEW" "$STAGED"
fi

if [ "$DRY_RUN" = 1 ]; then
  say "Dry run: staged $STAGED; not installing."
  check_agents || true
  exit 0
fi

wait_until_safe

if inside_app; then
  # Quitting the app would kill this script mid-swap, so hand the swap to a
  # detached copy that outlives the app's terminals.
  say "Running inside $APP_NAME: it will quit, update and reopen in a moment."
  say "Log: $LOG"
  args=(__swap)
  [ "$FLAVOR" = dev ] && args+=(--dev)
  nohup /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' \
    /bin/bash "$SELF" "${args[@]}" >"$LOG" 2>&1 </dev/null &
  disown || true
  exit 0
fi

swap_in "$STAGED"
