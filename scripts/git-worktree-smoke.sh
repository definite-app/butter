#!/usr/bin/env bash
set -euo pipefail

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/butter-worktree-smoke-XXXXXX")"
REPO="$TMP_ROOT/repo"
WORKTREES="$TMP_ROOT/worktrees"
NAME="tree-pink-algebra-open-basket"
BRANCH="branch-pink-algebra-open-basket"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$REPO"
git init "$REPO" >/dev/null

git -C "$REPO" config user.email "smoke@example.com"
git -C "$REPO" config user.name "Smoke Test"

printf "hello\n" > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -m "init" >/dev/null

mkdir -p "$WORKTREES"

git -C "$REPO" worktree add "$WORKTREES/$NAME" -b "$BRANCH" >/dev/null

if [[ ! -d "$WORKTREES/$NAME" ]]; then
  echo "worktree dir missing: $WORKTREES/$NAME" >&2
  exit 1
fi

if ! git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "branch not created: $BRANCH" >&2
  exit 1
fi

target_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$WORKTREES/$NAME")"
found=0
while IFS= read -r path; do
  path_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$path")"
  if [[ "$path_real" == "$target_real" ]]; then
    found=1
    break
  fi
done < <(git -C "$REPO" worktree list --porcelain | awk '/^worktree /{print $2}')

if [[ "$found" -ne 1 ]]; then
  echo "worktree not listed" >&2
  exit 1
fi

echo "git worktree smoke test passed"
