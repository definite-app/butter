import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

// Types matching the Rust backend
interface Agent {
  id: string;
  name: string;
  role: "manager" | "worker" | "reviewer";
  capabilities: string[];
  working_directory: string | null;
  terminal_id: string | null;
  status: "active" | "busy" | "idle" | "offline";
  registered_at: number;
  last_heartbeat: number;
}

interface Message {
  id: number;
  from_agent: string;
  to_agent: string | null;
  message_type: "ask" | "respond" | "notify";
  content: string;
  context: any;
  status: "pending" | "read" | "responded";
  created_at: number;
  read_at: number | null;
  response_id: number | null;
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  assigned_by: string | null;
  assigned_to: string | null;
  status: "pending" | "in_progress" | "completed" | "failed";
  priority: number;
  context: any;
  result: string | null;
  created_at: number;
  completed_at: number | null;
}

type TabType = "agents" | "messages" | "tasks";

interface AgentPanelProps {
  onClose: () => void;
  onFocusAgent: (agentId: string) => void;
}

function AgentPanel(props: AgentPanelProps) {
  const [activeTab, setActiveTab] = createSignal<TabType>("agents");
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [selectedAgentId, setSelectedAgentId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  let refreshInterval: number | undefined;

  onMount(async () => {
    await refreshAll();
    refreshInterval = window.setInterval(refreshAll, 2000);
  });

  onCleanup(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });

  async function refreshAll() {
    await Promise.all([refreshAgents(), refreshMessages(), refreshTasks()]);
  }

  async function refreshAgents() {
    try {
      const agentList = await invoke<Agent[]>("get_agents");
      setAgents(agentList);
      setError(null);
    } catch (e) {
      console.error("Failed to get agents:", e);
      setError(e as string);
    }
  }

  async function refreshMessages() {
    try {
      // Get messages for all agents or selected agent
      const agentId = selectedAgentId();
      if (agentId) {
        const messageList = await invoke<Message[]>("get_agent_messages", { agentId });
        setMessages(messageList);
      } else {
        // If no agent selected, show all pending messages
        setMessages([]);
      }
    } catch (e) {
      console.error("Failed to get messages:", e);
    }
  }

  async function refreshTasks() {
    try {
      const taskList = await invoke<Task[]>("get_all_tasks");
      setTasks(taskList);
    } catch (e) {
      console.error("Failed to get tasks:", e);
    }
  }

  function getRoleIcon(role: string) {
    switch (role) {
      case "manager":
        return "\u{1F451}"; // Crown emoji
      case "reviewer":
        return "\u{1F441}"; // Eye emoji
      default:
        return "\u{1F527}"; // Wrench emoji for worker
    }
  }

  function getStatusColor(status: string) {
    switch (status) {
      case "active":
        return "#4ade80"; // green
      case "busy":
        return "#fbbf24"; // yellow
      case "idle":
        return "#94a3b8"; // gray
      case "offline":
        return "#ef4444"; // red
      default:
        return "#94a3b8";
    }
  }

  function getTaskStatusIcon(status: string) {
    switch (status) {
      case "pending":
        return "\u{23F3}"; // Hourglass
      case "in_progress":
        return "\u{1F504}"; // Arrows
      case "completed":
        return "\u{2705}"; // Check mark
      case "failed":
        return "\u{274C}"; // X mark
      default:
        return "\u{2753}"; // Question mark
    }
  }

  function formatTime(timestamp: number) {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  }

  function handleAgentClick(agent: Agent) {
    setSelectedAgentId(agent.id);
    if (agent.terminal_id) {
      props.onFocusAgent(agent.id);
    }
  }

  return (
    <div class="agent-panel">
      <div class="agent-panel-header">
        <h2>Agents</h2>
        <button class="agent-panel-close" onClick={props.onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div class="agent-panel-tabs">
        <button
          class={`agent-tab ${activeTab() === "agents" ? "active" : ""}`}
          onClick={() => setActiveTab("agents")}
        >
          Agents ({agents().length})
        </button>
        <button
          class={`agent-tab ${activeTab() === "messages" ? "active" : ""}`}
          onClick={() => setActiveTab("messages")}
        >
          Messages
        </button>
        <button
          class={`agent-tab ${activeTab() === "tasks" ? "active" : ""}`}
          onClick={() => setActiveTab("tasks")}
        >
          Tasks ({tasks().filter(t => t.status !== "completed").length})
        </button>
      </div>

      <Show when={error()}>
        <div class="agent-panel-error">{error()}</div>
      </Show>

      <div class="agent-panel-content">
        {/* Agents Tab */}
        <Show when={activeTab() === "agents"}>
          <Show when={agents().length === 0}>
            <div class="agent-panel-empty">
              <p>No agents registered</p>
              <p class="agent-panel-hint">
                Register an agent via HTTP API:<br />
                <code>curl -X POST localhost:9876/agents/register</code>
              </p>
            </div>
          </Show>
          <div class="agent-list">
            <For each={agents()}>
              {(agent) => (
                <div
                  class={`agent-item ${selectedAgentId() === agent.id ? "selected" : ""}`}
                  onClick={() => handleAgentClick(agent)}
                >
                  <div class="agent-icon">{getRoleIcon(agent.role)}</div>
                  <div class="agent-info">
                    <div class="agent-name">{agent.name}</div>
                    <div class="agent-meta">
                      <span class="agent-role">{agent.role}</span>
                      <Show when={agent.capabilities.length > 0}>
                        <span class="agent-capabilities">
                          {agent.capabilities.slice(0, 2).join(", ")}
                          {agent.capabilities.length > 2 && "..."}
                        </span>
                      </Show>
                    </div>
                  </div>
                  <div
                    class="agent-status"
                    style={{ "background-color": getStatusColor(agent.status) }}
                    title={agent.status}
                  ></div>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Messages Tab */}
        <Show when={activeTab() === "messages"}>
          <Show when={!selectedAgentId()}>
            <div class="agent-panel-empty">
              <p>Select an agent to view messages</p>
            </div>
          </Show>
          <Show when={selectedAgentId() && messages().length === 0}>
            <div class="agent-panel-empty">
              <p>No messages</p>
            </div>
          </Show>
          <div class="message-list">
            <For each={messages()}>
              {(message) => (
                <div class={`message-item ${message.status}`}>
                  <div class="message-header">
                    <span class="message-from">{message.from_agent}</span>
                    <span class="message-time">{formatTime(message.created_at)}</span>
                  </div>
                  <div class="message-content">{message.content}</div>
                  <div class="message-footer">
                    <span class={`message-type ${message.message_type}`}>
                      {message.message_type}
                    </span>
                    <span class={`message-status ${message.status}`}>
                      {message.status}
                    </span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Tasks Tab */}
        <Show when={activeTab() === "tasks"}>
          <Show when={tasks().length === 0}>
            <div class="agent-panel-empty">
              <p>No tasks</p>
              <p class="agent-panel-hint">
                Create a task via HTTP API:<br />
                <code>curl -X POST localhost:9876/tasks</code>
              </p>
            </div>
          </Show>
          <div class="task-list">
            <For each={tasks()}>
              {(task) => (
                <div class={`task-item ${task.status}`}>
                  <div class="task-header">
                    <span class="task-status-icon">{getTaskStatusIcon(task.status)}</span>
                    <span class="task-title">{task.title}</span>
                    <span class="task-priority" title={`Priority: ${task.priority}`}>
                      P{task.priority}
                    </span>
                  </div>
                  <Show when={task.description}>
                    <div class="task-description">{task.description}</div>
                  </Show>
                  <div class="task-footer">
                    <Show when={task.assigned_to}>
                      <span class="task-assignee">
                        Assigned to: {task.assigned_to}
                      </span>
                    </Show>
                    <Show when={!task.assigned_to}>
                      <span class="task-unassigned">Unassigned</span>
                    </Show>
                    <span class="task-time">{formatTime(task.created_at)}</span>
                  </div>
                  <Show when={task.result}>
                    <div class="task-result">
                      <strong>Result:</strong> {task.result}
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="agent-panel-footer">
        <span class="agent-panel-hint">
          API: http://localhost:9876
        </span>
        <button class="refresh-btn" onClick={refreshAll}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6"></path>
            <path d="M1 20v-6h6"></path>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg>
        </button>
      </div>
    </div>
  );
}

export default AgentPanel;
