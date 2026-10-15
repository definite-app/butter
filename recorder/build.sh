#!/bin/sh
# Builds ButterRec.app (a UI-less agent bundle, so macOS can grant it microphone,
# system audio and accessibility permissions) and installs it to ~/.butter.
#   recorder/build.sh            build + install to ~/.butter/ButterRec.app
#   recorder/build.sh --no-install
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/build"
app="$out/ButterRec.app"
dest="$HOME/.butter/ButterRec.app"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$here/Info.plist" "$app/Contents/Info.plist"
cp "$here/asr/worker.py" "$app/Contents/Resources/asr_worker.py"
cp "$here"/sounds/*.wav "$app/Contents/Resources/"

swiftc -O -swift-version 5 -target arm64-apple-macos14.4 \
  -o "$app/Contents/MacOS/butter-rec" "$here"/Sources/*.swift

# A real identity keeps TCC grants across rebuilds; ad-hoc signing changes the
# code hash every build, so macOS re-prompts for permissions.
identity="${BUTTER_REC_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development[^"]*\)".*/\1/p' | head -1)}"
codesign --force --sign "${identity:--}" --identifier app.butter.rec "$app"
echo "Built $app (signed: ${identity:-ad-hoc})"

[ "${1:-}" = "--no-install" ] && exit 0

mkdir -p "$HOME/.butter/bin"
rm -rf "$dest"
cp -R "$app" "$dest"
ln -sf "$dest/Contents/MacOS/butter-rec" "$HOME/.butter/bin/butter-rec"
echo "Installed $dest and ~/.butter/bin/butter-rec"

if launchctl print "gui/$(id -u)/app.butter.rec" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/app.butter.rec"
  echo "Restarted the running daemon"
fi
