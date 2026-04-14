# Butter

A premium, minimal macOS terminal manager for agentic CLI workflows (Claude Code, Codex, Copilot). Built with Tauri + Solid.js + xterm.js, inspired by Arc and Zen browsers.

## Features

- **Multi-session terminal** — xterm.js panes driven by a native Rust PTY layer
- **Arc-style sidebar** — organize sessions with tags, presets, and filters
- **Command palette** — `Cmd+Shift+K` to jump anywhere
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

- `Cmd+Shift+K` — command palette
- `Cmd+O` — file browser
- `Cmd+K` — clear terminal
- `Cmd+click` — open links

## Storage

- Config: `~/.config/butter/config.toml`
- Sessions + agent data: `~/.butter/agent.db`
