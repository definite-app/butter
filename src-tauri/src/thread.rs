//! 1thread: an iMessage-style chat stream where every thread is backed by a
//! real Butter terminal session running Claude Code. The agent replies to the
//! chat via `butter-cli thread reply`, which hits the HTTP server and lands here.
//!
//! All timestamps in the `threads` / `thread_messages` tables are Unix millis.

use crate::database::AgentDatabase;
use crate::pty::PtyManager;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

/// Event emitted to the webview when an agent reply arrives over HTTP.
pub const THREAD_MESSAGE_EVENT: &str = "thread-message";

const THREAD_COLUMNS: &str =
    "session_id, title, cwd, pinned, created_at, last_activity_at, last_viewed_at";
const MESSAGE_COLUMNS: &str =
    "id, session_id, role, body, source, status, created_at, attachments";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadRecord {
    pub session_id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub pinned: bool,
    pub created_at: i64,
    pub last_activity_at: i64,
    pub last_viewed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMessage {
    pub id: String,
    pub session_id: String,
    /// "user" | "agent"
    pub role: String,
    pub body: String,
    /// "composer" | "cli" | "transcript"
    pub source: Option<String>,
    /// User messages only: "queued" | "delivered" | "seen"
    pub status: Option<String>,
    pub created_at: i64,
    /// Absolute paths of images attached to the message, stored under
    /// `threads/attachments/<thread id>/`.
    #[serde(default)]
    pub attachments: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadAgentAlive {
    pub id: String,
    pub alive: bool,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn row_to_thread(row: &Row) -> rusqlite::Result<ThreadRecord> {
    Ok(ThreadRecord {
        session_id: row.get(0)?,
        title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        cwd: row.get(2)?,
        pinned: row.get::<_, i64>(3)? != 0,
        created_at: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
        last_activity_at: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
        last_viewed_at: row.get(6)?,
    })
}

fn row_to_message(row: &Row) -> rusqlite::Result<ThreadMessage> {
    Ok(ThreadMessage {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: row.get(2)?,
        body: row.get(3)?,
        source: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        attachments: row
            .get::<_, Option<String>>(7)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default(),
    })
}

fn get_thread_conn(conn: &Connection, session_id: &str) -> Result<Option<ThreadRecord>, String> {
    conn.query_row(
        &format!("SELECT {THREAD_COLUMNS} FROM threads WHERE session_id = ?1"),
        params![session_id],
        row_to_thread,
    )
    .optional()
    .map_err(|e| format!("Failed to load thread: {e}"))
}

/// The one working directory every thread's agent starts in: ~/.butter/threads.
/// Sharing it means Claude's per-folder questions (trust, project MCP servers)
/// come up once, not once per thread.
fn threads_dir() -> Result<PathBuf, String> {
    Ok(crate::paths::butter_home()?.join("threads"))
}

fn validate_thread_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid thread id".to_string());
    }
    Ok(())
}

pub fn get_thread(db: &AgentDatabase, session_id: &str) -> Result<Option<ThreadRecord>, String> {
    db.with_conn(|conn| get_thread_conn(conn, session_id))
}

/// Insert a message and bump the thread's activity timestamp.
pub fn add_message(
    db: &AgentDatabase,
    session_id: &str,
    role: &str,
    body: &str,
    source: Option<&str>,
    status: Option<&str>,
    attachments: &[String],
) -> Result<ThreadMessage, String> {
    if role != "user" && role != "agent" {
        return Err(format!("Invalid thread message role: {role}"));
    }
    let body = body.trim();
    if body.is_empty() && attachments.is_empty() {
        return Err("Message body is empty".to_string());
    }
    let message = ThreadMessage {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        role: role.to_string(),
        body: body.to_string(),
        source: source.map(str::to_string),
        status: status.map(str::to_string),
        created_at: now_ms(),
        attachments: attachments.to_vec(),
    };
    let attachments_json = if message.attachments.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&message.attachments).map_err(|e| e.to_string())?)
    };
    db.with_conn(|conn| {
        conn.execute(
            &format!("INSERT INTO thread_messages ({MESSAGE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"),
            params![
                message.id,
                message.session_id,
                message.role,
                message.body,
                message.source,
                message.status,
                message.created_at,
                attachments_json
            ],
        )
        .map_err(|e| format!("Failed to insert thread message: {e}"))?;
        conn.execute(
            "UPDATE threads SET last_activity_at = ?2 WHERE session_id = ?1",
            params![session_id, message.created_at],
        )
        .map_err(|e| format!("Failed to bump thread activity: {e}"))?;
        Ok(())
    })?;
    Ok(message)
}

#[tauri::command]
pub fn thread_create(
    session_id: String,
    title: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<ThreadRecord, String> {
    validate_thread_id(&session_id)?;
    let dir = threads_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create threads dir: {e}"))?;
    let cwd = dir.to_string_lossy().to_string();
    let now = now_ms();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO threads (session_id, title, cwd, pinned, created_at, last_activity_at, last_viewed_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?4, ?4)
             ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, cwd = excluded.cwd",
            params![session_id, title, cwd, now],
        )
        .map_err(|e| format!("Failed to create thread: {e}"))?;
        get_thread_conn(conn, &session_id)?.ok_or_else(|| "Thread not found after insert".to_string())
    })
}

#[tauri::command]
pub fn thread_list(db: State<Arc<AgentDatabase>>) -> Result<Vec<ThreadRecord>, String> {
    db.with_conn(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {THREAD_COLUMNS} FROM threads ORDER BY last_activity_at DESC"
            ))
            .map_err(|e| format!("Failed to prepare thread list: {e}"))?;
        let rows = stmt
            .query_map([], row_to_thread)
            .map_err(|e| format!("Failed to list threads: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read thread row: {e}"))
    })
}

/// Most recent `limit` messages across all threads, oldest first.
#[tauri::command]
pub fn thread_messages_all(
    limit: Option<i64>,
    db: State<Arc<AgentDatabase>>,
) -> Result<Vec<ThreadMessage>, String> {
    let limit = limit.unwrap_or(1000).clamp(1, 10_000);
    db.with_conn(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {MESSAGE_COLUMNS} FROM (
                     SELECT {MESSAGE_COLUMNS}, rowid AS rid FROM thread_messages
                     ORDER BY created_at DESC, rowid DESC LIMIT ?1
                 ) ORDER BY created_at ASC, rid ASC"
            ))
            .map_err(|e| format!("Failed to prepare thread messages: {e}"))?;
        let rows = stmt
            .query_map(params![limit], row_to_message)
            .map_err(|e| format!("Failed to list thread messages: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read thread message row: {e}"))
    })
}

#[tauri::command]
pub fn thread_add_message(
    session_id: String,
    role: String,
    body: String,
    source: Option<String>,
    status: Option<String>,
    attachments: Option<Vec<String>>,
    db: State<Arc<AgentDatabase>>,
) -> Result<ThreadMessage, String> {
    if get_thread(&db, &session_id)?.is_none() {
        return Err("Thread not found".to_string());
    }
    let attachments = adopt_pending_attachments(&session_id, &attachments.unwrap_or_default())?;
    add_message(
        &db,
        &session_id,
        &role,
        &body,
        source.as_deref(),
        status.as_deref(),
        &attachments,
    )
}

/// Pasted images wait here until their message is sent, because a new
/// thread has no id until then.
fn pending_attachments_dir() -> Result<PathBuf, String> {
    Ok(crate::paths::butter_home()?.join("thread-attachments-pending"))
}

const PENDING_ATTACHMENT_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

/// Save the clipboard image for the 1thread composer and return its path.
#[tauri::command]
pub fn thread_save_clipboard_image() -> Result<String, String> {
    let payload = crate::read_clipboard_image_native()?;
    let extension = match payload.mime.as_str() {
        "image/tiff" => "tiff",
        _ => "png",
    };
    let dir = pending_attachments_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create attachments dir: {e}"))?;
    prune_pending_attachments(&dir);
    let path = dir.join(format!("image-{}.{extension}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, payload.bytes).map_err(|e| format!("Failed to save image: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Drop pasted images that were never sent.
fn prune_pending_attachments(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > PENDING_ATTACHMENT_MAX_AGE);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Move pasted images into threads/attachments/<id>/ so the agent can read
/// them without leaving its working directory. Only files from the pending folder
/// are accepted.
fn adopt_pending_attachments(session_id: &str, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let pending = std::fs::canonicalize(pending_attachments_dir()?)
        .map_err(|e| format!("Attachments dir unavailable: {e}"))?;
    validate_thread_id(session_id)?;
    let target_dir = threads_dir()?.join("attachments").join(session_id);
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create thread attachments dir: {e}"))?;
    let mut adopted = Vec::with_capacity(paths.len());
    for path in paths {
        let source = std::fs::canonicalize(path).map_err(|e| format!("Attachment missing: {e}"))?;
        if source.parent() != Some(pending.as_path()) {
            return Err("Refusing to attach a file outside the pending attachments folder".to_string());
        }
        let name = source
            .file_name()
            .ok_or_else(|| "Invalid attachment path".to_string())?;
        let target = target_dir.join(name);
        std::fs::rename(&source, &target)
            .or_else(|_| std::fs::copy(&source, &target).map(|_| ()).and_then(|_| std::fs::remove_file(&source)))
            .map_err(|e| format!("Failed to move attachment: {e}"))?;
        adopted.push(target.to_string_lossy().to_string());
    }
    Ok(adopted)
}

#[tauri::command]
pub fn thread_update_message_status(
    id: String,
    status: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<(), String> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE thread_messages SET status = ?2 WHERE id = ?1",
            params![id, status],
        )
        .map(|_| ())
        .map_err(|e| format!("Failed to update thread message status: {e}"))
    })
}

#[tauri::command]
pub fn thread_set_pinned(
    session_id: String,
    pinned: bool,
    db: State<Arc<AgentDatabase>>,
) -> Result<(), String> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE threads SET pinned = ?2 WHERE session_id = ?1",
            params![session_id, pinned as i64],
        )
        .map(|_| ())
        .map_err(|e| format!("Failed to pin thread: {e}"))
    })
}

#[tauri::command]
pub fn thread_mark_viewed(session_id: String, db: State<Arc<AgentDatabase>>) -> Result<i64, String> {
    let now = now_ms();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE threads SET last_viewed_at = ?2 WHERE session_id = ?1",
            params![session_id, now],
        )
        .map(|_| now)
        .map_err(|e| format!("Failed to mark thread viewed: {e}"))
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadLaunchFiles {
    /// None when resuming without a new message (e.g. from the restore picker).
    pub prompt_path: Option<String>,
    pub instructions_path: String,
}

/// Stage the prompt + system-prompt text in files so the command typed into the
/// shell stays short. Commands are written to a freshly spawned PTY before the
/// shell's line editor is up, while the tty is still in canonical mode, which on
/// macOS silently drops anything past MAX_CANON (1024 bytes) on a single line.
#[tauri::command]
pub fn thread_stage_launch(
    session_id: String,
    prompt: Option<String>,
    instructions: String,
) -> Result<ThreadLaunchFiles, String> {
    // Staging files stay out of the agent's cwd.
    validate_thread_id(&session_id)?;
    let dir = crate::paths::butter_home()?.join("thread-launch").join(&session_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create launch dir: {e}"))?;
    let prompt_path = match prompt {
        Some(prompt) => {
            let path = dir.join(format!("prompt-{}.txt", now_ms()));
            std::fs::write(&path, prompt).map_err(|e| format!("Failed to write prompt: {e}"))?;
            Some(path.to_string_lossy().to_string())
        }
        None => None,
    };
    if let Err(err) = ensure_claude_trusts_threads() {
        eprintln!("[thread] could not pre-trust the threads folder for Claude: {err}");
    }
    let instructions_path = dir.join("instructions.txt");
    std::fs::write(&instructions_path, instructions)
        .map_err(|e| format!("Failed to write instructions: {e}"))?;
    Ok(ThreadLaunchFiles {
        prompt_path,
        instructions_path: instructions_path.to_string_lossy().to_string(),
    })
}

/// Claude Code asks "Do you trust this folder?" the first time it runs in a
/// directory, which would stall every new thread on a prompt the user never
/// sees. Marking the shared threads folder trusted once covers every thread
/// (and threads created before it was shared, in subfolders, via Claude's
/// parent-directory lookup).
fn ensure_claude_trusts_threads() -> Result<(), String> {
    let threads_dir = threads_dir()?;
    std::fs::create_dir_all(&threads_dir).map_err(|e| e.to_string())?;
    let key = threads_dir.to_string_lossy().to_string();
    let config_path = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir).join(".claude.json"),
        _ => dirs::home_dir()
            .ok_or_else(|| "No home directory".to_string())?
            .join(".claude.json"),
    };
    let mut config: serde_json::Value = match std::fs::read_to_string(&config_path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("Unreadable {}: {e}", config_path.display()))?,
        // Claude hasn't run yet; it will ask for trust once like any folder.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.to_string()),
    };
    if config["projects"][&key]["hasTrustDialogAccepted"] == serde_json::Value::Bool(true) {
        return Ok(());
    }
    let root = config
        .as_object_mut()
        .ok_or_else(|| "Claude config is not a JSON object".to_string())?;
    let projects = root
        .entry("projects")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "Claude config `projects` is not an object".to_string())?;
    let project = projects
        .entry(key)
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "Claude project entry is not an object".to_string())?;
    project.insert("hasTrustDialogAccepted".to_string(), serde_json::Value::Bool(true));
    let serialized = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    // Write a sibling file and rename it so Claude never reads a half-written config.
    let tmp_path = config_path.with_extension("json.butter-tmp");
    std::fs::write(&tmp_path, serialized).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, &config_path).map_err(|e| e.to_string())
}

/// Whether a `claude` process is running under each PTY's shell. Unlike
/// `get_claude_activity`, this does not depend on hook events (which go stale
/// after 5 minutes), so the follow-up scheduler can tell "idle for a while"
/// apart from "Claude exited".
#[tauri::command(async)]
pub fn thread_agent_alive(ids: Vec<String>, manager: State<'_, PtyManager>) -> Vec<ThreadAgentAlive> {
    ids.into_iter()
        .map(|id| {
            let alive = manager
                .get_pid(&id)
                .ok()
                .flatten()
                .map(crate::is_claude_running)
                .unwrap_or(false);
            ThreadAgentAlive { id, alive }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_message_bumps_activity_and_validates() {
        let db = AgentDatabase::open_in_memory().unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO threads (session_id, title, cwd, pinned, created_at, last_activity_at)
                 VALUES ('t1', 'demo', NULL, 0, 1, 1)",
                [],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .unwrap();

        let msg = add_message(&db, "t1", "agent", "  hi there ", Some("cli"), None, &[]).unwrap();
        assert_eq!(msg.body, "hi there");
        let thread = get_thread(&db, "t1").unwrap().unwrap();
        assert_eq!(thread.last_activity_at, msg.created_at);
        assert!(add_message(&db, "t1", "robot", "x", None, None, &[]).is_err());
        assert!(add_message(&db, "t1", "user", "   ", None, None, &[]).is_err());
        let with_image =
            add_message(&db, "t1", "user", "", None, None, &["/tmp/a.png".to_string()]).unwrap();
        assert_eq!(with_image.attachments, vec!["/tmp/a.png".to_string()]);
        assert!(get_thread(&db, "missing").unwrap().is_none());
        assert!(validate_thread_id("../etc").is_err());
    }
}
