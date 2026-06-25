import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Command } from "@tauri-apps/plugin-shell";
import { useAppContext } from "../../app/context/AppContext";
import { renderMarkdownToSafeHtml } from "../../utils/markdown";
import type {
  TeamAgentRun,
  TeamChannel,
  TeamConversation,
  TeamInboxItem,
  TeamMessage,
  TeamPin,
  TeamPinKind,
  TeamUser,
} from "../../app/types";

interface PtyOutput {
  id: string;
  data: string;
}

interface RunningRun {
  run: TeamAgentRun;
  user: TeamUser;
  parentMessageId: string;
  conversationId: string;
  buffer: string;
}

type TeamSelection = { kind: "inbox" } | { kind: "conversation"; conversationId: string };
type MessageMenuState = { messageId: string; x: number; y: number };
type TeamPinInput = {
  id: string | null;
  kind: TeamPinKind;
  title: string | null;
  file_path: string | null;
  url: string | null;
  message_id: string | null;
};

const DONE_MARKER_PREFIX = "__BUTTER_TEAM_RUN_DONE__:";

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\"'\"'")}'`;

const stripAnsi = (value: string) =>
  value.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    "",
  );

const formatClock = (timestampSeconds: number) => {
  const date = new Date(timestampSeconds * 1000);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

const compactText = (value: string, max = 140) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
};

const looksLikeUrl = (value: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

const basename = (path: string) => path.trim().replace(/\/+$/, "").split("/").pop() || path;

export function TeamMode() {
  const app = useAppContext();
  const [users, setUsers] = createSignal<TeamUser[]>([]);
  const [channels, setChannels] = createSignal<TeamChannel[]>([]);
  const [conversations, setConversations] = createSignal<TeamConversation[]>([]);
  const [messages, setMessages] = createSignal<TeamMessage[]>([]);
  const [threadMessages, setThreadMessages] = createSignal<TeamMessage[]>([]);
  const [inbox, setInbox] = createSignal<TeamInboxItem[]>([]);
  const [runs, setRuns] = createSignal<TeamAgentRun[]>([]);
  const [pins, setPins] = createSignal<TeamPin[]>([]);
  const [selection, setSelection] = createSignal<TeamSelection>({ kind: "inbox" });
  const [selectedThreadParentId, setSelectedThreadParentId] = createSignal<string | null>(null);
  const [composerText, setComposerText] = createSignal("");
  const [threadComposerText, setThreadComposerText] = createSignal("");
  const [channelName, setChannelName] = createSignal("");
  const [pinTarget, setPinTarget] = createSignal("");
  const [agentUsername, setAgentUsername] = createSignal("");
  const [agentDisplayName, setAgentDisplayName] = createSignal("");
  const [agentPwd, setAgentPwd] = createSignal("");
  const [agentCmd, setAgentCmd] = createSignal('claude -p "{user_msg}"');
  const [editingAgentId, setEditingAgentId] = createSignal<string | null>(null);
  const [messageMenu, setMessageMenu] = createSignal<MessageMenuState | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const runningRuns = new Map<string, RunningRun>();
  let stopPtyListener: (() => void) | undefined;

  const selectedConversation = createMemo(() => {
    const current = selection();
    if (current.kind !== "conversation") return null;
    return conversations().find((conversation) => conversation.id === current.conversationId) || null;
  });

  const selectedChannel = createMemo(() => {
    const conversation = selectedConversation();
    if (!conversation?.channel_id) return null;
    return channels().find((channel) => channel.id === conversation.channel_id) || null;
  });

  const selectedThreadParent = createMemo(() => {
    const parentId = selectedThreadParentId();
    if (!parentId) return null;
    return messages().find((message) => message.id === parentId) || null;
  });

  const editingAgent = createMemo(() => {
    const id = editingAgentId();
    if (!id) return null;
    return users().find((user) => user.id === id) || null;
  });

  const enabledUsers = createMemo(() => users().filter((user) => user.enabled));

  const unreadByConversation = createMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of inbox()) {
      counts[item.conversation.id] = (counts[item.conversation.id] || 0) + 1;
    }
    return counts;
  });

  const unreadInboxCount = createMemo(() => inbox().length);

  const channelConversation = (channelId: string) =>
    conversations().find(
      (conversation) => conversation.kind === "channel" && conversation.channel_id === channelId,
    ) || null;

  const authorName = (message: TeamMessage) => {
    if (message.author_kind === "human") return "You";
    if (message.author_kind === "system") return "System";
    return users().find((user) => user.id === message.author_user_id)?.display_name || "Agent";
  };

  const avatarLabel = (message: TeamMessage) => {
    if (message.author_kind === "human") return "Y";
    const name = authorName(message).trim();
    return name ? name[0].toUpperCase() : "A";
  };

  const avatarColor = (message: TeamMessage) =>
    users().find((user) => user.id === message.author_user_id)?.avatar_color || "";

  const findMessageById = (messageId: string) =>
    messages().find((message) => message.id === messageId) ||
    threadMessages().find((message) => message.id === messageId) ||
    inbox().find((item) => item.message.id === messageId)?.message ||
    inbox().find((item) => item.parent_message?.id === messageId)?.parent_message ||
    null;

  const agentSessionIdForMessage = (message: TeamMessage) => {
    if (!message.pty_session_id) return null;
    const run = runs().find(
      (entry) => entry.id === message.pty_session_id || entry.pty_session_id === message.pty_session_id,
    );
    return run?.pty_session_id || message.pty_session_id;
  };

  const openMessageMenu = (
    event: MouseEvent & { currentTarget: HTMLButtonElement },
    message: TeamMessage,
  ) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 210;
    const menuHeight = agentSessionIdForMessage(message) ? 126 : 88;
    setMessageMenu({
      messageId: message.id,
      x: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menuHeight - 8)),
    });
  };

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMessageMenu(null);
    } catch (err) {
      setError(`Clipboard copy failed: ${String(err)}`);
    }
  };

  const MessageContent = (props: { content: string }) => (
    <div
      class="team-message-content markdown"
      innerHTML={renderMarkdownToSafeHtml(props.content)}
    />
  );

  const MessageArticle = (props: { message: TeamMessage; compact?: boolean }) => (
    <article class={`team-message ${props.compact ? "compact" : ""}`}>
      <div
        class={`team-avatar ${props.compact ? "mini" : ""}`}
        style={{ "--team-avatar-color": avatarColor(props.message) }}
      >
        {avatarLabel(props.message)}
      </div>
      <div class="team-message-body">
        <div class="team-message-meta">
          <span class="team-message-author">{authorName(props.message)}</span>
          <span>{formatClock(props.message.created_at)}</span>
          <button
            class="team-message-menu-button"
            onClick={(event) => openMessageMenu(event, props.message)}
            title="Message actions"
            aria-label="Message actions"
          >
            ...
          </button>
        </div>
        <MessageContent content={props.message.content} />
        <Show
          when={props.compact}
          fallback={
            <div class="team-message-actions">
              <button onClick={() => void openThread(props.message)}>
                {props.message.thread_reply_count > 0
                  ? `${props.message.thread_reply_count} repl${props.message.thread_reply_count === 1 ? "y" : "ies"}`
                  : "Reply in thread"}
              </button>
              <button onClick={() => void markInboxUnread(props.message.id)}>Mark unread</button>
            </div>
          }
        >
          <button class="team-thread-unread" onClick={() => void markInboxUnread(props.message.id)}>
            Mark unread
          </button>
        </Show>
      </div>
    </article>
  );

  const refreshInbox = async () => {
    const nextInbox = await invoke<TeamInboxItem[]>("team_get_inbox");
    setInbox(nextInbox);
  };

  const refreshRuns = async () => {
    const nextRuns = await invoke<TeamAgentRun[]>("team_list_agent_runs");
    setRuns(nextRuns);
  };

  const refreshPins = async () => {
    const nextPins = await invoke<TeamPin[]>("team_list_pins");
    setPins(nextPins);
  };

  const refreshMessages = async (conversationId = selectedConversation()?.id || null) => {
    if (!conversationId) return;
    const nextMessages = await invoke<TeamMessage[]>("team_list_messages", {
      conversationId,
      parentMessageId: null,
    });
    setMessages(nextMessages);
  };

  const refreshThread = async (parentMessageId = selectedThreadParentId()) => {
    const conversation = selectedConversation();
    if (!conversation || !parentMessageId) {
      setThreadMessages([]);
      return;
    }
    const replies = await invoke<TeamMessage[]>("team_list_messages", {
      conversationId: conversation.id,
      parentMessageId,
    });
    setThreadMessages(replies);
  };

  const loadBase = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextUsers, nextChannels, nextConversations, nextInbox, nextRuns, nextPins] = await Promise.all([
        invoke<TeamUser[]>("team_list_users"),
        invoke<TeamChannel[]>("team_list_channels"),
        invoke<TeamConversation[]>("team_list_conversations"),
        invoke<TeamInboxItem[]>("team_get_inbox"),
        invoke<TeamAgentRun[]>("team_list_agent_runs"),
        invoke<TeamPin[]>("team_list_pins"),
      ]);
      setUsers(nextUsers);
      setChannels(nextChannels);
      setConversations(nextConversations);
      setInbox(nextInbox);
      setRuns(nextRuns);
      setPins(nextPins);

      const current = selection();
      if (current.kind === "conversation") {
        await refreshMessages(current.conversationId);
        return;
      }

      const general = nextChannels.find((channel) => channel.name === "general");
      const generalConversation = general
        ? nextConversations.find((conversation) => conversation.channel_id === general.id)
        : null;
      if (generalConversation) {
        setSelection({ kind: "conversation", conversationId: generalConversation.id });
        await refreshMessages(generalConversation.id);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const selectConversation = async (conversationId: string) => {
    setSelection({ kind: "conversation", conversationId });
    setSelectedThreadParentId(null);
    setThreadMessages([]);
    await refreshMessages(conversationId);
    await invoke("team_mark_conversation_read", { conversationId });
    await refreshInbox();
  };

  const selectChannel = async (channel: TeamChannel) => {
    const conversation =
      channelConversation(channel.id) ||
      (await invoke<TeamConversation | null>("team_get_channel_conversation", {
        channelId: channel.id,
      }));
    if (conversation) {
      await selectConversation(conversation.id);
    }
  };

  const selectDm = async (user: TeamUser) => {
    const conversation = await invoke<TeamConversation>("team_get_or_create_dm", { userId: user.id });
    setConversations((current) => {
      if (current.some((entry) => entry.id === conversation.id)) return current;
      return [...current, conversation];
    });
    await selectConversation(conversation.id);
  };

  const resetAgentForm = () => {
    setEditingAgentId(null);
    setAgentUsername("");
    setAgentDisplayName("");
    setAgentPwd("");
    setAgentCmd('claude -p "{user_msg}"');
    setSelectedThreadParentId(null);
  };

  const editAgent = (user: TeamUser) => {
    setEditingAgentId(user.id);
    setAgentUsername(user.username);
    setAgentDisplayName(user.display_name);
    setAgentPwd(user.pwd);
    setAgentCmd(user.cmd);
    setSelectedThreadParentId(null);
  };

  const openInbox = async () => {
    setSelection({ kind: "inbox" });
    setSelectedThreadParentId(null);
    setMessages([]);
    setThreadMessages([]);
    await refreshInbox();
  };

  const openThread = async (message: TeamMessage) => {
    const parentId = message.parent_message_id || message.id;
    setSelectedThreadParentId(parentId);
    await refreshThread(parentId);
    await invoke("team_mark_thread_read", { parentMessageId: parentId });
    await refreshInbox();
  };

  const openInboxItem = async (item: TeamInboxItem) => {
    setSelection({ kind: "conversation", conversationId: item.conversation.id });
    await refreshMessages(item.conversation.id);
    if (item.parent_message) {
      setSelectedThreadParentId(item.parent_message.id);
      await refreshThread(item.parent_message.id);
      await invoke("team_mark_thread_read", { parentMessageId: item.parent_message.id });
    } else {
      setSelectedThreadParentId(null);
      setThreadMessages([]);
      await invoke("team_mark_message_read", { messageId: item.message.id });
    }
    await refreshInbox();
  };

  const mentionedUsers = (content: string) => {
    const names = new Set(
      [...content.matchAll(/@([A-Za-z0-9_-]+)/g)].map((match) => match[1].toLowerCase()),
    );
    return enabledUsers().filter((user) => names.has(user.username.toLowerCase()));
  };

  const buildRunCommand = (
    run: TeamAgentRun,
    user: TeamUser,
    parentMessageId: string,
    conversationId: string,
  ) => {
    const marker = `${DONE_MARKER_PREFIX}${run.id}:`;
    const exports = [
      `export BUTTER_TEAM_USER_ID=${shellQuote(user.id)}`,
      `export BUTTER_TEAM_PARENT_MESSAGE_ID=${shellQuote(parentMessageId)}`,
      `export BUTTER_TEAM_CONVERSATION_ID=${shellQuote(conversationId)}`,
      `export BUTTER_TEAM_RUN_ID=${shellQuote(run.id)}`,
    ].join("; ");
    return `${exports}; ${run.rendered_command}\nprintf '\\n${marker}%s\\n' "$?"`;
  };

  const finishRun = async (runId: string, exitCode: number, rawOutput: string) => {
    const running = runningRuns.get(runId);
    if (!running) return;
    runningRuns.delete(runId);
    const cleaned = stripAnsi(rawOutput)
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
    const status = exitCode === 0 ? "succeeded" : "failed";
    await invoke<TeamAgentRun>("team_update_agent_run", {
      id: runId,
      req: {
        pty_session_id: runId,
        status,
        exit_code: exitCode,
        error: exitCode === 0 ? null : `Exited with ${exitCode}`,
      },
    });
    await invoke("pty_close", { id: runId }).catch(() => undefined);
    await invoke<TeamMessage>("team_send_message", {
      req: {
        id: null,
        conversation_id: running.conversationId,
        author_kind: "agent",
        author_user_id: running.user.id,
        content: cleaned || "(no output)",
        parent_message_id: running.parentMessageId,
        pty_session_id: runId,
      },
    });
    await Promise.all([refreshRuns(), refreshInbox(), refreshMessages(running.conversationId)]);
    if (selectedThreadParentId() === running.parentMessageId) {
      await refreshThread(running.parentMessageId);
    }
  };

  const handlePtyData = (payload: PtyOutput) => {
    const running = runningRuns.get(payload.id);
    if (!running) return;
    running.buffer += payload.data;
    const marker = `${DONE_MARKER_PREFIX}${payload.id}:`;
    const markerIndex = running.buffer.indexOf(marker);
    if (markerIndex < 0) return;
    const output = running.buffer.slice(0, markerIndex);
    const afterMarker = running.buffer.slice(markerIndex + marker.length);
    const exitMatch = afterMarker.match(/(-?\d+)/);
    const exitCode = exitMatch ? Number(exitMatch[1]) : 0;
    void finishRun(payload.id, Number.isFinite(exitCode) ? exitCode : 0, output).catch((err) => {
      setError(String(err));
    });
  };

  const launchMentionedAgents = async (
    triggerMessage: TeamMessage,
    content: string,
    parentMessageId: string,
  ) => {
    const targets = mentionedUsers(content);
    if (targets.length === 0) return;
    for (const user of targets) {
      const run = await invoke<TeamAgentRun>("team_create_agent_run", {
        req: {
          trigger_message_id: triggerMessage.id,
          reply_parent_message_id: parentMessageId,
          user_id: user.id,
          user_msg: content,
        },
      });
      const command = buildRunCommand(run, user, parentMessageId, triggerMessage.conversation_id);
      runningRuns.set(run.id, {
        run,
        user,
        parentMessageId,
        conversationId: triggerMessage.conversation_id,
        buffer: "",
      });
      await invoke<string>("pty_create", {
        id: run.id,
        rows: 24,
        cols: 100,
        cwd: run.cwd,
        command,
      });
      await invoke<TeamAgentRun>("team_update_agent_run", {
        id: run.id,
        req: {
          pty_session_id: run.id,
          status: "running",
          exit_code: null,
          error: null,
        },
      });
    }
    await refreshRuns();
  };

  const sendMessage = async (parentMessageId: string | null) => {
    const conversation = selectedConversation();
    const content = parentMessageId ? threadComposerText().trim() : composerText().trim();
    if (!conversation || !content) return;
    setError(null);
    try {
      const message = await invoke<TeamMessage>("team_send_message", {
        req: {
          id: null,
          conversation_id: conversation.id,
          author_kind: "human",
          author_user_id: null,
          content,
          parent_message_id: parentMessageId,
          pty_session_id: null,
        },
      });
      if (parentMessageId) {
        setThreadComposerText("");
        await refreshThread(parentMessageId);
      } else {
        setComposerText("");
      }
      await refreshMessages(conversation.id);
      await launchMentionedAgents(message, content, parentMessageId || message.id);
    } catch (err) {
      setError(String(err));
    }
  };

  const saveChannel = async () => {
    const name = channelName().trim();
    if (!name) return;
    setError(null);
    try {
      const channel = await invoke<TeamChannel>("team_save_channel", {
        req: {
          id: null,
          name,
          display_name: name.replace(/^#/, ""),
          description: null,
        },
      });
      setChannelName("");
      await loadBase();
      await selectChannel(channel);
    } catch (err) {
      setError(String(err));
    }
  };

  const saveAgent = async () => {
    const username = agentUsername().trim();
    const displayName = agentDisplayName().trim() || username;
    const pwd = agentPwd().trim();
    const cmd = agentCmd().trim();
    if (!username || !pwd || !cmd) return;
    setError(null);
    try {
      const saved = await invoke<TeamUser>("team_save_user", {
        req: {
          id: editingAgentId(),
          username,
          display_name: displayName,
          avatar_color: null,
          pwd,
          cmd,
          description: null,
          enabled: true,
        },
      });
      setEditingAgentId(saved.id);
      setAgentUsername(saved.username);
      setAgentDisplayName(saved.display_name);
      setAgentPwd(saved.pwd);
      setAgentCmd(saved.cmd);
      await loadBase();
    } catch (err) {
      setError(String(err));
    }
  };

  const savePin = async (req: TeamPinInput) => {
    const saved = await invoke<TeamPin>("team_save_pin", { req });
    await refreshPins();
    return saved;
  };

  const savePinnedTarget = async () => {
    const target = pinTarget().trim();
    if (!target) return;
    setError(null);
    try {
      await savePin({
        id: null,
        kind: looksLikeUrl(target) ? "link" : "file",
        title: looksLikeUrl(target) ? target : basename(target),
        file_path: looksLikeUrl(target) ? null : target,
        url: looksLikeUrl(target) ? target : null,
        message_id: null,
      });
      setPinTarget("");
    } catch (err) {
      setError(String(err));
    }
  };

  const pinMessage = async (message: TeamMessage) => {
    setError(null);
    try {
      await savePin({
        id: null,
        kind: "message",
        title: compactText(message.content, 80),
        file_path: null,
        url: null,
        message_id: message.id,
      });
      setMessageMenu(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const deletePin = async (pin: TeamPin) => {
    setError(null);
    try {
      await invoke("team_delete_pin", { id: pin.id });
      await refreshPins();
    } catch (err) {
      setError(String(err));
    }
  };

  const openPin = async (pin: TeamPin) => {
    setError(null);
    try {
      if (pin.kind === "file" && pin.file_path) {
        if (app.canOpenPathInButter(pin.file_path)) {
          await app.openFileInButter(pin.file_path);
          app.setAppView("terminal");
          return;
        }
        await Command.create("open", [pin.file_path]).execute();
        return;
      }
      if (pin.kind === "link" && pin.url) {
        await Command.create("open", [pin.url]).execute();
        return;
      }
      if (pin.kind === "message" && pin.message_conversation_id && pin.message_id) {
        setSelection({ kind: "conversation", conversationId: pin.message_conversation_id });
        await refreshMessages(pin.message_conversation_id);
        if (pin.message_parent_message_id) {
          setSelectedThreadParentId(pin.message_parent_message_id);
          await refreshThread(pin.message_parent_message_id);
          await invoke("team_mark_thread_read", { parentMessageId: pin.message_parent_message_id });
        } else {
          setSelectedThreadParentId(null);
          setThreadMessages([]);
          await invoke("team_mark_message_read", { messageId: pin.message_id });
        }
        await refreshInbox();
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const pinSubtitle = (pin: TeamPin) => {
    if (pin.kind === "file") return pin.file_path || "";
    if (pin.kind === "link") return pin.url || "";
    return pin.message_preview ? compactText(pin.message_preview, 110) : "Pinned message";
  };

  const pinIcon = (pin: TeamPin) => {
    if (pin.kind === "file") return "F";
    if (pin.kind === "link") return "L";
    return "M";
  };

  const markInboxRead = async (messageId: string) => {
    await invoke("team_mark_message_read", { messageId });
    await refreshInbox();
  };

  const markInboxUnread = async (messageId: string) => {
    await invoke("team_mark_message_unread", { messageId });
    await refreshInbox();
  };

  const closeMessageMenuFromEvent = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(".team-message-menu") || target?.closest(".team-message-menu-button")) {
      return;
    }
    setMessageMenu(null);
  };

  const closeMessageMenuOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setMessageMenu(null);
    }
  };

  onMount(() => {
    void loadBase();
    void listen<PtyOutput>("pty-data", (event) => handlePtyData(event.payload)).then((unlisten) => {
      stopPtyListener = unlisten;
    });
    window.addEventListener("pointerdown", closeMessageMenuFromEvent);
    window.addEventListener("keydown", closeMessageMenuOnEscape);
  });

  onCleanup(() => {
    stopPtyListener?.();
    window.removeEventListener("pointerdown", closeMessageMenuFromEvent);
    window.removeEventListener("keydown", closeMessageMenuOnEscape);
  });

  return (
    <main class="team-mode">
      <aside class="team-rail">
        <div class="team-rail-header">
          <div class="team-product">Team Mode</div>
          <button class="team-icon-button" onClick={() => void loadBase()} title="Refresh Team Mode">
            R
          </button>
        </div>

        <button
          class={`team-nav-item inbox ${selection().kind === "inbox" ? "active" : ""}`}
          onClick={() => void openInbox()}
        >
          <span>Inbox</span>
          <Show when={unreadInboxCount() > 0}>
            <span class="team-badge">{unreadInboxCount()}</span>
          </Show>
        </button>

        <div class="team-section-label">Channels</div>
        <For each={channels()}>
          {(channel) => {
            const conversation = () => channelConversation(channel.id);
            const unread = () => (conversation() ? unreadByConversation()[conversation()!.id] || 0 : 0);
            const active = () =>
              selection().kind === "conversation" &&
              conversation()?.id === (selection() as { kind: "conversation"; conversationId: string }).conversationId;
            return (
              <button
                class={`team-nav-item ${active() ? "active" : ""}`}
                onClick={() => void selectChannel(channel)}
              >
                <span class="team-channel-name"># {channel.display_name}</span>
                <Show when={unread() > 0}>
                  <span class="team-badge">{unread()}</span>
                </Show>
              </button>
            );
          }}
        </For>
        <div class="team-inline-form">
          <input
            value={channelName()}
            onInput={(event) => setChannelName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveChannel();
            }}
            placeholder="new-channel"
            spellcheck={false}
          />
          <button onClick={() => void saveChannel()} title="Add channel">+</button>
        </div>

        <div class="team-section-label">DMs</div>
        <For each={users()}>
          {(user) => (
            <button class="team-nav-item" onClick={() => void selectDm(user)}>
              <span class="team-avatar mini" style={{ "--team-avatar-color": user.avatar_color || "" }}>
                {user.display_name[0]?.toUpperCase() || "A"}
              </span>
              <span>{user.display_name}</span>
            </button>
          )}
        </For>

        <div class="team-section-label directory">Directory</div>
        <Show when={users().length > 0} fallback={<div class="team-directory-empty">No users yet.</div>}>
          <For each={users()}>
            {(user) => (
              <div class={`team-directory-row ${editingAgentId() === user.id ? "active" : ""}`}>
                <button class="team-directory-main" onClick={() => editAgent(user)}>
                  <span class="team-avatar mini" style={{ "--team-avatar-color": user.avatar_color || "" }}>
                    {user.display_name[0]?.toUpperCase() || "A"}
                  </span>
                  <span class="team-directory-text">
                    <span class="team-directory-name">{user.display_name}</span>
                    <span class="team-directory-handle">@{user.username}</span>
                  </span>
                </button>
                <button class="team-directory-edit" onClick={() => editAgent(user)}>
                  Edit
                </button>
              </div>
            )}
          </For>
        </Show>

        <div class="team-section-label pinned">Pinned</div>
        <Show when={pins().length > 0} fallback={<div class="team-pins-empty">No pinned objects.</div>}>
          <For each={pins()}>
            {(pin) => (
              <div class="team-pin-row">
                <button class="team-pin-main" onClick={() => void openPin(pin)}>
                  <span class={`team-pin-icon ${pin.kind}`}>{pinIcon(pin)}</span>
                  <span class="team-pin-text">
                    <span class="team-pin-title">{pin.title}</span>
                    <span class="team-pin-subtitle">{pinSubtitle(pin)}</span>
                  </span>
                </button>
                <button class="team-pin-remove" onClick={() => void deletePin(pin)} title="Remove pin">
                  x
                </button>
              </div>
            )}
          </For>
        </Show>
        <div class="team-inline-form team-pin-form">
          <input
            value={pinTarget()}
            onInput={(event) => setPinTarget(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void savePinnedTarget();
            }}
            placeholder="/path/to/file or https://"
            spellcheck={false}
          />
          <button onClick={() => void savePinnedTarget()} title="Pin file or link">+</button>
        </div>
      </aside>

      <section class="team-main">
        <header class="team-main-header">
          <div>
            <div class="team-title">
              <Show when={selection().kind === "inbox"} fallback={selectedChannel() ? `# ${selectedChannel()!.display_name}` : selectedConversation()?.title || "DM"}>
                Inbox
              </Show>
            </div>
            <div class="team-subtitle">
              <Show
                when={selection().kind === "inbox"}
                fallback="Mention an agent to start a threaded run."
              >
                Unread DMs, mentions, and thread replies across Team Mode.
              </Show>
            </div>
          </div>
          <Show when={loading()}>
            <span class="team-status">Loading</span>
          </Show>
        </header>

        <Show when={error()}>
          {(message) => <div class="team-error">{message()}</div>}
        </Show>

        <Show
          when={selection().kind !== "inbox"}
          fallback={
            <div class="team-inbox-list">
              <Show when={inbox().length === 0}>
                <div class="team-empty">Inbox is clear.</div>
              </Show>
              <For each={inbox()}>
                {(item) => (
                  <div class="team-inbox-row" onClick={() => void openInboxItem(item)}>
                    <div class="team-inbox-source">
                      {item.channel ? `# ${item.channel.display_name}` : item.conversation.title || "DM"}
                      <Show when={item.parent_message}> · thread</Show>
                    </div>
                    <div class="team-inbox-title">{item.author?.display_name || "Agent"}</div>
                    <div class="team-inbox-preview">{compactText(item.message.content)}</div>
                    <div class="team-inbox-actions">
                      <button
                        class="team-message-menu-button inbox"
                        onClick={(event) => openMessageMenu(event, item.message)}
                        title="Message actions"
                        aria-label="Message actions"
                      >
                        ...
                      </button>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void markInboxRead(item.message.id);
                        }}
                      >
                        Mark read
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          }
        >
          <div class="team-message-list">
            <Show when={messages().length === 0}>
              <div class="team-empty">No messages yet.</div>
            </Show>
            <For each={messages()}>
              {(message) => <MessageArticle message={message} />}
            </For>
          </div>
          <div class="team-composer">
            <textarea
              value={composerText()}
              onInput={(event) => setComposerText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage(null);
                }
              }}
              placeholder="Message #general, or mention @molly"
              spellcheck={false}
            />
            <button onClick={() => void sendMessage(null)}>Send</button>
          </div>
        </Show>
      </section>

      <aside class="team-side">
        <Show
          when={selectedThreadParent()}
          fallback={
            <div class="team-panel">
              <div class="team-panel-heading">
                <div>
                  <div class="team-panel-title">
                    <Show when={editingAgent()} fallback="New agent">
                      {(agent) => `Agent config: ${agent().display_name}`}
                    </Show>
                  </div>
                  <div class="team-panel-subtitle">
                    <Show when={editingAgent()} fallback="Create a preconfigured agent user.">
                      {(agent) => `@${agent().username}`}
                    </Show>
                  </div>
                </div>
                <button class="team-panel-action" onClick={resetAgentForm}>New</button>
              </div>
              <For each={runs().filter((run) => run.status === "running" || run.status === "queued")}>
                {(run) => {
                  const user = () => users().find((entry) => entry.id === run.user_id);
                  return (
                    <div class="team-run-row">
                      <span>{user()?.display_name || "Agent"}</span>
                      <span>{run.status}</span>
                    </div>
                  );
                }}
              </For>
              <div class="team-agent-form">
                <input
                  value={agentUsername()}
                  onInput={(event) => setAgentUsername(event.currentTarget.value)}
                  placeholder="username"
                  spellcheck={false}
                />
                <input
                  value={agentDisplayName()}
                  onInput={(event) => setAgentDisplayName(event.currentTarget.value)}
                  placeholder="Display name"
                  spellcheck={false}
                />
                <input
                  value={agentPwd()}
                  onInput={(event) => setAgentPwd(event.currentTarget.value)}
                  placeholder="/path/to/start"
                  spellcheck={false}
                />
                <input
                  value={agentCmd()}
                  onInput={(event) => setAgentCmd(event.currentTarget.value)}
                  placeholder={'claude -p "{user_msg}"'}
                  spellcheck={false}
                />
                <button onClick={() => void saveAgent()}>
                  <Show when={editingAgentId()} fallback="Save agent">
                    Update agent
                  </Show>
                </button>
              </div>
            </div>
          }
        >
          {(parent) => (
            <div class="team-thread">
              <div class="team-thread-header">
                <div>
                  <div class="team-panel-title">Thread</div>
                  <div class="team-thread-parent">{compactText(parent().content, 90)}</div>
                </div>
                <button class="team-icon-button" onClick={() => setSelectedThreadParentId(null)} title="Close thread">
                  x
                </button>
              </div>
              <div class="team-thread-list">
                <For each={threadMessages()}>
                  {(message) => <MessageArticle message={message} compact />}
                </For>
              </div>
              <div class="team-composer thread">
                <textarea
                  value={threadComposerText()}
                  onInput={(event) => setThreadComposerText(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage(parent().id);
                    }
                  }}
                  placeholder="Reply in thread"
                  spellcheck={false}
                />
                <button onClick={() => void sendMessage(parent().id)}>Reply</button>
              </div>
            </div>
          )}
        </Show>
      </aside>

      <Show when={messageMenu()}>
        {(menu) => {
          const message = () => findMessageById(menu().messageId);
          const sessionId = () => {
            const current = message();
            return current ? agentSessionIdForMessage(current) : null;
          };
          return (
            <div
              class="team-message-menu"
              style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
            >
              <button
                onClick={() => {
                  const current = message();
                  if (current) void copyToClipboard(current.content);
                }}
              >
                Copy full message
              </button>
              <button
                onClick={() => {
                  const current = message();
                  if (current) void pinMessage(current);
                }}
              >
                Pin message
              </button>
              <Show when={sessionId()}>
                {(value) => (
                  <button onClick={() => void copyToClipboard(value())}>
                    Copy agent session id
                  </button>
                )}
              </Show>
            </div>
          );
        }}
      </Show>
    </main>
  );
}
