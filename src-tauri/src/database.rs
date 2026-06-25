use crate::agent_types::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

// ============================================================================
// Session Types for Terminal Persistence
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub directory: Option<String>,
    pub command: Option<String>,
    pub created_at: i64,
    pub last_accessed_at: Option<i64>,
    pub is_closed: bool,
    pub closed_at: Option<i64>,
    /// Last-known agent running in this terminal: "claude" | "codex" | null.
    pub agent_kind: Option<String>,
    /// Agent conversation id used to resume (claude --resume / codex resume).
    pub agent_session_id: Option<String>,
    /// Working directory the agent was running in (for cwd-based resume).
    pub agent_cwd: Option<String>,
    /// Unix seconds when the agent was last observed running.
    pub agent_last_seen_at: Option<i64>,
}

/// Per-terminal agent snapshot, persisted so a crash/quit doesn't lose which
/// agent (and which conversation) was running in each terminal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionAgentUpdate {
    pub session_id: String,
    pub agent_kind: Option<String>,
    pub agent_session_id: Option<String>,
    pub agent_cwd: Option<String>,
    pub agent_last_seen_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSessionRequest {
    pub id: String,
    pub title: String,
    pub directory: Option<String>,
    pub command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSessionRequest {
    pub title: Option<String>,
    pub directory: Option<String>,
    pub last_accessed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionScrollback {
    pub session_id: String,
    pub content: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_color: Option<String>,
    pub pwd: String,
    pub cmd: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamUserInput {
    pub id: Option<String>,
    pub username: String,
    pub display_name: String,
    pub avatar_color: Option<String>,
    pub pwd: String,
    pub cmd: String,
    pub description: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamChannel {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamChannelInput {
    pub id: Option<String>,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamConversation {
    pub id: String,
    pub kind: String,
    pub channel_id: Option<String>,
    pub title: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamMessage {
    pub id: String,
    pub conversation_id: String,
    pub author_kind: String,
    pub author_user_id: Option<String>,
    pub content: String,
    pub created_at: i64,
    pub edited_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub status: String,
    pub parent_message_id: Option<String>,
    pub thread_reply_count: i64,
    pub last_reply_at: Option<i64>,
    pub pty_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamMessageInput {
    pub id: Option<String>,
    pub conversation_id: String,
    pub author_kind: String,
    pub author_user_id: Option<String>,
    pub content: String,
    pub parent_message_id: Option<String>,
    pub pty_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamInboxItem {
    pub message: TeamMessage,
    pub conversation: TeamConversation,
    pub channel: Option<TeamChannel>,
    pub author: Option<TeamUser>,
    pub parent_message: Option<TeamMessage>,
    pub delivered_at: Option<i64>,
    pub read_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamPin {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub file_path: Option<String>,
    pub url: Option<String>,
    pub message_id: Option<String>,
    pub message_conversation_id: Option<String>,
    pub message_parent_message_id: Option<String>,
    pub message_preview: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamPinInput {
    pub id: Option<String>,
    pub kind: String,
    pub title: Option<String>,
    pub file_path: Option<String>,
    pub url: Option<String>,
    pub message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamAgentRun {
    pub id: String,
    pub trigger_message_id: String,
    pub reply_parent_message_id: String,
    pub user_id: String,
    pub pty_session_id: Option<String>,
    pub cwd: String,
    pub command_template: String,
    pub rendered_command: String,
    pub status: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub exit_code: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamAgentRunInput {
    pub trigger_message_id: String,
    pub reply_parent_message_id: String,
    pub user_id: String,
    pub user_msg: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamAgentRunUpdate {
    pub pty_session_id: Option<String>,
    pub status: Option<String>,
    pub exit_code: Option<i64>,
    pub error: Option<String>,
}

/// Get current Unix timestamp
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// Columns selected for a full `Session`, in the order `row_to_session` expects.
const SESSION_COLUMNS: &str = "id, title, directory, command, created_at, last_accessed_at, is_closed, closed_at, agent_kind, agent_session_id, agent_cwd, agent_last_seen_at";

/// Build a `Session` from a row selecting `SESSION_COLUMNS`.
fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        title: row.get(1)?,
        directory: row.get(2)?,
        command: row.get(3)?,
        created_at: row.get(4)?,
        last_accessed_at: row.get(5)?,
        is_closed: row.get::<_, i32>(6)? != 0,
        closed_at: row.get(7)?,
        agent_kind: row.get(8)?,
        agent_session_id: row.get(9)?,
        agent_cwd: row.get(10)?,
        agent_last_seen_at: row.get(11)?,
    })
}

fn row_to_team_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamUser> {
    Ok(TeamUser {
        id: row.get(0)?,
        username: row.get(1)?,
        display_name: row.get(2)?,
        avatar_color: row.get(3)?,
        pwd: row.get(4)?,
        cmd: row.get(5)?,
        description: row.get(6)?,
        enabled: row.get::<_, i32>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn row_to_team_channel(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamChannel> {
    Ok(TeamChannel {
        id: row.get(0)?,
        name: row.get(1)?,
        display_name: row.get(2)?,
        description: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        archived_at: row.get(6)?,
    })
}

fn row_to_team_conversation(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamConversation> {
    Ok(TeamConversation {
        id: row.get(0)?,
        kind: row.get(1)?,
        channel_id: row.get(2)?,
        title: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        archived_at: row.get(6)?,
    })
}

fn row_to_team_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamMessage> {
    Ok(TeamMessage {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        author_kind: row.get(2)?,
        author_user_id: row.get(3)?,
        content: row.get(4)?,
        created_at: row.get(5)?,
        edited_at: row.get(6)?,
        deleted_at: row.get(7)?,
        status: row.get(8)?,
        parent_message_id: row.get(9)?,
        thread_reply_count: row.get(10)?,
        last_reply_at: row.get(11)?,
        pty_session_id: row.get(12)?,
    })
}

fn row_to_team_agent_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamAgentRun> {
    Ok(TeamAgentRun {
        id: row.get(0)?,
        trigger_message_id: row.get(1)?,
        reply_parent_message_id: row.get(2)?,
        user_id: row.get(3)?,
        pty_session_id: row.get(4)?,
        cwd: row.get(5)?,
        command_template: row.get(6)?,
        rendered_command: row.get(7)?,
        status: row.get(8)?,
        started_at: row.get(9)?,
        completed_at: row.get(10)?,
        exit_code: row.get(11)?,
        error: row.get(12)?,
    })
}

fn row_to_team_pin(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamPin> {
    Ok(TeamPin {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        file_path: row.get(3)?,
        url: row.get(4)?,
        message_id: row.get(5)?,
        message_conversation_id: row.get(6)?,
        message_parent_message_id: row.get(7)?,
        message_preview: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn render_team_command(template: &str, user_msg: &str) -> String {
    let quoted = shell_quote(user_msg);
    template
        .replace("\"{user_msg}\"", &quoted)
        .replace("'{user_msg}'", &quoted)
        .replace("{user_msg}", &quoted)
}

fn compact_pin_title(value: &str, max_chars: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_chars {
        return normalized;
    }
    let mut title = normalized
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>();
    title.push_str("...");
    title
}

/// Generate a UUID-like ID
fn generate_id(prefix: &str) -> String {
    format!(
        "{}-{}",
        prefix,
        uuid::Uuid::new_v4().to_string()[..8].to_string()
    )
}

/// Database manager for agent communication
pub struct AgentDatabase {
    conn: Mutex<Connection>,
}

impl AgentDatabase {
    /// Open an in-memory database (for tests)
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Failed to open in-memory database: {}", e))?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.initialize_schema()?;
        Ok(db)
    }

    /// Open or create the database
    pub fn open() -> Result<Self, String> {
        let db_path = Self::get_db_path()?;

        // Ensure directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create database directory: {}", e))?;
        }

        let conn =
            Connection::open(&db_path).map_err(|e| format!("Failed to open database: {}", e))?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.initialize_schema()?;

        Ok(db)
    }

    /// Get the database file path
    fn get_db_path() -> Result<PathBuf, String> {
        let home =
            dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
        Ok(home.join(".butter").join("agent.db"))
    }

    /// Initialize database schema
    fn initialize_schema(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                capabilities TEXT,
                working_directory TEXT,
                terminal_id TEXT,
                status TEXT DEFAULT 'active',
                registered_at INTEGER,
                last_heartbeat INTEGER
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_agent TEXT NOT NULL,
                to_agent TEXT,
                message_type TEXT NOT NULL,
                content TEXT NOT NULL,
                context TEXT,
                status TEXT DEFAULT 'pending',
                created_at INTEGER,
                read_at INTEGER,
                response_id INTEGER
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT,
                assigned_by TEXT,
                assigned_to TEXT,
                status TEXT DEFAULT 'pending',
                priority INTEGER DEFAULT 5,
                context TEXT,
                result TEXT,
                created_at INTEGER,
                completed_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS shared_context (
                key TEXT PRIMARY KEY,
                value TEXT,
                set_by TEXT,
                updated_at INTEGER
            );

            -- Migrate old cwd-based hook_events to pid-based
            DROP TABLE IF EXISTS hook_events;

            CREATE TABLE IF NOT EXISTS hook_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                shell_pid INTEGER NOT NULL,
                hook_event TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                prompt_text TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_hook_events_shell_pid ON hook_events(shell_pid, timestamp);
            CREATE INDEX IF NOT EXISTS idx_hook_events_session_id ON hook_events(session_id, timestamp);

            CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, status);
            CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
            CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
            CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

            -- Session persistence tables
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                directory TEXT,
                command TEXT,
                created_at INTEGER NOT NULL,
                last_accessed_at INTEGER,
                is_closed INTEGER DEFAULT 0,
                closed_at INTEGER,
                agent_kind TEXT,
                agent_session_id TEXT,
                agent_cwd TEXT,
                agent_last_seen_at INTEGER
            );

            -- Small key/value store for app-level state we want to survive a
            -- crash (e.g. the active session id and the ordered open set).
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_tags (
                session_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY (session_id, tag),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS session_scrollback (
                session_id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
            CREATE INDEX IF NOT EXISTS idx_session_tags_session ON session_tags(session_id);

            CREATE TABLE IF NOT EXISTS clipboard_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                text TEXT,
                image_path TEXT,
                source_app TEXT,
                byte_len INTEGER NOT NULL,
                content_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_clipboard_created ON clipboard_history(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_clipboard_hash ON clipboard_history(content_hash);

            CREATE TABLE IF NOT EXISTS team_users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                avatar_color TEXT,
                pwd TEXT NOT NULL,
                cmd TEXT NOT NULL,
                description TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS team_channels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                description TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                archived_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS team_conversations (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK (kind IN ('channel', 'dm', 'group_dm')),
                channel_id TEXT,
                title TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                archived_at INTEGER,
                FOREIGN KEY (channel_id) REFERENCES team_channels(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS team_conversation_members (
                conversation_id TEXT NOT NULL,
                member_kind TEXT NOT NULL CHECK (member_kind IN ('human', 'agent')),
                user_id TEXT,
                display_name TEXT,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (conversation_id, member_kind, user_id),
                FOREIGN KEY (conversation_id) REFERENCES team_conversations(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES team_users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS team_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent', 'system')),
                author_user_id TEXT,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                edited_at INTEGER,
                deleted_at INTEGER,
                status TEXT NOT NULL DEFAULT 'sent',
                parent_message_id TEXT,
                thread_reply_count INTEGER NOT NULL DEFAULT 0,
                last_reply_at INTEGER,
                pty_session_id TEXT,
                FOREIGN KEY (conversation_id) REFERENCES team_conversations(id) ON DELETE CASCADE,
                FOREIGN KEY (author_user_id) REFERENCES team_users(id) ON DELETE SET NULL,
                FOREIGN KEY (parent_message_id) REFERENCES team_messages(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS team_message_recipients (
                message_id TEXT NOT NULL,
                recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('human', 'agent', 'channel')),
                recipient_user_id TEXT,
                channel_id TEXT,
                delivery_status TEXT NOT NULL DEFAULT 'pending',
                delivered_at INTEGER,
                read_at INTEGER,
                unread INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (message_id, recipient_kind, recipient_user_id, channel_id),
                FOREIGN KEY (message_id) REFERENCES team_messages(id) ON DELETE CASCADE,
                FOREIGN KEY (recipient_user_id) REFERENCES team_users(id) ON DELETE CASCADE,
                FOREIGN KEY (channel_id) REFERENCES team_channels(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS team_agent_runs (
                id TEXT PRIMARY KEY,
                trigger_message_id TEXT NOT NULL,
                reply_parent_message_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                pty_session_id TEXT,
                cwd TEXT NOT NULL,
                command_template TEXT NOT NULL,
                rendered_command TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
                started_at INTEGER,
                completed_at INTEGER,
                exit_code INTEGER,
                error TEXT,
                FOREIGN KEY (trigger_message_id) REFERENCES team_messages(id) ON DELETE CASCADE,
                FOREIGN KEY (reply_parent_message_id) REFERENCES team_messages(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES team_users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS team_pins (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK (kind IN ('file', 'message', 'link')),
                title TEXT NOT NULL,
                file_path TEXT,
                url TEXT,
                message_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (message_id) REFERENCES team_messages(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_team_messages_top_level
                ON team_messages(conversation_id, created_at)
                WHERE parent_message_id IS NULL;
            CREATE INDEX IF NOT EXISTS idx_team_messages_thread
                ON team_messages(parent_message_id, created_at)
                WHERE parent_message_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_team_message_recipients_inbox
                ON team_message_recipients(recipient_kind, recipient_user_id, unread, delivered_at);
            CREATE INDEX IF NOT EXISTS idx_team_agent_runs_trigger
                ON team_agent_runs(trigger_message_id);
            CREATE INDEX IF NOT EXISTS idx_team_pins_created
                ON team_pins(created_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_team_pins_file_path
                ON team_pins(file_path)
                WHERE kind = 'file' AND file_path IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_team_pins_url
                ON team_pins(url)
                WHERE kind = 'link' AND url IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_team_pins_message
                ON team_pins(message_id)
                WHERE kind = 'message' AND message_id IS NOT NULL;
            "#,
        )
        .map_err(|e| format!("Failed to initialize schema: {}", e))?;

        let timestamp = now();
        conn.execute(
            "INSERT OR IGNORE INTO team_channels
             (id, name, display_name, description, created_at, updated_at)
             VALUES ('channel-general', 'general', 'general', 'Default team channel', ?1, ?1)",
            params![timestamp],
        )
        .map_err(|e| format!("Failed to seed Team Mode general channel: {}", e))?;
        conn.execute(
            "INSERT OR IGNORE INTO team_conversations
             (id, kind, channel_id, title, created_at, updated_at)
             VALUES ('conversation-general', 'channel', 'channel-general', 'general', ?1, ?1)",
            params![timestamp],
        )
        .map_err(|e| format!("Failed to seed Team Mode general conversation: {}", e))?;

        // Additive migration for existing databases created before `closed_at` existed.
        if let Err(err) = conn.execute("ALTER TABLE sessions ADD COLUMN closed_at INTEGER", []) {
            let message = err.to_string();
            if !message.contains("duplicate column name") {
                return Err(format!(
                    "Failed to migrate sessions.closed_at column: {}",
                    err
                ));
            }
        }

        if let Err(err) = conn.execute("ALTER TABLE hook_events ADD COLUMN prompt_text TEXT", []) {
            let message = err.to_string();
            if !message.contains("duplicate column name") {
                return Err(format!(
                    "Failed to migrate hook_events.prompt_text column: {}",
                    err
                ));
            }
        }

        if let Err(err) = conn.execute(
            "ALTER TABLE hook_events ADD COLUMN suggested_title TEXT",
            [],
        ) {
            let message = err.to_string();
            if !message.contains("duplicate column name") {
                return Err(format!(
                    "Failed to migrate hook_events.suggested_title column: {}",
                    err
                ));
            }
        }

        // Additive migration for the per-terminal agent snapshot columns.
        for column in [
            "agent_kind TEXT",
            "agent_session_id TEXT",
            "agent_cwd TEXT",
            "agent_last_seen_at INTEGER",
        ] {
            let sql = format!("ALTER TABLE sessions ADD COLUMN {}", column);
            if let Err(err) = conn.execute(&sql, []) {
                let message = err.to_string();
                if !message.contains("duplicate column name") {
                    return Err(format!("Failed to migrate sessions.{}: {}", column, err));
                }
            }
        }

        Ok(())
    }

    // ========================================================================
    // Agent Operations
    // ========================================================================

    /// Register a new agent
    pub fn register_agent(&self, req: &RegisterAgentRequest) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();
        let id = generate_id("agent");
        let capabilities_json = serde_json::to_string(&req.capabilities)
            .map_err(|e| format!("Failed to serialize capabilities: {}", e))?;
        let timestamp = now();

        conn.execute(
            r#"
            INSERT INTO agents (id, name, role, capabilities, working_directory, terminal_id, status, registered_at, last_heartbeat)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)
            "#,
            params![
                id,
                req.name,
                req.role.to_string(),
                capabilities_json,
                req.working_directory,
                req.terminal_id,
                timestamp,
            ],
        )
        .map_err(|e| format!("Failed to register agent: {}", e))?;

        Ok(id)
    }

    /// Get all agents
    pub fn list_agents(&self) -> Result<Vec<Agent>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, role, capabilities, working_directory, terminal_id, status, registered_at, last_heartbeat FROM agents")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let agents = stmt
            .query_map([], |row| {
                let capabilities_json: String = row.get(3)?;
                let capabilities: Vec<String> =
                    serde_json::from_str(&capabilities_json).unwrap_or_default();
                let role_str: String = row.get(2)?;
                let status_str: String = row.get(6)?;

                Ok(Agent {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    role: role_str.parse().unwrap_or(AgentRole::Worker),
                    capabilities,
                    working_directory: row.get(4)?,
                    terminal_id: row.get(5)?,
                    status: status_str.parse().unwrap_or(AgentStatus::Active),
                    registered_at: row.get(7)?,
                    last_heartbeat: row.get(8)?,
                })
            })
            .map_err(|e| format!("Failed to query agents: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect agents: {}", e))?;

        Ok(agents)
    }

    /// Get agent by ID or name
    pub fn get_agent(&self, id_or_name: &str) -> Result<Option<Agent>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, role, capabilities, working_directory, terminal_id, status, registered_at, last_heartbeat FROM agents WHERE id = ?1 OR name = ?1")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut rows = stmt
            .query(params![id_or_name])
            .map_err(|e| format!("Failed to query: {}", e))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to get row: {}", e))?
        {
            let capabilities_json: String = row
                .get(3)
                .map_err(|e| format!("Failed to get capabilities: {}", e))?;
            let capabilities: Vec<String> =
                serde_json::from_str(&capabilities_json).unwrap_or_default();
            let role_str: String = row
                .get(2)
                .map_err(|e| format!("Failed to get role: {}", e))?;
            let status_str: String = row
                .get(6)
                .map_err(|e| format!("Failed to get status: {}", e))?;

            Ok(Some(Agent {
                id: row.get(0).map_err(|e| format!("Failed to get id: {}", e))?,
                name: row
                    .get(1)
                    .map_err(|e| format!("Failed to get name: {}", e))?,
                role: role_str.parse().unwrap_or(AgentRole::Worker),
                capabilities,
                working_directory: row
                    .get(4)
                    .map_err(|e| format!("Failed to get working_directory: {}", e))?,
                terminal_id: row
                    .get(5)
                    .map_err(|e| format!("Failed to get terminal_id: {}", e))?,
                status: status_str.parse().unwrap_or(AgentStatus::Active),
                registered_at: row
                    .get(7)
                    .map_err(|e| format!("Failed to get registered_at: {}", e))?,
                last_heartbeat: row
                    .get(8)
                    .map_err(|e| format!("Failed to get last_heartbeat: {}", e))?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Update agent
    pub fn update_agent(&self, id: &str, req: &UpdateAgentRequest) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();

        if let Some(status) = &req.status {
            conn.execute(
                "UPDATE agents SET status = ?1 WHERE id = ?2",
                params![status.to_string(), id],
            )
            .map_err(|e| format!("Failed to update status: {}", e))?;
        }

        if let Some(terminal_id) = &req.terminal_id {
            conn.execute(
                "UPDATE agents SET terminal_id = ?1 WHERE id = ?2",
                params![terminal_id, id],
            )
            .map_err(|e| format!("Failed to update terminal_id: {}", e))?;
        }

        Ok(())
    }

    /// Update agent heartbeat
    pub fn heartbeat(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE agents SET last_heartbeat = ?1 WHERE id = ?2",
            params![now(), id],
        )
        .map_err(|e| format!("Failed to update heartbeat: {}", e))?;
        Ok(())
    }

    /// Unregister agent
    pub fn unregister_agent(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM agents WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to unregister agent: {}", e))?;
        Ok(())
    }

    /// Mark stale agents as offline
    pub fn cleanup_stale_agents(&self, timeout_seconds: i64) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        let cutoff = now() - timeout_seconds;

        let count = conn
            .execute(
                "UPDATE agents SET status = 'offline' WHERE last_heartbeat < ?1 AND status != 'offline'",
                params![cutoff],
            )
            .map_err(|e| format!("Failed to cleanup stale agents: {}", e))?;

        Ok(count)
    }

    // ========================================================================
    // Message Operations
    // ========================================================================

    /// Create a message
    pub fn create_message(
        &self,
        from_agent: &str,
        to_agent: Option<&str>,
        message_type: MessageType,
        content: &str,
        context: Option<&serde_json::Value>,
    ) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        let context_json = context.map(|c| serde_json::to_string(c).ok()).flatten();

        conn.execute(
            r#"
            INSERT INTO messages (from_agent, to_agent, message_type, content, context, status, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)
            "#,
            params![
                from_agent,
                to_agent,
                message_type.to_string(),
                content,
                context_json,
                now(),
            ],
        )
        .map_err(|e| format!("Failed to create message: {}", e))?;

        Ok(conn.last_insert_rowid())
    }

    /// Get messages for an agent (inbox)
    pub fn get_inbox(
        &self,
        agent_id: &str,
        status_filter: Option<&str>,
    ) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().unwrap();

        let query = match status_filter {
            Some(status) => format!(
                "SELECT id, from_agent, to_agent, message_type, content, context, status, created_at, read_at, response_id
                 FROM messages
                 WHERE (to_agent = ?1 OR to_agent IS NULL) AND status = '{}'
                 ORDER BY created_at DESC",
                status
            ),
            None => "SELECT id, from_agent, to_agent, message_type, content, context, status, created_at, read_at, response_id
                     FROM messages
                     WHERE to_agent = ?1 OR to_agent IS NULL
                     ORDER BY created_at DESC".to_string(),
        };

        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let messages = stmt
            .query_map(params![agent_id], |row| {
                let context_json: Option<String> = row.get(5)?;
                let context = context_json
                    .map(|c| serde_json::from_str(&c).ok())
                    .flatten();
                let message_type_str: String = row.get(3)?;
                let status_str: String = row.get(6)?;

                Ok(Message {
                    id: row.get(0)?,
                    from_agent: row.get(1)?,
                    to_agent: row.get(2)?,
                    message_type: message_type_str.parse().unwrap_or(MessageType::Notify),
                    content: row.get(4)?,
                    context,
                    status: status_str.parse().unwrap_or(MessageStatus::Pending),
                    created_at: row.get(7)?,
                    read_at: row.get(8)?,
                    response_id: row.get(9)?,
                })
            })
            .map_err(|e| format!("Failed to query messages: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect messages: {}", e))?;

        Ok(messages)
    }

    /// Get a specific message
    pub fn get_message(&self, id: i64) -> Result<Option<Message>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, from_agent, to_agent, message_type, content, context, status, created_at, read_at, response_id FROM messages WHERE id = ?1")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut rows = stmt
            .query(params![id])
            .map_err(|e| format!("Failed to query: {}", e))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to get row: {}", e))?
        {
            let context_json: Option<String> = row
                .get(5)
                .map_err(|e| format!("Failed to get context: {}", e))?;
            let context = context_json
                .map(|c| serde_json::from_str(&c).ok())
                .flatten();
            let message_type_str: String = row
                .get(3)
                .map_err(|e| format!("Failed to get message_type: {}", e))?;
            let status_str: String = row
                .get(6)
                .map_err(|e| format!("Failed to get status: {}", e))?;

            Ok(Some(Message {
                id: row.get(0).map_err(|e| format!("Failed to get id: {}", e))?,
                from_agent: row
                    .get(1)
                    .map_err(|e| format!("Failed to get from_agent: {}", e))?,
                to_agent: row
                    .get(2)
                    .map_err(|e| format!("Failed to get to_agent: {}", e))?,
                message_type: message_type_str.parse().unwrap_or(MessageType::Notify),
                content: row
                    .get(4)
                    .map_err(|e| format!("Failed to get content: {}", e))?,
                context,
                status: status_str.parse().unwrap_or(MessageStatus::Pending),
                created_at: row
                    .get(7)
                    .map_err(|e| format!("Failed to get created_at: {}", e))?,
                read_at: row
                    .get(8)
                    .map_err(|e| format!("Failed to get read_at: {}", e))?,
                response_id: row
                    .get(9)
                    .map_err(|e| format!("Failed to get response_id: {}", e))?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Mark message as read
    pub fn mark_message_read(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET status = 'read', read_at = ?1 WHERE id = ?2",
            params![now(), id],
        )
        .map_err(|e| format!("Failed to mark message read: {}", e))?;
        Ok(())
    }

    /// Respond to a message
    pub fn respond_to_message(
        &self,
        message_id: i64,
        from_agent: &str,
        response: &str,
    ) -> Result<i64, String> {
        // Get the original message to find the sender
        let original = self
            .get_message(message_id)?
            .ok_or_else(|| "Message not found".to_string())?;

        // Create response message
        let response_id = self.create_message(
            from_agent,
            Some(&original.from_agent),
            MessageType::Respond,
            response,
            None,
        )?;

        // Update original message
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET status = 'responded', response_id = ?1 WHERE id = ?2",
            params![response_id, message_id],
        )
        .map_err(|e| format!("Failed to update original message: {}", e))?;

        Ok(response_id)
    }

    /// Wait for a response to a message
    pub fn wait_for_response(
        &self,
        message_id: i64,
        timeout_seconds: u64,
    ) -> Result<Option<String>, String> {
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(timeout_seconds);

        loop {
            if let Some(msg) = self.get_message(message_id)? {
                if let Some(response_id) = msg.response_id {
                    if let Some(response_msg) = self.get_message(response_id)? {
                        return Ok(Some(response_msg.content));
                    }
                }
            }

            if start.elapsed() >= timeout {
                return Ok(None);
            }

            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }

    // ========================================================================
    // Task Operations
    // ========================================================================

    /// Create a task
    pub fn create_task(&self, req: &CreateTaskRequest) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();
        let id = generate_id("task");
        let context_json = req
            .context
            .as_ref()
            .map(|c| serde_json::to_string(c).ok())
            .flatten();

        conn.execute(
            r#"
            INSERT INTO tasks (id, title, description, assigned_by, assigned_to, status, priority, context, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8)
            "#,
            params![
                id,
                req.title,
                req.description,
                req.assigned_by,
                req.assigned_to,
                req.priority,
                context_json,
                now(),
            ],
        )
        .map_err(|e| format!("Failed to create task: {}", e))?;

        Ok(id)
    }

    /// List tasks with optional filters
    pub fn list_tasks(
        &self,
        assigned_to: Option<&str>,
        assigned_by: Option<&str>,
        status: Option<&str>,
    ) -> Result<Vec<Task>, String> {
        let conn = self.conn.lock().unwrap();

        let mut conditions = Vec::new();
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(to) = assigned_to {
            conditions.push(format!("assigned_to = ?{}", params_vec.len() + 1));
            params_vec.push(Box::new(to.to_string()));
        }
        if let Some(by) = assigned_by {
            conditions.push(format!("assigned_by = ?{}", params_vec.len() + 1));
            params_vec.push(Box::new(by.to_string()));
        }
        if let Some(s) = status {
            conditions.push(format!("status = ?{}", params_vec.len() + 1));
            params_vec.push(Box::new(s.to_string()));
        }

        let where_clause = if conditions.is_empty() {
            "".to_string()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let query = format!(
            "SELECT id, title, description, assigned_by, assigned_to, status, priority, context, result, created_at, completed_at
             FROM tasks {} ORDER BY priority DESC, created_at DESC",
            where_clause
        );

        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();

        let tasks = stmt
            .query_map(params_refs.as_slice(), |row| {
                let context_json: Option<String> = row.get(7)?;
                let context = context_json
                    .map(|c| serde_json::from_str(&c).ok())
                    .flatten();
                let status_str: String = row.get(5)?;

                Ok(Task {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    assigned_by: row.get(3)?,
                    assigned_to: row.get(4)?,
                    status: status_str.parse().unwrap_or(TaskStatus::Pending),
                    priority: row.get(6)?,
                    context,
                    result: row.get(8)?,
                    created_at: row.get(9)?,
                    completed_at: row.get(10)?,
                })
            })
            .map_err(|e| format!("Failed to query tasks: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect tasks: {}", e))?;

        Ok(tasks)
    }

    /// Get a specific task
    pub fn get_task(&self, id: &str) -> Result<Option<Task>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, title, description, assigned_by, assigned_to, status, priority, context, result, created_at, completed_at FROM tasks WHERE id = ?1")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut rows = stmt
            .query(params![id])
            .map_err(|e| format!("Failed to query: {}", e))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to get row: {}", e))?
        {
            let context_json: Option<String> = row
                .get(7)
                .map_err(|e| format!("Failed to get context: {}", e))?;
            let context = context_json
                .map(|c| serde_json::from_str(&c).ok())
                .flatten();
            let status_str: String = row
                .get(5)
                .map_err(|e| format!("Failed to get status: {}", e))?;

            Ok(Some(Task {
                id: row.get(0).map_err(|e| format!("Failed to get id: {}", e))?,
                title: row
                    .get(1)
                    .map_err(|e| format!("Failed to get title: {}", e))?,
                description: row
                    .get(2)
                    .map_err(|e| format!("Failed to get description: {}", e))?,
                assigned_by: row
                    .get(3)
                    .map_err(|e| format!("Failed to get assigned_by: {}", e))?,
                assigned_to: row
                    .get(4)
                    .map_err(|e| format!("Failed to get assigned_to: {}", e))?,
                status: status_str.parse().unwrap_or(TaskStatus::Pending),
                priority: row
                    .get(6)
                    .map_err(|e| format!("Failed to get priority: {}", e))?,
                context,
                result: row
                    .get(8)
                    .map_err(|e| format!("Failed to get result: {}", e))?,
                created_at: row
                    .get(9)
                    .map_err(|e| format!("Failed to get created_at: {}", e))?,
                completed_at: row
                    .get(10)
                    .map_err(|e| format!("Failed to get completed_at: {}", e))?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Claim a task
    pub fn claim_task(&self, task_id: &str, agent_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET assigned_to = ?1, status = 'in_progress' WHERE id = ?2 AND assigned_to IS NULL",
            params![agent_id, task_id],
        )
        .map_err(|e| format!("Failed to claim task: {}", e))?;
        Ok(())
    }

    /// Update a task
    pub fn update_task(&self, id: &str, req: &UpdateTaskRequest) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();

        if let Some(status) = &req.status {
            let completed_at = if *status == TaskStatus::Completed || *status == TaskStatus::Failed
            {
                Some(now())
            } else {
                None
            };

            conn.execute(
                "UPDATE tasks SET status = ?1, completed_at = ?2 WHERE id = ?3",
                params![status.to_string(), completed_at, id],
            )
            .map_err(|e| format!("Failed to update status: {}", e))?;
        }

        if let Some(result) = &req.result {
            conn.execute(
                "UPDATE tasks SET result = ?1 WHERE id = ?2",
                params![result, id],
            )
            .map_err(|e| format!("Failed to update result: {}", e))?;
        }

        Ok(())
    }

    // ========================================================================
    // Shared Context Operations
    // ========================================================================

    /// Set a context value
    pub fn set_context(&self, key: &str, value: &str, set_by: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO shared_context (key, value, set_by, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(key) DO UPDATE SET value = ?2, set_by = ?3, updated_at = ?4
            "#,
            params![key, value, set_by, now()],
        )
        .map_err(|e| format!("Failed to set context: {}", e))?;
        Ok(())
    }

    /// Get a context value
    pub fn get_context(&self, key: &str) -> Result<Option<SharedContext>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT key, value, set_by, updated_at FROM shared_context WHERE key = ?1")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut rows = stmt
            .query(params![key])
            .map_err(|e| format!("Failed to query: {}", e))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to get row: {}", e))?
        {
            Ok(Some(SharedContext {
                key: row
                    .get(0)
                    .map_err(|e| format!("Failed to get key: {}", e))?,
                value: row
                    .get(1)
                    .map_err(|e| format!("Failed to get value: {}", e))?,
                set_by: row
                    .get(2)
                    .map_err(|e| format!("Failed to get set_by: {}", e))?,
                updated_at: row
                    .get(3)
                    .map_err(|e| format!("Failed to get updated_at: {}", e))?,
            }))
        } else {
            Ok(None)
        }
    }

    /// List all context
    pub fn list_context(&self) -> Result<Vec<SharedContext>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT key, value, set_by, updated_at FROM shared_context ORDER BY key")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let contexts = stmt
            .query_map([], |row| {
                Ok(SharedContext {
                    key: row.get(0)?,
                    value: row.get(1)?,
                    set_by: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|e| format!("Failed to query contexts: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect contexts: {}", e))?;

        Ok(contexts)
    }

    /// Delete a context value
    pub fn delete_context(&self, key: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM shared_context WHERE key = ?1", params![key])
            .map_err(|e| format!("Failed to delete context: {}", e))?;
        Ok(())
    }

    // ========================================================================
    // Hook Event Operations
    // ========================================================================

    /// Get the latest hook event for a given shell PID
    pub fn get_latest_hook_event_by_pid(
        &self,
        shell_pid: u32,
    ) -> Result<Option<(String, i64)>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT hook_event, timestamp FROM hook_events \
                 WHERE shell_pid = ?1 \
                 ORDER BY timestamp DESC LIMIT 1",
            )
            .map_err(|e| format!("Failed to prepare hook_events query: {}", e))?;

        let mut rows = stmt
            .query(params![shell_pid as i64])
            .map_err(|e| format!("Failed to query hook_events: {}", e))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to get row: {}", e))?
        {
            let event: String = row
                .get(0)
                .map_err(|e| format!("Failed to get hook_event: {}", e))?;
            let ts: i64 = row
                .get(1)
                .map_err(|e| format!("Failed to get timestamp: {}", e))?;
            Ok(Some((event, ts)))
        } else {
            Ok(None)
        }
    }

    /// Get the latest agent session_id seen for a given shell PID.
    pub fn get_latest_hook_session_id_by_pid(
        &self,
        shell_pid: u32,
    ) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT session_id FROM hook_events \
                 WHERE shell_pid = ?1 \
                 ORDER BY timestamp DESC LIMIT 1",
            )
            .map_err(|e| format!("Failed to prepare hook_events session_id query: {}", e))?;

        let mut rows = stmt
            .query(params![shell_pid as i64])
            .map_err(|e| format!("Failed to query hook_events session_id: {}", e))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to get row: {}", e))?
        {
            let session_id: String = row
                .get(0)
                .map_err(|e| format!("Failed to get session_id: {}", e))?;
            Ok(Some(session_id))
        } else {
            Ok(None)
        }
    }

    /// Get the earliest captured UserPromptSubmit prompt for an agent session.
    pub fn get_first_user_prompt_by_agent_session_id(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT prompt_text FROM hook_events \
                 WHERE session_id = ?1 \
                 AND hook_event = 'UserPromptSubmit' \
                 AND prompt_text IS NOT NULL \
                 AND TRIM(prompt_text) <> '' \
                 AND NOT (TRIM(prompt_text) LIKE '/%' AND TRIM(prompt_text) NOT LIKE '% %') \
                 AND prompt_text NOT LIKE '%<task-notification>%' \
                 ORDER BY timestamp ASC, id ASC",
            )
            .map_err(|e| format!("Failed to prepare first prompt query: {}", e))?;

        let mut rows = stmt
            .query(params![session_id])
            .map_err(|e| format!("Failed to query first prompt: {}", e))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to iterate first prompt rows: {}", e))?
        {
            let prompt: String = row
                .get(0)
                .map_err(|e| format!("Failed to get prompt_text: {}", e))?;
            return Ok(Some(prompt));
        }

        Ok(None)
    }

    /// Delete hook events older than max_age_secs
    pub fn cleanup_old_hook_events(&self, max_age_secs: i64) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        let cutoff = now() - max_age_secs;
        let count = conn
            .execute(
                "DELETE FROM hook_events WHERE timestamp < ?1",
                params![cutoff],
            )
            .map_err(|e| format!("Failed to cleanup old hook events: {}", e))?;
        Ok(count)
    }

    /// Insert a hook event (used by tests; in production the hook script inserts directly)
    #[cfg(test)]
    pub fn insert_hook_event(
        &self,
        session_id: &str,
        shell_pid: u32,
        hook_event: &str,
        timestamp: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO hook_events (session_id, shell_pid, hook_event, timestamp, prompt_text) VALUES (?1, ?2, ?3, ?4, NULL)",
            params![session_id, shell_pid as i64, hook_event, timestamp],
        )
        .map_err(|e| format!("Failed to insert hook event: {}", e))?;
        Ok(())
    }

    #[cfg(test)]
    pub fn insert_hook_event_with_prompt(
        &self,
        session_id: &str,
        shell_pid: u32,
        hook_event: &str,
        timestamp: i64,
        prompt_text: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO hook_events (session_id, shell_pid, hook_event, timestamp, prompt_text) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, shell_pid as i64, hook_event, timestamp, prompt_text],
        )
        .map_err(|e| format!("Failed to insert hook event with prompt: {}", e))?;
        Ok(())
    }

    // ========================================================================
    // Session Operations (Terminal Persistence)
    // ========================================================================

    /// Create a new session
    pub fn create_session(&self, req: &CreateSessionRequest) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let timestamp = now();

        conn.execute(
            r#"
            INSERT INTO sessions (id, title, directory, command, created_at, last_accessed_at, is_closed, closed_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0, NULL)
            "#,
            params![
                req.id,
                req.title,
                req.directory,
                req.command,
                timestamp,
            ],
        )
        .map_err(|e| format!("Failed to create session: {}", e))?;

        Ok(())
    }

    /// Update an existing session
    pub fn update_session(&self, id: &str, req: &UpdateSessionRequest) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();

        if let Some(title) = &req.title {
            conn.execute(
                "UPDATE sessions SET title = ?1 WHERE id = ?2",
                params![title, id],
            )
            .map_err(|e| format!("Failed to update title: {}", e))?;
        }

        if let Some(directory) = &req.directory {
            conn.execute(
                "UPDATE sessions SET directory = ?1 WHERE id = ?2",
                params![directory, id],
            )
            .map_err(|e| format!("Failed to update directory: {}", e))?;
        }

        if let Some(last_accessed_at) = req.last_accessed_at {
            conn.execute(
                "UPDATE sessions SET last_accessed_at = ?1 WHERE id = ?2",
                params![last_accessed_at, id],
            )
            .map_err(|e| format!("Failed to update last_accessed_at: {}", e))?;
        }

        Ok(())
    }

    /// Record the agent snapshot (kind, conversation id, cwd) for a session so
    /// it can be resumed after a quit or crash. A null `agent_kind` clears it.
    pub fn set_session_agent(&self, req: &SessionAgentUpdate) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions
             SET agent_kind = ?2,
                 agent_session_id = ?3,
                 agent_cwd = ?4,
                 agent_last_seen_at = ?5
             WHERE id = ?1",
            params![
                req.session_id,
                req.agent_kind,
                req.agent_session_id,
                req.agent_cwd,
                req.agent_last_seen_at,
            ],
        )
        .map_err(|e| format!("Failed to set session agent: {}", e))?;
        Ok(())
    }

    /// Read a value from the small app_state key/value store.
    pub fn get_app_state(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("Failed to read app_state: {}", other)),
        })
    }

    /// Upsert a value into the small app_state key/value store.
    pub fn set_app_state(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
            params![key, value, now()],
        )
        .map_err(|e| format!("Failed to write app_state: {}", e))?;
        Ok(())
    }

    // ========================================================================
    // Team Mode Operations
    // ========================================================================

    pub fn list_team_users(&self) -> Result<Vec<TeamUser>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, username, display_name, avatar_color, pwd, cmd, description,
                        enabled, created_at, updated_at
                 FROM team_users
                 ORDER BY username ASC",
            )
            .map_err(|e| format!("Failed to prepare team users query: {}", e))?;
        let result = stmt
            .query_map([], row_to_team_user)
            .map_err(|e| format!("Failed to query team users: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect team users: {}", e));
        result
    }

    pub fn get_team_user(&self, id: &str) -> Result<Option<TeamUser>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, username, display_name, avatar_color, pwd, cmd, description,
                    enabled, created_at, updated_at
             FROM team_users
             WHERE id = ?1",
            params![id],
            row_to_team_user,
        )
        .optional()
        .map_err(|e| format!("Failed to get team user: {}", e))
    }

    pub fn get_team_user_by_username(&self, username: &str) -> Result<Option<TeamUser>, String> {
        let normalized = username.trim().trim_start_matches('@').to_lowercase();
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, username, display_name, avatar_color, pwd, cmd, description,
                    enabled, created_at, updated_at
             FROM team_users
             WHERE username = ?1",
            params![normalized],
            row_to_team_user,
        )
        .optional()
        .map_err(|e| format!("Failed to get team user by username: {}", e))
    }

    pub fn save_team_user(&self, req: &TeamUserInput) -> Result<TeamUser, String> {
        let username = req.username.trim().trim_start_matches('@').to_lowercase();
        if username.is_empty() {
            return Err("username is required".to_string());
        }
        let display_name = req.display_name.trim();
        if display_name.is_empty() {
            return Err("display_name is required".to_string());
        }
        let pwd = req.pwd.trim();
        if pwd.is_empty() {
            return Err("pwd is required".to_string());
        }
        let cmd = req.cmd.trim();
        if cmd.is_empty() {
            return Err("cmd is required".to_string());
        }

        let existing_id = self
            .get_team_user_by_username(&username)?
            .map(|user| user.id);
        let id = req
            .id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_string())
            .or(existing_id)
            .unwrap_or_else(|| format!("team-user-{}", uuid::Uuid::new_v4()));
        let timestamp = now();
        let enabled = req.enabled.unwrap_or(true);

        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO team_users
                 (id, username, display_name, avatar_color, pwd, cmd, description, enabled, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                    username = ?2,
                    display_name = ?3,
                    avatar_color = ?4,
                    pwd = ?5,
                    cmd = ?6,
                    description = ?7,
                    enabled = ?8,
                    updated_at = ?9",
                params![
                    id,
                    username,
                    display_name,
                    req.avatar_color,
                    pwd,
                    cmd,
                    req.description,
                    if enabled { 1 } else { 0 },
                    timestamp,
                ],
            )
            .map_err(|e| format!("Failed to save team user: {}", e))?;
        }

        self.get_team_user(&id)?
            .ok_or_else(|| "Saved team user was not found".to_string())
    }

    pub fn list_team_channels(&self) -> Result<Vec<TeamChannel>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, display_name, description, created_at, updated_at, archived_at
                 FROM team_channels
                 WHERE archived_at IS NULL
                 ORDER BY name ASC",
            )
            .map_err(|e| format!("Failed to prepare team channels query: {}", e))?;
        let result = stmt
            .query_map([], row_to_team_channel)
            .map_err(|e| format!("Failed to query team channels: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect team channels: {}", e));
        result
    }

    pub fn get_team_channel(&self, id: &str) -> Result<Option<TeamChannel>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, display_name, description, created_at, updated_at, archived_at
             FROM team_channels
             WHERE id = ?1",
            params![id],
            row_to_team_channel,
        )
        .optional()
        .map_err(|e| format!("Failed to get team channel: {}", e))
    }

    pub fn get_team_channel_by_name(&self, name: &str) -> Result<Option<TeamChannel>, String> {
        let normalized = name.trim().trim_start_matches('#').to_lowercase();
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, display_name, description, created_at, updated_at, archived_at
             FROM team_channels
             WHERE name = ?1",
            params![normalized],
            row_to_team_channel,
        )
        .optional()
        .map_err(|e| format!("Failed to get team channel by name: {}", e))
    }

    pub fn save_team_channel(&self, req: &TeamChannelInput) -> Result<TeamChannel, String> {
        let name = req.name.trim().trim_start_matches('#').to_lowercase();
        if name.is_empty() {
            return Err("channel name is required".to_string());
        }
        let display_name = req.display_name.trim();
        if display_name.is_empty() {
            return Err("display_name is required".to_string());
        }
        let existing_id = self
            .get_team_channel_by_name(&name)?
            .map(|channel| channel.id);
        let id = req
            .id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_string())
            .or(existing_id)
            .unwrap_or_else(|| format!("channel-{}", uuid::Uuid::new_v4()));
        let conversation_id = format!("conversation-{}", id);
        let timestamp = now();

        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO team_channels
                 (id, name, display_name, description, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                    name = ?2,
                    display_name = ?3,
                    description = ?4,
                    updated_at = ?5",
                params![id, name, display_name, req.description, timestamp],
            )
            .map_err(|e| format!("Failed to save team channel: {}", e))?;
            conn.execute(
                "INSERT OR IGNORE INTO team_conversations
                 (id, kind, channel_id, title, created_at, updated_at)
                 VALUES (?1, 'channel', ?2, ?3, ?4, ?4)",
                params![conversation_id, id, display_name, timestamp],
            )
            .map_err(|e| format!("Failed to save team channel conversation: {}", e))?;
            conn.execute(
                "UPDATE team_conversations SET title = ?2, updated_at = ?3 WHERE id = ?1",
                params![conversation_id, display_name, timestamp],
            )
            .map_err(|e| format!("Failed to update team channel conversation: {}", e))?;
        }

        self.get_team_channel(&id)?
            .ok_or_else(|| "Saved team channel was not found".to_string())
    }

    pub fn list_team_conversations(&self) -> Result<Vec<TeamConversation>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, channel_id, title, created_at, updated_at, archived_at
                 FROM team_conversations
                 WHERE archived_at IS NULL
                 ORDER BY kind ASC, title ASC",
            )
            .map_err(|e| format!("Failed to prepare team conversations query: {}", e))?;
        let result = stmt
            .query_map([], row_to_team_conversation)
            .map_err(|e| format!("Failed to query team conversations: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect team conversations: {}", e));
        result
    }

    pub fn get_team_conversation(&self, id: &str) -> Result<Option<TeamConversation>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, kind, channel_id, title, created_at, updated_at, archived_at
             FROM team_conversations
             WHERE id = ?1",
            params![id],
            row_to_team_conversation,
        )
        .optional()
        .map_err(|e| format!("Failed to get team conversation: {}", e))
    }

    pub fn get_team_conversation_for_channel(
        &self,
        channel_id: &str,
    ) -> Result<Option<TeamConversation>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, kind, channel_id, title, created_at, updated_at, archived_at
             FROM team_conversations
             WHERE channel_id = ?1 AND kind = 'channel'",
            params![channel_id],
            row_to_team_conversation,
        )
        .optional()
        .map_err(|e| format!("Failed to get team channel conversation: {}", e))
    }

    pub fn get_or_create_team_dm(&self, user_id: &str) -> Result<TeamConversation, String> {
        let user = self
            .get_team_user(user_id)?
            .ok_or_else(|| format!("Team user not found: {}", user_id))?;
        let conversation_id = format!("dm-{}", user.id);
        let timestamp = now();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO team_conversations
                 (id, kind, channel_id, title, created_at, updated_at)
                 VALUES (?1, 'dm', NULL, ?2, ?3, ?3)",
                params![conversation_id, user.display_name, timestamp],
            )
            .map_err(|e| format!("Failed to create team DM: {}", e))?;
            conn.execute(
                "INSERT OR IGNORE INTO team_conversation_members
                 (conversation_id, member_kind, user_id, display_name, created_at)
                 VALUES (?1, 'agent', ?2, ?3, ?4)",
                params![conversation_id, user.id, user.display_name, timestamp],
            )
            .map_err(|e| format!("Failed to add team DM agent member: {}", e))?;
            conn.execute(
                "INSERT OR IGNORE INTO team_conversation_members
                 (conversation_id, member_kind, user_id, display_name, created_at)
                 VALUES (?1, 'human', NULL, 'You', ?2)",
                params![conversation_id, timestamp],
            )
            .map_err(|e| format!("Failed to add team DM human member: {}", e))?;
        }

        self.get_team_conversation(&conversation_id)?
            .ok_or_else(|| "Created team DM was not found".to_string())
    }

    pub fn get_team_message(&self, id: &str) -> Result<Option<TeamMessage>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, conversation_id, author_kind, author_user_id, content, created_at,
                    edited_at, deleted_at, status, parent_message_id, thread_reply_count,
                    last_reply_at, pty_session_id
             FROM team_messages
             WHERE id = ?1",
            params![id],
            row_to_team_message,
        )
        .optional()
        .map_err(|e| format!("Failed to get team message: {}", e))
    }

    pub fn list_team_messages(
        &self,
        conversation_id: &str,
        parent_message_id: Option<&str>,
    ) -> Result<Vec<TeamMessage>, String> {
        let conn = self.conn.lock().unwrap();
        if let Some(parent_id) = parent_message_id {
            let mut stmt = conn
                .prepare(
                    "SELECT id, conversation_id, author_kind, author_user_id, content, created_at,
                            edited_at, deleted_at, status, parent_message_id, thread_reply_count,
                            last_reply_at, pty_session_id
                     FROM team_messages
                     WHERE conversation_id = ?1 AND parent_message_id = ?2 AND deleted_at IS NULL
                     ORDER BY created_at ASC",
                )
                .map_err(|e| format!("Failed to prepare team thread query: {}", e))?;
            let result = stmt
                .query_map(params![conversation_id, parent_id], row_to_team_message)
                .map_err(|e| format!("Failed to query team thread: {}", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("Failed to collect team thread: {}", e));
            result
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, conversation_id, author_kind, author_user_id, content, created_at,
                            edited_at, deleted_at, status, parent_message_id, thread_reply_count,
                            last_reply_at, pty_session_id
                     FROM team_messages
                     WHERE conversation_id = ?1 AND parent_message_id IS NULL AND deleted_at IS NULL
                     ORDER BY created_at ASC",
                )
                .map_err(|e| format!("Failed to prepare team messages query: {}", e))?;
            let result = stmt
                .query_map(params![conversation_id], row_to_team_message)
                .map_err(|e| format!("Failed to query team messages: {}", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("Failed to collect team messages: {}", e));
            result
        }
    }

    pub fn create_team_message(&self, req: &TeamMessageInput) -> Result<TeamMessage, String> {
        if req.content.trim().is_empty() {
            return Err("message content is required".to_string());
        }
        let id = req
            .id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_string())
            .unwrap_or_else(|| format!("team-msg-{}", uuid::Uuid::new_v4()));
        let timestamp = now();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO team_messages
                 (id, conversation_id, author_kind, author_user_id, content, created_at, status,
                  parent_message_id, pty_session_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sent', ?7, ?8)",
                params![
                    id,
                    req.conversation_id,
                    req.author_kind,
                    req.author_user_id,
                    req.content,
                    timestamp,
                    req.parent_message_id,
                    req.pty_session_id,
                ],
            )
            .map_err(|e| format!("Failed to create team message: {}", e))?;

            if let Some(parent_id) = &req.parent_message_id {
                conn.execute(
                    "UPDATE team_messages
                     SET thread_reply_count = thread_reply_count + 1,
                         last_reply_at = ?2
                     WHERE id = ?1",
                    params![parent_id, timestamp],
                )
                .map_err(|e| format!("Failed to update team thread metadata: {}", e))?;
            }

            if req.author_kind == "agent" {
                conn.execute(
                    "DELETE FROM team_message_recipients
                     WHERE message_id = ?1 AND recipient_kind = 'human' AND recipient_user_id IS NULL",
                    params![id],
                )
                .map_err(|e| format!("Failed to clear team message recipient: {}", e))?;
                conn.execute(
                    "INSERT INTO team_message_recipients
                     (message_id, recipient_kind, recipient_user_id, channel_id, delivery_status,
                      delivered_at, read_at, unread)
                     VALUES (?1, 'human', NULL, NULL, 'delivered', ?2, NULL, 1)",
                    params![id, timestamp],
                )
                .map_err(|e| format!("Failed to create team message recipient: {}", e))?;
            }
        }

        self.get_team_message(&id)?
            .ok_or_else(|| "Created team message was not found".to_string())
    }

    pub fn mark_team_message_read(&self, message_id: &str) -> Result<(), String> {
        let timestamp = now();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE team_message_recipients
             SET delivery_status = 'read', read_at = ?2, unread = 0
             WHERE message_id = ?1 AND recipient_kind = 'human'",
            params![message_id, timestamp],
        )
        .map_err(|e| format!("Failed to mark team message read: {}", e))?;
        Ok(())
    }

    pub fn mark_team_message_unread(&self, message_id: &str) -> Result<(), String> {
        let timestamp = now();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM team_message_recipients
             WHERE message_id = ?1 AND recipient_kind = 'human' AND recipient_user_id IS NULL",
            params![message_id],
        )
        .map_err(|e| format!("Failed to clear team unread recipient: {}", e))?;
        conn.execute(
            "INSERT INTO team_message_recipients
             (message_id, recipient_kind, recipient_user_id, channel_id, delivery_status,
              delivered_at, read_at, unread)
             VALUES (?1, 'human', NULL, NULL, 'delivered', ?2, NULL, 1)",
            params![message_id, timestamp],
        )
        .map_err(|e| format!("Failed to mark team message unread: {}", e))?;
        Ok(())
    }

    pub fn mark_team_conversation_read(&self, conversation_id: &str) -> Result<(), String> {
        let timestamp = now();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE team_message_recipients
             SET delivery_status = 'read', read_at = ?2, unread = 0
             WHERE recipient_kind = 'human'
               AND message_id IN (SELECT id FROM team_messages WHERE conversation_id = ?1)",
            params![conversation_id, timestamp],
        )
        .map_err(|e| format!("Failed to mark team conversation read: {}", e))?;
        Ok(())
    }

    pub fn mark_team_thread_read(&self, parent_message_id: &str) -> Result<(), String> {
        let timestamp = now();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE team_message_recipients
             SET delivery_status = 'read', read_at = ?2, unread = 0
             WHERE recipient_kind = 'human'
               AND message_id IN (
                 SELECT id FROM team_messages WHERE id = ?1 OR parent_message_id = ?1
               )",
            params![parent_message_id, timestamp],
        )
        .map_err(|e| format!("Failed to mark team thread read: {}", e))?;
        Ok(())
    }

    pub fn list_team_pins(&self) -> Result<Vec<TeamPin>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.kind, p.title, p.file_path, p.url, p.message_id,
                        m.conversation_id, m.parent_message_id, m.content,
                        p.created_at, p.updated_at
                 FROM team_pins p
                 LEFT JOIN team_messages m ON m.id = p.message_id
                 ORDER BY p.created_at DESC",
            )
            .map_err(|e| format!("Failed to prepare team pins query: {}", e))?;
        let result = stmt
            .query_map([], row_to_team_pin)
            .map_err(|e| format!("Failed to query team pins: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect team pins: {}", e));
        result
    }

    pub fn get_team_pin(&self, id: &str) -> Result<Option<TeamPin>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT p.id, p.kind, p.title, p.file_path, p.url, p.message_id,
                    m.conversation_id, m.parent_message_id, m.content,
                    p.created_at, p.updated_at
             FROM team_pins p
             LEFT JOIN team_messages m ON m.id = p.message_id
             WHERE p.id = ?1",
            params![id],
            row_to_team_pin,
        )
        .optional()
        .map_err(|e| format!("Failed to get team pin: {}", e))
    }

    pub fn save_team_pin(&self, req: &TeamPinInput) -> Result<TeamPin, String> {
        let kind = req.kind.trim().to_lowercase();
        let file_path = req
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let url = req
            .url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let message_id = req
            .message_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        let message = if kind == "message" {
            let id = message_id
                .as_deref()
                .ok_or_else(|| "message_id is required for message pins".to_string())?;
            Some(
                self.get_team_message(id)?
                    .ok_or_else(|| format!("Team message not found: {}", id))?,
            )
        } else {
            None
        };

        match kind.as_str() {
            "file" if file_path.is_none() => {
                return Err("file_path is required for file pins".to_string())
            }
            "link" if url.is_none() => return Err("url is required for link pins".to_string()),
            "message" => {}
            "file" | "link" => {}
            _ => return Err("pin kind must be file, message, or link".to_string()),
        }

        let title = req
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| match kind.as_str() {
                "file" => file_path
                    .as_deref()
                    .and_then(|path| path.trim_end_matches('/').rsplit('/').next())
                    .filter(|value| !value.is_empty())
                    .unwrap_or("File")
                    .to_string(),
                "link" => url.clone().unwrap_or_else(|| "Link".to_string()),
                "message" => compact_pin_title(
                    message
                        .as_ref()
                        .map(|entry| entry.content.as_str())
                        .unwrap_or("Message"),
                    80,
                ),
                _ => "Pin".to_string(),
            });

        let timestamp = now();
        let id = {
            let conn = self.conn.lock().unwrap();
            let existing_id = match kind.as_str() {
                "file" => conn
                    .query_row(
                        "SELECT id FROM team_pins WHERE kind = 'file' AND file_path = ?1",
                        params![file_path.as_ref().unwrap()],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|e| format!("Failed to find existing file pin: {}", e))?,
                "link" => conn
                    .query_row(
                        "SELECT id FROM team_pins WHERE kind = 'link' AND url = ?1",
                        params![url.as_ref().unwrap()],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|e| format!("Failed to find existing link pin: {}", e))?,
                "message" => conn
                    .query_row(
                        "SELECT id FROM team_pins WHERE kind = 'message' AND message_id = ?1",
                        params![message_id.as_ref().unwrap()],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|e| format!("Failed to find existing message pin: {}", e))?,
                _ => None,
            };
            let id = req
                .id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.trim().to_string())
                .or(existing_id)
                .unwrap_or_else(|| format!("team-pin-{}", uuid::Uuid::new_v4()));

            conn.execute(
                "INSERT INTO team_pins
                 (id, kind, title, file_path, url, message_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                    kind = ?2,
                    title = ?3,
                    file_path = ?4,
                    url = ?5,
                    message_id = ?6,
                    updated_at = ?7",
                params![id, kind, title, file_path, url, message_id, timestamp],
            )
            .map_err(|e| format!("Failed to save team pin: {}", e))?;
            id
        };

        self.get_team_pin(&id)?
            .ok_or_else(|| "Saved team pin was not found".to_string())
    }

    pub fn delete_team_pin(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM team_pins WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete team pin: {}", e))?;
        Ok(())
    }

    pub fn create_team_agent_run(&self, req: &TeamAgentRunInput) -> Result<TeamAgentRun, String> {
        let user = self
            .get_team_user(&req.user_id)?
            .ok_or_else(|| format!("Team user not found: {}", req.user_id))?;
        if !user.enabled {
            return Err(format!("Team user '{}' is disabled", user.username));
        }
        let id = format!("team-run-{}", uuid::Uuid::new_v4());
        let rendered_command = render_team_command(&user.cmd, &req.user_msg);
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO team_agent_runs
                 (id, trigger_message_id, reply_parent_message_id, user_id, cwd,
                  command_template, rendered_command, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued')",
                params![
                    id,
                    req.trigger_message_id,
                    req.reply_parent_message_id,
                    req.user_id,
                    user.pwd,
                    user.cmd,
                    rendered_command,
                ],
            )
            .map_err(|e| format!("Failed to create team agent run: {}", e))?;
        }

        self.get_team_agent_run(&id)?
            .ok_or_else(|| "Created team agent run was not found".to_string())
    }

    pub fn get_team_agent_run(&self, id: &str) -> Result<Option<TeamAgentRun>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, trigger_message_id, reply_parent_message_id, user_id, pty_session_id,
                    cwd, command_template, rendered_command, status, started_at, completed_at,
                    exit_code, error
             FROM team_agent_runs
             WHERE id = ?1",
            params![id],
            row_to_team_agent_run,
        )
        .optional()
        .map_err(|e| format!("Failed to get team agent run: {}", e))
    }

    pub fn update_team_agent_run(
        &self,
        id: &str,
        req: &TeamAgentRunUpdate,
    ) -> Result<TeamAgentRun, String> {
        let status = req.status.as_deref();
        let timestamp = now();
        {
            let conn = self.conn.lock().unwrap();
            if let Some(pty_session_id) = &req.pty_session_id {
                conn.execute(
                    "UPDATE team_agent_runs SET pty_session_id = ?2 WHERE id = ?1",
                    params![id, pty_session_id],
                )
                .map_err(|e| format!("Failed to update team run pty: {}", e))?;
            }
            if let Some(status) = status {
                conn.execute(
                    "UPDATE team_agent_runs
                     SET status = ?2,
                         started_at = CASE
                           WHEN ?2 = 'running' AND started_at IS NULL THEN ?3
                           ELSE started_at
                         END,
                         completed_at = CASE
                           WHEN ?2 IN ('succeeded', 'failed', 'cancelled') THEN ?3
                           ELSE completed_at
                         END
                     WHERE id = ?1",
                    params![id, status, timestamp],
                )
                .map_err(|e| format!("Failed to update team run status: {}", e))?;
            }
            if req.exit_code.is_some() || req.error.is_some() {
                conn.execute(
                    "UPDATE team_agent_runs SET exit_code = ?2, error = ?3 WHERE id = ?1",
                    params![id, req.exit_code, req.error],
                )
                .map_err(|e| format!("Failed to update team run result: {}", e))?;
            }
        }

        self.get_team_agent_run(id)?
            .ok_or_else(|| "Updated team agent run was not found".to_string())
    }

    pub fn list_team_agent_runs(&self) -> Result<Vec<TeamAgentRun>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, trigger_message_id, reply_parent_message_id, user_id, pty_session_id,
                        cwd, command_template, rendered_command, status, started_at, completed_at,
                        exit_code, error
                 FROM team_agent_runs
                 ORDER BY COALESCE(started_at, completed_at, 0) DESC, id DESC
                 LIMIT 100",
            )
            .map_err(|e| format!("Failed to prepare team runs query: {}", e))?;
        let result = stmt
            .query_map([], row_to_team_agent_run)
            .map_err(|e| format!("Failed to query team runs: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect team runs: {}", e));
        result
    }

    pub fn get_team_inbox(&self) -> Result<Vec<TeamInboxItem>, String> {
        let rows: Vec<(String, Option<i64>, Option<i64>)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT message_id, delivered_at, read_at
                     FROM team_message_recipients
                     WHERE recipient_kind = 'human' AND unread = 1
                     ORDER BY COALESCE(delivered_at, 0) DESC
                     LIMIT 200",
                )
                .map_err(|e| format!("Failed to prepare team inbox query: {}", e))?;
            let result = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|e| format!("Failed to query team inbox: {}", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("Failed to collect team inbox: {}", e))?;
            result
        };

        let mut items = Vec::new();
        for (message_id, delivered_at, read_at) in rows {
            let Some(message) = self.get_team_message(&message_id)? else {
                continue;
            };
            let Some(conversation) = self.get_team_conversation(&message.conversation_id)? else {
                continue;
            };
            let channel = conversation
                .channel_id
                .as_deref()
                .map(|id| self.get_team_channel(id))
                .transpose()?
                .flatten();
            let author = message
                .author_user_id
                .as_deref()
                .map(|id| self.get_team_user(id))
                .transpose()?
                .flatten();
            let parent_message = message
                .parent_message_id
                .as_deref()
                .map(|id| self.get_team_message(id))
                .transpose()?
                .flatten();
            items.push(TeamInboxItem {
                message,
                conversation,
                channel,
                author,
                parent_message,
                delivered_at,
                read_at,
            });
        }

        Ok(items)
    }

    /// List all open (non-closed) sessions
    pub fn list_sessions(&self) -> Result<Vec<Session>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SESSION_COLUMNS}
                 FROM sessions
                 WHERE is_closed = 0
                 ORDER BY created_at ASC"
            ))
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let sessions = stmt
            .query_map([], |row| row_to_session(row))
            .map_err(|e| format!("Failed to query sessions: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect sessions: {}", e))?;

        Ok(sessions)
    }

    /// Get a specific session by ID
    pub fn get_session(&self, id: &str) -> Result<Option<Session>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1"
            ))
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut rows = stmt
            .query(params![id])
            .map_err(|e| format!("Failed to query: {}", e))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to get row: {}", e))?
        {
            Ok(Some(
                row_to_session(row).map_err(|e| format!("Failed to read session: {}", e))?,
            ))
        } else {
            Ok(None)
        }
    }

    /// Mark a session as closed (soft delete)
    pub fn close_session(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let timestamp = now();
        conn.execute(
            "UPDATE sessions SET is_closed = 1, closed_at = ?2 WHERE id = ?1",
            params![id, timestamp],
        )
        .map_err(|e| format!("Failed to close session: {}", e))?;
        Ok(())
    }

    /// Reopen a previously closed session
    pub fn reopen_session(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let timestamp = now();
        conn.execute(
            "UPDATE sessions SET is_closed = 0, closed_at = NULL, last_accessed_at = ?2 WHERE id = ?1",
            params![id, timestamp],
        )
        .map_err(|e| format!("Failed to reopen session: {}", e))?;
        Ok(())
    }

    /// List recently closed sessions ordered by recency
    pub fn list_closed_sessions(&self, limit: Option<usize>) -> Result<Vec<Session>, String> {
        let conn = self.conn.lock().unwrap();
        let max_items = limit.unwrap_or(20).clamp(1, 200) as i64;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SESSION_COLUMNS}
                 FROM sessions
                 WHERE is_closed = 1
                 ORDER BY COALESCE(closed_at, last_accessed_at, created_at) DESC
                 LIMIT ?1"
            ))
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let sessions = stmt
            .query_map(params![max_items], |row| row_to_session(row))
            .map_err(|e| format!("Failed to query closed sessions: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect closed sessions: {}", e))?;

        Ok(sessions)
    }

    /// Permanently delete a session and its associated data
    pub fn delete_session(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        // Delete scrollback first (foreign key)
        conn.execute(
            "DELETE FROM session_scrollback WHERE session_id = ?1",
            params![id],
        )
        .map_err(|e| format!("Failed to delete scrollback: {}", e))?;
        // Delete tags (foreign key)
        conn.execute(
            "DELETE FROM session_tags WHERE session_id = ?1",
            params![id],
        )
        .map_err(|e| format!("Failed to delete tags: {}", e))?;
        // Delete session
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete session: {}", e))?;
        Ok(())
    }

    // ========================================================================
    // Session Tags Operations
    // ========================================================================

    /// Get tags for a session
    pub fn get_session_tags(&self, session_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT tag FROM session_tags WHERE session_id = ?1 ORDER BY tag")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let tags = stmt
            .query_map(params![session_id], |row| row.get(0))
            .map_err(|e| format!("Failed to query tags: {}", e))?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| format!("Failed to collect tags: {}", e))?;

        Ok(tags)
    }

    /// Set tags for a session (replaces existing tags)
    pub fn set_session_tags(&self, session_id: &str, tags: &[String]) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();

        // Delete existing tags
        conn.execute(
            "DELETE FROM session_tags WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| format!("Failed to clear tags: {}", e))?;

        // Insert new tags
        for tag in tags {
            conn.execute(
                "INSERT INTO session_tags (session_id, tag) VALUES (?1, ?2)",
                params![session_id, tag],
            )
            .map_err(|e| format!("Failed to insert tag: {}", e))?;
        }

        Ok(())
    }

    /// Get all tags for all open sessions (for bulk loading)
    pub fn get_all_session_tags(
        &self,
    ) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT st.session_id, st.tag
                 FROM session_tags st
                 INNER JOIN sessions s ON s.id = st.session_id
                 WHERE s.is_closed = 0
                 ORDER BY st.session_id, st.tag",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut result: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();

        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("Failed to query tags: {}", e))?;

        for row in rows {
            let (session_id, tag) = row.map_err(|e| format!("Failed to get row: {}", e))?;
            result.entry(session_id).or_default().push(tag);
        }

        Ok(result)
    }

    // ========================================================================
    // Session Scrollback Operations
    // ========================================================================

    /// Save scrollback content for a session
    pub fn save_scrollback(&self, session_id: &str, content: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let timestamp = now();

        conn.execute(
            r#"
            INSERT INTO session_scrollback (session_id, content, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(session_id) DO UPDATE SET content = ?2, updated_at = ?3
            "#,
            params![session_id, content, timestamp],
        )
        .map_err(|e| format!("Failed to save scrollback: {}", e))?;

        Ok(())
    }

    /// Get scrollback content for a session
    pub fn get_scrollback(&self, session_id: &str) -> Result<Option<SessionScrollback>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT session_id, content, updated_at FROM session_scrollback WHERE session_id = ?1")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut rows = stmt
            .query(params![session_id])
            .map_err(|e| format!("Failed to query: {}", e))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to get row: {}", e))?
        {
            Ok(Some(SessionScrollback {
                session_id: row
                    .get(0)
                    .map_err(|e| format!("Failed to get session_id: {}", e))?,
                content: row
                    .get(1)
                    .map_err(|e| format!("Failed to get content: {}", e))?,
                updated_at: row
                    .get(2)
                    .map_err(|e| format!("Failed to get updated_at: {}", e))?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Delete scrollback for a session
    pub fn delete_scrollback(&self, session_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM session_scrollback WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| format!("Failed to delete scrollback: {}", e))?;
        Ok(())
    }

    // ========================================================================
    // Clipboard history
    // ========================================================================

    pub fn clipboard_insert(&self, entry: &NewClipboardEntry) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO clipboard_history (kind, text, image_path, source_app, byte_len, content_hash, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                entry.kind,
                entry.text,
                entry.image_path,
                entry.source_app,
                entry.byte_len as i64,
                entry.content_hash,
                entry.created_at,
            ],
        )
        .map_err(|e| format!("Failed to insert clipboard entry: {}", e))?;
        Ok(conn.last_insert_rowid())
    }

    /// If the most recent entry has the same hash, bump its created_at and return its id.
    pub fn clipboard_touch_if_recent_dup(
        &self,
        hash: &str,
        now: i64,
    ) -> Result<Option<i64>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, content_hash FROM clipboard_history ORDER BY created_at DESC LIMIT 1",
            )
            .map_err(|e| format!("Failed to prepare dedupe query: {}", e))?;
        let head: Option<(i64, String)> = stmt
            .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))
            .ok();
        if let Some((id, head_hash)) = head {
            if head_hash == hash {
                conn.execute(
                    "UPDATE clipboard_history SET created_at = ?1 WHERE id = ?2",
                    params![now, id],
                )
                .map_err(|e| format!("Failed to bump clipboard entry: {}", e))?;
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    pub fn clipboard_list(&self, limit: i64) -> Result<Vec<ClipboardEntry>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, kind, text, image_path, source_app, byte_len, content_hash, created_at
                FROM clipboard_history
                ORDER BY created_at DESC
                LIMIT ?1
                "#,
            )
            .map_err(|e| format!("Failed to prepare list query: {}", e))?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(ClipboardEntry {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    text: row.get(2)?,
                    image_path: row.get(3)?,
                    source_app: row.get(4)?,
                    byte_len: row.get::<_, i64>(5)? as usize,
                    content_hash: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })
            .map_err(|e| format!("Failed to query clipboard: {}", e))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("Failed to read clipboard row: {}", e))?);
        }
        Ok(out)
    }

    pub fn clipboard_get(&self, id: i64) -> Result<Option<ClipboardEntry>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, kind, text, image_path, source_app, byte_len, content_hash, created_at
                FROM clipboard_history WHERE id = ?1
                "#,
            )
            .map_err(|e| format!("Failed to prepare get query: {}", e))?;
        let result = stmt.query_row(params![id], |row| {
            Ok(ClipboardEntry {
                id: row.get(0)?,
                kind: row.get(1)?,
                text: row.get(2)?,
                image_path: row.get(3)?,
                source_app: row.get(4)?,
                byte_len: row.get::<_, i64>(5)? as usize,
                content_hash: row.get(6)?,
                created_at: row.get(7)?,
            })
        });
        match result {
            Ok(entry) => Ok(Some(entry)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to fetch clipboard entry: {}", e)),
        }
    }

    pub fn clipboard_delete(&self, id: i64) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        let image_path: Option<String> = conn
            .query_row(
                "SELECT image_path FROM clipboard_history WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        conn.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete clipboard entry: {}", e))?;
        Ok(image_path)
    }

    pub fn clipboard_clear(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT image_path FROM clipboard_history WHERE image_path IS NOT NULL")
            .map_err(|e| format!("Failed to prepare clear query: {}", e))?;
        let paths: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query images: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        conn.execute("DELETE FROM clipboard_history", [])
            .map_err(|e| format!("Failed to clear clipboard history: {}", e))?;
        Ok(paths)
    }

    /// Trim history to caps. Returns image paths that should be removed from disk.
    pub fn clipboard_evict(&self, max_text: i64, max_image: i64) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut to_remove: Vec<(i64, Option<String>)> = Vec::new();

        for (kind, cap) in [("text", max_text), ("image", max_image)] {
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT id, image_path FROM clipboard_history
                    WHERE kind = ?1
                    ORDER BY created_at DESC
                    LIMIT -1 OFFSET ?2
                    "#,
                )
                .map_err(|e| format!("Failed to prepare evict query: {}", e))?;
            let rows = stmt
                .query_map(params![kind, cap], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(|e| format!("Failed to query evict: {}", e))?;
            for r in rows {
                to_remove.push(r.map_err(|e| format!("Failed to read evict row: {}", e))?);
            }
        }

        let mut paths = Vec::new();
        for (id, image_path) in to_remove {
            conn.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to delete evicted: {}", e))?;
            if let Some(p) = image_path {
                paths.push(p);
            }
        }
        Ok(paths)
    }
}

// ============================================================================
// Clipboard history types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    pub id: i64,
    pub kind: String,
    pub text: Option<String>,
    pub image_path: Option<String>,
    pub source_app: Option<String>,
    pub byte_len: usize,
    pub content_hash: String,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewClipboardEntry {
    pub kind: String,
    pub text: Option<String>,
    pub image_path: Option<String>,
    pub source_app: Option<String>,
    pub byte_len: usize,
    pub content_hash: String,
    pub created_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_db() -> AgentDatabase {
        AgentDatabase::open_in_memory().expect("Failed to open in-memory database")
    }

    // ========================================================================
    // Schema Tests
    // ========================================================================

    #[test]
    fn test_schema_creates_hook_events_table() {
        let db = make_db();
        db.insert_hook_event("sess-1", 1234, "UserPromptSubmit", 1000)
            .expect("insert should succeed");
        let result = db
            .get_latest_hook_event_by_pid(1234)
            .expect("query should succeed");
        assert!(result.is_some());
    }

    #[test]
    fn test_team_mode_threaded_agent_reply_and_inbox_state() {
        let db = make_db();
        let molly = db
            .save_team_user(&TeamUserInput {
                id: Some("user-molly".to_string()),
                username: "molly".to_string(),
                display_name: "Molly".to_string(),
                avatar_color: None,
                pwd: "/tmp".to_string(),
                cmd: "claude -p \"{user_msg}\"".to_string(),
                description: None,
                enabled: Some(true),
            })
            .unwrap();

        let general = db.get_team_channel_by_name("general").unwrap().unwrap();
        let conversation = db
            .get_team_conversation_for_channel(&general.id)
            .unwrap()
            .unwrap();
        let top_level = db
            .create_team_message(&TeamMessageInput {
                id: Some("msg-1".to_string()),
                conversation_id: conversation.id.clone(),
                author_kind: "human".to_string(),
                author_user_id: None,
                content: "hey @molly please look at xyz".to_string(),
                parent_message_id: None,
                pty_session_id: None,
            })
            .unwrap();

        let run = db
            .create_team_agent_run(&TeamAgentRunInput {
                trigger_message_id: top_level.id.clone(),
                reply_parent_message_id: top_level.id.clone(),
                user_id: molly.id.clone(),
                user_msg: top_level.content.clone(),
            })
            .unwrap();
        assert_eq!(run.cwd, "/tmp");
        assert_eq!(
            run.rendered_command,
            "claude -p 'hey @molly please look at xyz'"
        );

        db.create_team_message(&TeamMessageInput {
            id: Some("msg-2".to_string()),
            conversation_id: conversation.id.clone(),
            author_kind: "agent".to_string(),
            author_user_id: Some(molly.id),
            content: "I checked xyz.".to_string(),
            parent_message_id: Some(top_level.id.clone()),
            pty_session_id: Some(run.id),
        })
        .unwrap();

        let refreshed_parent = db.get_team_message(&top_level.id).unwrap().unwrap();
        assert_eq!(refreshed_parent.thread_reply_count, 1);
        assert!(refreshed_parent.last_reply_at.is_some());

        let inbox = db.get_team_inbox().unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].message.content, "I checked xyz.");
        assert_eq!(
            inbox[0].parent_message.as_ref().map(|msg| msg.id.as_str()),
            Some("msg-1")
        );

        db.mark_team_message_read("msg-2").unwrap();
        assert!(db.get_team_inbox().unwrap().is_empty());

        db.mark_team_message_unread("msg-2").unwrap();
        assert_eq!(db.get_team_inbox().unwrap().len(), 1);
    }

    #[test]
    fn test_team_pins_store_file_link_and_message_targets() {
        let db = make_db();
        let general = db.get_team_channel_by_name("general").unwrap().unwrap();
        let conversation = db
            .get_team_conversation_for_channel(&general.id)
            .unwrap()
            .unwrap();
        let message = db
            .create_team_message(&TeamMessageInput {
                id: Some("pin-msg-1".to_string()),
                conversation_id: conversation.id.clone(),
                author_kind: "human".to_string(),
                author_user_id: None,
                content: "please keep this around".to_string(),
                parent_message_id: None,
                pty_session_id: None,
            })
            .unwrap();

        let file_pin = db
            .save_team_pin(&TeamPinInput {
                id: None,
                kind: "file".to_string(),
                title: None,
                file_path: Some("/tmp/readme.md".to_string()),
                url: None,
                message_id: None,
            })
            .unwrap();
        assert_eq!(file_pin.title, "readme.md");

        db.save_team_pin(&TeamPinInput {
            id: None,
            kind: "link".to_string(),
            title: Some("Docs".to_string()),
            file_path: None,
            url: Some("https://example.com/docs".to_string()),
            message_id: None,
        })
        .unwrap();

        let message_pin = db
            .save_team_pin(&TeamPinInput {
                id: None,
                kind: "message".to_string(),
                title: None,
                file_path: None,
                url: None,
                message_id: Some(message.id.clone()),
            })
            .unwrap();
        assert_eq!(message_pin.message_conversation_id, Some(conversation.id));
        assert_eq!(message_pin.message_preview, Some(message.content));

        let updated_file_pin = db
            .save_team_pin(&TeamPinInput {
                id: None,
                kind: "file".to_string(),
                title: Some("README".to_string()),
                file_path: Some("/tmp/readme.md".to_string()),
                url: None,
                message_id: None,
            })
            .unwrap();
        assert_eq!(updated_file_pin.id, file_pin.id);
        assert_eq!(db.list_team_pins().unwrap().len(), 3);

        db.delete_team_pin(&updated_file_pin.id).unwrap();
        assert_eq!(db.list_team_pins().unwrap().len(), 2);
    }

    // ========================================================================
    // get_latest_hook_event_by_pid Tests
    // ========================================================================

    #[test]
    fn test_no_events_returns_none() {
        let db = make_db();
        let result = db.get_latest_hook_event_by_pid(9999).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_exact_pid_match() {
        let db = make_db();
        db.insert_hook_event("sess-1", 1000, "UserPromptSubmit", 1000)
            .unwrap();
        let result = db.get_latest_hook_event_by_pid(1000).unwrap();
        assert_eq!(result, Some(("UserPromptSubmit".to_string(), 1000)));
    }

    #[test]
    fn test_returns_latest_event_for_same_pid() {
        let db = make_db();
        db.insert_hook_event("sess-1", 1000, "UserPromptSubmit", 1000)
            .unwrap();
        db.insert_hook_event("sess-1", 1000, "Stop", 2000).unwrap();
        db.insert_hook_event("sess-1", 1000, "UserPromptSubmit", 3000)
            .unwrap();

        let result = db.get_latest_hook_event_by_pid(1000).unwrap();
        assert_eq!(result, Some(("UserPromptSubmit".to_string(), 3000)));
    }

    #[test]
    fn test_no_match_for_different_pid() {
        let db = make_db();
        db.insert_hook_event("sess-1", 1000, "UserPromptSubmit", 1000)
            .unwrap();
        let result = db.get_latest_hook_event_by_pid(2000).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_multiple_pids_returns_correct_one() {
        let db = make_db();
        db.insert_hook_event("sess-1", 1000, "UserPromptSubmit", 1000)
            .unwrap();
        db.insert_hook_event("sess-2", 2000, "Stop", 2000).unwrap();

        let r1 = db.get_latest_hook_event_by_pid(1000).unwrap();
        assert_eq!(r1, Some(("UserPromptSubmit".to_string(), 1000)));

        let r2 = db.get_latest_hook_event_by_pid(2000).unwrap();
        assert_eq!(r2, Some(("Stop".to_string(), 2000)));
    }

    #[test]
    fn test_different_sessions_same_pid() {
        let db = make_db();
        db.insert_hook_event("sess-1", 1000, "UserPromptSubmit", 1000)
            .unwrap();
        db.insert_hook_event("sess-2", 1000, "Stop", 2000).unwrap();

        let result = db.get_latest_hook_event_by_pid(1000).unwrap();
        assert_eq!(result, Some(("Stop".to_string(), 2000)));
    }

    // ========================================================================
    // cleanup_old_hook_events Tests
    // ========================================================================

    #[test]
    fn test_cleanup_removes_old_events() {
        let db = make_db();
        let old_ts = now() - 100_000;
        let recent_ts = now() - 10;

        db.insert_hook_event("sess-1", 1000, "UserPromptSubmit", old_ts)
            .unwrap();
        db.insert_hook_event("sess-2", 2000, "Stop", recent_ts)
            .unwrap();

        let removed = db.cleanup_old_hook_events(86400).unwrap();
        assert_eq!(removed, 1);

        assert!(db.get_latest_hook_event_by_pid(1000).unwrap().is_none());
        assert!(db.get_latest_hook_event_by_pid(2000).unwrap().is_some());
    }

    #[test]
    fn test_cleanup_with_no_old_events() {
        let db = make_db();
        let recent_ts = now() - 10;
        db.insert_hook_event("sess-1", 1000, "UserPromptSubmit", recent_ts)
            .unwrap();

        let removed = db.cleanup_old_hook_events(86400).unwrap();
        assert_eq!(removed, 0);
        assert!(db.get_latest_hook_event_by_pid(1000).unwrap().is_some());
    }

    #[test]
    fn test_cleanup_empty_table() {
        let db = make_db();
        let removed = db.cleanup_old_hook_events(86400).unwrap();
        assert_eq!(removed, 0);
    }

    #[test]
    fn test_first_user_prompt_by_agent_session_id_returns_earliest_prompt() {
        let db = make_db();
        db.insert_hook_event_with_prompt("agent-1", 1000, "UserPromptSubmit", 2000, Some("second"))
            .unwrap();
        db.insert_hook_event_with_prompt("agent-1", 1000, "Stop", 2500, None)
            .unwrap();
        db.insert_hook_event_with_prompt("agent-1", 1000, "UserPromptSubmit", 1000, Some("first"))
            .unwrap();

        let first = db
            .get_first_user_prompt_by_agent_session_id("agent-1")
            .unwrap();
        assert_eq!(first, Some("first".to_string()));
    }

    #[test]
    fn test_first_user_prompt_skips_task_notifications_and_bare_slash_commands() {
        let db = make_db();
        db.insert_hook_event_with_prompt(
            "agent-2",
            1001,
            "UserPromptSubmit",
            1000,
            Some("/status"),
        )
        .unwrap();
        db.insert_hook_event_with_prompt(
            "agent-2",
            1001,
            "UserPromptSubmit",
            1200,
            Some("<task-notification>...</task-notification>"),
        )
        .unwrap();
        db.insert_hook_event_with_prompt(
            "agent-2",
            1001,
            "UserPromptSubmit",
            1400,
            Some("ship the canvas recorder"),
        )
        .unwrap();

        let first = db
            .get_first_user_prompt_by_agent_session_id("agent-2")
            .unwrap();
        assert_eq!(first, Some("ship the canvas recorder".to_string()));
    }

    #[test]
    fn test_first_user_prompt_keeps_slash_commands_with_arguments() {
        let db = make_db();
        db.insert_hook_event_with_prompt(
            "agent-3",
            1002,
            "UserPromptSubmit",
            1000,
            Some("/status"),
        )
        .unwrap();
        db.insert_hook_event_with_prompt(
            "agent-3",
            1002,
            "UserPromptSubmit",
            1100,
            Some("/devops who signed up last 7 days?"),
        )
        .unwrap();

        let first = db
            .get_first_user_prompt_by_agent_session_id("agent-3")
            .unwrap();
        assert_eq!(
            first,
            Some("/devops who signed up last 7 days?".to_string())
        );
    }
}
