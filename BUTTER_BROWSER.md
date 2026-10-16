# butter-browser

`butter-browser` is the CLI for controlling Butter's in-app browser from a terminal session.

It is intended for agents running inside Butter, not for use from an arbitrary shell. Each Butter terminal session gets its own browser identity and auth token, and the CLI talks to Butter's local agent API on that session's behalf.

## How It Works

- Butter installs the CLI shim at `~/.butter/bin/butter-browser`.
- New terminal sessions launched by Butter receive:
  - `BUTTER_SESSION_ID`
  - `BUTTER_BROWSER_ENDPOINT`
  - `BUTTER_BROWSER_TOKEN`
- `BUTTER_BROWSER_BIN`
- `butter-browser` uses those env vars to call Butter's local browser control API.
- Commands are scoped to the current Butter session, so one terminal can only control its own linked browser pane.
- Browser storage belongs to a named profile from `~/.config/butter/browser.toml` (Butter Dev: `~/.config/butter-dev/browser.toml`). A pane starts on its preset's `browser_profile`, or `default`, and keeps that profile until it's switched from the pane's footer or with `open --profile`. The terminal's folder doesn't matter.

## Requirements

`butter-browser` only works correctly when all of these are true:

- Butter is running.
- The current shell was launched by Butter.
- The session has the Butter browser env vars.

Quick check:

```bash
which butter-browser
echo "$BUTTER_SESSION_ID"
echo "$BUTTER_BROWSER_ENDPOINT"
echo "$BUTTER_BROWSER_TOKEN"
```

If one of those env vars is missing, the CLI exits with an error like:

```text
butter-browser: missing BUTTER_BROWSER_TOKEN
```

## Commands

```text
butter-browser open [--profile <id>] [url]
butter-browser goto <url>
butter-browser close
butter-browser console [all|errors|warn|info|log|debug] [limit]
butter-browser console-clear
butter-browser network [all|errors|fetch|xhr] [limit]
butter-browser network-clear
butter-browser state
butter-browser back
butter-browser forward
butter-browser reload
butter-browser click <selector>
butter-browser type <selector> <text>
butter-browser press <key>
butter-browser wait-for <selector> [timeout-ms]
butter-browser html
butter-browser snapshot [dom|image] [output-path]
butter-browser help
butter-browser --help
butter-browser -h
```

`help`, `--help`, and `-h` print usage and exit successfully without requiring the Butter session env vars.

## Command Details

### `open [--profile <id>] [url]`

Opens the browser for the current session. If a URL is provided, Butter navigates to it. `--profile` switches the pane to that browser.toml profile first (an unknown id means `default`); the page reloads in the new profile.

Examples:

```bash
butter-browser open
butter-browser open https://example.com
butter-browser open --profile work https://mail.google.com/
```

### `goto <url>`

Navigates the existing browser to a URL.

Example:

```bash
butter-browser goto https://news.ycombinator.com
```

### `close`

Closes the linked browser pane for the current session.

### `console [all|errors|warn|info|log|debug] [limit]`

Returns recent console entries as JSON.

Defaults:

- filter: `all`
- limit: `100`

Examples:

```bash
butter-browser console
butter-browser console errors
butter-browser console errors 25
```

The current payload includes:

- `timestampMs`
- `level`
- `text`
- `args`
- `frameUrl`
- `sourceUrl`
- `line`
- `column`
- `stack`
- `kind`

### `console-clear`

Clears the current session's buffered console log.

Example:

```bash
butter-browser console-clear
```

### `network [all|errors|fetch|xhr] [limit]`

Returns captured page network activity as JSON.

Defaults:

- filter: `all`
- limit: `100`

Examples:

```bash
butter-browser network
butter-browser network errors
butter-browser network fetch 25
```

The current payload includes:

- `timestampMs`
- `kind`
- `method`
- `url`
- `status`
- `statusText`
- `ok`
- `durationMs`
- `frameUrl`
- `contentType`
- `error`

Current coverage:

- `fetch`
- `XMLHttpRequest`

This does not yet include full WebKit devtools-grade network inspection for every document, image, stylesheet, or socket.

### `network-clear`

Clears the current session's buffered network log.

Example:

```bash
butter-browser network-clear
```

### `state`

Returns JSON describing the current browser session state.

Current fields include:

- `sessionId`
- `open`
- `visible`
- `loading`
- `url`
- `title`
- `profileId`
- `canGoBack`
- `canGoForward`
- `bounds`
- `lastError`

Example:

```bash
butter-browser state
```

### `back`, `forward`, `reload`

Standard browser navigation controls.

Examples:

```bash
butter-browser back
butter-browser forward
butter-browser reload
```

### `click <selector>`

Finds a DOM element with `document.querySelector()` and clicks it.

Example:

```bash
butter-browser click 'button[type="submit"]'
```

### `type <selector> <text>`

Sets the value of an input-like element, then dispatches `input` and `change` events.

Example:

```bash
butter-browser type 'input[name="q"]' 'butter browser'
```

### `press <key>`

Dispatches keyboard events against the active element.

Example:

```bash
butter-browser press Enter
```

### `wait-for <selector> [timeout-ms]`

Polls until a selector exists in the page DOM.

Examples:

```bash
butter-browser wait-for 'input[name="search"]'
butter-browser wait-for '.results-list' 15000
```

### `html`

Returns the current page HTML to stdout.

Example:

```bash
butter-browser html > /tmp/page.html
```

### `snapshot dom`

Returns a JSON DOM snapshot to stdout.

The current payload includes:

- `url`
- `title`
- `html`
- `text`
- `interactives`

Example:

```bash
butter-browser snapshot dom > /tmp/page-dom.json
```

### `snapshot image [output-path]`

Returns a screenshot of the visible browser viewport. If `output-path` is provided, the image is written there.

Current behavior:

- default format is PNG
- if `output-path` ends in `.jpg` or `.jpeg`, Butter writes JPEG
- if `output-path` ends in `.tif` or `.tiff`, Butter writes TIFF
- capture is viewport-only
- this is not a stitched full-page screenshot

Examples:

```bash
butter-browser snapshot image > /tmp/page.png
butter-browser snapshot image /tmp/page.png
butter-browser snapshot image /tmp/page.jpg
```

## Typical Agent Flow

```bash
butter-browser open https://www.wikipedia.org/
butter-browser wait-for 'input[name="search"]' 10000
butter-browser type 'input[name="search"]' 'Tauri'
butter-browser press Enter
butter-browser state
butter-browser snapshot dom > /tmp/tauri-page.json
```

## Session Isolation

- Browser control is tied to the Butter terminal session that launched the command.
- Auth is enforced with `BUTTER_BROWSER_TOKEN`.
- A session cannot control another session's browser by default.
- Browser cookies, local storage, and login state are shared by every pane on the same profile, and only by them.
- Every profile, `default` included, has its own WebKit data store, separate from the one Butter's own UI uses.

## Notes And Limits

- `click`, `type`, and `wait-for` use DOM selectors, not image-based targeting.
- The browser is Butter's embedded WebKit browser pane, not an external Chrome instance.
- `snapshot image` captures what is visible in the pane, not the full scrollable page.
- `console` captures page-level JavaScript console output plus `window.onerror` and `unhandledrejection`.
- The console buffer is session-scoped, bounded, and is cleared when a new top-level page load starts.
- `network` currently captures page-level `fetch` and `XMLHttpRequest` traffic after Butter's browser bridge is injected.
- The network buffer is session-scoped, bounded, and is cleared when a new top-level page load starts.
- New Butter terminals receive the CLI env vars at PTY creation time. Old terminals from before a restart will not.
- If Butter is already using port `9876`, it now automatically chooses another free localhost port and updates the session env vars accordingly.

## Troubleshooting

If `butter-browser` is missing:

1. Restart Butter.
2. Open a brand new terminal session inside Butter.
3. Run `which butter-browser` again.

If commands fail with missing env vars:

1. Confirm the shell was launched by Butter.
2. Check `BUTTER_SESSION_ID`, `BUTTER_BROWSER_ENDPOINT`, and `BUTTER_BROWSER_TOKEN`.

If you want to inspect the local API directly:

```bash
curl -s "$BUTTER_BROWSER_ENDPOINT/health"
```

That should return:

```json
{"status":"ok"}
```
