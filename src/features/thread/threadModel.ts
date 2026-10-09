import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DbSession, TerminalPreset, WebSession } from "../../app/types";
import { shellEscape } from "../../utils/shell";

// ===== 1thread =====
// A chat stream where each thread is a real Butter terminal session running
// Claude Code. User messages are typed into the terminal; the agent answers by
// running `butter-cli thread reply`, which arrives as a "thread-message" event.

export interface ThreadRecord {
  session_id: string;
  title: string;
  cwd: string | null;
  pinned: boolean;
  created_at: number;
  last_activity_at: number;
  last_viewed_at: number | null;
}

export type ThreadMessageRole = "user" | "agent";
export type ThreadMessageStatus = "queued" | "delivered" | "seen";

export interface ThreadMessage {
  id: string;
  session_id: string;
  role: ThreadMessageRole;
  body: string;
  source: "composer" | "cli" | "transcript" | null;
  status: ThreadMessageStatus | null;
  created_at: number;
}

export interface ThreadModelDeps {
  sessions: readonly WebSession[];
  claudeState: Accessor<Record<string, string>>;
  agentSessionIdBySession: Accessor<Record<string, string>>;
  ptyBySession: Accessor<Record<string, string>>;
  createSession: (
    preset?: TerminalPreset,
    commandOverride?: string,
    directoryOverride?: string,
    titleOverride?: string,
    idOverride?: string
  ) => string;
  /** Start the session's xterm + PTY even when the terminal view is not mounted. */
  startSessionTerminal: (id: string) => Promise<void>;
  /** Bracketed-paste text into the session, then press Enter. */
  pasteIntoSession: (id: string, text: string) => Promise<boolean>;
  reopenSession: (id: string) => Promise<string | null>;
  tagSession: (id: string, tag: string) => void;
}

export const THREAD_TAG = "thread";

const THREAD_INSTRUCTIONS =
  "You were started from Butter's 1thread chat. The user never sees your terminal, only the messages you send with butter-cli. Do the work. When you finish, or when you need a decision from the user, reply by running: butter-cli thread reply \"<message>\". Write like a text message: 1-3 short sentences, plain words, no code, no logs, no markdown. Always send a reply before you stop. Follow-up messages from the user arrive wrapped in <butter_message> tags.";

// Pre-approve the reply command so the agent never blocks on a permission
// prompt the user can't see. `--allowedTools` is variadic, so it must be
// followed by another option before the positional prompt.
const THREAD_ALLOWED_TOOLS = "Bash(butter-cli thread reply *)";

// Don't paste into a Claude that may still be booting / just got input.
const LAUNCH_GRACE_MS = 8_000;
// Claude not running this long after we launched it → treat as exited.
const CLAUDE_BOOT_GRACE_MS = 15_000;
// With hooks reporting "unknown", require Claude alive this long before pasting.
const UNKNOWN_ALIVE_MS = 5_000;
// After a delivery, wait for "working" (or this long) before delivering again.
const AWAIT_WORK_MS = 20_000;
const FALLBACK_DELAY_MS = 5_000;

export const wrapButterMessage = (text: string) => `<butter_message>${text}</butter_message>`;

interface ThreadLaunchFiles {
  prompt_path: string | null;
  instructions_path: string;
}

// The prompt and instructions are read from staged files so the typed command
// stays well under the tty's canonical line limit (see thread_stage_launch).
export function buildThreadClaudeCommand(files: ThreadLaunchFiles, resumeId?: string | null): string {
  const parts = ["claude"];
  if (resumeId) parts.push("--resume", shellEscape(resumeId));
  parts.push(
    "--allowedTools",
    shellEscape(THREAD_ALLOWED_TOOLS),
    "--append-system-prompt",
    `"$(cat ${shellEscape(files.instructions_path)})"`
  );
  if (files.prompt_path) parts.push(`"$(cat ${shellEscape(files.prompt_path)})"`);
  return parts.join(" ");
}

/**
 * Resume a thread's Claude with the 1thread instructions but no new message,
 * e.g. from the restore picker. Plain `claude --resume` would drop the
 * instructions, which aren't stored in the transcript.
 */
export async function buildThreadResumeCommand(threadId: string, resumeId: string | null): Promise<string> {
  const files = await invoke<ThreadLaunchFiles>("thread_stage_launch", {
    sessionId: threadId,
    prompt: null,
    instructions: THREAD_INSTRUCTIONS,
  });
  return buildThreadClaudeCommand(files, resumeId);
}

export function threadTitleFromMessage(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  const slug = words.join("-").replace(/-+/g, "-").slice(0, 40).replace(/-$/, "");
  return slug || "thread";
}

interface ThreadRuntime {
  lastLaunchAt: number;
  awaitingWork: boolean;
  aliveSince: number | null;
}

interface LastAssistantTurn {
  text: string;
  timestamp: string | null;
}

export function createThreadModel(deps: ThreadModelDeps) {
  const [threads, setThreads] = createSignal<ThreadRecord[]>([]);
  const [messages, setMessages] = createSignal<ThreadMessage[]>([]);
  const [focusedThreadId, setFocusedThreadId] = createSignal<string | null>(null);
  const [replyTargetId, setReplyTargetId] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);

  const runtime = new Map<string, ThreadRuntime>();
  const inflight = new Set<string>();
  const fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let prevStates: Record<string, string> = {};

  const rt = (id: string): ThreadRuntime => {
    let entry = runtime.get(id);
    if (!entry) {
      entry = { lastLaunchAt: 0, awaitingWork: false, aliveSince: null };
      runtime.set(id, entry);
    }
    return entry;
  };

  const threadById = createMemo(() => {
    const map: Record<string, ThreadRecord> = {};
    for (const t of threads()) map[t.session_id] = t;
    return map;
  });

  const isThread = (id: string) => Boolean(threadById()[id]);

  const upsertMessage = (message: ThreadMessage) => {
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.id === message.id);
      if (index === -1) return [...prev, message];
      const next = prev.slice();
      next[index] = message;
      return next;
    });
    setThreads((prev) =>
      prev.map((t) =>
        t.session_id === message.session_id && message.created_at > t.last_activity_at
          ? { ...t, last_activity_at: message.created_at }
          : t
      )
    );
  };

  const patchThread = (id: string, patch: Partial<ThreadRecord>) => {
    setThreads((prev) => prev.map((t) => (t.session_id === id ? { ...t, ...patch } : t)));
  };

  const setStatus = async (ids: string[], status: ThreadMessageStatus) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    setMessages((prev) => prev.map((m) => (idSet.has(m.id) ? { ...m, status } : m)));
    await Promise.all(
      ids.map((id) =>
        invoke("thread_update_message_status", { id, status }).catch((err) =>
          console.error("[thread] status update failed", err)
        )
      )
    );
  };

  const markThreadSeen = (threadId: string) => {
    const ids = messages()
      .filter((m) => m.session_id === threadId && m.role === "user" && m.status === "delivered")
      .map((m) => m.id);
    void setStatus(ids, "seen");
  };

  const markViewed = async (threadId: string) => {
    try {
      const at = await invoke<number>("thread_mark_viewed", { sessionId: threadId });
      patchThread(threadId, { last_viewed_at: at });
    } catch (err) {
      console.error("[thread] mark viewed failed", err);
    }
  };

  const load = async () => {
    try {
      const [list, all] = await Promise.all([
        invoke<ThreadRecord[]>("thread_list"),
        invoke<ThreadMessage[]>("thread_messages_all", { limit: 2000 }),
      ]);
      setThreads(list);
      setMessages(all);
    } catch (err) {
      console.error("[thread] load failed", err);
    } finally {
      setLoaded(true);
    }
  };

  const addMessage = async (
    threadId: string,
    role: ThreadMessageRole,
    body: string,
    source: ThreadMessage["source"],
    status: ThreadMessageStatus | null
  ) => {
    const message = await invoke<ThreadMessage>("thread_add_message", {
      sessionId: threadId,
      role,
      body,
      source,
      status,
    });
    upsertMessage(message);
    return message;
  };

  const resolveAgentSessionId = async (threadId: string): Promise<string | null> => {
    const live = deps.agentSessionIdBySession()[threadId];
    if (live) return live;
    try {
      const session = await invoke<DbSession | null>("db_get_session", { id: threadId });
      return session?.agent_session_id ?? null;
    } catch {
      return null;
    }
  };

  const writeCommand = async (threadId: string, command: string) => {
    const ptyId = deps.ptyBySession()[threadId];
    if (!ptyId) throw new Error("Thread terminal has no PTY");
    await invoke("pty_write", { id: ptyId, data: `${command}\n` });
  };

  const launchClaude = async (threadId: string, prompt: string, resumeId: string | null) => {
    const files = await invoke<ThreadLaunchFiles>("thread_stage_launch", {
      sessionId: threadId,
      prompt,
      instructions: THREAD_INSTRUCTIONS,
    });
    await writeCommand(threadId, buildThreadClaudeCommand(files, resumeId));
  };

  // ----- Starting a thread -----
  const startThread = async (text: string) => {
    const body = text.trim();
    if (!body) return null;
    const title = threadTitleFromMessage(body);
    // Create the session without a stored command: if the app restarts, the
    // restored shell must not replay the first prompt as a new conversation.
    // Resume goes through the persisted agent snapshot instead.
    const sessionId = crypto.randomUUID();
    const record = await invoke<ThreadRecord>("thread_create", { sessionId, title });
    setThreads((prev) => [record, ...prev.filter((t) => t.session_id !== record.session_id)]);
    const id = deps.createSession(undefined, undefined, record.cwd ?? undefined, title, sessionId);
    deps.tagSession(id, THREAD_TAG);
    await addMessage(id, "user", body, "composer", "delivered");
    const entry = rt(id);
    entry.lastLaunchAt = Date.now();
    entry.awaitingWork = true;
    try {
      await deps.startSessionTerminal(id);
      await launchClaude(id, body, null);
    } catch (err) {
      console.error("[thread] failed to launch thread terminal", err);
    }
    return id;
  };

  // ----- Follow-ups -----
  const sendReply = async (threadId: string, text: string) => {
    const body = text.trim();
    if (!body) return;
    await addMessage(threadId, "user", body, "composer", "queued");
    void deliverQueued(threadId);
  };

  const queuedFor = (threadId: string) =>
    messages().filter((m) => m.session_id === threadId && m.role === "user" && m.status === "queued");

  const deliverQueued = async (threadId: string) => {
    if (inflight.has(threadId)) return;
    const queued = queuedFor(threadId);
    if (queued.length === 0) return;
    inflight.add(threadId);
    try {
      const entry = rt(threadId);
      const now = Date.now();
      const combined = queued.map((m) => m.body).join("\n\n");
      const session = deps.sessions.find((s) => s.id === threadId);

      if (!session || !deps.ptyBySession()[threadId]) {
        // Terminal closed (or not yet started this app run): bring it back and
        // resume the agent's conversation with the queued messages.
        if (!session) {
          const reopened = await deps.reopenSession(threadId);
          if (!reopened) {
            console.warn("[thread] could not reopen session for thread", threadId);
            return;
          }
        }
        await deps.startSessionTerminal(threadId);
        const resumeId = await resolveAgentSessionId(threadId);
        await launchClaude(threadId, wrapButterMessage(combined), resumeId);
        entry.lastLaunchAt = Date.now();
        entry.awaitingWork = true;
        entry.aliveSince = null;
        await setStatus(queued.map((m) => m.id), "delivered");
        return;
      }

      if (now - entry.lastLaunchAt < LAUNCH_GRACE_MS) return;
      const state = deps.claudeState()[threadId];
      if (state === "working") return;
      if (entry.awaitingWork && now - entry.lastLaunchAt < AWAIT_WORK_MS) return;

      const [alive] = await invoke<{ id: string; alive: boolean }[]>("thread_agent_alive", {
        ids: [deps.ptyBySession()[threadId]],
      });
      if (alive?.alive) {
        if (state !== "idle") {
          // Hooks give no signal (stale or not installed). Only paste once
          // Claude has been running for a little while.
          entry.aliveSince ??= now;
          if (now - entry.aliveSince < UNKNOWN_ALIVE_MS) return;
        }
        const ok = await deps.pasteIntoSession(threadId, wrapButterMessage(combined));
        if (!ok) return;
      } else {
        entry.aliveSince = null;
        if (now - entry.lastLaunchAt < CLAUDE_BOOT_GRACE_MS) return;
        // Shell is alive but Claude exited: resume it with the message.
        const resumeId = await resolveAgentSessionId(threadId);
        await launchClaude(threadId, wrapButterMessage(combined), resumeId);
      }
      entry.lastLaunchAt = Date.now();
      entry.awaitingWork = true;
      await setStatus(queued.map((m) => m.id), "delivered");
    } catch (err) {
      console.error("[thread] delivery failed", err);
    } finally {
      inflight.delete(threadId);
    }
  };

  // ----- Transcript fallback -----
  const runFallback = async (threadId: string) => {
    const threadMessages = messages().filter((m) => m.session_id === threadId);
    const lastUser = [...threadMessages]
      .reverse()
      .find((m) => m.role === "user" && (m.status === "delivered" || m.status === "seen"));
    if (!lastUser) return;
    const lastAgent = [...threadMessages].reverse().find((m) => m.role === "agent");
    if (lastAgent && lastAgent.created_at > lastUser.created_at) return;
    const agentSessionId = await resolveAgentSessionId(threadId);
    if (!agentSessionId) return;
    try {
      const turn = await invoke<LastAssistantTurn | null>("cc_last_assistant_turn", {
        agentSessionId,
      });
      const text = turn?.text?.trim();
      if (!text) return;
      if (lastAgent && lastAgent.body.trim() === text) return;
      if (turn?.timestamp) {
        const ts = Date.parse(turn.timestamp);
        // Ignore a turn that predates the user's latest message (allow clock slop).
        if (Number.isFinite(ts) && ts < lastUser.created_at - 2_000) return;
      }
      // Re-check: a CLI reply may have landed while we were reading the transcript.
      const latest = messages().filter((m) => m.session_id === threadId && m.role === "agent").pop();
      if (latest && latest.created_at > lastUser.created_at) return;
      await addMessage(threadId, "agent", text, "transcript", null);
    } catch (err) {
      console.error("[thread] transcript fallback failed", err);
    }
  };

  // React to Claude activity transitions for thread sessions.
  createEffect(
    on(deps.claudeState, (states) => {
      for (const t of threads()) {
        const id = t.session_id;
        const prev = prevStates[id];
        const curr = states[id];
        const entry = rt(id);
        if (curr === "working" && entry.awaitingWork) {
          entry.awaitingWork = false;
          markThreadSeen(id);
        }
        if (prev === "working" && curr === "idle") {
          const existing = fallbackTimers.get(id);
          if (existing) clearTimeout(existing);
          fallbackTimers.set(
            id,
            setTimeout(() => {
              fallbackTimers.delete(id);
              void runFallback(id);
            }, FALLBACK_DELAY_MS)
          );
        }
        if (prev !== curr && curr !== "working" && queuedFor(id).length > 0) {
          void deliverQueued(id);
        }
      }
      prevStates = { ...states };
    })
  );

  // Periodic sweep for queued messages (covers stale/unknown hook states).
  const sweep = setInterval(() => {
    const ids = new Set(
      messages()
        .filter((m) => m.role === "user" && m.status === "queued")
        .map((m) => m.session_id)
    );
    for (const id of ids) void deliverQueued(id);
  }, 2_000);

  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen<ThreadMessage>("thread-message", (event) => {
    const message = event.payload;
    upsertMessage(message);
    if (message.role === "agent") {
      // An agent reply means it read whatever we delivered.
      rt(message.session_id).awaitingWork = false;
      markThreadSeen(message.session_id);
      if (focusedThreadId() === message.session_id) void markViewed(message.session_id);
    }
    if (!isThread(message.session_id)) void load();
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });

  void load();

  onCleanup(() => {
    disposed = true;
    clearInterval(sweep);
    for (const timer of fallbackTimers.values()) clearTimeout(timer);
    fallbackTimers.clear();
    unlisten?.();
  });

  // ----- UI-facing helpers -----
  const setPinned = async (threadId: string, pinned: boolean) => {
    patchThread(threadId, { pinned });
    try {
      await invoke("thread_set_pinned", { sessionId: threadId, pinned });
    } catch (err) {
      console.error("[thread] pin failed", err);
      patchThread(threadId, { pinned: !pinned });
    }
  };

  const focusThread = (threadId: string | null) => {
    setFocusedThreadId(threadId);
    if (threadId) {
      setReplyTargetId(null);
      void markViewed(threadId);
    }
  };

  const hasUnread = (threadId: string) => {
    const t = threadById()[threadId];
    if (!t) return false;
    const viewed = t.last_viewed_at ?? 0;
    return messages().some(
      (m) => m.session_id === threadId && m.role === "agent" && m.created_at > viewed
    );
  };

  const isWorking = (threadId: string) => deps.claudeState()[threadId] === "working";

  return {
    threads,
    messages,
    loaded,
    threadById,
    focusedThreadId,
    focusThread,
    replyTargetId,
    setReplyTargetId,
    startThread,
    sendReply,
    setPinned,
    hasUnread,
    isWorking,
    reload: load,
  };
}

export type ThreadModel = ReturnType<typeof createThreadModel>;
