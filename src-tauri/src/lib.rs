mod agent_types;
mod browser;
mod cc_search;
mod clipboard_history;
mod config;
mod database;
mod http_server;
mod pty;
mod thread;

use agent_types::*;
use browser::{
    BrowserActionCallback, BrowserBounds, BrowserConsoleEvent, BrowserManager, BrowserNetworkEvent,
    BrowserSessionState,
};
use database::{
    AgentDatabase, ClipboardEntry, CreateSessionRequest, Session, SessionAgentUpdate,
    SessionScrollback, TeamAgentRun, TeamAgentRunInput, TeamAgentRunUpdate, TeamChannel,
    TeamChannelInput, TeamConversation, TeamInboxItem, TeamMessage, TeamMessageInput, TeamPin,
    TeamPinInput, TeamSearchResult, TeamUser, TeamUserInput, UpdateSessionRequest,
};
use pty::PtyManager;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write as IoWrite;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tauri::{Manager, State, WebviewWindow};

fn activity_log(msg: &str) {
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/butter-activity.log")
    {
        let _ = writeln!(f, "[{}] {}", chrono::Local::now().format("%H:%M:%S"), msg);
    }
}

fn pty_cwd_by_id(manager: &PtyManager, id: &str) -> Result<String, String> {
    let pid = manager
        .get_pid(id)?
        .ok_or_else(|| "Could not get process ID".to_string())?;

    let output = std::process::Command::new("lsof")
        .args(["-a", "-d", "cwd", "-Fn", "-p", &pid.to_string()])
        .output()
        .map_err(|e| format!("Failed to run lsof: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix('n') {
            if !path.is_empty() {
                return Ok(path.to_string());
            }
        }
    }

    Err("Could not determine current working directory".to_string())
}

fn bind_agent_api_listener() -> Result<TcpListener, String> {
    for port in 9876..=9976 {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => return Ok(listener),
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(err) => {
                return Err(format!(
                    "Failed to bind agent API listener on 127.0.0.1:{port}: {err}"
                ));
            }
        }
    }

    TcpListener::bind(("127.0.0.1", 0))
        .map_err(|err| format!("Failed to bind fallback agent API listener on localhost: {err}"))
}

#[derive(Serialize)]
struct ClipboardImagePayload {
    mime: String,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingTranscriptionResult {
    video_path: String,
    transcript_path: String,
    transcript_json_path: String,
    transcript_text: String,
    model: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingClipboardEvent {
    timestamp_ms: u64,
    text: String,
}

#[tauri::command]
fn focus_manager_window(window: WebviewWindow) -> Result<(), String> {
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_window_width(width: u32, window: WebviewWindow) -> Result<(), String> {
    let current_size = window.outer_size().map_err(|e| e.to_string())?;
    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width,
            height: current_size.height,
        }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn minimize_manager_window(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_create(
    id: Option<String>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    command: Option<String>,
    manager: State<PtyManager>,
    browser_manager: State<Arc<BrowserManager>>,
) -> Result<String, String> {
    let session_id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    browser_manager.register_session_directory(&session_id, cwd.as_deref())?;
    let extra_env = browser_manager.shell_env(&session_id)?;
    manager.create(Some(session_id), rows, cols, cwd, command, Some(extra_env))
}

#[tauri::command]
fn pty_write(id: String, data: String, manager: State<PtyManager>) -> Result<(), String> {
    manager.write(&id, data)
}

#[tauri::command]
fn pty_resize(id: String, rows: u16, cols: u16, manager: State<PtyManager>) -> Result<(), String> {
    manager.resize(&id, rows, cols)
}

#[tauri::command]
fn pty_close(id: String, manager: State<PtyManager>) -> Result<(), String> {
    manager.close(&id)
}

#[tauri::command]
fn browser_open(
    session_id: String,
    url: Option<String>,
    manager: State<Arc<BrowserManager>>,
    pty_manager: State<PtyManager>,
) -> Result<BrowserSessionState, String> {
    if let Ok(cwd) = pty_cwd_by_id(&pty_manager, &session_id) {
        let _ = manager.register_session_directory(&session_id, Some(&cwd));
    }
    manager.open(&session_id, url)
}

#[tauri::command]
fn browser_close(session_id: String, manager: State<Arc<BrowserManager>>) -> Result<(), String> {
    manager.close(&session_id)
}

#[tauri::command]
fn browser_navigate(
    session_id: String,
    url: String,
    manager: State<Arc<BrowserManager>>,
    pty_manager: State<PtyManager>,
) -> Result<BrowserSessionState, String> {
    if let Ok(cwd) = pty_cwd_by_id(&pty_manager, &session_id) {
        let _ = manager.register_session_directory(&session_id, Some(&cwd));
    }
    manager.navigate(&session_id, &url)
}

#[tauri::command]
fn browser_reload(
    session_id: String,
    manager: State<Arc<BrowserManager>>,
) -> Result<BrowserSessionState, String> {
    manager.reload(&session_id)
}

#[tauri::command]
fn browser_go_back(
    session_id: String,
    manager: State<Arc<BrowserManager>>,
) -> Result<BrowserSessionState, String> {
    manager.go_back(&session_id)
}

#[tauri::command]
fn browser_go_forward(
    session_id: String,
    manager: State<Arc<BrowserManager>>,
) -> Result<BrowserSessionState, String> {
    manager.go_forward(&session_id)
}

#[tauri::command]
fn browser_set_bounds(
    session_id: String,
    bounds: BrowserBounds,
    manager: State<Arc<BrowserManager>>,
) -> Result<BrowserSessionState, String> {
    manager.set_bounds(&session_id, bounds)
}

#[tauri::command]
fn browser_set_visible(
    session_id: String,
    visible: bool,
    manager: State<Arc<BrowserManager>>,
) -> Result<BrowserSessionState, String> {
    manager.set_visible(&session_id, visible)
}

#[tauri::command]
fn browser_get_state(
    session_id: String,
    manager: State<Arc<BrowserManager>>,
) -> Result<BrowserSessionState, String> {
    manager.get_state(&session_id)
}

#[tauri::command]
fn browser_open_devtools(
    session_id: String,
    manager: State<Arc<BrowserManager>>,
) -> Result<(), String> {
    manager.open_devtools(&session_id)
}

#[tauri::command]
fn browser_close_devtools(
    session_id: String,
    manager: State<Arc<BrowserManager>>,
) -> Result<(), String> {
    manager.close_devtools(&session_id)
}

#[tauri::command]
fn browser_clear_profile(
    session_id: String,
    manager: State<Arc<BrowserManager>>,
) -> Result<(), String> {
    manager.clear_profile_state(&session_id)
}

#[tauri::command]
fn browser_ipc_callback(
    payload: BrowserActionCallback,
    manager: State<Arc<BrowserManager>>,
) -> Result<(), String> {
    manager.resolve_callback(payload)
}

#[tauri::command]
fn browser_console_event(
    payload: BrowserConsoleEvent,
    manager: State<Arc<BrowserManager>>,
) -> Result<(), String> {
    manager.record_console_event(payload)
}

#[tauri::command]
fn browser_network_event(
    payload: BrowserNetworkEvent,
    manager: State<Arc<BrowserManager>>,
) -> Result<(), String> {
    manager.record_network_event(payload)
}

#[derive(Serialize)]
struct ClaudeActivity {
    id: String,
    state: String,
    since: Option<i64>,
}

#[derive(Serialize)]
struct AgentSessionActivity {
    id: String,
    session_id: Option<String>,
}

/// Check if a `claude` process is running as a child of the given shell PID.
fn is_claude_running(shell_pid: u32) -> bool {
    std::process::Command::new("pgrep")
        .args(["-P", &shell_pid.to_string(), "-f", "claude"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if a `codex` process is running as a child of the given shell PID.
fn is_codex_running(shell_pid: u32) -> bool {
    std::process::Command::new("pgrep")
        .args(["-P", &shell_pid.to_string(), "-f", "codex"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

static CLEANUP_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

#[tauri::command(async)]
fn get_claude_activity(
    ids: Vec<String>,
    manager: State<'_, PtyManager>,
    db: State<'_, Arc<AgentDatabase>>,
) -> Vec<ClaudeActivity> {
    // Cleanup old events every ~20 polls (~60s) instead of every call
    let count = CLEANUP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if count % 20 == 0 {
        let _ = db.cleanup_old_hook_events(86400);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    activity_log(&format!("polling {} PTY ids: {:?}", ids.len(), ids));

    ids.into_iter()
        .map(|id| {
            let pid = manager.get_pid(&id).ok().flatten();
            activity_log(&format!("  pty={} -> pid={:?}", id, pid));

            let (state, since) = match pid {
                Some(pid) => {
                    let claude_alive = is_claude_running(pid);
                    activity_log(&format!("    pid={} claude_alive={}", pid, claude_alive));

                    if !claude_alive {
                        ("unknown".to_string(), None)
                    } else {
                        match db.get_latest_hook_event_by_pid(pid) {
                            Ok(Some((event, ts))) => {
                                activity_log(&format!(
                                    "    pid={} event={} ts={} age={}s",
                                    pid,
                                    event,
                                    ts,
                                    now - ts
                                ));
                                if now - ts > 300 {
                                    ("unknown".to_string(), None)
                                } else if event == "UserPromptSubmit" {
                                    ("working".to_string(), Some(ts))
                                } else if event == "Stop" {
                                    ("idle".to_string(), Some(ts))
                                } else {
                                    ("unknown".to_string(), None)
                                }
                            }
                            Ok(None) => {
                                activity_log(&format!("    pid={} no events in db", pid));
                                ("unknown".to_string(), None)
                            }
                            Err(e) => {
                                activity_log(&format!("    pid={} db error: {}", pid, e));
                                ("unknown".to_string(), None)
                            }
                        }
                    }
                }
                None => ("unknown".to_string(), None),
            };

            activity_log(&format!("  pty={} => state={}", id, state));
            ClaudeActivity { id, state, since }
        })
        .collect()
}

#[tauri::command(async)]
fn get_codex_activity(
    ids: Vec<String>,
    manager: State<'_, PtyManager>,
    db: State<'_, Arc<AgentDatabase>>,
) -> Vec<ClaudeActivity> {
    // Cleanup old events every ~20 polls (~60s) instead of every call
    let count = CLEANUP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if count % 20 == 0 {
        let _ = db.cleanup_old_hook_events(86400);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    activity_log(&format!("polling codex {} PTY ids: {:?}", ids.len(), ids));

    ids.into_iter()
        .map(|id| {
            let pid = manager.get_pid(&id).ok().flatten();
            activity_log(&format!("  codex pty={} -> pid={:?}", id, pid));

            let (state, since) = match pid {
                Some(pid) => {
                    let codex_alive = is_codex_running(pid);
                    activity_log(&format!("    codex pid={} alive={}", pid, codex_alive));

                    match db.get_latest_hook_event_by_pid(pid) {
                        Ok(Some((event, ts))) => {
                            activity_log(&format!(
                                "    codex pid={} event={} ts={} age={}s",
                                pid,
                                event,
                                ts,
                                now - ts
                            ));
                            if now - ts > 300 {
                                ("unknown".to_string(), None)
                            } else if event == "agent-turn-complete" || event == "Stop" {
                                ("idle".to_string(), Some(ts))
                            } else if event == "UserPromptSubmit" {
                                ("working".to_string(), Some(ts))
                            } else if codex_alive {
                                ("working".to_string(), Some(ts))
                            } else {
                                ("unknown".to_string(), None)
                            }
                        }
                        Ok(None) => {
                            activity_log(&format!("    codex pid={} no events in db", pid));
                            if codex_alive {
                                ("working".to_string(), None)
                            } else {
                                ("unknown".to_string(), None)
                            }
                        }
                        Err(e) => {
                            activity_log(&format!("    codex pid={} db error: {}", pid, e));
                            ("unknown".to_string(), None)
                        }
                    }
                }
                None => ("unknown".to_string(), None),
            };

            activity_log(&format!("  codex pty={} => state={}", id, state));
            ClaudeActivity { id, state, since }
        })
        .collect()
}

#[tauri::command(async)]
fn get_agent_session_ids(
    ids: Vec<String>,
    manager: State<'_, PtyManager>,
    db: State<'_, Arc<AgentDatabase>>,
) -> Vec<AgentSessionActivity> {
    ids.into_iter()
        .map(|id| {
            let session_id = manager
                .get_pid(&id)
                .ok()
                .flatten()
                .and_then(|pid| db.get_latest_hook_session_id_by_pid(pid).ok().flatten());
            AgentSessionActivity { id, session_id }
        })
        .collect()
}

fn normalize_prompt_title(prompt: &str) -> Option<String> {
    let lower = prompt.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }

    let words: Vec<&str> = lower
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect();
    if words.is_empty() {
        return None;
    }

    let mut slug = String::new();
    for word in words {
        if slug.is_empty() {
            if word.len() > 48 {
                slug.push_str(&word[..48]);
                break;
            }
            slug.push_str(word);
            continue;
        }

        let next_len = slug.len() + 1 + word.len();
        if next_len > 48 {
            break;
        }
        slug.push('-');
        slug.push_str(word);
    }

    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

#[tauri::command(async)]
fn get_agent_first_prompt_title(
    session_id: String,
    db: State<'_, Arc<AgentDatabase>>,
) -> Result<Option<String>, String> {
    let first_prompt = db.get_first_user_prompt_by_agent_session_id(&session_id)?;
    Ok(first_prompt.and_then(|prompt| normalize_prompt_title(&prompt)))
}

#[derive(Serialize, Deserialize, Clone)]
struct FileEntry {
    name: String,
    path: String,
    relative_path: String,
    is_dir: bool,
    is_hidden: bool,
    size: Option<u64>,
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let expanded = expand_path(&path);

    let mut entries = Vec::new();
    let read_dir =
        fs::read_dir(&expanded).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let file_path = entry.path().to_string_lossy().to_string();
        let metadata = entry.metadata();
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = if is_dir {
            None
        } else {
            metadata.as_ref().map(|m| m.len()).ok()
        };
        let is_hidden = name.starts_with('.');

        entries.push(FileEntry {
            name: name.clone(),
            path: file_path,
            relative_path: name,
            is_dir,
            is_hidden,
            size,
        });
    }

    // Sort: directories first, then alphabetically (case-insensitive)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

fn expand_path(path: &str) -> String {
    if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped).to_string_lossy().to_string();
        }
    } else if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().to_string();
        }
    }
    path.to_string()
}

// Directories to skip during recursive search
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "target",
    "build",
    "dist",
    "__pycache__",
    ".next",
    ".nuxt",
    ".cache",
    ".venv",
    "venv",
    ".tox",
    "vendor",
    "Pods",
    ".gradle",
    ".idea",
    ".vscode",
];

#[tauri::command(async)]
fn search_directory(
    path: String,
    query: String,
    include_hidden: bool,
) -> Result<Vec<FileEntry>, String> {
    let expanded = expand_path(&path);
    let query_lower = query.to_lowercase();
    let base = std::path::Path::new(&expanded);
    let mut results = Vec::new();

    fn walk(
        dir: &std::path::Path,
        base: &std::path::Path,
        query: &str,
        include_hidden: bool,
        results: &mut Vec<FileEntry>,
        depth: usize,
    ) {
        if depth > 4 || results.len() >= 100 {
            return;
        }
        let read_dir = match fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => return,
        };
        for entry in read_dir {
            if results.len() >= 100 {
                return;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let is_hidden = name.starts_with('.');

            // Skip hidden entries when not included, and always skip heavy dirs
            if is_hidden && !include_hidden {
                continue;
            }
            let metadata = entry.metadata();
            let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);

            if is_dir && SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }

            let name_lower = name.to_lowercase();

            if name_lower.contains(query) {
                let file_path = entry.path().to_string_lossy().to_string();
                let relative = entry
                    .path()
                    .strip_prefix(base)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| name.clone());
                let size = if is_dir {
                    None
                } else {
                    metadata.as_ref().map(|m| m.len()).ok()
                };
                results.push(FileEntry {
                    name: name.clone(),
                    path: file_path,
                    relative_path: relative,
                    is_dir,
                    is_hidden,
                    size,
                });
            }

            // Recurse into subdirectories
            if is_dir {
                walk(
                    &entry.path(),
                    base,
                    query,
                    include_hidden,
                    results,
                    depth + 1,
                );
            }
        }
    }

    walk(base, base, &query_lower, include_hidden, &mut results, 0);

    // Sort: directories first, then by relative path depth (shallower first), then alphabetical
    results.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| {
                let a_depth = a.relative_path.matches('/').count();
                let b_depth = b.relative_path.matches('/').count();
                a_depth.cmp(&b_depth)
            })
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(results)
}

#[tauri::command]
fn get_pty_cwd(id: String, manager: State<PtyManager>) -> Result<String, String> {
    pty_cwd_by_id(&manager, &id)
}

#[tauri::command]
fn rename_terminal(_index: usize, _new_name: String) -> Result<(), String> {
    // Store custom names in app state or config file
    // The actual window title comes from the shell, so we track overrides separately
    Ok(())
}

// ============================================================================
// Agent API Tauri Commands (for UI)
// ============================================================================

#[tauri::command]
fn get_agents(db: State<Arc<AgentDatabase>>) -> Result<Vec<Agent>, String> {
    db.list_agents()
}

#[tauri::command]
fn get_agent_messages(
    agent_id: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<Vec<Message>, String> {
    db.get_inbox(&agent_id, None)
}

#[tauri::command]
fn get_pending_messages(
    agent_id: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<Vec<Message>, String> {
    db.get_inbox(&agent_id, Some("pending"))
}

#[tauri::command]
fn get_agent_tasks(
    agent_id: Option<String>,
    db: State<Arc<AgentDatabase>>,
) -> Result<Vec<Task>, String> {
    db.list_tasks(agent_id.as_deref(), None, None)
}

#[tauri::command]
fn get_all_tasks(db: State<Arc<AgentDatabase>>) -> Result<Vec<Task>, String> {
    db.list_tasks(None, None, None)
}

// ============================================================================
// Session Persistence Tauri Commands
// ============================================================================

#[tauri::command]
fn db_create_session(
    req: CreateSessionRequest,
    db: State<Arc<AgentDatabase>>,
) -> Result<(), String> {
    db.create_session(&req)
}

#[tauri::command]
fn db_update_session(
    id: String,
    req: UpdateSessionRequest,
    db: State<Arc<AgentDatabase>>,
) -> Result<(), String> {
    db.update_session(&id, &req)
}

#[tauri::command]
fn db_set_session_agent(
    req: SessionAgentUpdate,
    db: State<Arc<AgentDatabase>>,
) -> Result<(), String> {
    db.set_session_agent(&req)
}

#[tauri::command]
fn db_get_app_state(key: String, db: State<Arc<AgentDatabase>>) -> Result<Option<String>, String> {
    db.get_app_state(&key)
}

#[tauri::command]
fn db_set_app_state(
    key: String,
    value: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<(), String> {
    db.set_app_state(&key, &value)
}

#[tauri::command]
fn team_list_users(db: State<Arc<AgentDatabase>>) -> Result<Vec<TeamUser>, String> {
    db.list_team_users()
}

#[tauri::command]
fn team_save_user(req: TeamUserInput, db: State<Arc<AgentDatabase>>) -> Result<TeamUser, String> {
    db.save_team_user(&req)
}

#[tauri::command]
fn team_list_channels(db: State<Arc<AgentDatabase>>) -> Result<Vec<TeamChannel>, String> {
    db.list_team_channels()
}

#[tauri::command]
fn team_save_channel(
    req: TeamChannelInput,
    db: State<Arc<AgentDatabase>>,
) -> Result<TeamChannel, String> {
    db.save_team_channel(&req)
}

#[tauri::command]
fn team_list_conversations(db: State<Arc<AgentDatabase>>) -> Result<Vec<TeamConversation>, String> {
    db.list_team_conversations()
}

#[tauri::command]
fn team_get_channel_conversation(
    channel_id: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<Option<TeamConversation>, String> {
    db.get_team_conversation_for_channel(&channel_id)
}

#[tauri::command]
fn team_get_or_create_dm(
    user_id: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<TeamConversation, String> {
    db.get_or_create_team_dm(&user_id)
}

#[tauri::command]
fn team_list_messages(
    conversation_id: String,
    parent_message_id: Option<String>,
    db: State<Arc<AgentDatabase>>,
) -> Result<Vec<TeamMessage>, String> {
    db.list_team_messages(&conversation_id, parent_message_id.as_deref())
}

#[tauri::command]
fn team_send_message(
    req: TeamMessageInput,
    db: State<Arc<AgentDatabase>>,
) -> Result<TeamMessage, String> {
    db.create_team_message(&req)
}

#[tauri::command]
fn team_mark_message_read(message_id: String, db: State<Arc<AgentDatabase>>) -> Result<(), String> {
    db.mark_team_message_read(&message_id)
}

#[tauri::command]
fn team_mark_message_unread(
    message_id: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<(), String> {
    db.mark_team_message_unread(&message_id)
}

#[tauri::command]
fn team_mark_conversation_read(
    conversation_id: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<(), String> {
    db.mark_team_conversation_read(&conversation_id)
}

#[tauri::command]
fn team_mark_thread_read(
    parent_message_id: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<(), String> {
    db.mark_team_thread_read(&parent_message_id)
}

#[tauri::command]
fn team_create_agent_run(
    req: TeamAgentRunInput,
    db: State<Arc<AgentDatabase>>,
) -> Result<TeamAgentRun, String> {
    db.create_team_agent_run(&req)
}

#[tauri::command]
fn team_update_agent_run(
    id: String,
    req: TeamAgentRunUpdate,
    db: State<Arc<AgentDatabase>>,
) -> Result<TeamAgentRun, String> {
    db.update_team_agent_run(&id, &req)
}

#[tauri::command]
fn team_list_agent_runs(db: State<Arc<AgentDatabase>>) -> Result<Vec<TeamAgentRun>, String> {
    db.list_team_agent_runs()
}

#[tauri::command]
fn team_get_inbox(
    include_read: Option<bool>,
    limit: Option<usize>,
    db: State<Arc<AgentDatabase>>,
) -> Result<Vec<TeamInboxItem>, String> {
    db.get_team_inbox(include_read.unwrap_or(false), limit)
}

#[tauri::command]
fn team_search_messages(
    q: String,
    limit: Option<usize>,
    advanced: Option<bool>,
    db: State<Arc<AgentDatabase>>,
) -> Result<Vec<TeamSearchResult>, String> {
    if advanced.unwrap_or(false) {
        return db.search_team_messages_advanced(&q, limit);
    }
    db.search_team_messages(&q, limit)
}

#[tauri::command]
fn team_list_pins(db: State<Arc<AgentDatabase>>) -> Result<Vec<TeamPin>, String> {
    db.list_team_pins()
}

#[tauri::command]
fn team_save_pin(req: TeamPinInput, db: State<Arc<AgentDatabase>>) -> Result<TeamPin, String> {
    db.save_team_pin(&req)
}

#[tauri::command]
fn team_delete_pin(id: String, db: State<Arc<AgentDatabase>>) -> Result<(), String> {
    db.delete_team_pin(&id)
}

#[tauri::command]
fn db_list_sessions(db: State<Arc<AgentDatabase>>) -> Result<Vec<Session>, String> {
    db.list_sessions()
}

#[tauri::command]
fn db_get_session(id: String, db: State<Arc<AgentDatabase>>) -> Result<Option<Session>, String> {
    db.get_session(&id)
}

#[tauri::command]
fn db_close_session(id: String, db: State<Arc<AgentDatabase>>) -> Result<(), String> {
    db.close_session(&id)
}

#[tauri::command]
fn db_reopen_session(id: String, db: State<Arc<AgentDatabase>>) -> Result<(), String> {
    db.reopen_session(&id)
}

#[tauri::command]
fn db_list_closed_sessions(
    limit: Option<u32>,
    db: State<Arc<AgentDatabase>>,
) -> Result<Vec<Session>, String> {
    db.list_closed_sessions(limit.map(|value| value as usize))
}

#[tauri::command]
fn db_delete_session(id: String, db: State<Arc<AgentDatabase>>) -> Result<(), String> {
    db.delete_session(&id)
}

#[tauri::command]
fn db_get_session_tags(
    session_id: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<Vec<String>, String> {
    db.get_session_tags(&session_id)
}

#[tauri::command]
fn db_set_session_tags(
    session_id: String,
    tags: Vec<String>,
    db: State<Arc<AgentDatabase>>,
) -> Result<(), String> {
    db.set_session_tags(&session_id, &tags)
}

#[tauri::command]
fn db_get_all_session_tags(
    db: State<Arc<AgentDatabase>>,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    db.get_all_session_tags()
}

#[tauri::command]
fn db_save_scrollback(
    session_id: String,
    content: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<(), String> {
    db.save_scrollback(&session_id, &content)
}

#[tauri::command]
fn db_get_scrollback(
    session_id: String,
    db: State<Arc<AgentDatabase>>,
) -> Result<Option<SessionScrollback>, String> {
    db.get_scrollback(&session_id)
}

#[tauri::command]
fn db_delete_scrollback(session_id: String, db: State<Arc<AgentDatabase>>) -> Result<(), String> {
    db.delete_scrollback(&session_id)
}

// ============================================================================
// Config Tauri Commands
// ============================================================================

#[tauri::command]
fn get_config() -> Result<config::Config, String> {
    config::load_config()
}

#[tauri::command]
fn save_config(config: config::Config) -> Result<(), String> {
    config::save_config(&config)
}

#[tauri::command]
fn get_config_path() -> String {
    config::config_path().to_string_lossy().to_string()
}

#[tauri::command]
fn git_worktree_create(
    repo_dir: String,
    worktree_name: String,
    branch_name: String,
) -> Result<String, String> {
    let root_output = Command::new("git")
        .args(["-C", &repo_dir, "rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;
    if !root_output.status.success() {
        return Err(format!(
            "Failed to resolve repo root: {}",
            String::from_utf8_lossy(&root_output.stderr).trim()
        ));
    }
    let root = String::from_utf8_lossy(&root_output.stdout)
        .trim()
        .to_string();
    if root.is_empty() {
        return Err("Failed to resolve repo root: empty output".to_string());
    }

    let root_path = PathBuf::from(&root);
    let parent = root_path
        .parent()
        .ok_or_else(|| "Failed to resolve repo root parent".to_string())?;
    let worktree_base = parent.join("worktrees");
    fs::create_dir_all(&worktree_base)
        .map_err(|e| format!("Failed to create worktree base: {}", e))?;
    let worktree_path = worktree_base.join(&worktree_name);
    if worktree_path.exists() {
        return Err(format!(
            "Worktree path already exists: {}",
            worktree_path.to_string_lossy()
        ));
    }

    let worktree_str = worktree_path.to_string_lossy().to_string();
    let output = Command::new("git")
        .args([
            "-C",
            &root,
            "worktree",
            "add",
            &worktree_str,
            "-b",
            &branch_name,
        ])
        .output()
        .map_err(|e| format!("Failed to execute git worktree add: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to create worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(worktree_str)
}

#[tauri::command]
fn read_file_binary(path: String) -> Result<Vec<u8>, String> {
    let expanded = if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(stripped).to_string_lossy().to_string()
        } else {
            path.clone()
        }
    } else {
        path.clone()
    };
    std::fs::read(expanded).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_text(path: String, max_bytes: Option<usize>) -> Result<String, String> {
    let expanded = expand_path(&path);
    let limit = max_bytes
        .unwrap_or(512 * 1024)
        .clamp(4 * 1024, 2 * 1024 * 1024);
    if let Ok(metadata) = std::fs::metadata(&expanded) {
        if metadata.len() > limit as u64 {
            return Err(format!(
                "File too large for inline preview ({} bytes > {} bytes)",
                metadata.len(),
                limit
            ));
        }
    }
    let bytes = std::fs::read(expanded).map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err(format!(
            "File too large for inline preview ({} bytes > {} bytes)",
            bytes.len(),
            limit
        ));
    }
    String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text".to_string())
}

#[tauri::command]
fn write_file_text(path: String, content: String) -> Result<(), String> {
    let expanded = expand_path(&path);
    fs::write(expanded, content).map_err(|e| e.to_string())
}

/// Return the file's mtime (unix ms) and size. Used by frontend polling to
/// cheaply detect external file changes without reading content.
#[tauri::command]
fn stat_file(path: String) -> Result<FileStat, String> {
    let expanded = expand_path(&path);
    let metadata = std::fs::metadata(&expanded).map_err(|e| e.to_string())?;
    let mtime = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    Ok(FileStat {
        mtime_ms: mtime,
        size: metadata.len(),
    })
}

#[derive(Serialize)]
struct FileStat {
    mtime_ms: u64,
    size: u64,
}

#[tauri::command]
fn write_file_binary(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let expanded = if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(stripped)
        } else {
            PathBuf::from(path.clone())
        }
    } else {
        PathBuf::from(path.clone())
    };
    let parent = expanded
        .parent()
        .ok_or_else(|| "Invalid path".to_string())?;
    let allowed_dir = paste_images_dir()?;
    let allowed_canon = fs::canonicalize(&allowed_dir).map_err(|e| e.to_string())?;
    let parent_canon = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !parent_canon.starts_with(&allowed_canon) {
        return Err("Refusing to write outside paste images directory".to_string());
    }
    fs::write(&expanded, bytes).map_err(|e| e.to_string())
}

fn ensure_path_in_paste_images(path: &Path) -> Result<(), String> {
    let allowed_dir = paste_images_dir()?;
    fs::create_dir_all(&allowed_dir).map_err(|e| e.to_string())?;
    let allowed_canon = fs::canonicalize(&allowed_dir).map_err(|e| e.to_string())?;
    let path_canon = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !path_canon.starts_with(&allowed_canon) {
        return Err("Refusing to access files outside paste images directory".to_string());
    }
    Ok(())
}

fn ensure_parent_in_paste_images(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "Invalid path".to_string())?;
    let allowed_dir = paste_images_dir()?;
    fs::create_dir_all(&allowed_dir).map_err(|e| e.to_string())?;
    let allowed_canon = fs::canonicalize(&allowed_dir).map_err(|e| e.to_string())?;
    let parent_canon = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !parent_canon.starts_with(&allowed_canon) {
        return Err("Refusing to write outside paste images directory".to_string());
    }
    Ok(())
}

fn sanitize_filename(input: &str) -> String {
    let base = Path::new(input)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("recording.webm");
    let mut out = String::with_capacity(base.len());
    for ch in base.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let collapsed = out.trim_matches('.').trim_matches('_');
    if collapsed.is_empty() {
        format!(
            "record-{}.webm",
            chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f")
        )
    } else {
        out
    }
}

const TRANSCRIBE_MEDIA_SCRIPT: &str = r####"#!/usr/bin/env python3
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser(description="Transcribe recording audio with faster-whisper")
    parser.add_argument("--input", required=True, help="Input wav path")
    parser.add_argument("--out-md", required=True, help="Output markdown path")
    parser.add_argument("--out-json", required=True, help="Output json path")
    parser.add_argument("--model", default="base", help="Whisper model size")
    args = parser.parse_args()

    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        args.input,
        beam_size=1,
        language="en",
        vad_filter=True,
    )

    segment_items = []
    full_parts = []
    for segment in segments:
        text = (segment.text or "").strip()
        if not text:
            continue
        full_parts.append(text)
        segment_items.append(
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": text,
            }
        )

    full_text = " ".join(full_parts).strip()
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": args.model,
        "language": getattr(info, "language", None),
        "language_probability": getattr(info, "language_probability", None),
        "full_transcript": full_text,
        "segments": segment_items,
    }
    Path(args.out_json).write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    lines = [
        "# Recording Transcript",
        "",
        f"**Model**: whisper-{args.model}",
        "",
        "## Full Transcript",
        "",
        full_text if full_text else "_No speech detected._",
        "",
        "## Segments",
        "",
    ]
    if segment_items:
        for item in segment_items:
            lines.append(f"- `{item['start']:.2f}s`-{item['end']:.2f}s: {item['text']}")
    else:
        lines.append("- _No segments detected._")
    lines.append("")

    Path(args.out_md).write_text("\n".join(lines), encoding="utf-8")
    print(full_text)


if __name__ == "__main__":
    main()
"####;

fn write_temp_transcribe_script() -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!(
        "butter-transcribe-{}.py",
        chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f")
    ));
    fs::write(&path, TRANSCRIBE_MEDIA_SCRIPT)
        .map_err(|e| format!("Failed to write transcribe script: {}", e))?;
    Ok(path)
}

fn summarized_stderr(output: &[u8]) -> String {
    let text = String::from_utf8_lossy(output);
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return "No stderr output".to_string();
    }
    let take = lines.len().min(20);
    lines[lines.len() - take..].join("\n")
}

fn format_event_timestamp(timestamp_ms: u64) -> String {
    let total_seconds = timestamp_ms / 1000;
    let millis = timestamp_ms % 1000;
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{:02}:{:02}.{:03}", minutes, seconds, millis)
}

fn append_clipboard_events_to_markdown(
    transcript_path: &Path,
    clipboard_events: &[RecordingClipboardEvent],
) -> Result<(), String> {
    if clipboard_events.is_empty() {
        return Ok(());
    }
    let mut content = fs::read_to_string(transcript_path).map_err(|e| e.to_string())?;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str("\n## Clipboard Events\n\n");
    for event in clipboard_events {
        let timestamp = format_event_timestamp(event.timestamp_ms);
        let text = event.text.replace('\n', " ↵ ");
        content.push_str(&format!("- `{}` {}\n", timestamp, text));
    }
    fs::write(transcript_path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_recording_file(filename: String, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Recording payload is empty".to_string());
    }
    let dir = paste_images_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe_filename = sanitize_filename(&filename);
    let path = dir.join(safe_filename);
    ensure_parent_in_paste_images(&path)?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn transcribe_recording_file(
    path: String,
    clipboard_events: Option<Vec<RecordingClipboardEvent>>,
) -> Result<RecordingTranscriptionResult, String> {
    let expanded = PathBuf::from(expand_path(&path));
    if !expanded.exists() {
        return Err(format!(
            "Recording file not found: {}",
            expanded.to_string_lossy()
        ));
    }
    ensure_path_in_paste_images(&expanded)?;

    let parent = expanded
        .parent()
        .ok_or_else(|| "Recording path has no parent directory".to_string())?;
    let stem_raw = expanded
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    let stem = sanitize_filename(stem_raw)
        .trim_end_matches('.')
        .to_string();
    let transcript_path = parent.join(format!("{}.transcript.md", stem));
    let transcript_json_path = parent.join(format!("{}.transcript.json", stem));
    let wav_path = parent.join(format!(
        "{}.transcribe-{}.wav",
        stem,
        chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f")
    ));

    let ffmpeg_output = Command::new("ffmpeg")
        .arg("-y")
        .arg("-i")
        .arg(&expanded)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(&wav_path)
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;
    if !ffmpeg_output.status.success() {
        return Err(format!(
            "Failed to extract audio via ffmpeg:\n{}",
            summarized_stderr(&ffmpeg_output.stderr)
        ));
    }

    let script_path = write_temp_transcribe_script()?;
    let uv_output = Command::new("uv")
        .arg("run")
        .arg("--with")
        .arg("faster-whisper")
        .arg("python")
        .arg(&script_path)
        .arg("--input")
        .arg(&wav_path)
        .arg("--out-md")
        .arg(&transcript_path)
        .arg("--out-json")
        .arg(&transcript_json_path)
        .arg("--model")
        .arg("base")
        .output()
        .map_err(|e| format!("Failed to run uv transcription: {}", e))?;

    let _ = fs::remove_file(&script_path);
    let _ = fs::remove_file(&wav_path);

    if !uv_output.status.success() {
        return Err(format!(
            "Transcription failed:\n{}",
            summarized_stderr(&uv_output.stderr)
        ));
    }

    let mut transcript_json = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(&transcript_json_path).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to parse transcript JSON: {}", e))?;

    if let Some(events) = clipboard_events.as_ref() {
        if !events.is_empty() {
            let values = events
                .iter()
                .map(|event| {
                    serde_json::json!({
                        "timestamp_ms": event.timestamp_ms,
                        "text": event.text
                    })
                })
                .collect::<Vec<_>>();
            if let Some(obj) = transcript_json.as_object_mut() {
                obj.insert(
                    "clipboard_events".to_string(),
                    serde_json::Value::Array(values),
                );
            }
            append_clipboard_events_to_markdown(&transcript_path, events)?;
        }
    }

    let transcript_text = transcript_json
        .get("full_transcript")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();

    let transcript_json_text = serde_json::to_string_pretty(&transcript_json)
        .map_err(|e| format!("Failed to serialize transcript JSON: {}", e))?;
    fs::write(&transcript_json_path, transcript_json_text).map_err(|e| e.to_string())?;

    Ok(RecordingTranscriptionResult {
        video_path: expanded.to_string_lossy().to_string(),
        transcript_path: transcript_path.to_string_lossy().to_string(),
        transcript_json_path: transcript_json_path.to_string_lossy().to_string(),
        transcript_text,
        model: "base".to_string(),
    })
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn read_clipboard_image_native() -> Result<ClipboardImagePayload, String> {
    use objc2::msg_send;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::ClassType;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF};
    use objc2_foundation::NSData;

    autoreleasepool(|_| {
        let pasteboard: Option<Retained<NSPasteboard>> =
            unsafe { msg_send![NSPasteboard::class(), generalPasteboard] };
        let pasteboard = pasteboard.ok_or("Failed to access NSPasteboard")?;
        if let Some(data) = unsafe { pasteboard.dataForType(NSPasteboardTypePNG) } {
            let data: Retained<NSData> = data;
            let bytes = unsafe { data.as_bytes_unchecked() }.to_vec();
            return Ok(ClipboardImagePayload {
                mime: "image/png".to_string(),
                bytes,
            });
        }
        if let Some(data) = unsafe { pasteboard.dataForType(NSPasteboardTypeTIFF) } {
            let data: Retained<NSData> = data;
            let bytes = unsafe { data.as_bytes_unchecked() }.to_vec();
            return Ok(ClipboardImagePayload {
                mime: "image/tiff".to_string(),
                bytes,
            });
        }
        Err("Clipboard image not available".to_string())
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn read_clipboard_image_native() -> Result<ClipboardImagePayload, String> {
    Err("Clipboard image not supported on this platform".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn read_clipboard_types_native() -> Result<Vec<String>, String> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::ClassType;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;

    let pasteboard: Option<Retained<NSPasteboard>> =
        unsafe { msg_send![NSPasteboard::class(), generalPasteboard] };
    let pasteboard = pasteboard.ok_or("Failed to access NSPasteboard")?;
    let mut out = Vec::new();
    if let Some(types) = pasteboard.types() {
        for item in types.iter() {
            let item: &NSString = &item;
            out.push(item.to_string());
        }
    }
    Ok(out)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn read_clipboard_types_native() -> Result<Vec<String>, String> {
    Err("Clipboard types not supported on this platform".to_string())
}

fn butter_files_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join(".config").join("butter"))
}

fn paste_images_dir() -> Result<PathBuf, String> {
    Ok(butter_files_dir()?.join("paste-images"))
}

fn notes_dir() -> Result<PathBuf, String> {
    Ok(butter_files_dir()?.join("notes"))
}

fn enforce_paste_image_limit(dir: &PathBuf, max_files: usize) -> Result<(), String> {
    let mut entries: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            entries.push((modified, path));
        }
    }
    if entries.len() <= max_files {
        return Ok(());
    }
    entries.sort_by_key(|(time, _)| *time);
    let to_remove = entries.len().saturating_sub(max_files);
    for (_, path) in entries.into_iter().take(to_remove) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn save_clipboard_image() -> Result<String, String> {
    let payload = read_clipboard_image_native()?;
    let dir = paste_images_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let extension = match payload.mime.as_str() {
        "image/tiff" => "tiff",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/heic" => "heic",
        "image/heif" => "heif",
        _ => "img",
    };
    let filename = format!(
        "paste-{}.{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f"),
        extension
    );
    let path = dir.join(filename);
    fs::write(&path, payload.bytes).map_err(|e| e.to_string())?;
    enforce_paste_image_limit(&dir, 100)?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn save_clipboard_image() -> Result<String, String> {
    Err("Clipboard image not supported on this platform".to_string())
}

#[tauri::command]
fn save_team_note_file(content: String) -> Result<String, String> {
    if content.trim().is_empty() {
        return Err("note content is required".to_string());
    }
    let dir = notes_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let filename = format!(
        "note-{}.md",
        chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f")
    );
    let path = dir.join(sanitize_filename(&filename));
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn clipboard_history_list(db: State<Arc<AgentDatabase>>) -> Result<Vec<ClipboardEntry>, String> {
    clipboard_history::list(db.inner())
}

#[tauri::command]
fn clipboard_history_delete(id: i64, db: State<Arc<AgentDatabase>>) -> Result<(), String> {
    clipboard_history::delete(db.inner(), id)
}

#[tauri::command]
fn clipboard_history_clear(db: State<Arc<AgentDatabase>>) -> Result<(), String> {
    clipboard_history::clear(db.inner())
}

#[tauri::command]
fn clipboard_history_compose(
    app: tauri::AppHandle,
    ids: Vec<i64>,
    separator: Option<String>,
    include_source: Option<bool>,
    db: State<Arc<AgentDatabase>>,
) -> Result<String, String> {
    let sep = separator.unwrap_or_else(|| "\n\n".to_string());
    let include = include_source.unwrap_or(true);
    clipboard_history::compose(&app, db.inner(), &ids, &sep, include)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .menu(|app_handle| {
            use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};

            let pkg_info = app_handle.package_info();
            let config = app_handle.config();
            let about_metadata = AboutMetadata {
                name: Some(pkg_info.name.clone()),
                version: Some(pkg_info.version.to_string()),
                copyright: config.bundle.copyright.clone(),
                authors: config.bundle.publisher.clone().map(|p| vec![p]),
                ..Default::default()
            };

            Menu::with_items(
                app_handle,
                &[
                    #[cfg(target_os = "macos")]
                    &Submenu::with_items(
                        app_handle,
                        pkg_info.name.clone(),
                        true,
                        &[
                            &PredefinedMenuItem::about(app_handle, None, Some(about_metadata))?,
                            &PredefinedMenuItem::separator(app_handle)?,
                            &PredefinedMenuItem::services(app_handle, None)?,
                            &PredefinedMenuItem::separator(app_handle)?,
                            &PredefinedMenuItem::hide(app_handle, None)?,
                            &PredefinedMenuItem::hide_others(app_handle, None)?,
                            &PredefinedMenuItem::separator(app_handle)?,
                            &PredefinedMenuItem::quit(app_handle, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app_handle,
                        "File",
                        true,
                        &[&PredefinedMenuItem::close_window(app_handle, None)?],
                    )?,
                    &Submenu::with_items(
                        app_handle,
                        "Edit",
                        true,
                        &[
                            &PredefinedMenuItem::undo(app_handle, None)?,
                            &PredefinedMenuItem::redo(app_handle, None)?,
                            &PredefinedMenuItem::separator(app_handle)?,
                            &PredefinedMenuItem::cut(app_handle, None)?,
                            &PredefinedMenuItem::copy(app_handle, None)?,
                            &PredefinedMenuItem::paste(app_handle, None)?,
                            // Intentionally omit select_all: otherwise macOS
                            // swallows Cmd+A at the menu level before the
                            // webview (Monaco, xterm, inputs) can handle it.
                        ],
                    )?,
                    #[cfg(target_os = "macos")]
                    &Submenu::with_items(
                        app_handle,
                        "View",
                        true,
                        &[&PredefinedMenuItem::fullscreen(app_handle, None)?],
                    )?,
                    &Submenu::with_items(
                        app_handle,
                        "Window",
                        true,
                        &[
                            &PredefinedMenuItem::minimize(app_handle, None)?,
                            &PredefinedMenuItem::maximize(app_handle, None)?,
                            #[cfg(target_os = "macos")]
                            &PredefinedMenuItem::separator(app_handle)?,
                            &PredefinedMenuItem::close_window(app_handle, None)?,
                        ],
                    )?,
                ],
            )
        })
        .invoke_handler(tauri::generate_handler![
            focus_manager_window,
            set_window_width,
            minimize_manager_window,
            pty_create,
            pty_write,
            pty_resize,
            pty_close,
            browser_open,
            browser_close,
            browser_navigate,
            browser_reload,
            browser_go_back,
            browser_go_forward,
            browser_set_bounds,
            browser_set_visible,
            browser_get_state,
            browser_open_devtools,
            browser_close_devtools,
            browser_clear_profile,
            browser_ipc_callback,
            browser_console_event,
            browser_network_event,
            get_claude_activity,
            get_codex_activity,
            get_agent_session_ids,
            get_agent_first_prompt_title,
            get_pty_cwd,
            list_directory,
            search_directory,
            rename_terminal,
            // Agent API commands
            get_agents,
            get_agent_messages,
            get_pending_messages,
            get_agent_tasks,
            get_all_tasks,
            // Session persistence commands
            db_create_session,
            db_update_session,
            db_set_session_agent,
            db_get_app_state,
            db_set_app_state,
            team_list_users,
            team_save_user,
            team_list_channels,
            team_save_channel,
            team_list_conversations,
            team_get_channel_conversation,
            team_get_or_create_dm,
            team_list_messages,
            team_send_message,
            team_mark_message_read,
            team_mark_message_unread,
            team_mark_conversation_read,
            team_mark_thread_read,
            team_create_agent_run,
            team_update_agent_run,
            team_list_agent_runs,
            team_get_inbox,
            team_search_messages,
            team_list_pins,
            team_save_pin,
            team_delete_pin,
            db_list_sessions,
            db_get_session,
            db_close_session,
            db_reopen_session,
            db_list_closed_sessions,
            db_delete_session,
            db_get_session_tags,
            db_set_session_tags,
            db_get_all_session_tags,
            db_save_scrollback,
            db_get_scrollback,
            db_delete_scrollback,
            // Config commands
            get_config,
            save_config,
            get_config_path,
            git_worktree_create,
            read_file_binary,
            read_file_text,
            write_file_text,
            stat_file,
            write_file_binary,
            save_recording_file,
            transcribe_recording_file,
            read_clipboard_image_native,
            read_clipboard_types_native,
            save_clipboard_image,
            save_team_note_file,
            clipboard_history_list,
            clipboard_history_delete,
            clipboard_history_clear,
            clipboard_history_compose,
            cc_search::cc_search,
            cc_search::cc_fetch,
            cc_search::cc_export_session,
            cc_search::cc_last_assistant_turn,
            cc_search::codex_last_assistant_turn,
            cc_search::codex_latest_session_id,
            thread::thread_create,
            thread::thread_list,
            thread::thread_messages_all,
            thread::thread_add_message,
            thread::thread_update_message_status,
            thread::thread_set_pinned,
            thread::thread_mark_viewed,
            thread::thread_agent_alive,
            thread::thread_stage_launch,
        ])
        .setup(|app| {
            // Initialize the agent database
            let db = Arc::new(AgentDatabase::open().expect("Failed to initialize agent database"));
            app.manage(db.clone());
            clipboard_history::spawn_watcher(app.handle().clone(), db);
            app.manage(PtyManager::new(app.handle().clone()));
            app.manage(Arc::new(cc_search::CcSearch::default()));
            let browser_manager = Arc::new(BrowserManager::new(app.handle().clone()));
            let http_listener =
                bind_agent_api_listener().expect("Failed to reserve local agent API port");
            let http_port = http_listener
                .local_addr()
                .expect("Failed to read local agent API port")
                .port();
            browser_manager.set_server_port(http_port);
            if let Err(err) = browser_manager.install_cli_shim() {
                eprintln!("Failed to install butter-browser CLI shim: {}", err);
            }
            app.manage(browser_manager);

            // Start the HTTP server for agent API in background
            let db_for_server = app.state::<Arc<AgentDatabase>>().inner().clone();
            let browser_for_server = app.state::<Arc<BrowserManager>>().inner().clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
                rt.block_on(async {
                    if let Err(e) =
                        http_server::start_server(http_listener, db_for_server, browser_for_server)
                            .await
                    {
                        eprintln!("HTTP server error: {}", e);
                    }
                });
            });

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.maximize();
            }

            // Setup global shortcut to toggle sidebar
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

                let shortcut = Shortcut::new(Some(Modifiers::SUPER), Code::KeyE);
                let app_handle = app.handle().clone();

                app.global_shortcut()
                    .on_shortcut(shortcut, move |_app, _shortcut, _event| {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
