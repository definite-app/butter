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
the `chrome.storage` and `chrome.runtime` APIs the content scripts use.

`src-tauri/src/userscripts.rs` assembles these files, in the manifest's
order, into userscripts and installs them into the userscripts folder on
launch. To update: fetch the same paths at a newer commit, check the
manifest's `content_scripts` order against `userscripts.rs`, and update the
commit above.
