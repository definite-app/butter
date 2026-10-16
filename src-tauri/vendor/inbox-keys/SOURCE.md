# Inbox Keys (vendored)

Content scripts and CSS from the open-source Gmail extension "Inbox Keys"
(MIT, see `LICENSE`).

- Repo: https://github.com/hadijaveed/open-superhuman
- Commit: `6b5b7b6e63239de4684f9eadd6d9debbb4c81850` (extension version 0.6.4)
- Copied unchanged: `manifest.json` (reference only), `src/shared/*.js`,
  `src/content/*.js`, `src/content/palette.css`.
- Not copied: the background service worker, the popup and the options page,
  icons, marketing assets and tests.

`butter-chrome-shim.js` is Butter's own code, not upstream. It stands in for
the `chrome.storage` and `chrome.runtime` APIs the content scripts use. It also
answers Butter's palette: Butter dispatches `butter:inboxkeys-request` DOM
events from the page world, and the shim lists or runs commands from
`InboxKeys.commands` and replies with `butter:inboxkeys-response`.

## Changes Butter makes when it bundles the files

The files above stay unchanged on disk. `HOTKEY_PATCHES` in
`src-tauri/src/userscripts.rs` edits them while building the userscripts,
because Butter's palette owns Cmd+K in every page:

- `storage.js`: the `paletteHotkey` default is `mod+j` (was `mod+k`), so Inbox
  Keys' Gmail palette opens with Cmd+J. A value saved in its settings still
  wins.
- `hotkeys.js`: the fallback for a missing setting is `mod+j` too.
- `palette.js`: the palette's key label reads Cmd+J.
- `gcal-ui.js`: the Calendar overlay opens with Cmd+J (it hard-codes the key).

A unit test fails if an upstream update moves any of these lines.

`src-tauri/src/userscripts.rs` assembles these files, in the manifest's
order, into userscripts and installs them into the userscripts folder on
launch. To update: fetch the same paths at a newer commit, check the
manifest's `content_scripts` order against `userscripts.rs`, and update the
commit above.
