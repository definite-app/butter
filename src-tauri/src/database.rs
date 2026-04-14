use crate::agent_types::*;
use rusqlite::{params, Connection};
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

/// Get current Unix timestamp
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
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
                closed_at INTEGER
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
            "#,
        )
        .map_err(|e| format!("Failed to initialize schema: {}", e))?;

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

        if let Err(err) =
            conn.execute("ALTER TABLE hook_events ADD COLUMN suggested_title TEXT", [])
        {
            let message = err.to_string();
            if !message.contains("duplicate column name") {
                return Err(format!(
                    "Failed to migrate hook_events.suggested_title column: {}",
                    err
                ));
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

    /// List all open (non-closed) sessions
    pub fn list_sessions(&self) -> Result<Vec<Session>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, directory, command, created_at, last_accessed_at, is_closed, closed_at
                 FROM sessions
                 WHERE is_closed = 0
                 ORDER BY created_at ASC"
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let sessions = stmt
            .query_map([], |row| {
                Ok(Session {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    directory: row.get(2)?,
                    command: row.get(3)?,
                    created_at: row.get(4)?,
                    last_accessed_at: row.get(5)?,
                    is_closed: row.get::<_, i32>(6)? != 0,
                    closed_at: row.get(7)?,
                })
            })
            .map_err(|e| format!("Failed to query sessions: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect sessions: {}", e))?;

        Ok(sessions)
    }

    /// Get a specific session by ID
    pub fn get_session(&self, id: &str) -> Result<Option<Session>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, directory, command, created_at, last_accessed_at, is_closed, closed_at
                 FROM sessions WHERE id = ?1"
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut rows = stmt
            .query(params![id])
            .map_err(|e| format!("Failed to query: {}", e))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to get row: {}", e))?
        {
            Ok(Some(Session {
                id: row.get(0).map_err(|e| format!("Failed to get id: {}", e))?,
                title: row
                    .get(1)
                    .map_err(|e| format!("Failed to get title: {}", e))?,
                directory: row
                    .get(2)
                    .map_err(|e| format!("Failed to get directory: {}", e))?,
                command: row
                    .get(3)
                    .map_err(|e| format!("Failed to get command: {}", e))?,
                created_at: row
                    .get(4)
                    .map_err(|e| format!("Failed to get created_at: {}", e))?,
                last_accessed_at: row
                    .get(5)
                    .map_err(|e| format!("Failed to get last_accessed_at: {}", e))?,
                is_closed: row
                    .get::<_, i32>(6)
                    .map_err(|e| format!("Failed to get is_closed: {}", e))?
                    != 0,
                closed_at: row
                    .get(7)
                    .map_err(|e| format!("Failed to get closed_at: {}", e))?,
            }))
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
            .prepare(
                "SELECT id, title, directory, command, created_at, last_accessed_at, is_closed, closed_at
                 FROM sessions
                 WHERE is_closed = 1
                 ORDER BY COALESCE(closed_at, last_accessed_at, created_at) DESC
                 LIMIT ?1"
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let sessions = stmt
            .query_map(params![max_items], |row| {
                Ok(Session {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    directory: row.get(2)?,
                    command: row.get(3)?,
                    created_at: row.get(4)?,
                    last_accessed_at: row.get(5)?,
                    is_closed: row.get::<_, i32>(6)? != 0,
                    closed_at: row.get(7)?,
                })
            })
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
            .prepare("SELECT id, content_hash FROM clipboard_history ORDER BY created_at DESC LIMIT 1")
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
    pub fn clipboard_evict(
        &self,
        max_text: i64,
        max_image: i64,
    ) -> Result<Vec<String>, String> {
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
