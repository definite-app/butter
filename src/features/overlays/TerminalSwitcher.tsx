import { For, Show, createMemo, createSignal, createEffect, onCleanup } from "solid-js";
import { homeDir } from "@tauri-apps/api/path";
import { useAppContext } from "../../app/context/AppContext";

type FilterTab = "all" | "active" | "attention";

type RowStatus = "active" | "attention" | "idle";

type AgentKind = "claude" | "codex" | "shell";

interface RowData {
  id: string;
  title: string;
  directory: string | null;
  status: RowStatus;
  seenAt: number | null;
  agentKind: AgentKind;
  /** One line of plain text: last agent reply, else last terminal line. */
  lastMessage: string | null;
  /** Full plain text used for search only. */
  searchText: string;
}

const AGENT_META: Record<AgentKind, { mark: string; name: string }> = {
  claude: { mark: "C", name: "Claude Code" },
  codex: { mark: "Cx", name: "Codex" },
  shell: { mark: "$", name: "Shell" },
};

function formatAgo(ms: number | null | undefined): string {
  if (!ms) return "";
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

/** Reduce one markdown line to plain text. Returns "" for structural-only lines. */
function markdownLineToPlain(line: string): string {
  let t = line.trim();
  if (!t) return "";
  if (/^(```|~~~)/.test(t)) return ""; // code fences
  if (/^([-*_]\s*){3,}$/.test(t)) return ""; // horizontal rules
  if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(t)) return ""; // table separator rows
  t = t
    .replace(/^#{1,6}\s+/, "") // headings
    .replace(/^>\s?/, "") // blockquote
    .replace(/^[-*+]\s+\[[ xX]\]\s+/, "") // task list items
    .replace(/^[-*+]\s+/, "") // bullets
    .replace(/^\d+[.)]\s+/, "") // ordered list
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links
    .replace(/`+([^`]*)`+/g, "$1") // inline code
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2") // italic
    .replace(/~~(.+?)~~/g, "$1") // strike
    .replace(/^\|\s*/, "")
    .replace(/\s*\|$/, "")
    .replace(/\s*\|\s*/g, "  ")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

function lastNonEmptyLine(lines: string[], transform: (line: string) => string): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const plain = transform(lines[i]);
    if (plain) return plain;
  }
  return null;
}

function shortenHome(path: string | null, home: string | null): string {
  if (!path) return "~";
  const h = home ? home.replace(/\/+$/, "") : null;
  if (h && (path === h || path.startsWith(`${h}/`))) return `~${path.slice(h.length)}`;
  // Fallback before homeDir() resolves: standard macOS home layout.
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

/**
 * Detect which CLI agent is running in a terminal session.
 *
 * Priority order, strongest signal first:
 *  1. Live process — backend pgrep + recent hook event ("working"/"idle").
 *     Any other state value ("unknown" or empty) means nothing is running.
 *  2. Command intent — if the user explicitly launched `claude` or `codex`,
 *     show that even when the process is currently between turns.
 *  3. Historical Claude session id — useful for rows whose transcript is
 *     still relevant after the agent exited.
 *
 * The signal-vs-truthiness distinction matters: claudeState/codexState are
 * frequently set to the literal string "unknown" by the poller, which is
 * truthy and would otherwise trigger false positives.
 */
function isLiveAgentState(value: string | undefined): boolean {
  return value === "working" || value === "idle";
}

function detectAgentKind(
  command: string | null | undefined,
  claudeStateValue: string | undefined,
  codexStateValue: string | undefined,
  hasClaudeId: boolean
): "claude" | "codex" | null {
  if (isLiveAgentState(claudeStateValue)) return "claude";
  if (isLiveAgentState(codexStateValue)) return "codex";
  const cmd = (command ?? "").toLowerCase();
  if (/(^|\s|\/)claude(\s|$)/.test(cmd)) return "claude";
  if (/(^|\s|\/)codex(\s|$)/.test(cmd)) return "codex";
  if (hasClaudeId) return "claude";
  return null;
}

export function TerminalSwitcher() {
  const app = useAppContext();
  const [filter, setFilter] = createSignal<FilterTab>("all");
  const [home, setHome] = createSignal<string | null>(null);
  let inputRef: HTMLInputElement | undefined;
  let bodyRef: HTMLDivElement | undefined;

  void homeDir()
    .then((h) => setHome(h))
    .catch(() => undefined);

  const isOpen = () => app.showCommandPalette() && app.commandPaletteMode() === "switcher";

  // Focus input + reset state + refresh agent transcripts whenever the switcher opens
  createEffect(() => {
    if (isOpen()) {
      requestAnimationFrame(() => inputRef?.focus());
      app.setCommandQuery("");
      app.setSwitcherIndex(0);
      setFilter("all");
      void app.refreshLastAgentTurnsForActiveSessions();
    }
  });

  // Force re-evaluation of relative timestamps while open
  const [tick, setTick] = createSignal(0);
  createEffect(() => {
    if (!isOpen()) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    onCleanup(() => clearInterval(interval));
  });

  const inboxSet = createMemo(() => new Set(app.inboxSessionIds()));

  const allRows = createMemo<RowData[]>(() => {
    const tags = app.terminalTags();
    const seenAt = app.sessionSeenAt();
    const previews = app.sessionPreview();
    const claudeIds = app.agentSessionIdBySession();
    const codex = app.codexState();
    const transcripts = app.lastAgentTurn();
    const claudeStates = app.claudeState();
    const inbox = inboxSet();
    return app.sessions.map((s) => {
      const state = app.getSessionState(s.id);
      const agentKind =
        detectAgentKind(s.command, claudeStates[s.id], codex[s.id], Boolean(claudeIds[s.id])) ??
        "shell";

      const status: RowStatus =
        state === "working" ? "active" : inbox.has(s.id) ? "attention" : "idle";

      const transcriptText = transcripts[s.id]?.text ?? "";
      const previewLines = (previews[s.id] ?? []).map(stripAnsi);
      let lastMessage: string | null = null;
      if (transcriptText.trim()) {
        const plain = stripAnsi(transcriptText);
        // Prefer prose: skip fenced code blocks, fall back to them if that is all there is.
        const prose = plain.replace(/(```|~~~)[\s\S]*?(\1|$)/g, "\n");
        lastMessage =
          lastNonEmptyLine(prose.split(/\r?\n/), markdownLineToPlain) ??
          lastNonEmptyLine(plain.split(/\r?\n/), markdownLineToPlain);
      }
      if (!lastMessage) {
        lastMessage = lastNonEmptyLine(previewLines, (l) => l.replace(/\s+/g, " ").trim());
      }

      const rowTags = tags[s.id] ?? [];
      return {
        id: s.id,
        title: s.title,
        directory: s.directory ?? null,
        status,
        seenAt: seenAt[s.id] ?? s.createdAt,
        agentKind,
        lastMessage,
        searchText: [
          s.title,
          s.directory ?? "",
          s.command ?? "",
          rowTags.join(" "),
          AGENT_META[agentKind].name,
          transcriptText,
          previewLines.join(" "),
        ]
          .join(" ")
          .toLowerCase(),
      };
    });
  });

  const counts = createMemo(() => {
    const rows = allRows();
    return {
      all: rows.length,
      active: rows.filter((r) => r.status === "active").length,
      attention: rows.filter((r) => r.status === "attention").length,
    };
  });

  // Visible order: needs-attention rows first, then everything else; both
  // groups most-recent-activity first. Same order in every filter tab.
  // Keyboard index and ⌘1–9 both index into this list.
  const visibleRows = createMemo<RowData[]>(() => {
    const tab = filter();
    const q = app.commandQuery().trim().toLowerCase();
    const byRecent = (a: RowData, b: RowData) => (b.seenAt ?? 0) - (a.seenAt ?? 0);
    const rows = allRows().filter((r) => {
      if (tab === "active" && r.status !== "active") return false;
      if (tab === "attention" && r.status !== "attention") return false;
      return !q || r.searchText.includes(q);
    });
    const attention = rows.filter((r) => r.status === "attention").sort(byRecent);
    const rest = rows.filter((r) => r.status !== "attention").sort(byRecent);
    return [...attention, ...rest];
  });

  // Keep the selected index in range when the list shrinks.
  createEffect(() => {
    const len = visibleRows().length;
    if (app.switcherIndex() > 0 && app.switcherIndex() >= len) {
      app.setSwitcherIndex(Math.max(0, len - 1));
    }
  });

  // Keep the keyboard-selected row visible.
  createEffect(() => {
    const idx = app.switcherIndex();
    if (!isOpen() || !bodyRef) return;
    const el = bodyRef.querySelector<HTMLElement>(`[data-row-index="${idx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  });

  const close = () => {
    app.setShowCommandPalette(false);
    app.setCommandQuery("");
  };

  const selectIdx = (idx: number) => {
    const row = visibleRows()[idx];
    if (!row) return;
    app.selectSession(row.id);
    close();
  };

  const setTab = (tab: FilterTab) => {
    setFilter(tab);
    app.setSwitcherIndex(0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const len = visibleRows().length;
    if (len === 0) return;

    // Cmd+number jumps
    if (e.metaKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const idx = parseInt(e.key, 10) - 1;
      if (idx < len) selectIdx(idx);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      selectIdx(app.switcherIndex());
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      app.setSwitcherIndex((i) => Math.min(len - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      app.setSwitcherIndex((i) => Math.max(0, i - 1));
      return;
    }
  };

  return (
    <Show when={isOpen()}>
      <div class="switcher-overlay" onClick={close}>
        <div class="switcher-modal" onClick={(e) => e.stopPropagation()}>
          <div class="switcher-header">
            <label class="switcher-search">
              <svg
                class="switcher-search-icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                ref={(el) => (inputRef = el)}
                class="switcher-search-input"
                aria-label="Search sessions"
                placeholder="Jump to a session, agent or tag"
                spellcheck={false}
                value={app.commandQuery()}
                onInput={(e) => {
                  app.setCommandQuery(e.currentTarget.value);
                  app.setSwitcherIndex(0);
                }}
                onKeyDown={onKeyDown}
              />
              <kbd class="switcher-kbd">esc</kbd>
            </label>

            <div class="switcher-tabs" role="tablist">
              <FilterPill
                label="All"
                count={counts().all}
                active={filter() === "all"}
                onClick={() => setTab("all")}
              />
              <FilterPill
                label="Active"
                count={counts().active}
                active={filter() === "active"}
                onClick={() => setTab("active")}
              />
              <FilterPill
                label="Needs input"
                count={counts().attention}
                active={filter() === "attention"}
                onClick={() => setTab("attention")}
              />
            </div>
          </div>

          <div class="switcher-body" ref={(el) => (bodyRef = el)}>
            <For each={visibleRows()}>
              {(row, index) => (
                <SessionRow
                  row={row}
                  index={index()}
                  selected={index() === app.switcherIndex()}
                  home={home()}
                  tick={tick()}
                  onClick={() => selectIdx(index())}
                />
              )}
            </For>

            <Show when={visibleRows().length === 0}>
              <div class="switcher-empty">
                <Show when={app.commandQuery().trim()} fallback={<span>No sessions</span>}>
                  <span>No sessions match "{app.commandQuery()}"</span>
                </Show>
              </div>
            </Show>
          </div>

          <div class="switcher-footer">
            <span class="switcher-footer-hint">
              <kbd class="switcher-kbd">↑↓</kbd>navigate
            </span>
            <span class="switcher-footer-hint">
              <kbd class="switcher-kbd">↵</kbd>open
            </span>
            <span class="switcher-footer-hint">
              <kbd class="switcher-kbd">⌘1–9</kbd>jump
            </span>
            <span class="switcher-footer-hint">
              <kbd class="switcher-kbd">⌘⇧K</kbd>commands
            </span>
          </div>
        </div>
      </div>
    </Show>
  );
}

function FilterPill(props: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      class={`switcher-tab ${props.active ? "active" : ""}`}
      onClick={props.onClick}
    >
      {props.label}
      <span class="switcher-tab-count">{props.count}</span>
    </button>
  );
}

function SessionRow(props: {
  row: RowData;
  index: number;
  selected: boolean;
  home: string | null;
  tick: number;
  onClick: () => void;
}) {
  const agent = () => AGENT_META[props.row.agentKind];
  const statusText = () => {
    void props.tick; // re-evaluate relative time every second
    if (props.row.status === "active") return "Working";
    if (props.row.status === "attention") return "Needs input";
    return formatAgo(props.row.seenAt);
  };
  const path = () => shortenHome(props.row.directory, props.home);

  return (
    <button
      type="button"
      class={`switcher-row status-${props.row.status} ${props.selected ? "selected" : ""}`}
      data-row-index={props.index}
      aria-pressed={props.selected}
      onClick={props.onClick}
    >
      <span class="switcher-row-title-cell">
        <span class="switcher-row-dot" aria-hidden="true" />
        <span class="switcher-row-title" title={props.row.title}>
          {props.row.title}
        </span>
      </span>
      <span class="switcher-row-agent">
        <span class={`switcher-row-badge kind-${props.row.agentKind}`}>{agent().mark}</span>
        {agent().name}
      </span>
      <span class="switcher-row-path" title={props.row.directory ?? undefined}>
        {path()}
      </span>
      <span
        class={`switcher-row-last ${props.row.lastMessage ? "" : "empty"}`}
        title={props.row.lastMessage ?? undefined}
      >
        {props.row.lastMessage ?? "No output yet"}
      </span>
      <span class="switcher-row-status">{statusText()}</span>
    </button>
  );
}
