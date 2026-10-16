//! Tampermonkey-style userscripts for the browser pane.
//!
//! Scripts are `.js` files in `<config dir>/userscripts/` (`~/.config/butter`
//! or `~/.config/butter-dev`) with a `// ==UserScript==` header. They are read
//! when a browser webview is created, and again on reload or navigation from
//! Butter. `browser.rs` injects each one as a `WKUserScript`, by default in
//! its own isolated `WKContentWorld`, so page CSP and Trusted Types (Gmail
//! enforces them, and WebKit 26 does too) don't block DOM writes such as
//! `innerHTML`. `@inject-into page` puts a script in the page's own world.
//!
//! Butter also installs the Inbox Keys Gmail extension (vendored under
//! `src-tauri/vendor/inbox-keys`) as userscripts on every launch, the same way
//! `agent_skill.rs` installs the agent skill: rewritten while the marker line
//! is present, left alone once the user removes it.

use std::fs;
use std::path::{Path, PathBuf};

/// Every injected source starts with this, so `browser.rs` can tell our
/// `WKUserScript`s from wry's when it swaps them.
pub const SOURCE_PREFIX: &str = "/* butter-userscript ";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunAt {
    DocumentStart,
    DocumentEnd,
    DocumentIdle,
}

/// Which JavaScript world the script runs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectInto {
    /// An isolated world of its own (like a Chrome content script). Default.
    Content,
    /// The page's own world: sees page globals, subject to the page's CSP.
    Page,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub name: Option<String>,
    pub matches: Vec<String>,
    pub run_at: RunAt,
    pub no_frames: bool,
    pub inject_into: InjectInto,
}

/// A parsed script, ready for `injection_source`.
#[derive(Debug, Clone)]
pub struct UserScript {
    pub file_name: String,
    pub name: String,
    pub run_at: RunAt,
    pub no_frames: bool,
    pub inject_into: InjectInto,
    /// One regex per `@match`, in syntax that JavaScript and Rust agree on.
    pub match_regexes: Vec<String>,
    pub source: String,
}

impl UserScript {
    /// Named isolated world for content scripts; `None` means the page world.
    pub fn world_name(&self) -> Option<String> {
        match self.inject_into {
            InjectInto::Content => Some(format!("butter-userscript:{}", self.file_name)),
            InjectInto::Page => None,
        }
    }
}

/// Parses the `// ==UserScript==` block. `None` when the file has none.
pub fn parse_header(source: &str) -> Option<Header> {
    let mut lines = source.lines().map(str::trim);
    lines
        .by_ref()
        .find(|line| is_header_line(line, "==UserScript=="))?;
    let mut header = Header {
        name: None,
        matches: Vec::new(),
        run_at: RunAt::DocumentIdle,
        no_frames: false,
        inject_into: InjectInto::Content,
    };
    for line in lines {
        if is_header_line(line, "==/UserScript==") {
            return Some(header);
        }
        let Some(rest) = line.strip_prefix("//") else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix('@') else {
            continue;
        };
        let (key, value) = match rest.find(char::is_whitespace) {
            Some(i) => (&rest[..i], rest[i..].trim()),
            None => (rest, ""),
        };
        match key {
            "name" if header.name.is_none() && !value.is_empty() => {
                header.name = Some(value.to_string())
            }
            "match" if !value.is_empty() => header.matches.push(value.to_string()),
            "run-at" => {
                header.run_at = match value {
                    "document-start" => RunAt::DocumentStart,
                    "document-end" => RunAt::DocumentEnd,
                    _ => RunAt::DocumentIdle,
                }
            }
            "noframes" => header.no_frames = true,
            "inject-into" => {
                header.inject_into = if value == "page" {
                    InjectInto::Page
                } else {
                    InjectInto::Content
                }
            }
            _ => {}
        }
    }
    // No closing line: not a valid header.
    None
}

fn is_header_line(line: &str, tag: &str) -> bool {
    line.strip_prefix("//")
        .is_some_and(|rest| rest.trim() == tag)
}

const SCHEMES: &[&str] = &["http", "https", "ws", "wss", "ftp", "file"];

/// Escapes regex metacharacters. Only these are escaped, so the result means
/// the same thing to JavaScript's `RegExp` and Rust's `regex`.
fn escape_regex(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Turns a Chrome match pattern (`https://*.google.com/*`, `<all_urls>`) into
/// a regex over the URL without its `#fragment`. The path part covers the
/// query string too, as in Chrome. A host without a port matches any port.
pub fn match_pattern_regex(pattern: &str) -> Result<String, String> {
    let pattern = pattern.trim();
    if pattern == "<all_urls>" {
        return Ok("^(?:https?|wss?|ftp|file)://".to_string());
    }
    let (scheme, rest) = pattern
        .split_once("://")
        .ok_or_else(|| format!("missing \"://\" in {pattern:?}"))?;
    let scheme = scheme.to_ascii_lowercase();
    let scheme_re = if scheme == "*" {
        "https?".to_string()
    } else if SCHEMES.contains(&scheme.as_str()) {
        scheme.clone()
    } else {
        return Err(format!("unsupported scheme in {pattern:?}"));
    };
    let slash = rest
        .find('/')
        .ok_or_else(|| format!("missing path in {pattern:?}"))?;
    let (host, path) = rest.split_at(slash);
    let host = host.to_ascii_lowercase();

    let host_re = if scheme == "file" {
        if !host.is_empty() {
            return Err(format!("file patterns can't have a host: {pattern:?}"));
        }
        String::new()
    } else {
        let (host_re, has_port) = if host == "*" {
            ("[^/:]+".to_string(), false)
        } else if let Some(domain) = host.strip_prefix("*.") {
            if domain.is_empty() || domain.contains('*') {
                return Err(format!("invalid host in {pattern:?}"));
            }
            (
                format!("(?:[^/:]+\\.)?{}", escape_regex(domain)),
                domain.contains(':'),
            )
        } else if host.is_empty() || host.contains('*') {
            return Err(format!("invalid host in {pattern:?}"));
        } else {
            (escape_regex(&host), host.contains(':'))
        };
        if has_port {
            host_re
        } else {
            format!("{host_re}(?::[0-9]+)?")
        }
    };

    let path_re = path
        .split('*')
        .map(escape_regex)
        .collect::<Vec<_>>()
        .join(".*");
    Ok(format!("^{scheme_re}://{host_re}{path_re}$"))
}

/// Parses a script file. `Err` explains why it won't be injected.
pub fn parse_script(file_name: &str, source: &str) -> Result<UserScript, String> {
    let header = parse_header(source).ok_or("no // ==UserScript== header")?;
    if header.matches.is_empty() {
        return Err("no @match lines".to_string());
    }
    let match_regexes = header
        .matches
        .iter()
        .map(|pattern| match_pattern_regex(pattern))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(UserScript {
        file_name: file_name.to_string(),
        name: header.name.unwrap_or_else(|| file_name.to_string()),
        run_at: header.run_at,
        no_frames: header.no_frames,
        inject_into: header.inject_into,
        match_regexes,
        source: source.to_string(),
    })
}

/// `<config dir>/userscripts`.
pub fn userscripts_dir() -> Result<PathBuf, String> {
    Ok(crate::paths::butter_config_dir()?.join("userscripts"))
}

/// Reads every `*.js` file in `dir`, sorted by name. Files that can't be
/// read or parsed are skipped with a log line.
pub fn load_from(dir: &Path) -> Vec<UserScript> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "js")
                && path.is_file()
                && !path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with('.'))
        })
        .collect();
    paths.sort();
    paths
        .into_iter()
        .filter_map(|path| {
            let file_name = path.file_name()?.to_string_lossy().into_owned();
            let source = match fs::read_to_string(&path) {
                Ok(source) => source,
                Err(err) => {
                    eprintln!("[userscripts] skipping {file_name}: {err}");
                    return None;
                }
            };
            match parse_script(&file_name, &source) {
                Ok(script) => Some(script),
                Err(err) => {
                    eprintln!("[userscripts] skipping {file_name}: {err}");
                    None
                }
            }
        })
        .collect()
}

pub fn load() -> Vec<UserScript> {
    userscripts_dir()
        .map(|dir| load_from(&dir))
        .unwrap_or_default()
}

/// The JavaScript Butter injects for `script`. It checks the frame's URL
/// against the `@match` patterns (WKUserScript has no URL filter), waits for
/// `@run-at`, and gives the script `GM_info` and `GM_addStyle`.
pub fn injection_source(script: &UserScript) -> String {
    let json = |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    let patterns = serde_json::to_string(&script.match_regexes).unwrap_or_else(|_| "[]".into());
    let start = match script.run_at {
        RunAt::DocumentIdle => {
            "if (document.readyState === \"loading\") document.addEventListener(\"DOMContentLoaded\", function () { setTimeout(run, 0); }, { once: true });\n  else setTimeout(run, 0);"
        }
        RunAt::DocumentStart | RunAt::DocumentEnd => "run();",
    };
    // The file name goes in a comment, so keep it from closing it.
    let label = script.file_name.replace("*/", "* /");
    format!(
        r##"{SOURCE_PREFIX}{label} */
(function () {{
  var url = String(location.href).split("#")[0];
  var patterns = {patterns};
  if (!patterns.some(function (p) {{ return new RegExp(p).test(url); }})) return;
  var GM_info = {{ scriptHandler: "Butter", script: {{ name: {name} }} }};
  var GM_addStyle = function (css) {{
    try {{
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(String(css));
      document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
      return sheet;
    }} catch (_err) {{
      var style = document.createElement("style");
      style.textContent = String(css);
      (document.head || document.documentElement).appendChild(style);
      return style;
    }}
  }};
  var run = function () {{
    try {{
      (function () {{
{source}
      }})();
    }} catch (err) {{
      console.error("[userscript] " + {name} + " failed:", err);
    }}
  }};
  {start}
}})();
"##,
        name = json(&script.name),
        source = script.source,
    )
}

// ---- Bundled Inbox Keys ----------------------------------------------------

/// Added after the header of each installed script. A copy without it is the
/// user's own, and Butter leaves it alone.
const MARKER: &str =
    "// Installed by Butter, which rewrites this file on every launch. Delete this line to keep your own version.";

macro_rules! vendored {
    ($path:literal) => {
        ($path, include_str!(concat!("../vendor/inbox-keys/", $path)))
    };
}

const INBOX_KEYS_LICENSE: &str = include_str!("../vendor/inbox-keys/LICENSE");
const INBOX_KEYS_SOURCE: &str =
    "https://github.com/hadijaveed/open-superhuman (commit 6b5b7b6e63239de4684f9eadd6d9debbb4c81850, v0.6.4)";
const CHROME_SHIM: (&str, &str) = (
    "butter-chrome-shim.js",
    include_str!("../vendor/inbox-keys/butter-chrome-shim.js"),
);
const PALETTE_CSS: &str = include_str!("../vendor/inbox-keys/src/content/palette.css");

/// Gmail content scripts, in the manifest's order.
const GMAIL_FILES: &[(&str, &str)] = &[
    vendored!("src/shared/hashutil.js"),
    vendored!("src/shared/keymap.js"),
    vendored!("src/content/storage.js"),
    vendored!("src/content/account-sync.js"),
    vendored!("src/content/toast.js"),
    vendored!("src/content/gmail.js"),
    vendored!("src/content/accounts.js"),
    vendored!("src/content/calendar.js"),
    vendored!("src/content/listnav.js"),
    vendored!("src/content/threadnav.js"),
    vendored!("src/content/tabs.js"),
    vendored!("src/content/commands.js"),
    vendored!("src/content/palette.js"),
    vendored!("src/content/hotkeys.js"),
    vendored!("src/content/content.js"),
];

/// Google Calendar content scripts, in the manifest's order.
const CALENDAR_FILES: &[(&str, &str)] = &[
    vendored!("src/shared/hashutil.js"),
    vendored!("src/shared/keymap.js"),
    vendored!("src/content/storage.js"),
    vendored!("src/content/account-sync.js"),
    vendored!("src/content/toast.js"),
    vendored!("src/content/gcal.js"),
    vendored!("src/content/gcal-ui.js"),
];

const BRIDGE_FILES: &[(&str, &str)] = &[vendored!("src/content/account-bridge.js")];

struct Bundled {
    file_name: &'static str,
    header: &'static str,
    /// Runs in the isolated world with the chrome.* shim and palette.css.
    content_world: bool,
    files: &'static [(&'static str, &'static str)],
}

const BUNDLED: &[Bundled] = &[
    Bundled {
        file_name: "inbox-keys.user.js",
        header: "// @name         Inbox Keys\n// @description  Gmail command palette (Cmd+J), hotkeys, split inbox and account switching.\n// @match        https://mail.google.com/*\n// @run-at       document-idle\n// @noframes",
        content_world: true,
        files: GMAIL_FILES,
    },
    Bundled {
        file_name: "inbox-keys-calendar.user.js",
        header: "// @name         Inbox Keys (Calendar)\n// @description  Cmd+J calendar layers, account switching and single-key navigation for Google Calendar.\n// @match        https://calendar.google.com/*\n// @run-at       document-idle\n// @noframes",
        content_world: true,
        files: CALENDAR_FILES,
    },
    Bundled {
        file_name: "inbox-keys-account-bridge.user.js",
        header: "// @name         Inbox Keys (account bridge)\n// @description  Reads the signed-in account list from the page and posts it to Inbox Keys.\n// @match        https://mail.google.com/*\n// @match        https://calendar.google.com/*\n// @run-at       document-idle\n// @noframes\n// @inject-into  page",
        content_world: false,
        files: BRIDGE_FILES,
    },
];

fn bundle_source(bundle: &Bundled) -> String {
    let mut out = format!(
        "// ==UserScript==\n{}\n// ==/UserScript==\n{MARKER}\n",
        bundle.header
    );
    out.push_str(&format!(
        "//\n// Inbox Keys, from {INBOX_KEYS_SOURCE}.\n// Butter joins the extension's content scripts into this file.\n//\n"
    ));
    for line in INBOX_KEYS_LICENSE.trim_end().lines() {
        out.push_str(format!("// {line}").trim_end());
        out.push('\n');
    }
    let mut push_file = |path: &str, source: &str| {
        out.push_str(&format!(
            "\n// ---- {path} ----\n{}\n;\n",
            source.trim_end()
        ));
    };
    if bundle.content_world {
        push_file(CHROME_SHIM.0, CHROME_SHIM.1);
        let css = serde_json::to_string(PALETTE_CSS).unwrap_or_else(|_| "\"\"".into());
        push_file("src/content/palette.css", &format!("GM_addStyle({css});"));
    }
    for (path, source) in bundle.files {
        push_file(path, &patch_vendored(path, source));
    }
    out
}

/// Butter's palette owns Cmd+K in every page, so Inbox Keys' own palette
/// (Gmail) and overlay (Calendar) move to Cmd+J. Gmail's hotkey is a setting,
/// so only its default and labels change; Calendar hard-codes it. Each entry:
/// file, text, replacement, expected count. See vendor/inbox-keys/SOURCE.md.
const HOTKEY_PATCHES: &[(&str, &str, &str, usize)] = &[
    (
        "src/content/storage.js",
        "paletteHotkey: \"mod+k\",",
        "paletteHotkey: \"mod+j\", // Butter: Cmd+K is Butter's palette.",
        1,
    ),
    (
        "src/content/hotkeys.js",
        "storage.get(\"paletteHotkey\") || \"mod+k\"",
        "storage.get(\"paletteHotkey\") || \"mod+j\"",
        1,
    ),
    (
        "src/content/palette.js",
        "keyLabel(\"Mod+K\")",
        "keyLabel(\"Mod+J\")",
        2,
    ),
    (
        "src/content/gcal-ui.js",
        "if (mod && key === \"k\") {",
        "if (mod && key === \"j\") { // Butter: Cmd+K is Butter's palette.",
        1,
    ),
];

fn patch_vendored(path: &str, source: &str) -> String {
    let mut out = source.to_string();
    for (file, from, to, _) in HOTKEY_PATCHES {
        if *file == path {
            out = out.replace(from, to);
        }
    }
    out
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if fs::read_to_string(path).is_ok_and(|existing| existing == content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    fs::write(path, content).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// Writes the bundled scripts into `dir`. Returns the names it left alone
/// because the user's copy has no marker.
fn install_into(dir: &Path) -> Result<Vec<&'static str>, String> {
    let mut kept = Vec::new();
    for bundle in BUNDLED {
        let path = dir.join(bundle.file_name);
        if let Ok(existing) = fs::read_to_string(&path) {
            if !existing.contains(MARKER) {
                kept.push(bundle.file_name);
                continue;
            }
        }
        write_if_changed(&path, &bundle_source(bundle))?;
    }
    Ok(kept)
}

pub fn install_bundled() {
    let result = userscripts_dir().and_then(|dir| install_into(&dir));
    match result {
        Ok(kept) => {
            for name in kept {
                eprintln!("[userscripts] keeping the user's own {name}");
            }
        }
        Err(err) => eprintln!("[userscripts] could not install Inbox Keys: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use regex::Regex;

    fn matches(pattern: &str, url: &str) -> bool {
        let re = Regex::new(&match_pattern_regex(pattern).unwrap()).unwrap();
        re.is_match(url.split('#').next().unwrap())
    }

    #[test]
    fn parses_headers() {
        let header = parse_header(
            "// ==UserScript==\r\n// @name   My Script\r\n// @match https://a.com/*\r\n//@match  https://b.com/x\r\n// @run-at document-start\r\n// @noframes\r\n// @grant none\r\n// ==/UserScript==\r\nalert(1)",
        )
        .unwrap();
        assert_eq!(header.name.as_deref(), Some("My Script"));
        assert_eq!(header.matches, vec!["https://a.com/*", "https://b.com/x"]);
        assert_eq!(header.run_at, RunAt::DocumentStart);
        assert!(header.no_frames);
        assert_eq!(header.inject_into, InjectInto::Content);

        let header = parse_header(
            "'use strict';\n  // ==UserScript==\n// @match <all_urls>\n// @run-at document-end\n// @inject-into page\n  // ==/UserScript==\n",
        )
        .unwrap();
        assert_eq!(header.name, None);
        assert_eq!(header.run_at, RunAt::DocumentEnd);
        assert!(!header.no_frames);
        assert_eq!(header.inject_into, InjectInto::Page);

        let header =
            parse_header("// ==UserScript==\n// @match *://x/*\n// ==/UserScript==").unwrap();
        assert_eq!(header.run_at, RunAt::DocumentIdle);

        assert!(parse_header("console.log(1)").is_none());
        assert!(parse_header("// ==UserScript==\n// @match *://x/*\n").is_none());
    }

    #[test]
    fn rejects_scripts_without_matches_or_with_bad_patterns() {
        assert!(parse_script("a.js", "nothing").is_err());
        assert!(parse_script("a.js", "// ==UserScript==\n// @name A\n// ==/UserScript==").is_err());
        assert!(parse_script(
            "a.js",
            "// ==UserScript==\n// @match mail.google.com\n// ==/UserScript=="
        )
        .is_err());
        let script = parse_script(
            "a.js",
            "// ==UserScript==\n// @match https://a.com/*\n// ==/UserScript==",
        )
        .unwrap();
        assert_eq!(script.name, "a.js");
        assert_eq!(
            script.world_name().as_deref(),
            Some("butter-userscript:a.js")
        );
    }

    #[test]
    fn matches_like_chrome() {
        let gmail = "https://mail.google.com/*";
        assert!(matches(gmail, "https://mail.google.com/mail/u/0/#inbox"));
        assert!(matches(gmail, "https://mail.google.com/"));
        assert!(!matches(gmail, "http://mail.google.com/mail/"));
        assert!(!matches(gmail, "https://calendar.google.com/calendar/r"));
        assert!(!matches(gmail, "https://mail.google.com.evil.com/"));
        assert!(!matches(
            gmail,
            "https://evil.com/?https://mail.google.com/"
        ));

        assert!(matches("*://*.google.com/*", "https://google.com/"));
        assert!(matches(
            "*://*.google.com/*",
            "http://docs.google.com/a?b=c"
        ));
        assert!(!matches("*://*.google.com/*", "https://notgoogle.com/"));
        assert!(!matches("*://*.google.com/*", "file:///google.com/"));

        assert!(matches(
            "https://example.com/foo*bar",
            "https://example.com/foo/x/bar"
        ));
        assert!(!matches(
            "https://example.com/foo*bar",
            "https://example.com/foo/x/bar/baz"
        ));
        assert!(matches(
            "https://example.com/a.html",
            "https://example.com/a.html#frag"
        ));
        assert!(!matches(
            "https://example.com/a.html",
            "https://example.com/aXhtml"
        ));
        assert!(!matches(
            "https://example.com/a.html",
            "https://example.com/a.html?q=1"
        ));

        assert!(matches("http://localhost/*", "http://localhost:5173/app"));
        assert!(matches(
            "http://localhost:5173/*",
            "http://localhost:5173/app"
        ));
        assert!(!matches(
            "http://localhost:5173/*",
            "http://localhost:8080/app"
        ));
        assert!(matches("*://*/*", "https://anything.dev/x"));
        assert!(matches(
            "HTTPS://Mail.Google.com/*",
            "https://mail.google.com/x"
        ));

        assert!(matches("file:///Users/*", "file:///Users/me/a.html"));
        assert!(matches("<all_urls>", "https://a.com/"));
        assert!(matches("<all_urls>", "file:///tmp/x"));
        assert!(!matches("<all_urls>", "about:blank"));
        assert!(!matches("*://*/*", "about:blank"));

        for bad in [
            "mail.google.com/*",
            "https://mail.google.com",
            "chrome://x/*",
            "https://ma*il.com/*",
            "https://*./*",
            "file://host/x",
        ] {
            assert!(
                match_pattern_regex(bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn loads_js_files_in_name_order() {
        let dir =
            std::env::temp_dir().join(format!("butter-userscripts-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let ok = "// ==UserScript==\n// @match https://a.com/*\n// ==/UserScript==\n";
        fs::write(dir.join("b.js"), ok).unwrap();
        fs::write(dir.join("a.user.js"), ok).unwrap();
        fs::write(dir.join("no-header.js"), "x").unwrap();
        fs::write(dir.join("notes.txt"), ok).unwrap();
        fs::write(dir.join(".hidden.js"), ok).unwrap();
        let names: Vec<_> = load_from(&dir).into_iter().map(|s| s.file_name).collect();
        assert_eq!(names, vec!["a.user.js", "b.js"]);
        assert!(load_from(&dir.join("missing")).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn injection_source_wraps_the_script() {
        let script = parse_script(
            "x.js",
            "// ==UserScript==\n// @name X\n// @match https://a.com/*\n// ==/UserScript==\nconsole.log('hi') // no newline",
        )
        .unwrap();
        let source = injection_source(&script);
        assert!(source.starts_with(SOURCE_PREFIX));
        assert!(source.contains(r#"["^https://a\\.com(?::[0-9]+)?/.*$"]"#));
        assert!(source.contains("console.log('hi') // no newline\n"));
        assert!(source.contains("DOMContentLoaded"));
    }

    #[test]
    fn inbox_keys_hotkeys_move_to_cmd_j() {
        for (file, from, to, count) in HOTKEY_PATCHES {
            let (_, original) = GMAIL_FILES
                .iter()
                .chain(CALENDAR_FILES)
                .find(|(path, _)| path == file)
                .unwrap();
            assert_eq!(
                original.matches(from).count(),
                *count,
                "{file}: the Cmd+J patch no longer applies; update HOTKEY_PATCHES"
            );
            let patched = patch_vendored(file, original);
            assert_eq!(patched.matches(to).count(), *count);
            assert!(!patched.contains(from));
        }
    }

    #[test]
    fn bundled_scripts_parse_and_install_like_the_skill() {
        for bundle in BUNDLED {
            let source = bundle_source(bundle);
            let script = parse_script(bundle.file_name, &source).unwrap();
            assert!(script.no_frames);
            assert!(source.contains(MARKER));
            assert!(source.contains("Copyright (c) 2026 Hadi Javeed"));
            assert_eq!(
                script.inject_into == InjectInto::Content,
                bundle.content_world
            );
            if bundle.content_world {
                assert!(source.contains("var chrome = (function"));
                assert!(source.contains("butter:inboxkeys-request"));
                assert!(!source.contains("mod+k") && !source.contains("Mod+K"));
                assert!(source.contains("GM_addStyle(\""));
                assert!(source.contains("InboxKeys.storage = storage"));
            } else {
                assert!(!source.contains("var chrome"));
                assert!(source.contains("__inboxkeys: \"accounts\""));
            }
        }

        let dir = std::env::temp_dir().join(format!(
            "butter-userscripts-install-{}",
            uuid::Uuid::new_v4()
        ));
        assert!(install_into(&dir).unwrap().is_empty());
        let main = dir.join("inbox-keys.user.js");
        let installed = fs::read_to_string(&main).unwrap();
        assert_eq!(load_from(&dir).len(), BUNDLED.len());

        // An older Butter's copy is replaced.
        fs::write(&main, format!("old\n{MARKER}\n")).unwrap();
        assert!(install_into(&dir).unwrap().is_empty());
        assert_eq!(fs::read_to_string(&main).unwrap(), installed);

        // The user's own copy (no marker) is kept, even an empty one.
        fs::write(&main, "").unwrap();
        assert_eq!(install_into(&dir).unwrap(), vec!["inbox-keys.user.js"]);
        assert_eq!(fs::read_to_string(&main).unwrap(), "");

        let _ = fs::remove_dir_all(&dir);
    }
}
