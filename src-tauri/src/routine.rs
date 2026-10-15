//! Routines: scheduled check-ins. An agent (or the user) runs
//! `butter-cli routine create --in 2w "<starter prompt>"` from a terminal;
//! when the routine comes due, the 1thread model starts a fresh agent in the
//! same conversation, folder and preset, with the conversation so far, a
//! pointer to the earlier agent's session and the starter prompt.
//!
//! Butter checks for due routines once a minute while it runs, and on launch
//! for any it missed while closed. Timestamps are Unix millis.

use crate::database::AgentDatabase;
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

/// Emitted to the webview when a routine is created, changed or removed.
pub const ROUTINES_CHANGED_EVENT: &str = "routines-changed";

const ROUTINE_COLUMNS: &str = "id, title, prompt, due_at, status, created_at, thread_id, source_session_id, preset_id, preset_name, directory, agent_command, agent_kind, agent_session_id, fired_at, fired_session_id, error";

/// A claim older than this never finished (Butter quit mid-launch), so the
/// routine is handed out again.
const STALE_CLAIM_MS: i64 = 10 * 60 * 1000;
/// Date-only `--at` values fire at this local time.
const DEFAULT_HOUR: u32 = 9;
const MAX_AHEAD_DAYS: i64 = 2 * 365;
const MAX_PROMPT_CHARS: usize = 8000;

#[derive(Debug, Clone, Serialize)]
pub struct Routine {
    pub id: String,
    pub title: String,
    /// What the agent is asked to do when the routine fires.
    pub prompt: String,
    pub due_at: i64,
    /// The due time in local time, for people and agents reading CLI output.
    pub due: String,
    /// "pending" | "firing" | "fired" | "cancelled" | "failed"
    pub status: String,
    pub created_at: i64,
    /// The 1thread conversation (root thread) the routine fires into. None
    /// when it was created from a plain terminal: it then starts a new thread.
    pub thread_id: Option<String>,
    /// The Butter session that created (or last snoozed) the routine.
    pub source_session_id: String,
    pub preset_id: Option<String>,
    pub preset_name: Option<String>,
    pub directory: Option<String>,
    pub agent_command: Option<String>,
    /// The earlier agent's kind and conversation id ("claude" / "codex"), so the
    /// new agent can read its transcript.
    pub agent_kind: Option<String>,
    pub agent_session_id: Option<String>,
    pub fired_at: Option<i64>,
    pub fired_session_id: Option<String>,
    pub error: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn format_local(ms: i64) -> String {
    match Local.timestamp_millis_opt(ms).single() {
        Some(at) => at.format("%a %Y-%m-%d %H:%M %Z").to_string(),
        None => ms.to_string(),
    }
}

fn row_to_routine(row: &Row) -> rusqlite::Result<Routine> {
    let due_at: i64 = row.get(3)?;
    Ok(Routine {
        id: row.get(0)?,
        title: row.get(1)?,
        prompt: row.get(2)?,
        due_at,
        due: format_local(due_at),
        status: row.get(4)?,
        created_at: row.get(5)?,
        thread_id: row.get(6)?,
        source_session_id: row.get(7)?,
        preset_id: row.get(8)?,
        preset_name: row.get(9)?,
        directory: row.get(10)?,
        agent_command: row.get(11)?,
        agent_kind: row.get(12)?,
        agent_session_id: row.get(13)?,
        fired_at: row.get(14)?,
        fired_session_id: row.get(15)?,
        error: row.get(16)?,
    })
}

fn get_routine_conn(conn: &Connection, id: &str) -> Result<Option<Routine>, String> {
    conn.query_row(
        &format!("SELECT {ROUTINE_COLUMNS} FROM routines WHERE id = ?1"),
        params![id],
        row_to_routine,
    )
    .optional()
    .map_err(|e| format!("Failed to load routine: {e}"))
}

/// Parses `--in` ("30m", "4h", "3d", "2w") or `--at` ("2026-10-29",
/// "2026-10-29 14:30", RFC 3339) into a due time. Date-only values mean 9:00
/// local time.
pub fn parse_due(at: Option<&str>, after: Option<&str>, now: DateTime<Local>) -> Result<i64, String> {
    let at = at.map(str::trim).filter(|s| !s.is_empty());
    let after = after.map(str::trim).filter(|s| !s.is_empty());
    let due = match (at, after) {
        (Some(_), Some(_)) => return Err("Use either --at or --in, not both".to_string()),
        (None, None) => return Err("Say when: --at <YYYY-MM-DD [HH:MM]> or --in <30m|4h|3d|2w>".to_string()),
        (None, Some(after)) => now.timestamp_millis() + parse_duration_ms(after)?,
        (Some(at), None) => parse_at(at)?,
    };
    if due < now.timestamp_millis() - 60_000 {
        return Err(format!("{} is in the past", format_local(due)));
    }
    if due > now.timestamp_millis() + MAX_AHEAD_DAYS * 24 * 60 * 60 * 1000 {
        return Err("Routines can be at most two years out".to_string());
    }
    Ok(due)
}

fn parse_duration_ms(raw: &str) -> Result<i64, String> {
    let raw = raw.to_ascii_lowercase();
    let split = raw.find(|c: char| !c.is_ascii_digit()).unwrap_or(raw.len());
    let (number, unit) = raw.split_at(split);
    let number: i64 = number
        .parse()
        .map_err(|_| format!("Can't read --in {raw:?}; try 30m, 4h, 3d or 2w"))?;
    let minute = 60 * 1000;
    let unit_ms = match unit.trim() {
        "m" | "min" | "mins" | "minute" | "minutes" => minute,
        "h" | "hr" | "hrs" | "hour" | "hours" => 60 * minute,
        "d" | "day" | "days" => 24 * 60 * minute,
        "w" | "wk" | "wks" | "week" | "weeks" => 7 * 24 * 60 * minute,
        _ => return Err(format!("Can't read --in {raw:?}; try 30m, 4h, 3d or 2w")),
    };
    if number <= 0 {
        return Err("--in must be more than zero".to_string());
    }
    number
        .checked_mul(unit_ms)
        .ok_or_else(|| "--in is too far out".to_string())
}

fn parse_at(raw: &str) -> Result<i64, String> {
    if let Ok(at) = DateTime::parse_from_rfc3339(raw) {
        return Ok(at.timestamp_millis());
    }
    let local = |naive: NaiveDateTime| {
        Local
            .from_local_datetime(&naive)
            .earliest()
            .map(|at| at.timestamp_millis())
            .ok_or_else(|| format!("{raw:?} doesn't exist in local time"))
    };
    for format in ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(raw, format) {
            return local(naive);
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        let nine = NaiveTime::from_hms_opt(DEFAULT_HOUR, 0, 0).expect("valid time");
        return local(date.and_time(nine));
    }
    Err(format!("Can't read --at {raw:?}; use YYYY-MM-DD or \"YYYY-MM-DD HH:MM\""))
}

/// What a new routine inherits from the session that creates it.
struct Origin {
    thread_id: Option<String>,
    preset_id: Option<String>,
    preset_name: Option<String>,
    directory: Option<String>,
    agent_command: Option<String>,
    agent_kind: Option<String>,
    agent_session_id: Option<String>,
}

/// A 1thread session fires back into its conversation with its own preset.
/// A plain terminal fires a new thread in its folder (`cwd`, the CLI's $PWD).
fn origin_of(conn: &Connection, session_id: &str, cwd: Option<&str>) -> Result<Origin, String> {
    let agent: Option<(Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT agent_kind, agent_session_id, COALESCE(agent_cwd, directory) FROM sessions WHERE id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to load session: {e}"))?;
    let (agent_kind, agent_session_id, session_dir) = agent.unwrap_or((None, None, None));
    let thread = conn
        .query_row(
            "SELECT parent_id, preset_id, preset_name, cwd, agent_command FROM threads WHERE session_id = ?1",
            params![session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("Failed to load thread: {e}"))?;
    Ok(match thread {
        Some((parent_id, preset_id, preset_name, thread_cwd, agent_command)) => {
            let kind = if agent_command.as_deref().is_some_and(|c| c.trim_start().starts_with("codex")) {
                "codex"
            } else {
                "claude"
            };
            Origin {
                thread_id: Some(parent_id.unwrap_or_else(|| session_id.to_string())),
                preset_id,
                preset_name,
                directory: thread_cwd,
                agent_command,
                agent_kind: agent_kind.or(Some(kind.to_string())),
                agent_session_id,
            }
        }
        None => Origin {
            thread_id: None,
            preset_id: None,
            preset_name: None,
            directory: cwd.map(str::to_string).filter(|d| !d.is_empty()).or(session_dir),
            agent_command: None,
            agent_kind,
            agent_session_id,
        },
    })
}

fn clean_prompt(prompt: &str) -> Result<String, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Give the routine a starter prompt: what to check and why".to_string());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("The prompt is longer than {MAX_PROMPT_CHARS} characters"));
    }
    Ok(prompt.to_string())
}

/// A short name for lists: the given title, else the prompt's first words.
fn routine_title(title: Option<&str>, prompt: &str) -> String {
    let source = title.map(str::trim).filter(|t| !t.is_empty()).unwrap_or(prompt);
    let words: Vec<&str> = source.split_whitespace().collect();
    let mut title = words.iter().take(8).copied().collect::<Vec<_>>().join(" ");
    if title.chars().count() > 60 {
        title = title.chars().take(59).collect::<String>() + "…";
    } else if words.len() > 8 {
        title.push('…');
    }
    title
}

pub fn create_routine(
    db: &AgentDatabase,
    session_id: &str,
    prompt: &str,
    title: Option<&str>,
    due_at: i64,
    cwd: Option<&str>,
) -> Result<Routine, String> {
    let prompt = clean_prompt(prompt)?;
    let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
    let title = routine_title(title, &prompt);
    let now = now_ms();
    db.with_conn(|conn| {
        let origin = origin_of(conn, session_id, cwd)?;
        conn.execute(
            &format!("INSERT INTO routines ({ROUTINE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, NULL, NULL)"),
            params![
                id,
                title,
                prompt,
                due_at,
                now,
                origin.thread_id,
                session_id,
                origin.preset_id,
                origin.preset_name,
                origin.directory,
                origin.agent_command,
                origin.agent_kind,
                origin.agent_session_id
            ],
        )
        .map_err(|e| format!("Failed to create routine: {e}"))?;
        get_routine_conn(conn, &id)?.ok_or_else(|| "Routine not found after insert".to_string())
    })
}

/// Routines a session can see from the CLI: those of its conversation, or its
/// own when it isn't in one. `all` lists every pending routine.
pub fn list_for_session(db: &AgentDatabase, session_id: &str, all: bool) -> Result<Vec<Routine>, String> {
    db.with_conn(|conn| {
        let thread_id = origin_of(conn, session_id, None)?.thread_id;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {ROUTINE_COLUMNS} FROM routines
                 WHERE status IN ('pending', 'firing')
                   AND (?3 OR source_session_id = ?1 OR (?2 IS NOT NULL AND thread_id = ?2))
                 ORDER BY due_at ASC"
            ))
            .map_err(|e| format!("Failed to prepare routine list: {e}"))?;
        let rows = stmt
            .query_map(params![session_id, thread_id, all], row_to_routine)
            .map_err(|e| format!("Failed to list routines: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read routine row: {e}"))
    })
}

/// The routine a session means when it gives no id: the one that started it
/// (so a woken agent can snooze itself), else its conversation's next one.
fn implied_routine(conn: &Connection, session_id: &str) -> Result<Option<String>, String> {
    let fired: Option<String> = conn
        .query_row(
            "SELECT id FROM routines WHERE fired_session_id = ?1 ORDER BY fired_at DESC LIMIT 1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to find routine: {e}"))?;
    if fired.is_some() {
        return Ok(fired);
    }
    let thread_id = origin_of(conn, session_id, None)?.thread_id;
    conn.query_row(
        "SELECT id FROM routines WHERE status = 'pending'
           AND (source_session_id = ?1 OR (?2 IS NOT NULL AND thread_id = ?2))
         ORDER BY due_at ASC LIMIT 1",
        params![session_id, thread_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("Failed to find routine: {e}"))
}

/// Reschedule a routine (pending or already fired). When the agent a routine
/// started snoozes it, the next run points at that agent's session instead.
pub fn snooze_routine(
    db: &AgentDatabase,
    session_id: &str,
    routine_id: Option<&str>,
    due_at: i64,
    prompt: Option<&str>,
) -> Result<Routine, String> {
    let prompt = prompt.map(str::trim).filter(|p| !p.is_empty()).map(clean_prompt).transpose()?;
    db.with_conn(|conn| {
        let id = match routine_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => id.to_string(),
            None => implied_routine(conn, session_id)?
                .ok_or_else(|| "No routine to snooze here; pass its id (butter-cli routine list)".to_string())?,
        };
        let routine = get_routine_conn(conn, &id)?.ok_or_else(|| format!("No routine {id}"))?;
        if routine.status == "cancelled" {
            return Err(format!("Routine {id} was cancelled"));
        }
        let origin = origin_of(conn, session_id, None)?;
        let takes_over = routine.fired_session_id.as_deref() == Some(session_id) && origin.agent_session_id.is_some();
        conn.execute(
            "UPDATE routines SET due_at = ?2, status = 'pending', error = NULL, prompt = COALESCE(?3, prompt),
                 source_session_id = CASE WHEN ?4 THEN ?5 ELSE source_session_id END,
                 agent_kind = CASE WHEN ?4 THEN ?6 ELSE agent_kind END,
                 agent_session_id = CASE WHEN ?4 THEN ?7 ELSE agent_session_id END
             WHERE id = ?1",
            params![id, due_at, prompt, takes_over, session_id, origin.agent_kind, origin.agent_session_id],
        )
        .map_err(|e| format!("Failed to snooze routine: {e}"))?;
        get_routine_conn(conn, &id)?.ok_or_else(|| "Routine vanished".to_string())
    })
}

pub fn cancel_routine(db: &AgentDatabase, id: &str) -> Result<Routine, String> {
    db.with_conn(|conn| {
        let changed = conn
            .execute(
                "UPDATE routines SET status = 'cancelled' WHERE id = ?1 AND status IN ('pending', 'failed')",
                params![id],
            )
            .map_err(|e| format!("Failed to cancel routine: {e}"))?;
        let routine = get_routine_conn(conn, id)?.ok_or_else(|| format!("No routine {id}"))?;
        if changed == 0 && routine.status != "cancelled" {
            return Err(format!("Routine {id} already ran ({})", routine.status));
        }
        Ok(routine)
    })
}

/// Hands out routines that are due, marking them "firing" so the next check
/// doesn't start them twice.
pub fn claim_due(db: &AgentDatabase, now: i64) -> Result<Vec<Routine>, String> {
    db.with_conn(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {ROUTINE_COLUMNS} FROM routines
                 WHERE (status = 'pending' AND due_at <= ?1)
                    OR (status = 'firing' AND fired_at <= ?2)
                 ORDER BY due_at ASC"
            ))
            .map_err(|e| format!("Failed to prepare due routines: {e}"))?;
        let due = stmt
            .query_map(params![now, now - STALE_CLAIM_MS], row_to_routine)
            .map_err(|e| format!("Failed to list due routines: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read routine row: {e}"))?;
        for routine in &due {
            conn.execute(
                "UPDATE routines SET status = 'firing', fired_at = ?2 WHERE id = ?1",
                params![routine.id, now],
            )
            .map_err(|e| format!("Failed to claim routine: {e}"))?;
        }
        Ok(due
            .into_iter()
            .map(|r| Routine { status: "firing".to_string(), fired_at: Some(now), ..r })
            .collect())
    })
}

// ----- Tauri commands -----

#[tauri::command]
pub fn routine_list(db: State<Arc<AgentDatabase>>) -> Result<Vec<Routine>, String> {
    db.with_conn(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {ROUTINE_COLUMNS} FROM routines WHERE status IN ('pending', 'firing', 'failed') ORDER BY due_at ASC"
            ))
            .map_err(|e| format!("Failed to prepare routine list: {e}"))?;
        let rows = stmt
            .query_map([], row_to_routine)
            .map_err(|e| format!("Failed to list routines: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read routine row: {e}"))
    })
}

#[tauri::command]
pub fn routine_claim_due(db: State<Arc<AgentDatabase>>) -> Result<Vec<Routine>, String> {
    claim_due(&db, now_ms())
}

#[tauri::command]
pub fn routine_mark_fired(id: String, session_id: String, db: State<Arc<AgentDatabase>>) -> Result<(), String> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE routines SET status = 'fired', fired_session_id = ?2, error = NULL WHERE id = ?1",
            params![id, session_id],
        )
        .map(|_| ())
        .map_err(|e| format!("Failed to update routine: {e}"))
    })
}

#[tauri::command]
pub fn routine_mark_failed(id: String, error: String, db: State<Arc<AgentDatabase>>) -> Result<(), String> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE routines SET status = 'failed', error = ?2 WHERE id = ?1",
            params![id, error],
        )
        .map(|_| ())
        .map_err(|e| format!("Failed to update routine: {e}"))
    })
}

#[tauri::command]
pub fn routine_cancel(id: String, db: State<Arc<AgentDatabase>>) -> Result<Routine, String> {
    cancel_routine(&db, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, min, 0).earliest().unwrap()
    }

    fn seed(db: &AgentDatabase) {
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO threads (session_id, title, cwd, pinned, created_at, last_activity_at, preset_id, preset_name, agent_command, parent_id)
                 VALUES ('root', 'parking', '/tmp/p', 0, 1, 1, 'cc', 'CC Mike3', 'claude --x', NULL),
                        ('child', 'parking', '/tmp/c', 0, 2, 2, 'cx', 'Codex', 'codex --y', 'root');
                 INSERT INTO sessions (id, title, directory, created_at, agent_kind, agent_session_id)
                 VALUES ('root', 'parking', '/tmp/p', 1, 'claude', 'claude-uuid'),
                        ('plain', 'shell', '/tmp/shell', 1, NULL, NULL);",
            )
            .map_err(|e| e.to_string())
        })
        .unwrap();
    }

    #[test]
    fn parses_due_times() {
        let now = local(2026, 10, 15, 14, 0);
        let day = 24 * 60 * 60 * 1000;
        assert_eq!(parse_due(None, Some("2w"), now).unwrap(), now.timestamp_millis() + 14 * day);
        assert_eq!(parse_due(None, Some("3 days"), now).unwrap(), now.timestamp_millis() + 3 * day);
        assert_eq!(parse_due(None, Some("30m"), now).unwrap(), now.timestamp_millis() + 30 * 60 * 1000);
        assert_eq!(
            parse_due(Some("2026-10-29"), None, now).unwrap(),
            local(2026, 10, 29, 9, 0).timestamp_millis()
        );
        assert_eq!(
            parse_due(Some("2026-10-29 16:30"), None, now).unwrap(),
            local(2026, 10, 29, 16, 30).timestamp_millis()
        );
        assert!(parse_due(Some("2026-10-01"), None, now).is_err());
        assert!(parse_due(None, None, now).is_err());
        assert!(parse_due(Some("2026-10-29"), Some("2w"), now).is_err());
        assert!(parse_due(None, Some("soon"), now).is_err());
        assert!(parse_due(None, Some("0d"), now).is_err());
        assert!(parse_due(None, Some("900w"), now).is_err());
    }

    #[test]
    fn routine_from_a_thread_fires_back_into_its_conversation() {
        let db = AgentDatabase::open_in_memory().unwrap();
        seed(&db);
        let from_root = create_routine(&db, "root", " Check the parking benefit ", None, 5_000, None).unwrap();
        assert_eq!(from_root.thread_id.as_deref(), Some("root"));
        assert_eq!(from_root.prompt, "Check the parking benefit");
        assert_eq!(from_root.preset_id.as_deref(), Some("cc"));
        assert_eq!(from_root.directory.as_deref(), Some("/tmp/p"));
        assert_eq!(from_root.agent_session_id.as_deref(), Some("claude-uuid"));
        assert_eq!(from_root.status, "pending");

        // A looped-in agent's routine goes to the root conversation, with its own preset.
        let from_child = create_routine(&db, "child", "Make the image", Some("image"), 6_000, None).unwrap();
        assert_eq!(from_child.thread_id.as_deref(), Some("root"));
        assert_eq!(from_child.agent_command.as_deref(), Some("codex --y"));
        assert_eq!(from_child.agent_kind.as_deref(), Some("codex"));
        assert_eq!(from_child.title, "image");

        // A plain terminal starts a new thread in its folder.
        let plain = create_routine(&db, "plain", "Look again", None, 7_000, Some("/tmp/here")).unwrap();
        assert_eq!(plain.thread_id, None);
        assert_eq!(plain.directory.as_deref(), Some("/tmp/here"));

        assert!(create_routine(&db, "root", "   ", None, 5_000, None).is_err());
        assert_eq!(list_for_session(&db, "child", false).unwrap().len(), 2);
        assert_eq!(list_for_session(&db, "plain", false).unwrap().len(), 1);
        assert_eq!(list_for_session(&db, "plain", true).unwrap().len(), 3);
    }

    #[test]
    fn due_routines_are_claimed_once_and_can_be_snoozed() {
        let db = AgentDatabase::open_in_memory().unwrap();
        seed(&db);
        let routine = create_routine(&db, "root", "Check the parking benefit", None, 5_000, None).unwrap();
        assert!(claim_due(&db, 4_000).unwrap().is_empty());
        let claimed = claim_due(&db, 5_000).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].status, "firing");
        assert!(claim_due(&db, 6_000).unwrap().is_empty());
        // A claim that never finished is handed out again.
        assert_eq!(claim_due(&db, 5_000 + STALE_CLAIM_MS).unwrap().len(), 1);

        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO sessions (id, title, created_at, agent_kind, agent_session_id)
                 VALUES ('woken', 'parking', 1, 'claude', 'woken-uuid')",
                [],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE routines SET status = 'fired', fired_session_id = 'woken' WHERE id = ?1",
                params![routine.id],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .unwrap();
        assert!(cancel_routine(&db, &routine.id).is_err());

        // The woken agent snoozes without an id; the next run points at it.
        let snoozed = snooze_routine(&db, "woken", None, 9_000, None).unwrap();
        assert_eq!(snoozed.id, routine.id);
        assert_eq!(snoozed.status, "pending");
        assert_eq!(snoozed.due_at, 9_000);
        assert_eq!(snoozed.source_session_id, "woken");
        assert_eq!(snoozed.agent_session_id.as_deref(), Some("woken-uuid"));

        let cancelled = cancel_routine(&db, &routine.id).unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(claim_due(&db, 10_000).unwrap().is_empty());
        assert!(snooze_routine(&db, "root", Some(&routine.id), 9_000, None).is_err());
    }

    #[test]
    fn titles_are_short() {
        assert_eq!(routine_title(Some(" Parking "), "x"), "Parking");
        assert_eq!(
            routine_title(None, "check whether the employer parking benefit is live and then pay"),
            "check whether the employer parking benefit is live…"
        );
    }
}
