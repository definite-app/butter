# AGENTS.md

Guidance for coding agents working in this repository.

See [CLAUDE.md](./CLAUDE.md) for Claude-specific guidance. (Relative links between docs are standard Markdown on GitHub.)

## Project Summary
Butter is a macOS Tauri app that embeds xterm.js terminals in a full-screen UI with an Arc-style sidebar for session organization (tags, presets, filters). Frontend is Solid.js + TypeScript; backend is Rust + Tauri v2 with a PTY layer (portable-pty) that streams terminal I/O to the UI.

## Repo Layout
- `src/` — Solid.js frontend
- `src-tauri/` — Rust backend and Tauri config
- `src-tauri/src/` — Core Rust modules (`lib.rs`, `pty.rs`, agent API/db)

## Common Commands
```bash
npm install
npm run dev
npm run build
cd src-tauri && cargo tauri dev
cd src-tauri && cargo tauri build --bundles app
```

## Development Notes
- Terminals are rendered via `xterm.js` in the webview.
- PTY lifecycle is handled by Tauri commands (`pty_create`, `pty_write`, `pty_resize`, `pty_close`) and `pty-data` events.
- Presets, tags, and UI state are stored in localStorage.
- The main window is full-screen; the sidebar is part of the web UI (not a separate window).
- Team Mode is a separate Slack-like frontend mode backed by the existing Rust/Tauri SQLite database; it stores users, channels, messages, and pins, and uses `butter-cli` for agent communication/configuration.

## Code Style
- TypeScript: strict, no `any`, no unused variables.
- Rust: standard Tauri patterns, snake_case.
- Solid.js: use `createSignal`/`createEffect` for reactivity.

## Build Outputs
- `src-tauri/target/release/bundle/macos/Butter.app`

(We do not build the DMG.)
