# Butter

A macOS Tauri app that embeds xterm.js terminals in a full-screen UI with an Arc-style sidebar for organizing sessions (tags, presets, filters, command palette).

- Repo-wide guidance: [AGENTS.md](../AGENTS.md)
- Claude-specific guidance: [CLAUDE.md](../CLAUDE.md)

## Quick Start
```bash
npm install
npm run dev
```
Vite runs at http://localhost:5155.

## Tauri Dev
```bash
cd src-tauri
cargo tauri dev
```

## Build
```bash
cd src-tauri
cargo tauri build --bundles app
```
Build output:
- `src-tauri/target/release/bundle/macos/Butter.app`

(We do not build the DMG.)

## Architecture
- **Frontend**: Solid.js + TypeScript (`src/`)
  - `xterm.js` renders terminals in the webview
  - Session organization lives in the sidebar
- **Backend**: Rust + Tauri (`src-tauri/`)
  - `pty.rs` manages PTY sessions and streams `pty-data` events

## Notes
- Presets, tags, and UI state are stored in localStorage.
- Command palette opens with Cmd+Shift+K.
