//! Composer dock backend: per-session draft files, sent-draft history,
//! Claude Code skill/command discovery, the optional TypeSafe Jev ranker and
//! the Wispr Flow dictation trigger.
//!
//! Drafts live under the flavor's data dir (`~/.butter/drafts` or
//! `~/.butter-dev/drafts`):
//! - `<drafts>/<session-title>-<MMDD-HHMM>.md`  the live draft for a session
//! - `<drafts>/index.json`                      session id -> live draft file name
//! - `<drafts>/sent/<file>.md`                  drafts moved here once sent
//! - `<drafts>/history.jsonl`                   one line per sent draft

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const HISTORY_FILE: &str = "history.jsonl";
const INDEX_FILE: &str = "index.json";
const SENT_DIR: &str = "sent";
const MAX_TITLE_SLUG: usize = 48;
const MAX_HISTORY_RETURNED: usize = 500;
const MAX_ACTION_DESCRIPTION: usize = 200;

// ---------------------------------------------------------------------------
// Paths and naming (pure helpers are unit tested below)
// ---------------------------------------------------------------------------

pub fn drafts_dir() -> Result<PathBuf, String> {
    Ok(crate::paths::butter_home()?.join("drafts"))
}

/// File-name-safe slug of a session title: keeps letters, digits, `.`, `_`
/// and `-`, turns every other run of characters into one `-`, and caps the
/// length. Never empty.
pub fn title_slug(title: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in title.trim().chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '.' {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch);
        } else {
            pending_dash = true;
        }
        if out.chars().count() >= MAX_TITLE_SLUG {
            break;
        }
    }
    let out = out.trim_matches(|c| c == '.' || c == '-').to_string();
    if out.is_empty() {
        "session".to_string()
    } else {
        out
    }
}

/// `<title-slug>-<MMDD-HHMM>.md`
pub fn draft_file_name(title: &str, at: &chrono::NaiveDateTime) -> String {
    format!("{}-{}.md", title_slug(title), at.format("%m%d-%H%M"))
}

/// First free path for `name` in `dir`: `name`, then `stem-2.md`, `stem-3.md`, ...
pub fn unique_path_in(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem.to_string(), format!(".{ext}")),
        None => (name.to_string(), String::new()),
    };
    for n in 2..10_000 {
        let candidate = dir.join(format!("{stem}-{n}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}{ext}", uuid::Uuid::new_v4()))
}

fn read_index(dir: &Path) -> HashMap<String, String> {
    fs::read_to_string(dir.join(INDEX_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_index(dir: &Path, index: &HashMap<String, String>) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{INDEX_FILE}.tmp"));
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(INDEX_FILE)).map_err(|e| e.to_string())
}

/// Only plain file names from the index are trusted (no separators, no `..`).
fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && name != "."
        && name != ".."
        && !name.starts_with('.')
}

/// Resolve (and, when `allocate`, create an index entry for) the live draft
/// file of `session_id` inside `dir`.
fn resolve_draft_path(
    dir: &Path,
    session_id: &str,
    title: &str,
    allocate: bool,
    now: &chrono::NaiveDateTime,
) -> Result<Option<PathBuf>, String> {
    let mut index = read_index(dir);
    if let Some(name) = index.get(session_id) {
        if is_plain_file_name(name) {
            return Ok(Some(dir.join(name)));
        }
    }
    if !allocate {
        return Ok(None);
    }
    let path = unique_path_in(dir, &draft_file_name(title, now));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "invalid draft path".to_string())?;
    index.insert(session_id.to_string(), name);
    write_index(dir, &index)?;
    Ok(Some(path))
}

// ---------------------------------------------------------------------------
// Drafts + history
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftState {
    pub path: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryEntry {
    pub session_id: String,
    pub session_title: String,
    pub text: String,
    /// Unix milliseconds.
    pub sent_at: i64,
    pub path: String,
}

fn now_local() -> chrono::NaiveDateTime {
    chrono::Local::now().naive_local()
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))
}

pub fn load_draft_in(dir: &Path, session_id: &str, title: &str) -> Result<DraftState, String> {
    ensure_dir(dir)?;
    let path = resolve_draft_path(dir, session_id, title, true, &now_local())?
        .ok_or_else(|| "could not allocate draft".to_string())?;
    let text = fs::read_to_string(&path).unwrap_or_default();
    Ok(DraftState {
        path: path.to_string_lossy().to_string(),
        text,
    })
}

pub fn save_draft_in(dir: &Path, session_id: &str, title: &str, text: &str) -> Result<String, String> {
    ensure_dir(dir)?;
    let path = resolve_draft_path(dir, session_id, title, true, &now_local())?
        .ok_or_else(|| "could not allocate draft".to_string())?;
    fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

/// Record a sent draft: move the draft file into `sent/`, append a history
/// line, and drop the session's index entry so the next draft gets a fresh
/// timestamped file.
pub fn record_sent_in(
    dir: &Path,
    session_id: &str,
    title: &str,
    text: &str,
    sent_at_ms: i64,
) -> Result<HistoryEntry, String> {
    ensure_dir(dir)?;
    let sent_dir = dir.join(SENT_DIR);
    ensure_dir(&sent_dir)?;
    let now = now_local();
    let live = resolve_draft_path(dir, session_id, title, false, &now)?;
    let file_name = live
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| draft_file_name(title, &now));
    let dest = unique_path_in(&sent_dir, &file_name);
    // The sent file always holds exactly what was sent.
    fs::write(&dest, text).map_err(|e| format!("write {}: {e}", dest.display()))?;
    if let Some(live) = live {
        let _ = fs::remove_file(live);
    }
    let mut index = read_index(dir);
    if index.remove(session_id).is_some() {
        write_index(dir, &index)?;
    }
    let entry = HistoryEntry {
        session_id: session_id.to_string(),
        session_title: title.to_string(),
        text: text.to_string(),
        sent_at: sent_at_ms,
        path: dest.to_string_lossy().to_string(),
    };
    let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(HISTORY_FILE))
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    Ok(entry)
}

/// Newest first, at most `limit` entries. Bad lines are skipped.
pub fn read_history_in(dir: &Path, limit: usize) -> Vec<HistoryEntry> {
    let Ok(raw) = fs::read_to_string(dir.join(HISTORY_FILE)) else {
        return Vec::new();
    };
    raw.lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<HistoryEntry>(line).ok())
        .take(limit)
        .collect()
}

#[tauri::command]
pub fn composer_load_draft(session_id: String, title: String) -> Result<DraftState, String> {
    load_draft_in(&drafts_dir()?, &session_id, &title)
}

#[tauri::command]
pub fn composer_save_draft(session_id: String, title: String, text: String) -> Result<String, String> {
    save_draft_in(&drafts_dir()?, &session_id, &title, &text)
}

#[tauri::command]
pub fn composer_record_sent(
    session_id: String,
    title: String,
    text: String,
) -> Result<HistoryEntry, String> {
    let sent_at = chrono::Utc::now().timestamp_millis();
    record_sent_in(&drafts_dir()?, &session_id, &title, &text, sent_at)
}

#[tauri::command]
pub fn composer_history(limit: Option<usize>) -> Result<Vec<HistoryEntry>, String> {
    let limit = limit.unwrap_or(MAX_HISTORY_RETURNED).min(MAX_HISTORY_RETURNED);
    Ok(read_history_in(&drafts_dir()?, limit))
}

// ---------------------------------------------------------------------------
// Actions: skills / slash commands for Claude Code and Codex
// ---------------------------------------------------------------------------
//
// Claude Code: `/name` for user/project skills and commands
//   (~/.claude/skills, <project>/.claude/skills, */.claude/commands/**.md;
//   nested command dirs become `dir:name`) and `/plugin:name` for skills and
//   commands of enabled plugins (~/.claude/plugins/installed_plugins.json).
// Codex: `$name` for skills (~/.codex/skills incl. `.system`,
//   <project>/.codex/skills, <project>/.agents/skills) and `/prompts:name`
//   for legacy custom prompts (~/.codex/prompts/*.md).

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Harness {
    Claude,
    Codex,
}

impl Harness {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    Skill,
    Command,
    Prompt,
}

impl ActionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Skill => "skill",
            Self::Command => "command",
            Self::Prompt => "prompt",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComposerAction {
    /// Skill / command name (without sigil or plugin prefix).
    pub name: String,
    /// Exact text to insert, e.g. `/mna`, `/typesafe:typesafe-ai`, `$buckit`.
    pub invoke: String,
    pub description: String,
    /// "skill" | "command" | "prompt"
    pub kind: String,
    /// "project" | "user" | "plugin" | "system"
    pub scope: String,
    /// "claude" | "codex"
    pub harness: String,
}

/// How each harness invokes an entry. `plugin` is the Claude plugin name.
pub fn invocation(harness: Harness, kind: ActionKind, name: &str, plugin: Option<&str>) -> String {
    match (harness, kind) {
        (Harness::Claude, _) => match plugin {
            Some(p) => format!("/{p}:{name}"),
            None => format!("/{name}"),
        },
        (Harness::Codex, ActionKind::Prompt) => format!("/prompts:{name}"),
        (Harness::Codex, _) => format!("${name}"),
    }
}

/// Minimal YAML-frontmatter reader for `name:` / `description:` style keys.
/// Supports plain, quoted and block (`|`, `>`) scalar values.
pub fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let body: Vec<&str> = lines.take_while(|line| line.trim() != "---").collect();
    let prefix = format!("{key}:");
    for (i, line) in body.iter().enumerate() {
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let Some(rest) = line.strip_prefix(&prefix) else {
            continue;
        };
        let value = rest.trim();
        if value.starts_with('|') || value.starts_with('>') {
            let joined: Vec<&str> = body[i + 1..]
                .iter()
                .take_while(|l| l.starts_with(char::is_whitespace) || l.trim().is_empty())
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect();
            return Some(joined.join(" "));
        }
        let unquoted = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        return Some(unquoted.to_string());
    }
    None
}

fn first_body_line(content: &str) -> String {
    let mut in_frontmatter = false;
    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if i == 0 && trimmed == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if trimmed == "---" {
                in_frontmatter = false;
            }
            continue;
        }
        if !trimmed.is_empty() {
            return trimmed.trim_start_matches('#').trim().to_string();
        }
    }
    String::new()
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Every `<dir>/<skill>/SKILL.md`. With `include_dot`, dot-dirs (Codex
/// `.system`) are scanned one level deeper as another skills dir.
pub fn scan_skills_dir(
    dir: &Path,
    harness: Harness,
    scope: &str,
    plugin: Option<&str>,
    include_dot: bool,
    out: &mut Vec<ComposerAction>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if dir_name.starts_with('.') {
            if include_dot && entry.path().is_dir() {
                scan_skills_dir(&entry.path(), harness, "system", plugin, false, out);
            }
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path().join("SKILL.md")) else {
            continue;
        };
        let name = frontmatter_value(&content, "name")
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty() && !n.contains(char::is_whitespace))
            .unwrap_or(dir_name);
        let description = frontmatter_value(&content, "description")
            .unwrap_or_else(|| first_body_line(&content));
        out.push(ComposerAction {
            invoke: invocation(harness, ActionKind::Skill, &name, plugin),
            name,
            description: clip(description.trim(), MAX_ACTION_DESCRIPTION),
            kind: ActionKind::Skill.as_str().to_string(),
            scope: scope.to_string(),
            harness: harness.as_str().to_string(),
        });
    }
}

/// `**.md` under `dir` as commands (Claude; nested dirs become `dir:name`)
/// or prompts (Codex, flat).
pub fn scan_commands_dir(
    dir: &Path,
    harness: Harness,
    kind: ActionKind,
    scope: &str,
    plugin: Option<&str>,
    out: &mut Vec<ComposerAction>,
) {
    fn walk(
        base: &Path,
        dir: &Path,
        depth: usize,
        max_depth: usize,
        found: &mut Vec<(String, PathBuf)>,
    ) {
        if depth > max_depth {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if path.is_dir() {
                walk(base, &path, depth + 1, max_depth, found);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(rel) = path.with_extension("").strip_prefix(base).map(|p| p.to_path_buf()) else {
                continue;
            };
            let name = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(":");
            if !name.is_empty() && !name.eq_ignore_ascii_case("readme") {
                found.push((name, path));
            }
        }
    }
    let mut found = Vec::new();
    let max_depth = if kind == ActionKind::Prompt { 0 } else { 3 };
    walk(dir, dir, 0, max_depth, &mut found);
    for (name, path) in found {
        let content = fs::read_to_string(&path).unwrap_or_default();
        let description = frontmatter_value(&content, "description")
            .unwrap_or_else(|| first_body_line(&content));
        out.push(ComposerAction {
            invoke: invocation(harness, kind, &name, plugin),
            name,
            description: clip(description.trim(), MAX_ACTION_DESCRIPTION),
            kind: kind.as_str().to_string(),
            scope: scope.to_string(),
            harness: harness.as_str().to_string(),
        });
    }
}

/// `cwd` and its ancestors up to (and including) the git root; at most 6
/// levels and never above the home dir.
pub fn project_roots(cwd: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut cur = Some(cwd.to_path_buf());
    while let Some(dir) = cur {
        if home.is_some_and(|h| dir == h) || out.len() >= 6 {
            break;
        }
        let is_git_root = dir.join(".git").exists();
        out.push(dir.clone());
        if is_git_root {
            break;
        }
        cur = dir.parent().map(|p| p.to_path_buf());
    }
    out
}

/// (plugin name, install path) for enabled Claude Code plugins.
fn claude_plugins(home: &Path) -> Vec<(String, PathBuf)> {
    let claude = home.join(".claude");
    let Ok(raw) = fs::read_to_string(claude.join("plugins").join("installed_plugins.json")) else {
        return Vec::new();
    };
    let Ok(installed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let enabled = fs::read_to_string(claude.join("settings.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("enabledPlugins").cloned());
    let mut out = Vec::new();
    let Some(plugins) = installed.get("plugins").and_then(|p| p.as_object()) else {
        return out;
    };
    for (key, installs) in plugins {
        if let Some(enabled) = enabled.as_ref() {
            if enabled.get(key).and_then(|v| v.as_bool()) != Some(true) {
                continue;
            }
        }
        let plugin_name = key.split('@').next().unwrap_or(key).to_string();
        let Some(path) = installs
            .as_array()
            .and_then(|a| a.last())
            .and_then(|i| i.get("installPath"))
            .and_then(|p| p.as_str())
        else {
            continue;
        };
        out.push((plugin_name, PathBuf::from(path)));
    }
    out
}

/// The directories one harness reads, as (dir, how to scan it).
enum Source {
    Skills { scope: &'static str, plugin: Option<String>, include_dot: bool },
    Commands { kind: ActionKind, scope: &'static str, plugin: Option<String> },
}

fn sources_for(harness: Harness, cwd: Option<&Path>, home: Option<&Path>) -> Vec<(PathBuf, Source)> {
    let mut out = Vec::new();
    let roots = cwd.map(|c| project_roots(c, home)).unwrap_or_default();
    match harness {
        Harness::Claude => {
            for root in &roots {
                out.push((root.join(".claude/skills"), Source::Skills { scope: "project", plugin: None, include_dot: false }));
                out.push((root.join(".claude/commands"), Source::Commands { kind: ActionKind::Command, scope: "project", plugin: None }));
            }
            if let Some(home) = home {
                out.push((home.join(".claude/skills"), Source::Skills { scope: "user", plugin: None, include_dot: false }));
                out.push((home.join(".claude/commands"), Source::Commands { kind: ActionKind::Command, scope: "user", plugin: None }));
                for (plugin, path) in claude_plugins(home) {
                    out.push((path.join("skills"), Source::Skills { scope: "plugin", plugin: Some(plugin.clone()), include_dot: false }));
                    out.push((path.join("commands"), Source::Commands { kind: ActionKind::Command, scope: "plugin", plugin: Some(plugin) }));
                }
            }
        }
        Harness::Codex => {
            for root in &roots {
                out.push((root.join(".codex/skills"), Source::Skills { scope: "project", plugin: None, include_dot: false }));
                out.push((root.join(".agents/skills"), Source::Skills { scope: "project", plugin: None, include_dot: false }));
            }
            if let Some(home) = home {
                let codex_home = std::env::var("CODEX_HOME")
                    .ok()
                    .filter(|v| !v.trim().is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".codex"));
                out.push((codex_home.join("skills"), Source::Skills { scope: "user", plugin: None, include_dot: true }));
                out.push((home.join(".agents/skills"), Source::Skills { scope: "user", plugin: None, include_dot: false }));
                out.push((codex_home.join("prompts"), Source::Commands { kind: ActionKind::Prompt, scope: "user", plugin: None }));
            }
        }
    }
    out
}

/// mtime fingerprint of every source dir (missing dirs count as 0).
fn fingerprint(sources: &[(PathBuf, Source)]) -> Vec<(PathBuf, u128)> {
    sources
        .iter()
        .map(|(dir, _)| {
            let mtime = fs::metadata(dir)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            (dir.clone(), mtime)
        })
        .collect()
}

/// Scan every source once; earlier sources (project) win over later ones
/// (user, plugin) for the same invocation text.
pub fn list_actions(harness: Harness, cwd: Option<&Path>, home: Option<&Path>) -> Vec<ComposerAction> {
    let mut out = Vec::new();
    for (dir, source) in sources_for(harness, cwd, home) {
        match source {
            Source::Skills { scope, plugin, include_dot } => {
                scan_skills_dir(&dir, harness, scope, plugin.as_deref(), include_dot, &mut out)
            }
            Source::Commands { kind, scope, plugin } => {
                scan_commands_dir(&dir, harness, kind, scope, plugin.as_deref(), &mut out)
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|a| seen.insert(a.invoke.clone()));
    out
}

type ActionCacheKey = (Harness, Option<PathBuf>);
type ActionCacheValue = (Vec<(PathBuf, u128)>, Vec<ComposerAction>);

fn action_cache() -> &'static std::sync::Mutex<HashMap<ActionCacheKey, ActionCacheValue>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<ActionCacheKey, ActionCacheValue>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Skills/commands for one harness ("claude" | "codex"); cached per
/// (harness, cwd) and rescanned when any source dir's mtime changes.
#[tauri::command(async)]
pub fn composer_list_actions(cwd: Option<String>, harness: String) -> Vec<ComposerAction> {
    let Some(harness) = Harness::parse(&harness) else {
        return Vec::new();
    };
    let cwd = cwd
        .filter(|c| !c.trim().is_empty())
        .map(|c| PathBuf::from(crate::expand_path(c.trim())));
    let home = dirs::home_dir();
    let sources = sources_for(harness, cwd.as_deref(), home.as_deref());
    let print = fingerprint(&sources);
    let key = (harness, cwd.clone());
    if let Ok(cache) = action_cache().lock() {
        if let Some((cached_print, actions)) = cache.get(&key) {
            if *cached_print == print {
                return actions.clone();
            }
        }
    }
    let actions = list_actions(harness, cwd.as_deref(), home.as_deref());
    if let Ok(mut cache) = action_cache().lock() {
        cache.insert(key, (print, actions.clone()));
    }
    actions
}

// ---------------------------------------------------------------------------
// TypeSafe Jev ranker
// ---------------------------------------------------------------------------

const JEV_ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const JEV_MAX_CANDIDATES: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JevStatus {
    pub configured: bool,
    pub model: String,
    pub timeout_ms: u64,
    /// "config" | "env" | "none"
    pub key_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JevCandidate {
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub detail: String,
}

pub(crate) struct JevSettings {
    pub(crate) key: Option<String>,
    key_source: &'static str,
    pub(crate) model: String,
    pub(crate) timeout_ms: u64,
}

pub(crate) fn jev_settings() -> JevSettings {
    let cfg = crate::config::load_config()
        .ok()
        .and_then(|c| c.typesafe)
        .unwrap_or_default();
    let mut key_source = "none";
    let mut key = None;
    if cfg.enabled {
        if let Some(k) = cfg.api_key.as_ref().map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
            key = Some(k);
            key_source = "config";
        } else if let Ok(k) = std::env::var("TYPESAFE_API_KEY") {
            let k = k.trim().to_string();
            if !k.is_empty() {
                key = Some(k);
                key_source = "env";
            }
        }
    }
    JevSettings {
        key,
        key_source,
        model: cfg.model,
        timeout_ms: cfg.timeout_ms,
    }
}

#[tauri::command]
pub fn composer_jev_status() -> JevStatus {
    let s = jev_settings();
    JevStatus {
        configured: s.key.is_some(),
        model: s.model,
        timeout_ms: s.timeout_ms,
        key_source: s.key_source.to_string(),
    }
}

/// One Noul per candidate: "does this suggestion fit what the user is typing".
pub fn build_jev_request(
    model: &str,
    draft: &str,
    query: &str,
    workspace: &str,
    candidates: &[JevCandidate],
) -> serde_json::Value {
    let tail: String = {
        let chars: Vec<char> = draft.chars().collect();
        let start = chars.len().saturating_sub(600);
        chars[start..].iter().collect()
    };
    let mut questions = serde_json::Map::new();
    for (i, c) in candidates.iter().take(JEV_MAX_CANDIDATES).enumerate() {
        questions.insert(
            format!("c{i:02}"),
            serde_json::json!({
                "type": "noul",
                "instructions": {
                    "suggestion": { "kind": c.kind, "text": c.text, "detail": c.detail },
                    "question": "Is `suggestion` what the user most likely wants to insert or do next, given the words they are typing in `draft`?"
                },
                "criteria": {
                    "true": "The suggestion fits the intent of the draft: the session, file, slash command or earlier message the user is referring to.",
                    "false": "The suggestion is unrelated to the draft, or only shares a few letters with the word being typed."
                }
            }),
        );
    }
    serde_json::json!({
        "model": model,
        "state": {
            "situation": "A developer is writing a message in a composer. The message will be sent to a coding agent (Claude Code or Codex) or a shell running in a terminal. Suggestions appear under the cursor while they type.",
            "draft": tail,
            "word_being_typed": query,
            "workspace": workspace,
        },
        "questions": questions,
    })
}

/// Escape a value for a double-quoted curl config (`-K`) entry.
pub fn curl_config_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// Pull the Noul values back out, in candidate order. Missing answers are NaN.
pub fn parse_jev_answers(body: &serde_json::Value, count: usize) -> Vec<f64> {
    (0..count.min(JEV_MAX_CANDIDATES))
        .map(|i| {
            body.get("answers")
                .and_then(|a| a.get(format!("c{i:02}")))
                .and_then(|a| a.get("noul"))
                .and_then(|v| v.as_f64())
                .unwrap_or(f64::NAN)
        })
        .collect()
}

/// Rank candidates with Jev. The key never leaves this process except as the
/// Authorization header, which is handed to curl on stdin (not argv, so it
/// is not visible in `ps`). Errors never include the key.
#[tauri::command]
pub async fn composer_jev_rank(
    draft: String,
    query: String,
    workspace: String,
    candidates: Vec<JevCandidate>,
) -> Result<Vec<f64>, String> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let settings = jev_settings();
    let Some(key) = settings.key else {
        return Err("jev not configured".to_string());
    };
    let body = build_jev_request(&settings.model, &draft, &query, &workspace, &candidates);
    let parsed = jev_post(&body, &key, settings.timeout_ms).await?;
    Ok(parse_jev_answers(&parsed, candidates.len()))
}

/// POSTs a request to Jev and returns the parsed JSON body. The key goes to
/// curl on stdin so it never shows up in `ps`, and errors never include it.
pub(crate) async fn jev_post(
    body: &serde_json::Value,
    key: &str,
    timeout_ms: u64,
) -> Result<serde_json::Value, String> {
    let body_raw = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    let config = format!(
        "url = {}\nrequest = \"POST\"\nheader = {}\nheader = \"Content-Type: application/json\"\ndata-binary = {}\n",
        curl_config_quote(JEV_ENDPOINT),
        curl_config_quote(&format!("Authorization: Bearer {key}")),
        curl_config_quote(&body_raw),
    );
    let timeout_ms = timeout_ms.clamp(100, 10_000);
    let max_time = format!("{:.3}", timeout_ms as f64 / 1000.0);

    let mut child = tokio::process::Command::new("/usr/bin/curl")
        .args(["-sS", "--max-time", &max_time, "-K", "-", "-w", "\n%{http_code}"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("curl spawn: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(config.as_bytes())
            .await
            .map_err(|e| format!("curl stdin: {e}"))?;
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms + 200),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "jev timeout".to_string())?
    .map_err(|e| format!("curl wait: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let (payload, status) = stdout.rsplit_once('\n').unwrap_or(("", stdout.as_ref()));
    let status: u16 = status.trim().parse().unwrap_or(0);
    if status == 0 {
        return Err("jev timeout or network error".to_string());
    }
    if status != 200 {
        return Err(format!("jev http {status}"));
    }
    serde_json::from_str(payload).map_err(|_| "jev bad response".to_string())
}

// ---------------------------------------------------------------------------
// Dictation (Wispr Flow)
// ---------------------------------------------------------------------------

const WISPR_APP: &str = "/Applications/Wispr Flow.app";

#[tauri::command]
pub fn dictation_available() -> bool {
    Path::new(WISPR_APP).exists()
}

/// Start or stop Wispr Flow hands-free dictation through its URL scheme.
/// `open -g` keeps Wispr in the background so keyboard focus (and the
/// transcription) stays in Butter's composer.
#[tauri::command]
pub fn dictation_hands_free(start: bool) -> Result<(), String> {
    if !dictation_available() {
        return Err("Wispr Flow is not installed".to_string());
    }
    let url = if start {
        "wispr-flow://start-hands-free"
    } else {
        "wispr-flow://stop-hands-free"
    };
    let status = std::process::Command::new("/usr/bin/open")
        .args(["-g", url])
        .status()
        .map_err(|e| format!("open: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open {url} failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("butter-composer-test-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn at(m: u32, d: u32, h: u32, min: u32) -> chrono::NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, m, d)
            .unwrap()
            .and_hms_opt(h, min, 0)
            .unwrap()
    }

    #[test]
    fn slug_keeps_safe_chars_and_collapses_the_rest() {
        assert_eq!(title_slug("aws-billing"), "aws-billing");
        assert_eq!(title_slug("  Fix the / sidebar!! bug "), "Fix-the-sidebar-bug");
        assert_eq!(title_slug("../../etc/passwd"), "etc-passwd");
        assert_eq!(title_slug("   "), "session");
        assert_eq!(title_slug("///"), "session");
        assert!(title_slug(&"x".repeat(200)).chars().count() <= MAX_TITLE_SLUG);
    }

    #[test]
    fn draft_name_uses_mmdd_hhmm() {
        assert_eq!(draft_file_name("mna", &at(9, 6, 7, 5)), "mna-0906-0705.md");
        assert_eq!(draft_file_name("aws billing", &at(12, 31, 23, 59)), "aws-billing-1231-2359.md");
    }

    #[test]
    fn drafts_dir_is_flavored() {
        let home = Path::new("/Users/x");
        assert_eq!(
            crate::paths::butter_home_in(home, true).join("drafts"),
            PathBuf::from("/Users/x/.butter-dev/drafts")
        );
        assert_eq!(
            crate::paths::butter_home_in(home, false).join("drafts"),
            PathBuf::from("/Users/x/.butter/drafts")
        );
    }

    #[test]
    fn unique_path_appends_counter() {
        let dir = tmpdir("unique");
        assert_eq!(unique_path_in(&dir, "a.md"), dir.join("a.md"));
        fs::write(dir.join("a.md"), "x").unwrap();
        assert_eq!(unique_path_in(&dir, "a.md"), dir.join("a-2.md"));
        fs::write(dir.join("a-2.md"), "x").unwrap();
        assert_eq!(unique_path_in(&dir, "a.md"), dir.join("a-3.md"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn draft_roundtrip_and_send_moves_to_history() {
        let dir = tmpdir("roundtrip");
        let first = load_draft_in(&dir, "s1", "mna").unwrap();
        assert_eq!(first.text, "");
        assert!(first.path.ends_with(".md"));
        let saved = save_draft_in(&dir, "s1", "mna", "hello").unwrap();
        assert_eq!(saved, first.path, "same session keeps the same file");
        assert_eq!(load_draft_in(&dir, "s1", "renamed").unwrap().text, "hello");

        let entry = record_sent_in(&dir, "s1", "mna", "hello", 1_000).unwrap();
        assert!(entry.path.contains("/sent/"));
        assert_eq!(fs::read_to_string(&entry.path).unwrap(), "hello");
        assert!(!Path::new(&saved).exists(), "live draft file is moved away");
        // Next draft for the session starts empty.
        assert_eq!(load_draft_in(&dir, "s1", "mna").unwrap().text, "");

        record_sent_in(&dir, "s2", "other", "second", 2_000).unwrap();
        let history = read_history_in(&dir, 10);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].text, "second", "newest first");
        assert_eq!(history[1].session_id, "s1");
        assert_eq!(read_history_in(&dir, 1).len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn index_rejects_path_traversal() {
        let dir = tmpdir("traversal");
        let mut index = HashMap::new();
        index.insert("s1".to_string(), "../../evil.md".to_string());
        write_index(&dir, &index).unwrap();
        let state = load_draft_in(&dir, "s1", "t").unwrap();
        assert!(Path::new(&state.path).starts_with(&dir));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn frontmatter_parses_plain_quoted_and_block_values() {
        let md = "---\nname: mytodos\ndescription: \"Personal todo tracker\"\n---\n# Body\n";
        assert_eq!(frontmatter_value(md, "name").as_deref(), Some("mytodos"));
        assert_eq!(frontmatter_value(md, "description").as_deref(), Some("Personal todo tracker"));
        let block = "---\nname: x\ndescription: >\n  first line\n  second line\nother: y\n---\n";
        assert_eq!(frontmatter_value(block, "description").as_deref(), Some("first line second line"));
        assert_eq!(frontmatter_value("no frontmatter", "name"), None);
    }

    #[test]
    fn scans_skills_and_nested_commands() {
        let dir = tmpdir("actions");
        let skills = dir.join("skills");
        fs::create_dir_all(skills.join("mna")).unwrap();
        fs::write(skills.join("mna/SKILL.md"), "---\nname: mna\ndescription: M&A research\n---\n").unwrap();
        fs::create_dir_all(skills.join("nameless")).unwrap();
        fs::write(skills.join("nameless/SKILL.md"), "# Just a heading\n").unwrap();
        fs::create_dir_all(skills.join(".system/skill-creator")).unwrap();
        fs::write(skills.join(".system/skill-creator/SKILL.md"), "---\nname: skill-creator\n---\n").unwrap();
        let commands = dir.join("commands");
        fs::create_dir_all(commands.join("git")).unwrap();
        fs::write(commands.join("git/pr.md"), "Open a pull request\n").unwrap();
        fs::write(commands.join("deploy.md"), "---\ndescription: Deploy it\n---\nbody").unwrap();

        let mut out = Vec::new();
        scan_skills_dir(&skills, Harness::Claude, "user", None, false, &mut out);
        scan_commands_dir(&commands, Harness::Claude, ActionKind::Command, "project", None, &mut out);
        let invokes: std::collections::HashSet<_> = out.iter().map(|a| a.invoke.clone()).collect();
        assert!(invokes.contains("/mna"));
        assert!(invokes.contains("/nameless"));
        assert!(invokes.contains("/git:pr"));
        assert!(invokes.contains("/deploy"));
        assert!(!invokes.iter().any(|i| i.contains("skill-creator")), "dot dirs skipped for Claude");
        let pr = out.iter().find(|a| a.name == "git:pr").unwrap();
        assert_eq!(pr.description, "Open a pull request");
        assert_eq!(pr.kind, "command");
        assert_eq!(pr.harness, "claude");

        let mut codex = Vec::new();
        scan_skills_dir(&skills, Harness::Codex, "user", None, true, &mut codex);
        let invokes: std::collections::HashSet<_> = codex.iter().map(|a| a.invoke.clone()).collect();
        assert!(invokes.contains("$mna"));
        assert!(invokes.contains("$skill-creator"), ".system scanned for Codex");
        assert_eq!(codex.iter().find(|a| a.name == "skill-creator").unwrap().scope, "system");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn invocation_syntax_per_harness() {
        assert_eq!(invocation(Harness::Claude, ActionKind::Skill, "mna", None), "/mna");
        assert_eq!(invocation(Harness::Claude, ActionKind::Command, "git:pr", None), "/git:pr");
        assert_eq!(
            invocation(Harness::Claude, ActionKind::Skill, "typesafe-ai", Some("typesafe")),
            "/typesafe:typesafe-ai"
        );
        assert_eq!(invocation(Harness::Codex, ActionKind::Skill, "buckit", None), "$buckit");
        assert_eq!(invocation(Harness::Codex, ActionKind::Prompt, "review", None), "/prompts:review");
        assert_eq!(Harness::parse("claude"), Some(Harness::Claude));
        assert_eq!(Harness::parse("shell"), None);
    }

    #[test]
    fn list_actions_per_harness_dedupes_and_prefers_project() {
        let home = tmpdir("home");
        let project = home.join("repo");
        fs::create_dir_all(project.join(".git")).unwrap();
        for (path, desc) in [
            (".claude/skills/shared", "user claude"),
            (".codex/skills/shared", "user codex"),
            ("repo/.claude/skills/shared", "project claude"),
            ("repo/.agents/skills/proj-codex", "project codex"),
        ] {
            fs::create_dir_all(home.join(path)).unwrap();
            let name = path.rsplit('/').next().unwrap();
            fs::write(
                home.join(path).join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {desc}\n---\n"),
            )
            .unwrap();
        }
        let claude = list_actions(Harness::Claude, Some(&project), Some(&home));
        let shared: Vec<_> = claude.iter().filter(|a| a.name == "shared").collect();
        assert_eq!(shared.len(), 1, "same skill shown once");
        assert_eq!(shared[0].description, "project claude");
        assert!(claude.iter().all(|a| a.harness == "claude"));

        let codex = list_actions(Harness::Codex, Some(&project), Some(&home));
        let invokes: Vec<_> = codex.iter().map(|a| a.invoke.as_str()).collect();
        assert!(invokes.contains(&"$shared"));
        assert!(invokes.contains(&"$proj-codex"));
        assert!(codex.iter().all(|a| a.harness == "codex"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn project_roots_stop_at_git_root() {
        let base = tmpdir("roots");
        let repo = base.join("repo");
        let deep = repo.join("a/b");
        fs::create_dir_all(&deep).unwrap();
        fs::create_dir_all(repo.join(".git")).unwrap();
        let roots = project_roots(&deep, None);
        assert_eq!(roots, vec![deep.clone(), repo.join("a"), repo.clone()]);
        assert!(project_roots(&repo, Some(&repo)).is_empty(), "never the home dir itself");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn curl_quote_escapes() {
        assert_eq!(curl_config_quote(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(curl_config_quote("x\ny"), r#""x\ny""#);
    }

    #[test]
    fn jev_request_has_one_noul_per_candidate() {
        let cands = vec![
            JevCandidate { kind: "session".into(), text: "mna".into(), detail: String::new() },
            JevCandidate { kind: "file".into(), text: "@data/mna/companies.db".into(), detail: String::new() },
        ];
        let body = build_jev_request("jev-latest", "mna todo", "todo", "mike3", &cands);
        assert_eq!(body["model"], "jev-latest");
        let qs = body["questions"].as_object().unwrap();
        assert_eq!(qs.len(), 2);
        assert_eq!(qs["c00"]["type"], "noul");
        assert_eq!(qs["c01"]["instructions"]["suggestion"]["text"], "@data/mna/companies.db");
        let answers = serde_json::json!({"answers": {"c00": {"type": "noul", "noul": 0.9}}});
        let parsed = parse_jev_answers(&answers, 2);
        assert_eq!(parsed[0], 0.9);
        assert!(parsed[1].is_nan());
    }
}

/// Live check of the Jev plumbing (curl config on stdin, status parsing).
/// Run with `TYPESAFE_API_KEY=... cargo test --lib jev_live -- --ignored --nocapture`.
#[cfg(test)]
mod live_tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn jev_live() {
        let started = std::time::Instant::now();
        let result = composer_jev_rank(
            "mna todo".to_string(),
            "todo".to_string(),
            "mike3".to_string(),
            vec![
                JevCandidate { kind: "file path".into(), text: "@data/todos/todos.db".into(), detail: String::new() },
                JevCandidate { kind: "route to terminal session".into(), text: "aws-billing".into(), detail: String::new() },
            ],
        )
        .await;
        println!("jev_live: {:?} in {} ms", result, started.elapsed().as_millis());
    }

    /// Prints what the dock would offer for this machine's real skill dirs.
    /// `COMPOSER_CWD=/path cargo test --lib actions_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn actions_live() {
        let cwd = std::env::var("COMPOSER_CWD").ok();
        for harness in ["claude", "codex"] {
            let started = std::time::Instant::now();
            let actions = composer_list_actions(cwd.clone(), harness.to_string());
            let cold = started.elapsed().as_micros();
            let started = std::time::Instant::now();
            let again = composer_list_actions(cwd.clone(), harness.to_string());
            let warm = started.elapsed().as_micros();
            assert_eq!(actions, again);
            let sample: Vec<_> = actions.iter().take(6).map(|a| a.invoke.clone()).collect();
            println!("{harness}: {} actions (cold {cold} us, cached {warm} us) e.g. {sample:?}", actions.len());
        }
    }
}
