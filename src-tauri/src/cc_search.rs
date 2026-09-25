//! Conversation-history search backend.
//!
//! Spawns a long-lived Python helper (`scripts/cc_search.py`, run via `uv`)
//! that owns the DuckDB query. The process is kept warm between keystrokes so
//! search-as-you-type stays fast — only the first query pays Python startup.
//!
//! Protocol: one JSON request line in, one JSON response line out, serialized
//! by the `Mutex` so requests and responses always stay paired.

use std::fs;
use std::io::{BufRead, BufReader, Write as IoWrite};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

const SCRIPT_SRC: &str = include_str!("../scripts/cc_search.py");
const STDERR_LOG: &str = "/tmp/butter-cc-search.log";

struct Proc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Managed Tauri state holding the (lazily spawned) search helper process.
#[derive(Default)]
pub struct CcSearch {
    proc: Mutex<Option<Proc>>,
}

/// Locate the `uv` binary. GUI apps launched from Finder get a minimal PATH,
/// so probe the usual install locations before falling back to a bare `uv`.
fn find_uv() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        for rel in [".local/bin/uv", ".cargo/bin/uv"] {
            let candidate = home.join(rel);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    for abs in ["/opt/homebrew/bin/uv", "/usr/local/bin/uv", "/usr/bin/uv"] {
        let candidate = PathBuf::from(abs);
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("uv")
}

/// Write the bundled Python helper to a temp file so `uv run --script` can
/// pick up its inline dependency metadata, regardless of how the app is run.
fn ensure_script() -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join("butter_cc_search.py");
    fs::write(&path, SCRIPT_SRC).map_err(|e| format!("write helper script: {e}"))?;
    Ok(path)
}

fn spawn_proc() -> Result<Proc, String> {
    let script = ensure_script()?;
    let stderr = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(STDERR_LOG)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());

    let mut child = Command::new(find_uv())
        .arg("run")
        .arg("--script")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .spawn()
        .map_err(|e| format!("failed to start cc-search helper (uv): {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "cc-search helper: no stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "cc-search helper: no stdout".to_string())?;

    Ok(Proc {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        next_id: 1,
    })
}

impl CcSearch {
    /// Send one request to the helper and return its parsed JSON response.
    /// The `Mutex` keeps request/response lines paired; a dead helper is
    /// respawned once and the request retried.
    fn exchange(&self, mut req: serde_json::Value) -> Result<serde_json::Value, String> {
        let mut guard = self.proc.lock().map_err(|e| e.to_string())?;

        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(spawn_proc()?);
            }
            let proc = guard.as_mut().unwrap();
            let id = proc.next_id;
            proc.next_id += 1;
            if let Some(obj) = req.as_object_mut() {
                obj.insert("id".to_string(), serde_json::json!(id));
            }

            let exchange = (|| -> std::io::Result<String> {
                writeln!(proc.stdin, "{req}")?;
                proc.stdin.flush()?;
                let mut line = String::new();
                let n = proc.stdout.read_line(&mut line)?;
                if n == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "cc-search helper closed its output",
                    ));
                }
                Ok(line)
            })();

            match exchange {
                Ok(line) => {
                    return serde_json::from_str(&line)
                        .map_err(|e| format!("invalid cc-search response: {e}"));
                }
                Err(_) if attempt == 0 => {
                    *guard = None; // drop kills the dead process; loop respawns
                }
                Err(e) => return Err(format!("cc-search helper failed: {e}")),
            }
        }
        Err("cc-search helper failed".to_string())
    }

    pub fn search(&self, query: &str, limit: u32) -> Result<serde_json::Value, String> {
        self.exchange(serde_json::json!({
            "op": "search", "query": query, "limit": limit,
        }))
    }

    pub fn fetch(
        &self,
        session_id: &str,
        mode: &str,
        query: &str,
    ) -> Result<serde_json::Value, String> {
        self.exchange(serde_json::json!({
            "op": "fetch", "session_id": session_id, "mode": mode, "query": query,
        }))
    }
}

#[tauri::command]
pub async fn cc_search(
    query: String,
    limit: Option<u32>,
    state: tauri::State<'_, Arc<CcSearch>>,
) -> Result<serde_json::Value, String> {
    // The helper exchange blocks on pipe I/O; run it off the main thread so
    // the webview stays responsive while the user keeps typing.
    let search = state.inner().clone();
    let limit = limit.unwrap_or(30);
    tauri::async_runtime::spawn_blocking(move || search.search(&query, limit))
        .await
        .map_err(|e| format!("cc-search task failed: {e}"))?
}

/// Fetch full message text for a session: `mode` is `"match"` (only messages
/// matching `query`) or `"thread"` (the whole user/assistant transcript).
#[tauri::command]
pub async fn cc_fetch(
    session_id: String,
    mode: String,
    query: Option<String>,
    state: tauri::State<'_, Arc<CcSearch>>,
) -> Result<serde_json::Value, String> {
    let search = state.inner().clone();
    let query = query.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || search.fetch(&session_id, &mode, &query))
        .await
        .map_err(|e| format!("cc-search task failed: {e}"))?
}

/// Latest assistant turn for a Claude Code agent session, for the switcher
/// preview. Reads `~/.claude/projects/*/<agent_session_id>.jsonl` directly —
/// no Python, no DuckDB — and returns the concatenated text of the last
/// assistant message in the transcript.
#[derive(serde::Serialize)]
pub struct LastAssistantTurn {
    pub text: String,
    pub timestamp: Option<String>,
    pub model: Option<String>,
}

fn find_session_jsonl(agent_session_id: &str) -> Option<PathBuf> {
    let projects_dir = dirs::home_dir()?.join(".claude").join("projects");
    let entries = fs::read_dir(&projects_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(format!("{agent_session_id}.jsonl"));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn extract_text(content: &serde_json::Value) -> String {
    // content is typically an array of {"type":"text"|"tool_use", "text":"..."}.
    // Concatenate text parts; ignore tool_use blocks.
    match content {
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    item.get("text")
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        serde_json::Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

#[tauri::command]
pub fn cc_last_assistant_turn(
    agent_session_id: String,
) -> Result<Option<LastAssistantTurn>, String> {
    let Some(path) = find_session_jsonl(&agent_session_id) else {
        return Ok(None);
    };
    // read_to_string fails on any invalid UTF-8 anywhere in the file; use the
    // byte form + lossy convert so a single bad sequence in a tool-use payload
    // doesn't blank the entire transcript preview.
    let bytes = fs::read(&path).map_err(|e| format!("read transcript: {e}"))?;
    let data = String::from_utf8_lossy(&bytes);
    // Walk lines in reverse to find the last assistant turn with non-empty text.
    for line in data.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v): Result<serde_json::Value, _> = serde_json::from_str(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let message = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        let text = message.get("content").map(extract_text).unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }
        return Ok(Some(LastAssistantTurn {
            text,
            timestamp: v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .map(String::from),
            model: message
                .get("model")
                .and_then(|m| m.as_str())
                .map(String::from),
        }));
    }
    Ok(None)
}

/// Latest assistant turn from a Codex CLI session whose working directory
/// matches `cwd`. Codex stores rollouts at
/// `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; line 1 is a
/// `session_meta` entry whose payload includes the `cwd`. We scan
/// newest-first by year/month/day so a cold scan is bounded.
fn list_codex_jsonls_newest_first(root: &std::path::Path, cap: usize) -> Vec<PathBuf> {
    fn sorted_subdirs(dir: &std::path::Path) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut out: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        out.sort_by(|a, b| b.file_name().cmp(&a.file_name())); // desc
        out
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for year in sorted_subdirs(root) {
        for month in sorted_subdirs(&year) {
            for day in sorted_subdirs(&month) {
                let Ok(files) = fs::read_dir(&day) else {
                    continue;
                };
                let mut day_files: Vec<(PathBuf, std::time::SystemTime)> = files
                    .flatten()
                    .filter_map(|e| {
                        let p = e.path();
                        if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                            return None;
                        }
                        let mtime = e.metadata().and_then(|m| m.modified()).ok()?;
                        Some((p, mtime))
                    })
                    .collect();
                day_files.sort_by(|a, b| b.1.cmp(&a.1)); // newest first within the day
                for (p, _) in day_files {
                    out.push(p);
                    if out.len() >= cap {
                        return out;
                    }
                }
            }
        }
    }
    out
}

fn codex_session_cwd(path: &std::path::Path) -> Option<String> {
    // Read the first line only, but do it as UTF-8 lines (not a raw byte
    // window) — a fixed-size read frequently splits a multi-byte char that
    // appears later in the file, making the whole chunk invalid UTF-8.
    let f = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(f);
    let mut first_line = String::new();
    let n = reader.read_line(&mut first_line).ok()?;
    if n == 0 {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(first_line.trim()).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    v.get("payload")
        .and_then(|p| p.get("cwd"))
        .and_then(|c| c.as_str())
        .map(String::from)
}

fn codex_extract_output_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(|t| t.as_str()) == Some("output_text") {
                    item.get("text")
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

#[tauri::command]
pub fn codex_last_assistant_turn(cwd: String) -> Result<Option<LastAssistantTurn>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(None);
    };
    let root = home.join(".codex").join("sessions");
    if !root.exists() {
        return Ok(None);
    }
    // Look at up to the most recent ~200 rollout files; for each, check cwd
    // matches before paying to read the full file.
    let candidates = list_codex_jsonls_newest_first(&root, 200);
    for path in candidates {
        match codex_session_cwd(&path) {
            Some(c) if c == cwd => {
                let bytes = fs::read(&path).map_err(|e| format!("read codex rollout: {e}"))?;
                let data = String::from_utf8_lossy(&bytes);
                for line in data.lines().rev() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(v): Result<serde_json::Value, _> = serde_json::from_str(line) else {
                        continue;
                    };
                    if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
                        continue;
                    }
                    let Some(payload) = v.get("payload") else {
                        continue;
                    };
                    if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
                        continue;
                    }
                    if payload.get("role").and_then(|r| r.as_str()) != Some("assistant") {
                        continue;
                    }
                    let text = payload
                        .get("content")
                        .map(codex_extract_output_text)
                        .unwrap_or_default();
                    if text.trim().is_empty() {
                        continue;
                    }
                    return Ok(Some(LastAssistantTurn {
                        text,
                        timestamp: v
                            .get("timestamp")
                            .and_then(|t| t.as_str())
                            .map(String::from),
                        model: None,
                    }));
                }
                // Found the file but no assistant content — stop scanning,
                // newer rollouts in the same cwd shouldn't exist.
                return Ok(None);
            }
            _ => continue,
        }
    }
    Ok(None)
}

/// Read the Codex session id (UUID) from a rollout's `session_meta` line.
/// Returns None for rollouts that can't be resumed as a top-level interactive
/// conversation: multi-agent sub-agent threads and `codex exec` runs.
fn codex_session_id(path: &std::path::Path) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(f);
    let mut first_line = String::new();
    if reader.read_line(&mut first_line).ok()? == 0 {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(first_line.trim()).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = v.get("payload")?;
    if !codex_meta_is_interactive_root(payload) {
        return None;
    }
    payload
        .get("id")
        .and_then(|i| i.as_str())
        .map(String::from)
}

fn codex_meta_is_interactive_root(payload: &serde_json::Value) -> bool {
    if payload.get("thread_source").and_then(|t| t.as_str()) == Some("subagent") {
        return false;
    }
    match payload.get("source") {
        // Sub-agent rollouts carry an object source ({"subagent": ...}).
        Some(serde_json::Value::Object(_)) => false,
        Some(serde_json::Value::String(src)) => src != "exec",
        _ => true,
    }
}

/// Fallback when the running codex process can't be mapped to its thread lock:
/// the most recent interactive Codex rollout whose `cwd` matches, skipping ids
/// in `exclude` (conversations other terminals already own).
#[tauri::command]
pub fn codex_latest_session_id(
    cwd: String,
    exclude: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(None);
    };
    let root = home.join(".codex").join("sessions");
    if !root.exists() {
        return Ok(None);
    }
    let exclude = exclude.unwrap_or_default();
    let candidates = list_codex_jsonls_newest_first(&root, 200);
    for path in candidates {
        if codex_session_cwd(&path).as_deref() != Some(cwd.as_str()) {
            continue;
        }
        if let Some(id) = codex_session_id(&path) {
            if !exclude.iter().any(|e| e == &id) {
                return Ok(Some(id));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod codex_meta_tests {
    use super::codex_meta_is_interactive_root;
    use serde_json::json;

    #[test]
    fn skips_subagent_and_exec_rollouts() {
        assert!(codex_meta_is_interactive_root(
            &json!({"id": "a", "source": "cli", "thread_source": "user"})
        ));
        assert!(codex_meta_is_interactive_root(&json!({"id": "a"})));
        assert!(!codex_meta_is_interactive_root(&json!({
            "id": "a",
            "source": {"subagent": {"thread_spawn": {"parent_thread_id": "p"}}},
            "thread_source": "subagent"
        })));
        assert!(!codex_meta_is_interactive_root(&json!({"id": "a", "source": "exec"})));
    }
}

/// Copy a session's raw `.jsonl` into a temp file and return that path, so it
/// can be opened in Butter's file viewer without touching the live transcript.
#[tauri::command]
pub fn cc_export_session(file_path: String) -> Result<String, String> {
    let src = PathBuf::from(&file_path);
    let data = fs::read(&src).map_err(|e| format!("read session file: {e}"))?;
    let dir = std::env::temp_dir().join("butter-cc-sessions");
    fs::create_dir_all(&dir).map_err(|e| format!("create temp dir: {e}"))?;
    let name = src
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("session.jsonl"));
    let dest = dir.join(name);
    fs::write(&dest, &data).map_err(|e| format!("write temp file: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}
