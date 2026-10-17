#!/bin/bash
# Re-sign a built Butter.app (or Butter Dev.app) with a stable identity so
# macOS keeps its permission grants across installs.
#
#   scripts/sign-app.sh <App.app>      sign in place, then verify
#   scripts/sign-app.sh --pick-identity
#       read `security find-identity -v -p codesigning` output on stdin and
#       print "<sha1>\t<name>" of the identity to use (nothing if none)
#
# macOS keys permissions (Screen Recording, Microphone, Full Disk Access,
# folders, Automation) to the app's designated requirement. An ad-hoc build's
# requirement is its code hash, so every build looks like a new app and loses
# its grants. A certificate's requirement names the bundle id and the
# certificate instead, which stays the same from build to build.
#
# Identity: $BUTTER_SIGN_IDENTITY (a name or SHA-1; "-" forces ad-hoc), else the first
# "Developer ID Application", else the first "Apple Development" identity in
# the keychain. With none, the app is signed ad-hoc and grants reset with
# each install.
#
# Local signing skips the hardened runtime: nothing needs it until the app is
# notarized. The later CI Developer ID + notarization work needs
# `--options runtime` and `com.apple.security.device.audio-input` in
# src-tauri/entitlements.plist, or the microphone stops working.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$REPO/src-tauri/entitlements.plist"

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# `security find-identity -v` lines look like
#   1) 0123...ABCD "Apple Development: Jane Doe (TEAMID1234)"
pick_identity() {
  local lines kind match
  lines="$(cat)"
  for kind in "Developer ID Application" "Apple Development"; do
    match="$(printf '%s\n' "$lines" |
      sed -n "s/^ *[0-9][0-9]*) \([0-9A-Fa-f]\{40\}\) \"\($kind: [^\"]*\)\"\$/\1	\2/p" | head -1)"
    if [ -n "$match" ]; then
      printf '%s\n' "$match"
      return 0
    fi
  done
  return 0
}

if [ "${1:-}" = --pick-identity ]; then
  pick_identity
  exit 0
fi

APP="${1:-}"
[ -n "$APP" ] && [ -d "$APP/Contents" ] || die "usage: sign-app.sh <App.app>"
[ -f "$ENTITLEMENTS" ] || die "missing $ENTITLEMENTS"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"

if [ -n "${BUTTER_SIGN_IDENTITY:-}" ]; then
  IDENTITY="$BUTTER_SIGN_IDENTITY"
  LABEL="$BUTTER_SIGN_IDENTITY"
else
  picked="$(security find-identity -v -p codesigning 2>/dev/null | pick_identity)"
  IDENTITY="${picked%%	*}"
  LABEL="${picked#*	}"
fi

if [ -z "$IDENTITY" ]; then
  IDENTITY=-
  cat >&2 <<'EOF'
warning: no code signing identity found, so this build is signed ad-hoc.
  macOS will treat it as a new app: Screen Recording, Microphone, Full Disk
  Access, folder and Automation grants reset with every install.
  To fix it, add a free "Apple Development" certificate (Xcode > Settings >
  Accounts > Manage Certificates > +), or set BUTTER_SIGN_IDENTITY to the name
  or SHA-1 of one from `security find-identity -v -p codesigning`.
EOF
  LABEL="ad-hoc"
fi

# Nested code first, innermost first: bundles under Contents, then loose Mach-O
# files outside them. The main executable is signed with the bundle itself.
# This avoids --deep, which would also stamp the app's entitlements on helpers.
main_exe="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
nested_bundles="$(find "$APP/Contents" -mindepth 1 -type d \
  \( -name '*.framework' -o -name '*.app' -o -name '*.appex' -o -name '*.xpc' -o -name '*.bundle' \) |
  awk '{ print gsub("/", "/"), $0 }' | sort -rn | cut -d' ' -f2-)"
while IFS= read -r bundle; do
  [ -n "$bundle" ] || continue
  codesign --force --sign "$IDENTITY" --timestamp=none "$bundle"
done <<<"$nested_bundles"
while IFS= read -r file; do
  [ -n "$file" ] && [ "$file" != "$main_exe" ] || continue
  inside=0
  while IFS= read -r bundle; do
    [ -n "$bundle" ] && case "$file" in "$bundle"/*) inside=1 ;; esac
  done <<<"$nested_bundles"
  [ "$inside" = 0 ] || continue
  file -b "$file" | grep -q '^Mach-O' || continue
  codesign --force --sign "$IDENTITY" --timestamp=none "$file"
done < <(find "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$APP/Contents/Resources" \
  -type f 2>/dev/null)

codesign --force --sign "$IDENTITY" --timestamp=none \
  --identifier "$BUNDLE_ID" --entitlements "$ENTITLEMENTS" "$APP"

codesign --verify --strict --deep "$APP" || die "$APP failed codesign --verify --strict."
requirement="$(codesign -d -r- "$APP" 2>/dev/null | sed -n 's/^#* *designated => //p')"
if [ "$IDENTITY" = - ]; then
  say "Signed $APP ad-hoc ($requirement)"
  exit 0
fi
case "$requirement" in
  ""|cdhash*) die "$APP still has a code-hash requirement ('$requirement'); signing didn't take." ;;
esac
say "Signed $APP with $LABEL"
say "Designated requirement: $requirement"
