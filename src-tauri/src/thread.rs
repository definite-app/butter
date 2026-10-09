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
const MESSAGE_COLUMNS: &str = "id, session_id, role, body, source, status, created_at";

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

/// Scratch working directory for a thread: ~/.butter/threads/<session_id>/
fn thread_dir(session_id: &str) -> Result<PathBuf, String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid thread id".to_string());
    }
    Ok(crate::paths::butter_home()?.join("threads").join(session_id))
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
) -> Result<ThreadMessage, String> {
    if role != "user" && role != "agent" {
        return Err(format!("Invalid thread message role: {role}"));
    }
    let body = body.trim();
    if body.is_empty() {
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
    };
    db.with_conn(|conn| {
        conn.execute(
            &format!("INSERT INTO thread_messages ({MESSAGE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"),
            params![
                message.id,
                message.session_id,
                message.role,
                message.body,
                message.source,
                message.status,
                message.created_at
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
    let dir = thread_dir(&session_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create thread dir: {e}"))?;
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
    db: State<Arc<AgentDatabase>>,
) -> Result<ThreadMessage, String> {
    if get_thread(&db, &session_id)?.is_none() {
        return Err("Thread not found".to_string());
    }
    add_message(
        &db,
        &session_id,
        &role,
        &body,
        source.as_deref(),
        status.as_deref(),
    )
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
    // Reuse the thread dir validation, but keep staging files out of the agent's cwd.
    thread_dir(&session_id)?;
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
    let instructions_path = dir.join("instructions.txt");
    std::fs::write(&instructions_path, instructions)
        .map_err(|e| format!("Failed to write instructions: {e}"))?;
    Ok(ThreadLaunchFiles {
        prompt_path,
        instructions_path: instructions_path.to_string_lossy().to_string(),
    })
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

        let msg = add_message(&db, "t1", "agent", "  hi there ", Some("cli"), None).unwrap();
        assert_eq!(msg.body, "hi there");
        let thread = get_thread(&db, "t1").unwrap().unwrap();
        assert_eq!(thread.last_activity_at, msg.created_at);
        assert!(add_message(&db, "t1", "robot", "x", None, None).is_err());
        assert!(add_message(&db, "t1", "user", "   ", None, None).is_err());
        assert!(get_thread(&db, "missing").unwrap().is_none());
        assert!(thread_dir("../etc").is_err());
    }
}
