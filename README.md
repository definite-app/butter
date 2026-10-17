# Butter

A premium, minimal macOS terminal manager for agentic CLI workflows (Claude Code, Codex, Copilot). Built with Tauri + Solid.js + xterm.js, inspired by Arc and Zen browsers.

## Install and update

GitHub Actions builds Butter for Apple Silicon Macs on every push to `main`. You install and update from those builds. Downloading them requires a GitHub account with access to this repo.

### With a clone of the repo (recommended)

```sh
git clone https://github.com/definite-app/butter.git
cd butter
scripts/install-app.sh --ci
```

To update, run `git pull && scripts/install-app.sh --ci` in the same folder. The script needs the [`gh` CLI](https://cli.github.com), signed in with `gh auth login`. It downloads the latest green `main` build. Then it quits Butter, saves the old app to `~/Butter.app.bak-<timestamp>`, installs the new one and reopens it. Your terminals come back through the reopen picker.

- `--wait`: wait until no Claude session in Butter is mid-turn before quitting
- `--rollback`: put the previous version back

The script re-signs the app with your code signing certificate before installing, so macOS keeps Screen Recording, Microphone and Full Disk Access grants from one version to the next.
- No flags (`scripts/install-app.sh`): build locally instead (needs Node and Rust)

### Without a clone

1. Open the [latest successful **Build macOS App** run on `main`](https://github.com/definite-app/butter/actions/workflows/build-macos.yml?query=branch%3Amain+is%3Asuccess). Download the **Butter-macos-arm64** artifact at the bottom of the page.
2. Unzip it to get `Butter.app`. Builds from before Oct 16, 2026 contain a `Butter.app.zip` instead; unzip that too.
3. Quit Butter. This closes its terminals.
4. Move the new `Butter.app` into `/Applications`, replacing the old one.
5. The app is ad-hoc signed, so clear the download quarantine before opening it:
   ```sh
   xattr -dr com.apple.quarantine /Applications/Butter.app
   ```

The same steps from a terminal, with `gh` signed in:

```sh
run=$(gh run list -R definite-app/butter -b main -e push -s success -L 20 \
  --json databaseId,workflowName -q '[.[] | select(.workflowName=="Build macOS App")][0].databaseId')
artifact=$(gh api "repos/definite-app/butter/actions/runs/$run/artifacts" \
  -q '[.artifacts[] | select(.expired | not) | select(.name | startswith("Butter-macos-arm64"))][0].id')
tmp=$(mktemp -d)
# `gh run download` can't fetch this artifact (cli/cli#13012), so go through the API.
gh api "repos/definite-app/butter/actions/artifacts/$artifact/zip" > "$tmp/artifact.zip"
ditto -x -k "$tmp/artifact.zip" "$tmp"
[ -f "$tmp/Butter.app.zip" ] && ditto -x -k "$tmp/Butter.app.zip" "$tmp"   # older builds
osascript -e 'quit app "Butter"'; sleep 3
[ -d /Applications/Butter.app ] && mv /Applications/Butter.app ~/Butter.app.bak-$(date +%Y%m%d-%H%M%S)
ditto "$tmp/Butter.app" /Applications/Butter.app
xattr -dr com.apple.quarantine /Applications/Butter.app
open /Applications/Butter.app
```

Notes:
- CI builds are ad-hoc signed, so installed by hand each one looks like a new app to macOS and loses the permissions you granted. `scripts/install-app.sh` re-signs them with your "Apple Development" (or Developer ID) certificate so permissions stick; without one it warns. Get a free one in Xcode > Settings > Accounts > Manage Certificates.
- Cmd+K "Permissions" shows what Butter, its terminals and ButterRec are allowed to do, with a Grant button for each.
- GitHub keeps build artifacts for 90 days. Always take the newest run.
- `butter-cli` is installed to `~/.butter/bin` every time Butter launches. There's nothing separate to update.

### Dictation and meeting recorder (optional)

The CI build doesn't include `butter-rec`. To install it, run this from a clone:

```sh
recorder/build.sh && butter-cli rec install
```

It needs Xcode's command-line tools (`xcode-select --install`) and [`uv`](https://docs.astral.sh/uv/). Run `recorder/build.sh` again after pulling to update it. See [recorder/README.md](recorder/README.md).

## Features

- **Multi-session terminal** — xterm.js panes driven by a native Rust PTY layer
- **Arc-style sidebar** — organize sessions with tags, presets, and filters
- **Command palette** — `Cmd+K` for commands, `Cmd+Shift+K` to jump to a terminal
- **Claude Code activity indicators** — live working/idle status in the sidebar via Claude hooks
- **Codex activity support** — `agent-turn-complete` events from Codex CLI
- **Session persistence** — SQLite-backed sessions with scrollback; restore on app restart
- **File browser** — integrated overlay with search (`Cmd+O`)
- **Clipboard images** — paste screenshots straight into terminals
- **Scratchpad** — quick notes drawer
- **Canvas workspace** — spatial layout for arranging terminals
- **Agent HTTP API** — local service for agent tooling (`~/.butter/agent.db`)

## Design Vision

Less is more. Subtle over flashy. Refined over busy.

- Ultra-flat surfaces, no heavy shadows
- Muted selection states (soft grays, not bright accents)
- Compact single-line list items
- Warm dark palette — not pure black
- **Primary accent:** butter yellow `#F5D76E`
- Sidebar width: 240px

## Quick Start

```bash
npm install
npm run dev           # Vite dev server at http://localhost:5155
```

### Tauri Dev

```bash
cd src-tauri
cargo tauri dev
```

### Build

```bash
cd src-tauri
cargo tauri build --bundles app
```

Output: `src-tauri/target/release/bundle/macos/Butter.app`

## Architecture

**Frontend** (`src/`) — Solid.js + TypeScript
- `App.tsx` → `AppShell.tsx` — main layout (Sidebar, TerminalArea, FooterBar, CommandPalette)
- `app/context/AppContext.tsx` — global state via Solid context
- Feature modules: `features/{terminal,sidebar,canvas,browser,files,overlays,presets,scratchpad,footer}`

**Backend** (`src-tauri/src/`) — Rust + Tauri v2
- `pty.rs` — PTY lifecycle + streaming (`portable-pty`)
- `database.rs` / `http_server.rs` — agent API storage and local HTTP service
- `browser.rs`, `clipboard_history.rs`, `config.rs` — feature modules

### PTY Commands

```ts
const ptyId = await invoke<string>("pty_create", { id, rows, cols, cwd, command });
await invoke("pty_write", { id: ptyId, data });
await invoke("pty_resize", { id: ptyId, rows, cols });
await invoke("pty_close", { id: ptyId });

listen<{ id: string; data: string }>("pty-data", (e) => {
  terminals.get(e.payload.id)?.write(e.payload.data);
});
```

## Configuration

Config file: `~/.config/butter/config.toml` (created on first run).

```toml
version = 1

[general]
default_shell = "/bin/zsh"
default_directory = "~"

[appearance]
font_family = "SF Mono"
font_size = 14
cursor_style = "block"

[appearance.theme]
background = "#18181b"
foreground = "#d4d4d8"
cursor = "#F5D76E"

[ui]
sidebar_width = 240
show_tags_by_default = false

[[presets.items]]
id = "backend-dev"
name = "Backend"
directory = "~/projects/my-app/backend"
command = "npm run dev"
tags = ["work"]
```

Presets can also be created via the UI (dropdown next to "New" in the sidebar).

## Agent Activity Hooks

### Claude Code

Register `~/.config/butter/hooks/claude-hook.sh` in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "command": "~/.config/butter/hooks/claude-hook.sh" }],
    "Stop": [{ "command": "~/.config/butter/hooks/claude-hook.sh" }]
  }
}
```

The hook writes events to `~/.butter/agent.db`; Butter polls every ~3s, correlates via shell PID, and shows `working` / `idle` / `unknown`.

### Codex

Symlink `scripts/codex-notify.sh` to `~/.config/butter/hooks/codex-notify.sh`, then in `~/.codex/config.toml`:

```toml
notify = ["bash", "~/.config/butter/hooks/codex-notify.sh"]
```

### Debug Logs

- `/tmp/butter-hook.log` — hook script execution
- `/tmp/butter-activity.log` — Rust poll results

## Keyboard Shortcuts

- `Cmd+K` — command palette
- `Cmd+Shift+K` — terminal switcher
- `Cmd+O` — file browser
- `Cmd+click` — open links

## Storage

- Config: `~/.config/butter/config.toml`
- Sessions + agent data: `~/.butter/agent.db`
