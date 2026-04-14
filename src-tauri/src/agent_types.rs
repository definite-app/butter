use serde::{Deserialize, Serialize};

/// Agent roles determine capabilities and permissions
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentRole {
    Manager,
    Worker,
    Reviewer,
}

impl std::fmt::Display for AgentRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentRole::Manager => write!(f, "manager"),
            AgentRole::Worker => write!(f, "worker"),
            AgentRole::Reviewer => write!(f, "reviewer"),
        }
    }
}

impl std::str::FromStr for AgentRole {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "manager" => Ok(AgentRole::Manager),
            "worker" => Ok(AgentRole::Worker),
            "reviewer" => Ok(AgentRole::Reviewer),
            _ => Err(format!("Unknown role: {}", s)),
        }
    }
}

/// Agent status
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Active,
    Busy,
    Idle,
    Offline,
}

impl std::fmt::Display for AgentStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentStatus::Active => write!(f, "active"),
            AgentStatus::Busy => write!(f, "busy"),
            AgentStatus::Idle => write!(f, "idle"),
            AgentStatus::Offline => write!(f, "offline"),
        }
    }
}

impl std::str::FromStr for AgentStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "active" => Ok(AgentStatus::Active),
            "busy" => Ok(AgentStatus::Busy),
            "idle" => Ok(AgentStatus::Idle),
            "offline" => Ok(AgentStatus::Offline),
            _ => Err(format!("Unknown status: {}", s)),
        }
    }
}

/// Message types
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageType {
    Ask,
    Respond,
    Notify,
}

impl std::fmt::Display for MessageType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MessageType::Ask => write!(f, "ask"),
            MessageType::Respond => write!(f, "respond"),
            MessageType::Notify => write!(f, "notify"),
        }
    }
}

impl std::str::FromStr for MessageType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "ask" => Ok(MessageType::Ask),
            "respond" => Ok(MessageType::Respond),
            "notify" => Ok(MessageType::Notify),
            _ => Err(format!("Unknown message type: {}", s)),
        }
    }
}

/// Message status
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageStatus {
    Pending,
    Read,
    Responded,
}

impl std::fmt::Display for MessageStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MessageStatus::Pending => write!(f, "pending"),
            MessageStatus::Read => write!(f, "read"),
            MessageStatus::Responded => write!(f, "responded"),
        }
    }
}

impl std::str::FromStr for MessageStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "pending" => Ok(MessageStatus::Pending),
            "read" => Ok(MessageStatus::Read),
            "responded" => Ok(MessageStatus::Responded),
            _ => Err(format!("Unknown message status: {}", s)),
        }
    }
}

/// Task status
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

impl std::fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskStatus::Pending => write!(f, "pending"),
            TaskStatus::InProgress => write!(f, "in_progress"),
            TaskStatus::Completed => write!(f, "completed"),
            TaskStatus::Failed => write!(f, "failed"),
        }
    }
}

impl std::str::FromStr for TaskStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "pending" => Ok(TaskStatus::Pending),
            "in_progress" => Ok(TaskStatus::InProgress),
            "completed" => Ok(TaskStatus::Completed),
            "failed" => Ok(TaskStatus::Failed),
            _ => Err(format!("Unknown task status: {}", s)),
        }
    }
}

// ============================================================================
// Domain Models
// ============================================================================

/// Registered agent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub role: AgentRole,
    pub capabilities: Vec<String>,
    pub working_directory: Option<String>,
    pub terminal_id: Option<String>,
    pub status: AgentStatus,
    pub registered_at: i64,
    pub last_heartbeat: i64,
}

/// Message between agents
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: i64,
    pub from_agent: String,
    pub to_agent: Option<String>,
    pub message_type: MessageType,
    pub content: String,
    pub context: Option<serde_json::Value>,
    pub status: MessageStatus,
    pub created_at: i64,
    pub read_at: Option<i64>,
    pub response_id: Option<i64>,
}

/// Task assignment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub assigned_by: Option<String>,
    pub assigned_to: Option<String>,
    pub status: TaskStatus,
    pub priority: i32,
    pub context: Option<serde_json::Value>,
    pub result: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

/// Shared context key-value pair
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedContext {
    pub key: String,
    pub value: String,
    pub set_by: Option<String>,
    pub updated_at: i64,
}

// ============================================================================
// API Request/Response Types
// ============================================================================

/// Request to register a new agent
#[derive(Debug, Deserialize)]
pub struct RegisterAgentRequest {
    pub name: String,
    pub role: AgentRole,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub working_directory: Option<String>,
    pub terminal_id: Option<String>,
}

/// Response after registering an agent
#[derive(Debug, Serialize)]
pub struct RegisterAgentResponse {
    pub agent_id: String,
    pub success: bool,
}

/// Request to update agent status
#[derive(Debug, Deserialize)]
pub struct UpdateAgentRequest {
    pub status: Option<AgentStatus>,
    pub terminal_id: Option<String>,
}

/// Request to ask another agent a question
#[derive(Debug, Deserialize)]
pub struct AskMessageRequest {
    pub from: String,
    pub to: String,
    pub message: String,
    #[serde(default)]
    pub context: Option<serde_json::Value>,
    #[serde(default)]
    pub wait_for_response: bool,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}

fn default_timeout() -> u64 {
    60
}

/// Response to ask request
#[derive(Debug, Serialize)]
pub struct AskMessageResponse {
    pub message_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
}

/// Request to respond to a message
#[derive(Debug, Deserialize)]
pub struct RespondMessageRequest {
    pub from: String,
    pub response: String,
}

/// Request to broadcast a message
#[derive(Debug, Deserialize)]
pub struct BroadcastRequest {
    pub from: String,
    pub message: String,
}

/// Request to create a task
#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    pub description: Option<String>,
    pub assigned_by: Option<String>,
    pub assigned_to: Option<String>,
    #[serde(default = "default_priority")]
    pub priority: i32,
    pub context: Option<serde_json::Value>,
}

fn default_priority() -> i32 {
    5
}

/// Response after creating a task
#[derive(Debug, Serialize)]
pub struct CreateTaskResponse {
    pub task_id: String,
}

/// Request to claim a task
#[derive(Debug, Deserialize)]
pub struct ClaimTaskRequest {
    pub agent_id: String,
}

/// Request to update a task
#[derive(Debug, Deserialize)]
pub struct UpdateTaskRequest {
    pub status: Option<TaskStatus>,
    pub result: Option<String>,
}

/// Request to set shared context
#[derive(Debug, Deserialize)]
pub struct SetContextRequest {
    pub value: String,
    pub set_by: Option<String>,
}

/// Generic list response wrapper
#[derive(Debug, Serialize)]
pub struct ListResponse<T> {
    pub items: Vec<T>,
    pub count: usize,
}

/// Generic error response
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}
