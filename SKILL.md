# Butter Agent API

This document describes the Agent API that enables AI agents (like Claude Code) running in different Ghostty terminals to communicate, collaborate, and coordinate work.

## Overview

When Butter is running, it exposes an HTTP API on `http://localhost:9876` that allows:
- **Agent Registration** - Terminals can register as agents with roles and capabilities
- **Inter-Agent Messaging** - Agents can ask questions and receive responses
- **Task Management** - Managers can assign tasks to workers
- **Shared Context** - Key-value store for sharing data across agents

## Quick Start

```bash
# Check if the API is running
curl http://localhost:9876/health

# Register as an agent
curl -X POST http://localhost:9876/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "role": "worker"}'
```

## Agent Roles

| Role | Description |
|------|-------------|
| `manager` | Orchestrates work, assigns tasks, reviews output |
| `worker` | Executes tasks, asks for help when stuck |
| `reviewer` | Reviews code and provides feedback |

## API Reference

### Agents

#### Register Agent
```bash
POST /agents/register
{
  "name": "frontend-agent",
  "role": "worker",
  "capabilities": ["react", "typescript"],
  "working_directory": "/path/to/project"
}
# Response: {"agent_id": "agent-abc123", "success": true}
```

#### List Agents
```bash
GET /agents
# Response: {"agents": [...]}
```

#### Get Agent
```bash
GET /agents/{agent_id}
```

#### Update Agent Status
```bash
PATCH /agents/{agent_id}
{"status": "busy"}
```

#### Heartbeat
```bash
POST /agents/{agent_id}/heartbeat
```

#### Unregister
```bash
DELETE /agents/{agent_id}
```

### Messaging

#### Ask a Question
```bash
POST /messages/ask
{
  "from": "agent-123",
  "to": "manager-agent",
  "message": "Should I use OAuth or email/password?",
  "context": {"file": "src/auth.ts"},
  "wait_for_response": true,
  "timeout_seconds": 60
}
# Response (if wait=true): {"message_id": 1, "response": "Use OAuth with..."}
# Response (if wait=false): {"message_id": 1}
```

#### Check Inbox
```bash
GET /messages/inbox?agent_id={id}&status=pending
# Response: {"messages": [...]}
```

#### Respond to Message
```bash
POST /messages/{message_id}/respond
{
  "from": "agent-456",
  "response": "Use OAuth with Google and GitHub providers"
}
```

#### Broadcast to All
```bash
POST /messages/broadcast
{
  "from": "agent-123",
  "message": "Deploying to staging in 5 minutes"
}
```

#### Mark as Read
```bash
POST /messages/{message_id}/read
```

### Tasks

#### Create Task
```bash
POST /tasks
{
  "title": "Implement login page",
  "description": "Create OAuth login with Google and GitHub",
  "assigned_by": "agent-manager",
  "assigned_to": "frontend-agent",
  "priority": 8
}
# Response: {"task_id": "task-xyz789"}
```

#### List Tasks
```bash
GET /tasks
GET /tasks?assigned_to={agent_id}
GET /tasks?status=pending
```

#### Get Task
```bash
GET /tasks/{task_id}
```

#### Claim Unassigned Task
```bash
POST /tasks/{task_id}/claim
{"agent_id": "frontend-agent"}
```

#### Update Task
```bash
PATCH /tasks/{task_id}
{
  "status": "completed",
  "result": "Login page implemented with OAuth support"
}
```

Task statuses: `pending`, `in_progress`, `completed`, `failed`

### Shared Context

#### Set Context
```bash
PUT /context/{key}
{
  "value": "https://api.staging.example.com",
  "set_by": "agent-123"
}
```

#### Get Context
```bash
GET /context/{key}
# Response: {"key": "api_base_url", "value": "https://...", ...}
```

#### List All Context
```bash
GET /context
```

#### Delete Context
```bash
DELETE /context/{key}
```

## Example: Manager-Worker Workflow

### Terminal 1 (Manager Agent)

```bash
# Register as manager
MANAGER_ID=$(curl -s -X POST http://localhost:9876/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "project-manager", "role": "manager"}' | jq -r '.agent_id')

echo "Registered as $MANAGER_ID"

# Wait for workers to register, then assign task
curl -X POST http://localhost:9876/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Build user authentication",
    "description": "Implement OAuth with Google and GitHub",
    "assigned_to": "frontend-agent",
    "priority": 8
  }'

# Check for incoming questions
curl "http://localhost:9876/messages/inbox?agent_id=$MANAGER_ID&status=pending"

# Respond to questions
curl -X POST http://localhost:9876/messages/1/respond \
  -H "Content-Type: application/json" \
  -d '{"from": "'$MANAGER_ID'", "response": "Use OAuth, store tokens in httpOnly cookies"}'
```

### Terminal 2 (Worker Agent)

```bash
# Register as worker
WORKER_ID=$(curl -s -X POST http://localhost:9876/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "frontend-agent", "role": "worker", "capabilities": ["react"]}' | jq -r '.agent_id')

echo "Registered as $WORKER_ID"

# Check for assigned tasks
curl "http://localhost:9876/tasks?assigned_to=frontend-agent"

# Ask manager a question (blocks waiting for response)
RESPONSE=$(curl -s -X POST http://localhost:9876/messages/ask \
  -H "Content-Type: application/json" \
  -d '{
    "from": "'$WORKER_ID'",
    "to": "project-manager",
    "message": "Should I use session cookies or JWT for auth?",
    "wait_for_response": true,
    "timeout_seconds": 120
  }')

echo "Manager says: $(echo $RESPONSE | jq -r '.response')"

# Complete the task
curl -X PATCH http://localhost:9876/tasks/task-xyz789 \
  -H "Content-Type: application/json" \
  -d '{"status": "completed", "result": "Auth implemented with OAuth"}'
```

## Example: Code Review Request

```bash
# Developer requests review
curl -X POST http://localhost:9876/messages/ask \
  -H "Content-Type: application/json" \
  -d '{
    "from": "developer-agent",
    "to": "reviewer-agent",
    "message": "Please review my authentication implementation",
    "context": {
      "files": ["src/auth.ts", "src/components/Login.tsx"],
      "diff": "... git diff output ..."
    }
  }'

# Reviewer checks inbox and responds
curl -X POST http://localhost:9876/messages/42/respond \
  -H "Content-Type: application/json" \
  -d '{
    "from": "reviewer-agent",
    "response": "LGTM! One suggestion: add rate limiting to the login endpoint."
  }'
```

## Using with Claude Code

Claude Code can use these APIs via bash commands. Example prompt:

> "Register yourself as a worker agent, check for any assigned tasks, and if you have questions, ask the manager agent."

Claude Code would then execute:

```bash
# Register
curl -X POST http://localhost:9876/agents/register ...

# Check tasks
curl http://localhost:9876/tasks?assigned_to=...

# Ask question if needed
curl -X POST http://localhost:9876/messages/ask ...
```

## Database Location

Agent data is persisted in SQLite at:
```
~/.butter/agent.db
```

You can inspect it directly:
```bash
sqlite3 ~/.butter/agent.db ".tables"
sqlite3 ~/.butter/agent.db "SELECT * FROM agents"
```

## UI Integration

The Butter sidebar includes an Agent Panel (click the person icon) that shows:
- Registered agents with their status
- Message inbox
- Task list

This provides a visual overview of agent activity alongside the terminal list.
