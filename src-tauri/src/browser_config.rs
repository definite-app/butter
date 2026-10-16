//! `<config dir>/browser.toml`: named browser profiles, pinned web apps and
//! URL palette commands. Kept out of `config.toml` because saving settings
//! from the UI rewrites that file and drops sections `Config` doesn't know.
//!
//! ```toml
//! [[profile]]
//! id = "work"
//! name = "Work"
//! color = "#7aa2f7"
//!
//! [[app]]
//! id = "gmail"
//! name = "Gmail"
//! url = "https://mail.google.com/mail/u/0/"
//! profile = "work"
//!
//! [[command]]
//! name = "Gmail: Search"
//! url = "#search/{query}"
//! match = "https://mail.google.com/*"
//! ```
//!
//! A `default` profile always exists. Every profile, `default` included, gets
//! its own WebKit data store, derived from a hash of its id, so Butter's own
//! UI (which uses WebKit's default store) never shares cookies or storage
//! with a browser pane.
//!
//! The file is read again whenever its mtime changes (`current`), so edits
//! apply without a restart. Butter's own edits (create/rename a profile) go
//! through `toml_edit`, which keeps the user's comments and other entries.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

pub const DEFAULT_PROFILE_ID: &str = "default";
const DEFAULT_PROFILE_NAME: &str = "Default";
const DEFAULT_PROFILE_COLOR: &str = "#F5D76E";
/// Colors handed to new profiles, in turn. Muted, so they sit well on the
/// warm dark sidebar.
const PROFILE_PALETTE: &[&str] = &[
    "#7AA2F7", "#9ECE6A", "#E0AF68", "#BB9AF7", "#F7768E", "#7DCFFF", "#C0CAF5",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub id: String,
    pub name: String,
    pub color: String,
    /// Whether browser.toml has a `[[profile]]` for it (`default` may not).
    pub defined: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserApp {
    pub id: String,
    pub name: String,
    pub url: String,
    /// Always a known profile id (unknown ones resolve to `default`).
    pub profile: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCommand {
    pub name: String,
    pub url: String,
    /// The Chrome match pattern as written, if any.
    #[serde(rename = "match")]
    pub match_pattern: Option<String>,
    /// `match_pattern` as a regex over the URL without its `#fragment`
    /// (JavaScript and Rust read it the same way).
    pub match_regex: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConfig {
    pub path: String,
    pub profiles: Vec<BrowserProfile>,
    pub apps: Vec<BrowserApp>,
    pub commands: Vec<BrowserCommand>,
    /// Problems found while reading the file: entries skipped and why.
    pub errors: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawFile {
    #[serde(default)]
    profile: Vec<RawProfile>,
    #[serde(default)]
    app: Vec<RawApp>,
    #[serde(default)]
    command: Vec<RawCommand>,
}

#[derive(Debug, Default, Deserialize)]
struct RawProfile {
    id: Option<String>,
    name: Option<String>,
    color: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawApp {
    id: Option<String>,
    name: Option<String>,
    url: Option<String>,
    profile: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawCommand {
    name: Option<String>,
    url: Option<String>,
    #[serde(rename = "match")]
    match_pattern: Option<String>,
}

/// Profile and app ids end up in WebKit store hashes, webview labels
/// (`browser-app:<id>`) and URLs, so keep them plain.
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn is_hex_color(value: &str) -> bool {
    let hex = value.strip_prefix('#').unwrap_or("");
    matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

fn palette_color(index: usize) -> String {
    PROFILE_PALETTE[index % PROFILE_PALETTE.len()].to_string()
}

/// Parses browser.toml text. Never fails: a broken file yields the built-in
/// `default` profile and an error line.
pub fn parse(text: &str, path: &str) -> BrowserConfig {
    let mut errors = Vec::new();
    let raw: RawFile = match toml::from_str(text) {
        Ok(raw) => raw,
        Err(err) => {
            errors.push(format!("browser.toml could not be read: {err}"));
            RawFile::default()
        }
    };

    let mut profiles: Vec<BrowserProfile> = Vec::new();
    for (index, entry) in raw.profile.into_iter().enumerate() {
        let Some(id) = non_empty(entry.id) else {
            errors.push(format!("[[profile]] #{} has no id", index + 1));
            continue;
        };
        if !is_valid_id(&id) {
            errors.push(format!(
                "profile id {id:?} may only use letters, digits, - and _"
            ));
            continue;
        }
        if profiles.iter().any(|p| p.id == id) {
            errors.push(format!(
                "profile {id:?} is defined twice; the first one wins"
            ));
            continue;
        }
        let color = match non_empty(entry.color) {
            Some(color) if is_hex_color(&color) => color,
            Some(color) => {
                errors.push(format!(
                    "profile {id:?}: color {color:?} is not a hex color like \"#7aa2f7\""
                ));
                palette_color(profiles.len())
            }
            None if id == DEFAULT_PROFILE_ID => DEFAULT_PROFILE_COLOR.to_string(),
            None => palette_color(profiles.len()),
        };
        let name = non_empty(entry.name).unwrap_or_else(|| {
            if id == DEFAULT_PROFILE_ID {
                DEFAULT_PROFILE_NAME.to_string()
            } else {
                id.clone()
            }
        });
        profiles.push(BrowserProfile {
            id,
            name,
            color,
            defined: true,
        });
    }
    if let Some(index) = profiles.iter().position(|p| p.id == DEFAULT_PROFILE_ID) {
        let default = profiles.remove(index);
        profiles.insert(0, default);
    } else {
        profiles.insert(
            0,
            BrowserProfile {
                id: DEFAULT_PROFILE_ID.to_string(),
                name: DEFAULT_PROFILE_NAME.to_string(),
                color: DEFAULT_PROFILE_COLOR.to_string(),
                defined: false,
            },
        );
    }

    let mut apps: Vec<BrowserApp> = Vec::new();
    for (index, entry) in raw.app.into_iter().enumerate() {
        let Some(id) = non_empty(entry.id) else {
            errors.push(format!("[[app]] #{} has no id", index + 1));
            continue;
        };
        if !is_valid_id(&id) {
            errors.push(format!(
                "app id {id:?} may only use letters, digits, - and _"
            ));
            continue;
        }
        if apps.iter().any(|a| a.id == id) {
            errors.push(format!("app {id:?} is defined twice; the first one wins"));
            continue;
        }
        let Some(url) = non_empty(entry.url) else {
            errors.push(format!("app {id:?} has no url"));
            continue;
        };
        if !is_http_url(&url) {
            errors.push(format!(
                "app {id:?}: url must start with http:// or https://"
            ));
            continue;
        }
        let requested = non_empty(entry.profile);
        let profile = resolve_profile_in(&profiles, requested.as_deref());
        if let Some(requested) = requested.filter(|r| *r != profile) {
            errors.push(format!(
                "app {id:?} uses profile {requested:?}, which isn't defined; using \"default\""
            ));
        }
        let name = non_empty(entry.name).unwrap_or_else(|| id.clone());
        apps.push(BrowserApp {
            id,
            name,
            url,
            profile,
        });
    }

    let mut commands = Vec::new();
    for (index, entry) in raw.command.into_iter().enumerate() {
        let Some(name) = non_empty(entry.name) else {
            errors.push(format!("[[command]] #{} has no name", index + 1));
            continue;
        };
        let Some(url) = non_empty(entry.url) else {
            errors.push(format!("command {name:?} has no url"));
            continue;
        };
        let match_pattern = non_empty(entry.match_pattern);
        let match_regex = match match_pattern.as_deref() {
            Some(pattern) => match crate::userscripts::match_pattern_regex(pattern) {
                Ok(regex) => Some(regex),
                Err(err) => {
                    errors.push(format!("command {name:?}: bad match pattern: {err}"));
                    continue;
                }
            },
            None => None,
        };
        commands.push(BrowserCommand {
            name,
            url,
            match_pattern,
            match_regex,
        });
    }

    BrowserConfig {
        path: path.to_string(),
        profiles,
        apps,
        commands,
        errors,
    }
}

fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn resolve_profile_in(profiles: &[BrowserProfile], requested: Option<&str>) -> String {
    let requested = requested.map(str::trim).unwrap_or("");
    if profiles.iter().any(|p| p.id == requested) {
        requested.to_string()
    } else {
        DEFAULT_PROFILE_ID.to_string()
    }
}

impl BrowserConfig {
    /// The profile a pane uses for `requested` (a preset's `browser_profile`,
    /// an app's `profile`, `butter-browser open --profile`): that profile when
    /// browser.toml knows it, otherwise `default`.
    pub fn resolve_profile(&self, requested: Option<&str>) -> String {
        resolve_profile_in(&self.profiles, requested)
    }

    /// Commands to show for a page: the ones whose `match` covers `url`
    /// (fragment ignored), then the global ones (no `match`).
    #[cfg(test)]
    fn commands_for_url(&self, url: Option<&str>) -> (Vec<&BrowserCommand>, Vec<&BrowserCommand>) {
        let page = url.map(|u| u.split('#').next().unwrap_or(u));
        let mut matched = Vec::new();
        let mut global = Vec::new();
        for command in &self.commands {
            match (&command.match_regex, page) {
                (None, _) => global.push(command),
                (Some(regex), Some(page)) => {
                    if regex::Regex::new(regex).is_ok_and(|re| re.is_match(page)) {
                        matched.push(command);
                    }
                }
                (Some(_), None) => {}
            }
        }
        (matched, global)
    }
}

/// 16 bytes for `WebviewBuilder::data_store_identifier`, stable across
/// launches. Depends only on the profile id.
pub fn data_store_identifier(profile_id: &str) -> [u8; 16] {
    let key = format!("butter-browser-profile:{profile_id}");
    let first = fnv1a64(key.as_bytes(), 0xcbf29ce484222325);
    let second = fnv1a64(key.as_bytes(), 0x84222325cbf29ce4);
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&first.to_be_bytes());
    bytes[8..].copy_from_slice(&second.to_be_bytes());
    bytes
}

fn fnv1a64(bytes: &[u8], seed: u64) -> u64 {
    let mut hash = seed;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

// ---- The file ---------------------------------------------------------------

pub fn browser_toml_path() -> Result<PathBuf, String> {
    Ok(crate::paths::butter_config_dir()?.join("browser.toml"))
}

const DEFAULT_FILE: &str = r##"# Butter browser settings: profiles, pinned web apps and palette commands.
# Butter reads this file again when you open the command palette (Cmd+K) or
# come back to the window, so edits apply without a restart.

# ---- Profiles ----------------------------------------------------------------
# Each profile keeps its own cookies, logins and site storage. A "default"
# profile always exists, even when it isn't listed here. A preset picks one with
# `browser_profile = "work"` in config.toml; otherwise its pane uses "default".
# Switch a pane's profile from the chip in the browser pane's footer.
#
# [[profile]]
# id = "work"
# name = "Work"
# color = "#7aa2f7"

# ---- Pinned web apps ---------------------------------------------------------
# Shown at the top of the sidebar and in Cmd+K as "Open <name>". An app opens
# full-window and stays loaded when you switch away.
#
# [[app]]
# id = "gmail"
# name = "Gmail"
# url = "https://mail.google.com/mail/u/0/"
# profile = "default"
#
# [[app]]
# id = "calendar"
# name = "Calendar"
# url = "https://calendar.google.com/calendar/u/0/r"
# profile = "default"

# ---- Palette commands --------------------------------------------------------
# A command opens a URL in the active browser (or a new pane). The url can be
# absolute or relative to the current page, like "#inbox". "{query}" in the url
# makes the palette ask for text first (press Tab or Enter on the command).
# With `match` (a Chrome match pattern) the command shows only while the active
# browser is on a matching page, listed first.
#
# [[command]]
# name = "Gmail: Unread in inbox"
# url = "#search/in:inbox is:unread"
# match = "https://mail.google.com/*"
#
# [[command]]
# name = "Gmail: Search"
# url = "#search/{query}"
# match = "https://mail.google.com/*"
"##;

/// Writes the commented example file when there's none. Never overwrites.
pub fn ensure_default_file() {
    let Ok(path) = browser_toml_path() else {
        return;
    };
    if let Err(err) = ensure_default_file_at(&path) {
        eprintln!("[browser.toml] {err}");
    }
}

fn ensure_default_file_at(path: &Path) -> Result<bool, String> {
    if path.exists() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    // create_new: a file that appeared in the meantime is left alone.
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(DEFAULT_FILE.as_bytes())
                .map_err(|e| format!("could not write {}: {e}", path.display()))?;
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(format!("could not create {}: {err}", path.display())),
    }
}

struct Cached {
    mtime: Option<SystemTime>,
    config: BrowserConfig,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

fn load_at(path: &Path) -> BrowserConfig {
    let display = path.to_string_lossy();
    match fs::read_to_string(path) {
        Ok(text) => parse(&text, &display),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => parse("", &display),
        Err(err) => {
            let mut config = parse("", &display);
            config
                .errors
                .push(format!("could not read {}: {err}", path.display()));
            config
        }
    }
}

/// The parsed file, re-read when its mtime changed since the last call.
pub fn current() -> BrowserConfig {
    let Ok(path) = browser_toml_path() else {
        return parse("", "browser.toml");
    };
    let mtime = fs::metadata(&path).and_then(|m| m.modified()).ok();
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cached) = cache.as_ref() {
        if cached.mtime == mtime && mtime.is_some() {
            return cached.config.clone();
        }
    }
    let config = load_at(&path);
    *cache = Some(Cached {
        mtime,
        config: config.clone(),
    });
    config
}

fn invalidate_cache() {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = None;
    }
}

// ---- Edits (keep the user's comments and other entries) ---------------------

fn read_document(path: &Path) -> Result<toml_edit::Document, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(format!("could not read {}: {err}", path.display())),
    };
    text.parse::<toml_edit::Document>()
        .map_err(|e| format!("browser.toml has a syntax error, fix it first: {e}"))
}

fn write_document(path: &Path, doc: &toml_edit::Document) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    fs::write(path, doc.to_string())
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    invalidate_cache();
    Ok(())
}

fn profile_tables(doc: &mut toml_edit::Document) -> Result<&mut toml_edit::ArrayOfTables, String> {
    if doc.get("profile").is_none() {
        doc.insert(
            "profile",
            toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new()),
        );
    }
    doc.get_mut("profile")
        .and_then(|item| item.as_array_of_tables_mut())
        .ok_or_else(|| "browser.toml: `profile` must be a list of [[profile]] tables".to_string())
}

/// A free id derived from `name`: "Side Project" -> "side-project", then
/// "side-project-2", ...
pub fn slug_for(name: &str, taken: &[String]) -> String {
    let mut slug = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    let mut base: String = slug.chars().take(48).collect();
    if base.is_empty() {
        base = "profile".to_string();
    }
    if !taken.iter().any(|t| *t == base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !taken.iter().any(|t| t == candidate))
        .unwrap_or(base)
}

fn create_profile_at(
    path: &Path,
    name: &str,
    color: Option<&str>,
) -> Result<BrowserProfile, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the profile a name".to_string());
    }
    let existing = load_at(path);
    let taken: Vec<String> = existing.profiles.iter().map(|p| p.id.clone()).collect();
    let id = slug_for(name, &taken);
    let color = match color.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) if is_hex_color(c) => c.to_string(),
        Some(c) => return Err(format!("{c:?} is not a hex color like \"#7aa2f7\"")),
        None => palette_color(existing.profiles.len().saturating_sub(1)),
    };
    let mut doc = read_document(path)?;
    let tables = profile_tables(&mut doc)?;
    let mut table = toml_edit::Table::new();
    table.insert("id", toml_edit::value(id.clone()));
    table.insert("name", toml_edit::value(name));
    table.insert("color", toml_edit::value(color.clone()));
    tables.push(table);
    write_document(path, &doc)?;
    Ok(BrowserProfile {
        id,
        name: name.to_string(),
        color,
        defined: true,
    })
}

fn update_profile_at(
    path: &Path,
    id: &str,
    name: Option<&str>,
    color: Option<&str>,
) -> Result<(), String> {
    let name = name.map(str::trim).filter(|n| !n.is_empty());
    let color = color.map(str::trim).filter(|c| !c.is_empty());
    if let Some(c) = color {
        if !is_hex_color(c) {
            return Err(format!("{c:?} is not a hex color like \"#7aa2f7\""));
        }
    }
    let existing = load_at(path);
    let Some(profile) = existing.profiles.iter().find(|p| p.id == id) else {
        return Err(format!("No profile {id:?}"));
    };
    let mut doc = read_document(path)?;
    let tables = profile_tables(&mut doc)?;
    let found = tables
        .iter_mut()
        .find(|t| t.get("id").and_then(|v| v.as_str()).map(str::trim) == Some(id));
    match found {
        Some(table) => {
            if let Some(name) = name {
                table.insert("name", toml_edit::value(name));
            }
            if let Some(color) = color {
                table.insert("color", toml_edit::value(color));
            }
        }
        None => {
            // `default` without a [[profile]] entry yet.
            let mut table = toml_edit::Table::new();
            table.insert("id", toml_edit::value(id));
            table.insert("name", toml_edit::value(name.unwrap_or(&profile.name)));
            table.insert("color", toml_edit::value(color.unwrap_or(&profile.color)));
            tables.push(table);
        }
    }
    write_document(path, &doc)
}

pub fn create_profile(name: &str, color: Option<&str>) -> Result<BrowserProfile, String> {
    create_profile_at(&browser_toml_path()?, name, color)
}

pub fn update_profile(id: &str, name: Option<&str>, color: Option<&str>) -> Result<(), String> {
    update_profile_at(&browser_toml_path()?, id, name, color)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "butter-browser-toml-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("browser.toml")
    }

    #[test]
    fn empty_file_has_only_default() {
        let config = parse("", "x");
        assert_eq!(config.profiles.len(), 1);
        assert_eq!(config.profiles[0].id, "default");
        assert!(!config.profiles[0].defined);
        assert!(config.apps.is_empty() && config.commands.is_empty());
        assert!(config.errors.is_empty());
    }

    #[test]
    fn parses_profiles_apps_and_commands() {
        let config = parse(
            r##"
# a comment
[[profile]]
id = "work"
name = "Work"
color = "#7aa2f7"

[[profile]]
id = "default"
name = "Personal"

[[app]]
id = "gmail"
name = "Gmail"
url = "https://mail.google.com/mail/u/0/"
profile = "work"

[[app]]
id = "cal"
url = "https://calendar.google.com/"
profile = "nope"

[[command]]
name = "Unread"
url = "#search/in:inbox is:unread"
match = "https://mail.google.com/*"

[[command]]
name = "HN"
url = "https://news.ycombinator.com/"
"##,
            "x",
        );
        let ids: Vec<_> = config.profiles.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["default", "work"], "default is always first");
        assert_eq!(config.profiles[0].name, "Personal");
        assert_eq!(config.profiles[0].color, DEFAULT_PROFILE_COLOR);
        assert!(config.profiles[0].defined);
        assert_eq!(config.profiles[1].color, "#7aa2f7");

        assert_eq!(config.apps.len(), 2);
        assert_eq!(config.apps[0].profile, "work");
        assert_eq!(config.apps[1].name, "cal");
        assert_eq!(config.apps[1].profile, "default");
        assert!(config.errors.iter().any(|e| e.contains("\"nope\"")));

        assert_eq!(config.commands.len(), 2);
        assert_eq!(
            config.commands[0].match_regex.as_deref(),
            Some("^https://mail\\.google\\.com(?::[0-9]+)?/.*$")
        );
        assert_eq!(config.commands[1].match_regex, None);
    }

    #[test]
    fn skips_bad_entries_with_errors() {
        let config = parse(
            r##"
[[profile]]
name = "No id"
[[profile]]
id = "has space"
[[profile]]
id = "dup"
[[profile]]
id = "dup"
color = "blue"
[[app]]
id = "x"
url = "mail.google.com"
[[app]]
id = "y"
[[command]]
name = "bad"
url = "#x"
match = "mail.google.com/*"
[[command]]
url = "#x"
"##,
            "x",
        );
        assert_eq!(config.profiles.len(), 2);
        assert!(config.apps.is_empty());
        assert!(config.commands.is_empty());
        assert_eq!(config.errors.len(), 7, "{:#?}", config.errors);
    }

    #[test]
    fn syntax_error_still_gives_default() {
        let config = parse("[[profile]\nid=", "x");
        assert_eq!(config.profiles.len(), 1);
        assert_eq!(config.errors.len(), 1);
    }

    #[test]
    fn resolves_profiles() {
        let config = parse("[[profile]]\nid = \"work\"\n", "x");
        assert_eq!(config.resolve_profile(Some("work")), "work");
        assert_eq!(config.resolve_profile(Some(" work ")), "work");
        assert_eq!(config.resolve_profile(Some("default")), "default");
        assert_eq!(config.resolve_profile(Some("missing")), "default");
        assert_eq!(config.resolve_profile(Some("")), "default");
        assert_eq!(config.resolve_profile(None), "default");
    }

    #[test]
    fn data_store_identifiers_are_stable_and_distinct() {
        let default = data_store_identifier("default");
        assert_eq!(default, data_store_identifier("default"));
        assert_ne!(default, data_store_identifier("work"));
        assert_ne!(default, [0u8; 16], "WebKit rejects an all-zero identifier");
        // Pinned, so a change can't silently orphan every profile's logins.
        assert_eq!(
            default,
            [80, 138, 160, 21, 186, 16, 148, 209, 34, 12, 165, 151, 74, 148, 8, 56]
        );
    }

    #[test]
    fn filters_commands_by_match() {
        let config = parse(
            r##"
[[command]]
name = "Gmail unread"
url = "#search/is:unread"
match = "https://mail.google.com/*"
[[command]]
name = "Any google"
url = "/"
match = "https://*.google.com/*"
[[command]]
name = "Bookmark"
url = "https://example.com/"
"##,
            "x",
        );
        let names = |list: Vec<&BrowserCommand>| {
            list.into_iter().map(|c| c.name.clone()).collect::<Vec<_>>()
        };

        let (matched, global) =
            config.commands_for_url(Some("https://mail.google.com/mail/u/0/#inbox"));
        assert_eq!(names(matched), vec!["Gmail unread", "Any google"]);
        assert_eq!(names(global), vec!["Bookmark"]);

        let (matched, _) = config.commands_for_url(Some("https://calendar.google.com/r"));
        assert_eq!(names(matched), vec!["Any google"]);

        let (matched, _) =
            config.commands_for_url(Some("https://example.com/#https://mail.google.com/"));
        assert!(matched.is_empty(), "the fragment is ignored");

        let (matched, global) = config.commands_for_url(None);
        assert!(matched.is_empty());
        assert_eq!(global.len(), 1);
    }

    #[test]
    fn default_file_is_written_once_and_parses_clean() {
        let path = temp_path("default");
        assert!(ensure_default_file_at(&path).unwrap());
        let config = load_at(&path);
        assert!(config.errors.is_empty(), "{:?}", config.errors);
        assert_eq!(config.profiles.len(), 1, "examples are commented out");
        assert!(config.apps.is_empty());

        fs::write(&path, "# mine\n").unwrap();
        assert!(!ensure_default_file_at(&path).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "# mine\n");

        // The commented examples are valid once uncommented.
        let uncommented: String = DEFAULT_FILE
            .lines()
            .map(|line| match line.strip_prefix("# ") {
                Some(rest)
                    if rest.starts_with("[[")
                        || rest.split_once(" = ").is_some_and(|(key, _)| {
                            !key.is_empty() && key.chars().all(|c| c.is_ascii_lowercase())
                        }) =>
                {
                    rest
                }
                _ => line,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let config = parse(&uncommented, "x");
        assert!(config.errors.is_empty(), "{:?}", config.errors);
        assert_eq!(config.apps.len(), 2);
        assert_eq!(config.apps[0].url, "https://mail.google.com/mail/u/0/");
        assert_eq!(config.commands.len(), 2);
        assert_eq!(config.profiles.len(), 2);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn create_and_rename_keep_comments_and_entries() {
        let path = temp_path("edit");
        let original = "# my notes\n\n[[app]]\nid = \"gmail\" # inline\nurl = \"https://mail.google.com/\"\n\n[[profile]]\nid = \"work\"\nname = \"Work\"\n";
        fs::write(&path, original).unwrap();

        let created = create_profile_at(&path, "Side Project!", None).unwrap();
        assert_eq!(created.id, "side-project");
        let again = create_profile_at(&path, "side project", Some("#abcdef")).unwrap();
        assert_eq!(again.id, "side-project-2");
        assert!(create_profile_at(&path, "  ", None).is_err());
        assert!(create_profile_at(&path, "x", Some("red")).is_err());

        update_profile_at(&path, "work", Some("Day job"), Some("#123456")).unwrap();
        update_profile_at(&path, "default", Some("Personal"), None).unwrap();
        assert!(update_profile_at(&path, "missing", Some("x"), None).is_err());

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("# my notes\n"), "{text}");
        assert!(text.contains("id = \"gmail\" # inline"), "{text}");

        let config = load_at(&path);
        assert!(config.errors.is_empty(), "{:?}", config.errors);
        let summary: Vec<_> = config
            .profiles
            .iter()
            .map(|p| (p.id.as_str(), p.name.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("default", "Personal"),
                ("work", "Day job"),
                ("side-project", "Side Project!"),
                ("side-project-2", "side project"),
            ]
        );
        assert_eq!(config.profiles[1].color, "#123456");
        assert_eq!(config.profiles[3].color, "#abcdef");
        assert_eq!(config.apps.len(), 1);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn slugs() {
        assert_eq!(slug_for("Work", &[]), "work");
        assert_eq!(slug_for("  Côte d'Azur ", &[]), "c-te-d-azur");
        assert_eq!(slug_for("!!!", &[]), "profile");
        assert_eq!(
            slug_for("work", &["work".into(), "work-2".into()]),
            "work-3"
        );
    }
}
