import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useAppContext } from "../../app/context/AppContext";
import { extractImageFromClipboard, inferImageMimeType } from "../../utils/clipboard";
import type { TerminalPreset } from "../../app/types";
import { threadAgentCommandForPreset } from "./threadModel";
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

type IconName = "reply" | "pin" | "more" | "copy" | "terminal" | "open" | "check" | "chevron";

// Inline stroke icons (16px, currentColor) for the bubble actions and menu.
function Icon(props: { name: IconName; filled?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <Switch>
        <Match when={props.name === "reply"}>
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </Match>
        <Match when={props.name === "pin"}>
          <path d="M12 17v5" />
          <path d="M9 3h6l-1 6 4 4H6l4-4-1-6z" fill={props.filled ? "currentColor" : "none"} />
        </Match>
        <Match when={props.name === "more"}>
          <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
        </Match>
        <Match when={props.name === "copy"}>
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
        </Match>
        <Match when={props.name === "terminal"}>
          <path d="m5 8 4 4-4 4" />
          <path d="M12 16h7" />
        </Match>
        <Match when={props.name === "check"}>
          <path d="M20 6 9 17l-5-5" />
        </Match>
        <Match when={props.name === "chevron"}>
          <path d="m18 15-6-6-6 6" />
        </Match>
        <Match when={props.name === "open"}>
          <path d="M14 4h6v6" />
          <path d="M20 4 11 13" />
          <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </Match>
      </Switch>
    </svg>
  );
}

/** A local image file, loaded as a blob URL (the webview can't read file paths). */
function LocalImage(props: { path: string; class?: string; onClick?: () => void }) {
  const [src, setSrc] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  createEffect(
    on(
      () => props.path,
      (path) => {
        let url: string | null = null;
        let cancelled = false;
        setSrc(null);
        setFailed(false);
        invoke<number[]>("read_file_binary", { path })
          .then((bytes) => {
            if (cancelled) return;
            const type = inferImageMimeType(path) ?? "image/png";
            url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
            setSrc(url);
          })
          .catch((err) => {
            if (cancelled) return;
            console.warn("[thread] failed to load image", path, err);
            setFailed(true);
          });
        onCleanup(() => {
          cancelled = true;
          if (url) URL.revokeObjectURL(url);
        });
      }
    )
  );
  return (
    <Show
      when={src()}
      fallback={<div class={`${props.class ?? ""} ot-image-placeholder`}>{failed() ? "Image unavailable" : ""}</div>}
    >
      {(url) => (
        <img
          class={props.class}
          src={url()}
          alt=""
          draggable={false}
          onClick={() => props.onClick?.()}
        />
      )}
    </Show>
  );
}

export function OneThread() {
  const app = useAppContext();
  const model = app.thread;
  const [draft, setDraft] = createSignal("");
  // Pasted images waiting to be sent, as paths in the pending attachments folder.
  const [pendingImages, setPendingImages] = createSignal<string[]>([]);
  const [pasteError, setPasteError] = createSignal<string | null>(null);
  // Which preset new threads start in; null is plain Claude Code in the
  // shared threads folder. Remembered per viewer.
  const PRESET_STORAGE_KEY = "butter.1thread.presetId";
  const readStoredPresetId = () => {
    try {
      return localStorage.getItem(PRESET_STORAGE_KEY);
    } catch {
      return null;
    }
  };
  const [presetId, setPresetId] = createSignal<string | null>(readStoredPresetId());
  const [presetMenuOpen, setPresetMenuOpen] = createSignal(false);
  const threadPresets = createMemo(() => app.presets().filter((p) => threadAgentCommandForPreset(p)));
  const selectedPreset = () => threadPresets().find((p) => p.id === presetId()) ?? null;
  const choosePreset = (preset: TerminalPreset | null) => {
    setPresetId(preset?.id ?? null);
    try {
      if (preset) localStorage.setItem(PRESET_STORAGE_KEY, preset.id);
      else localStorage.removeItem(PRESET_STORAGE_KEY);
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
    setPresetMenuOpen(false);
    inputRef?.focus();
  };
  const [sending, setSending] = createSignal(false);
  // Message id whose ⋯ menu is open.
  const [menuFor, setMenuFor] = createSignal<string | null>(null);
  // Open the menu upward when there isn't room below it in the stream.
  const [menuUp, setMenuUp] = createSignal(false);
  const MENU_HEIGHT = 220;
  const toggleMenu = (messageId: string, button: HTMLElement) => {
    if (menuFor() === messageId) {
      setMenuFor(null);
      return;
    }
    const streamBottom = streamRef?.getBoundingClientRect().bottom ?? window.innerHeight;
    setMenuUp(button.getBoundingClientRect().bottom + MENU_HEIGHT > streamBottom);
    setMenuFor(messageId);
  };
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

  const canSend = () => (draft().trim().length > 0 || pendingImages().length > 0) && !sending();

  const send = async () => {
    const text = draft().trim();
    const images = pendingImages();
    if (!canSend()) return;
    setSending(true);
    try {
      const target = focusedId() ?? replyTarget();
      if (target) {
        await model.sendReply(target, text, images);
      } else {
        await model.startThread(text, images, selectedPreset());
      }
      setDraft("");
      setPendingImages([]);
      setPasteError(null);
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

  // Images are saved from the native clipboard, like terminal paste, because
  // the webview's clipboard data isn't reliable for screenshots.
  const handlePaste = async (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!data) return;
    const hasImage =
      Array.from(data.items).some((item) => item.type.startsWith("image/")) ||
      Boolean(extractImageFromClipboard(data));
    if (!hasImage) return;
    event.preventDefault();
    setPasteError(null);
    try {
      const path = await invoke<string>("thread_save_clipboard_image");
      setPendingImages((prev) => [...prev, path]);
    } catch (err) {
      console.error("[thread] image paste failed", err);
      setPasteError("Couldn't paste that image");
    }
  };

  const removePendingImage = (path: string) => {
    setPendingImages((prev) => prev.filter((p) => p !== path));
    inputRef?.focus();
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

  const copyMessage = async (body: string) => {
    try {
      await navigator.clipboard.writeText(body);
    } catch (err) {
      console.error("[thread] copy failed:", err);
    }
  };

  // Run a menu action and close the menu.
  const fromMenu = (action: () => void) => () => {
    setMenuFor(null);
    action();
  };

  const closeMenuOnOutsideClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (presetMenuOpen() && !target?.closest(".ot-preset-menu, .ot-target.picker")) {
      setPresetMenuOpen(false);
    }
    if (!menuFor()) return;
    if (target?.closest(".ot-menu, .ot-more-btn")) return;
    setMenuFor(null);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (app.showCommandPalette()) return;
    if (event.key === "Escape") {
      if (presetMenuOpen()) {
        event.preventDefault();
        setPresetMenuOpen(false);
        inputRef?.focus();
        return;
      }
      if (menuFor()) {
        event.preventDefault();
        setMenuFor(null);
        return;
      }
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
    document.addEventListener("mousedown", closeMenuOnOutsideClick);
    requestAnimationFrame(() => {
      scrollToBottom();
      inputRef?.focus();
    });
  });
  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown);
    document.removeEventListener("mousedown", closeMenuOnOutsideClick);
  });

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
              <div class="ot-brand" role="heading" aria-level="1" aria-label="1thread">
                <span class="ot-mark" aria-hidden="true">1</span>
                <span class="ot-title" aria-hidden="true">thread</span>
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
                  {thread().preset_name ? `${thread().preset_name} · ` : ""}
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
                  class={`ot-ghost-btn ot-icon-btn ${thread().pinned ? "active" : ""}`}
                  onClick={() => void model.setPinned(thread().session_id, !thread().pinned)}
                  title={thread().pinned ? "Unpin thread" : "Pin thread"}
                  aria-label={thread().pinned ? "Unpin thread" : "Pin thread"}
                  aria-pressed={thread().pinned}
                >
                  <Icon name="pin" filled={thread().pinned} />
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
                          <div class="ot-bubble-stack">
                            <Show when={m().attachments?.length}>
                              <div class="ot-bubble-images">
                                <For each={m().attachments}>
                                  {(path) => (
                                    <LocalImage
                                      path={path}
                                      class="ot-bubble-image"
                                      onClick={() => void app.openPathExternally(path)}
                                    />
                                  )}
                                </For>
                              </div>
                            </Show>
                            <Show when={m().body}>
                              <div
                                class={`ot-bubble ${m().role} ${m().source === "transcript" ? "transcript" : ""}`}
                                title={m().source === "transcript" ? "From the session transcript" : undefined}
                              >
                                {m().body}
                              </div>
                            </Show>
                          </div>
                          <div class={`ot-hover-actions ${menuFor() === m().id ? "open" : ""}`}>
                            <Show when={!focusedId()}>
                              <button
                                onClick={() => startReply(m().session_id)}
                                title="Reply in this thread"
                                aria-label="Reply in this thread"
                              >
                                <Icon name="reply" />
                              </button>
                            </Show>
                            <button
                              class={pinned() ? "active" : ""}
                              onClick={() => void model.setPinned(m().session_id, !pinned())}
                              title={pinned() ? "Unpin thread" : "Pin thread"}
                              aria-label={pinned() ? "Unpin thread" : "Pin thread"}
                              aria-pressed={pinned()}
                            >
                              <Icon name="pin" filled={pinned()} />
                            </button>
                            <button
                              class="ot-more-btn"
                              onClick={(e) => toggleMenu(m().id, e.currentTarget)}
                              title="More"
                              aria-label="More actions"
                              aria-haspopup="menu"
                              aria-expanded={menuFor() === m().id}
                            >
                              <Icon name="more" />
                            </button>
                            <Show when={menuFor() === m().id}>
                              <div class={`ot-menu ${menuUp() ? "up" : ""}`} role="menu">
                                <Show when={m().body}>
                                  <button role="menuitem" onClick={fromMenu(() => void copyMessage(m().body))}>
                                    <Icon name="copy" />
                                    Copy message
                                  </button>
                                </Show>
                                <Show when={!focusedId()}>
                                  <button role="menuitem" onClick={fromMenu(() => startReply(m().session_id))}>
                                    <Icon name="reply" />
                                    Reply
                                  </button>
                                  <button role="menuitem" onClick={fromMenu(() => model.focusThread(m().session_id))}>
                                    <Icon name="open" />
                                    Open thread
                                  </button>
                                </Show>
                                <button
                                  role="menuitem"
                                  onClick={fromMenu(() => void model.setPinned(m().session_id, !pinned()))}
                                >
                                  <Icon name="pin" filled={pinned()} />
                                  {pinned() ? "Unpin thread" : "Pin thread"}
                                </button>
                                <div class="ot-menu-sep" role="separator" />
                                <button role="menuitem" onClick={fromMenu(() => void openTerminal(m().session_id))}>
                                  <Icon name="terminal" />
                                  Open terminal
                                </button>
                              </div>
                            </Show>
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
            fallback={
              <Show
                when={!focused()}
                fallback={<span class="ot-target">{focused()?.preset_name ?? "Claude Code"}</span>}
              >
                <button
                  type="button"
                  class={`ot-target picker ${presetMenuOpen() ? "open" : ""}`}
                  onClick={() => setPresetMenuOpen((open) => !open)}
                  title="Where new threads start"
                  aria-haspopup="listbox"
                  aria-expanded={presetMenuOpen()}
                >
                  <span class="ot-target-label">{selectedPreset()?.name ?? "Claude Code"}</span>
                  <Icon name="chevron" />
                </button>
                <Show when={presetMenuOpen()}>
                  <div class="ot-preset-menu" role="listbox" aria-label="Start new threads in">
                    <div class="ot-preset-heading">Start new threads in</div>
                    <button
                      type="button"
                      role="option"
                      aria-selected={!selectedPreset()}
                      class="ot-preset-item"
                      onClick={() => choosePreset(null)}
                    >
                      <span class="ot-preset-text">
                        <span class="ot-preset-name">Claude Code</span>
                        <span class="ot-preset-dir">1thread folder</span>
                      </span>
                      <Show when={!selectedPreset()}>
                        <Icon name="check" />
                      </Show>
                    </button>
                    <For each={threadPresets()}>
                      {(preset) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={selectedPreset()?.id === preset.id}
                          class="ot-preset-item"
                          onClick={() => choosePreset(preset)}
                        >
                          <span class="ot-preset-text">
                            <span class="ot-preset-name">{preset.name}</span>
                            <span class="ot-preset-dir" title={preset.directory}>
                              {(preset.directory || "~").replace(/^\/Users\/[^/]+(?=\/|$)/, "~")}
                            </span>
                          </span>
                          <Show when={selectedPreset()?.id === preset.id}>
                            <Icon name="check" />
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            }
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
          <Show when={pendingImages().length > 0 || pasteError()}>
            <div class="ot-attachments">
              <For each={pendingImages()}>
                {(path) => (
                  <div class="ot-attachment">
                    <LocalImage path={path} class="ot-attachment-image" />
                    <button
                      type="button"
                      class="ot-attachment-remove"
                      onClick={() => removePendingImage(path)}
                      aria-label="Remove image"
                      title="Remove image"
                    >
                      ×
                    </button>
                  </div>
                )}
              </For>
              <Show when={pasteError()}>
                {(error) => <span class="ot-attachment-error">{error()}</span>}
              </Show>
            </div>
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
            onPaste={(e) => void handlePaste(e)}
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
            disabled={!canSend()}
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
