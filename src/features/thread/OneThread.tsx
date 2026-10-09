import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";
import type { ThreadMessage } from "./threadModel";
import "./OneThread.css";

const TIME_GAP_MS = 10 * 60 * 1000;
// A delivered message with no sign of the agent after this long is likely
// blocked on something only the terminal shows (trust or permission prompt).
const STALE_DELIVERY_MS = 20_000;

type StreamItem =
  | { kind: "time"; key: string; at: number }
  | { kind: "label"; key: string; threadId: string }
  | { kind: "message"; key: string; message: ThreadMessage; receipt: string | null }
  | { kind: "typing"; key: string; threadId: string; showLabel: boolean };

const RECEIPT_LABEL: Record<string, string> = {
  queued: "Queued",
  delivered: "Delivered",
  seen: "Seen",
};

const sameItem = (a: StreamItem, b: StreamItem): boolean => {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case "time":
      return b.kind === "time" && a.at === b.at;
    case "label":
      return b.kind === "label" && a.threadId === b.threadId;
    case "message":
      return b.kind === "message" && a.message === b.message && a.receipt === b.receipt;
    case "typing":
      return b.kind === "typing" && a.threadId === b.threadId && a.showLabel === b.showLabel;
  }
};

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function formatSeparator(at: number): string {
  const date = new Date(at);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at >= startOfToday) return `Today ${time}`;
  if (at >= startOfToday - 86_400_000) return `Yesterday ${time}`;
  if (at >= startOfToday - 6 * 86_400_000) {
    return `${date.toLocaleDateString([], { weekday: "long" })} ${time}`;
  }
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function OneThread() {
  const app = useAppContext();
  const model = app.thread;
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  let streamRef: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;
  let stickToBottom = true;

  const focusedId = () => model.focusedThreadId();
  const focused = () => {
    const id = focusedId();
    return id ? model.threadById()[id] ?? null : null;
  };
  const threadTitle = (id: string) => model.threadById()[id]?.title || "thread";
  const replyTarget = () => {
    const id = model.replyTargetId();
    return id && model.threadById()[id] ? id : null;
  };

  const pinnedThreads = createMemo(() =>
    model
      .threads()
      .filter((t) => t.pinned)
      .slice()
      .sort((a, b) => b.last_activity_at - a.last_activity_at)
  );

  const visibleMessages = createMemo(() => {
    const id = focusedId();
    const all = model.messages();
    return id ? all.filter((m) => m.session_id === id) : all;
  });

  const workingThreads = createMemo(
    () => {
      const id = focusedId();
      const ids = id ? [id] : model.threads().map((t) => t.session_id);
      return ids.filter((tid) => model.isWorking(tid));
    },
    [],
    { equals: sameIds }
  );

  // Reuse unchanged item objects so <For> keeps their DOM (hover, selection).
  let itemCache = new Map<string, StreamItem>();

  const items = createMemo<StreamItem[]>(() => {
    const list = visibleMessages();
    const inAll = !focusedId();

    // Receipt goes under the latest user bubble of a thread, until the agent answers.
    const receiptFor = new Map<string, string>();
    const seenThreads = new Set<string>();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (seenThreads.has(m.session_id)) continue;
      seenThreads.add(m.session_id);
      if (m.role === "user" && m.status) {
        const label = RECEIPT_LABEL[m.status];
        if (label) receiptFor.set(m.id, label);
      }
    }

    const out: StreamItem[] = [];
    let prevAt = 0;
    let prev: ThreadMessage | null = null;
    for (const m of list) {
      if (m.created_at - prevAt > TIME_GAP_MS) {
        out.push({ kind: "time", key: `time-${m.id}`, at: m.created_at });
        prev = null;
      }
      prevAt = m.created_at;
      const startsAgentRun =
        m.role === "agent" && (!prev || prev.role !== "agent" || prev.session_id !== m.session_id);
      if (inAll && startsAgentRun) {
        out.push({ kind: "label", key: `label-${m.id}`, threadId: m.session_id });
      }
      out.push({ kind: "message", key: m.id, message: m, receipt: receiptFor.get(m.id) ?? null });
      prev = m;
    }

    const last = list[list.length - 1];
    for (const tid of workingThreads()) {
      const continuesRun = last && last.role === "agent" && last.session_id === tid;
      out.push({ kind: "typing", key: `typing-${tid}`, threadId: tid, showLabel: inAll && !continuesRun });
    }
    const nextCache = new Map<string, StreamItem>();
    const stable = out.map((item) => {
      const cached = itemCache.get(item.key);
      const kept = cached && sameItem(cached, item) ? cached : item;
      nextCache.set(item.key, kept);
      return kept;
    });
    itemCache = nextCache;
    return stable;
  });

  const scrollToBottom = () => {
    if (!streamRef) return;
    streamRef.scrollTop = streamRef.scrollHeight;
  };

  createEffect(
    on(items, () => {
      if (stickToBottom) requestAnimationFrame(scrollToBottom);
    })
  );

  createEffect(
    on(focusedId, () => {
      stickToBottom = true;
      requestAnimationFrame(() => {
        scrollToBottom();
        inputRef?.focus();
      });
    })
  );

  const handleScroll = () => {
    if (!streamRef) return;
    stickToBottom = streamRef.scrollHeight - streamRef.scrollTop - streamRef.clientHeight < 48;
  };

  const resizeInput = () => {
    if (!inputRef) return;
    inputRef.style.height = "auto";
    inputRef.style.height = `${Math.min(inputRef.scrollHeight, 140)}px`;
  };

  const send = async () => {
    const text = draft().trim();
    if (!text || sending()) return;
    setSending(true);
    try {
      const target = focusedId() ?? replyTarget();
      if (target) {
        await model.sendReply(target, text);
      } else {
        await model.startThread(text);
      }
      setDraft("");
      model.setReplyTargetId(null);
      stickToBottom = true;
      requestAnimationFrame(resizeInput);
    } catch (err) {
      console.error("[thread] send failed", err);
    } finally {
      setSending(false);
      inputRef?.focus();
    }
  };

  const openTerminal = async (threadId: string) => {
    const exists = app.sessions.some((s) => s.id === threadId);
    const opened = exists ? threadId : await app.reopenClosedSession(threadId);
    if (!opened) return;
    app.setAppView("terminal");
    app.selectSession(threadId);
  };

  const startReply = (threadId: string) => {
    if (focusedId()) return;
    model.setReplyTargetId(threadId);
    inputRef?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (app.showCommandPalette()) return;
    if (event.key === "Escape") {
      if (replyTarget()) {
        event.preventDefault();
        model.setReplyTargetId(null);
        return;
      }
      if (focusedId()) {
        event.preventDefault();
        model.focusThread(null);
      }
      return;
    }
    if (event.key === "Enter" && event.metaKey && focusedId()) {
      event.preventDefault();
      void openTerminal(focusedId() as string);
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(() => {
      scrollToBottom();
      inputRef?.focus();
    });
  });
  onCleanup(() => window.removeEventListener("keydown", handleKeyDown));

  const placeholder = () => {
    if (focused()) return `Message ${focused()?.title}`;
    if (replyTarget()) return "Reply";
    return "Start a new thread";
  };

  return (
    <div class="one-thread">
      <header class="ot-header">
        <div class="ot-header-left">
          <Show
            when={focused()}
            fallback={
              <div class="ot-brand">
                <span class="ot-mark">1</span>
                <span class="ot-title">One Thread</span>
              </div>
            }
          >
            <button class="ot-ghost-btn ot-back" onClick={() => model.focusThread(null)}>
              ‹ All
            </button>
          </Show>
        </div>
        <div class="ot-header-center">
          <Show when={focused()}>
            {(thread) => (
              <div class="ot-focus-title">
                <div class="ot-focus-name">{thread().title}</div>
                <div class={`ot-focus-status ${model.isWorking(thread().session_id) ? "working" : ""}`}>
                  {model.isWorking(thread().session_id) ? "working…" : "idle"}
                </div>
              </div>
            )}
          </Show>
        </div>
        <div class="ot-header-right">
          <Show when={focused()}>
            {(thread) => (
              <>
                <button
                  class={`ot-ghost-btn ${thread().pinned ? "active" : ""}`}
                  onClick={() => void model.setPinned(thread().session_id, !thread().pinned)}
                  title={thread().pinned ? "Unpin" : "Pin"}
                >
                  {thread().pinned ? "Pinned" : "Pin"}
                </button>
                <button
                  class="ot-ghost-btn"
                  onClick={() => void openTerminal(thread().session_id)}
                  title="Open this thread's terminal"
                >
                  Terminal <span class="ot-kbd">⌘↩</span>
                </button>
              </>
            )}
          </Show>
          <div class="ot-seg" role="tablist">
            <button class="ot-seg-btn active" role="tab" aria-selected="true">
              Thread
            </button>
            <button class="ot-seg-btn" role="tab" aria-selected="false" onClick={() => app.setAppView("terminal")}>
              Terminals
            </button>
          </div>
        </div>
      </header>

      <Show when={pinnedThreads().length > 0}>
        <div class="ot-shelf">
          <For each={pinnedThreads()}>
            {(thread) => (
              <button
                class={`ot-chip ${focusedId() === thread.session_id ? "active" : ""}`}
                onClick={() => model.focusThread(thread.session_id)}
                title={thread.title}
              >
                <span class="ot-chip-name">{thread.title}</span>
                <Show when={model.hasUnread(thread.session_id) && focusedId() !== thread.session_id}>
                  <span class="ot-unread" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="ot-stream" ref={streamRef} onScroll={handleScroll}>
        <div class="ot-column">
          <Show when={model.loaded() && visibleMessages().length === 0 && workingThreads().length === 0}>
            <div class="ot-empty">
              Send a message to start a thread. Each one runs Claude Code in its own terminal.
            </div>
          </Show>
          <For each={items()}>
            {(item) => (
              <Switch>
                <Match when={item.kind === "time" && item}>
                  {(it) => <div class="ot-time">{formatSeparator(it().at)}</div>}
                </Match>
                <Match when={item.kind === "label" && item}>
                  {(it) => (
                    <button class="ot-thread-name" onClick={() => model.focusThread(it().threadId)}>
                      {threadTitle(it().threadId)}
                    </button>
                  )}
                </Match>
                <Match when={item.kind === "typing" && item}>
                  {(it) => (
                    <div class="ot-row agent">
                      <Show when={it().showLabel}>
                        <button class="ot-thread-name" onClick={() => model.focusThread(it().threadId)}>
                          {threadTitle(it().threadId)}
                        </button>
                      </Show>
                      <div class="ot-bubble agent ot-typing" aria-label="Agent is working">
                        <span />
                        <span />
                        <span />
                      </div>
                    </div>
                  )}
                </Match>
                <Match when={item.kind === "message" && item}>
                  {(it) => {
                    const m = () => it().message;
                    const pinned = () => model.threadById()[m().session_id]?.pinned ?? false;
                    const stale = () => {
                      app.idleTick();
                      return (
                        m().status === "delivered" &&
                        !model.isWorking(m().session_id) &&
                        Date.now() - m().created_at > STALE_DELIVERY_MS
                      );
                    };
                    return (
                      <div class={`ot-row ${m().role}`}>
                        <div class="ot-bubble-line">
                          <div
                            class={`ot-bubble ${m().role} ${m().source === "transcript" ? "transcript" : ""}`}
                            title={m().source === "transcript" ? "From the session transcript" : undefined}
                          >
                            {m().body}
                          </div>
                          <div class="ot-hover-actions">
                            <Show when={!focusedId()}>
                              <button onClick={() => startReply(m().session_id)}>Reply</button>
                            </Show>
                            <button onClick={() => void model.setPinned(m().session_id, !pinned())}>
                              {pinned() ? "Unpin" : "Pin"}
                            </button>
                          </div>
                        </div>
                        <Show when={it().receipt}>
                          <div class="ot-receipt">
                            {it().receipt}
                            <Show when={stale()}>
                              {" · "}
                              <button class="ot-receipt-link" onClick={() => void openTerminal(m().session_id)}>
                                check terminal
                              </button>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </Match>
              </Switch>
            )}
          </For>
        </div>
      </div>

      <div class="ot-composer-wrap">
        <form
          class="ot-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Show
            when={!focused() && replyTarget()}
            fallback={<span class="ot-target">Claude Code</span>}
          >
            {(target) => (
              <span class="ot-target reply">
                ↳ {threadTitle(target())}
                <button
                  type="button"
                  class="ot-target-clear"
                  onClick={() => model.setReplyTargetId(null)}
                  aria-label="Clear reply target"
                >
                  ×
                </button>
              </span>
            )}
          </Show>
          <textarea
            ref={inputRef}
            class="ot-input"
            rows={1}
            placeholder={placeholder()}
            value={draft()}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              resizeInput();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="submit"
            class="ot-send"
            disabled={!draft().trim() || sending()}
            aria-label="Send"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
