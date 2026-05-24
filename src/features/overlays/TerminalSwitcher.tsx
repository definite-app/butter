import { For, Show, createMemo, createSignal, createEffect, onCleanup } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

type FilterTab = "all" | "active" | "attention" | "recent";

interface TileData {
  id: string;
  title: string;
  directory: string | null;
  command: string | null;
  tags: string[];
  state: "working" | "idle" | "unknown";
  seenAt: number | null;
  previewLines: string[];
  previewSource: "transcript" | "scrollback" | "empty";
  isActive: boolean;
  agentKind: "claude" | "codex" | null;
  agentSessionShort: string | null;
  agentModel: string | null;
}

const TILE_PREVIEW_LINES = 5;
const TRANSCRIPT_PREVIEW_LINES = 18;

function formatAgo(ms: number | null | undefined): string {
  if (!ms) return "—";
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function classifyPreviewLine(line: string): "error" | "success" | "muted" | "normal" {
  const trimmed = line.trim();
  if (!trimmed) return "muted";
  if (/\b(error|fail|failed|denied|panic|fatal|❌|ECONN|EPERM|ENOENT)\b/i.test(trimmed))
    return "error";
  if (/\b(ok|success|passed|done|built|compiled|✓|✔|ready)\b/i.test(trimmed)) return "success";
  if (/^[#>$]\s|^\s*\.{3,}\s*$|^\s*…\s*$/.test(trimmed)) return "muted";
  return "normal";
}

export function TerminalSwitcher() {
  const app = useAppContext();
  const [filter, setFilter] = createSignal<FilterTab>("all");
  let inputRef: HTMLInputElement | undefined;

  // Focus input + reset state + refresh agent transcripts whenever the switcher opens
  createEffect(() => {
    if (app.showCommandPalette() && app.commandPaletteMode() === "switcher") {
      requestAnimationFrame(() => inputRef?.focus());
      app.setCommandQuery("");
      app.setSwitcherIndex(0);
      setFilter("all");
      void app.refreshLastAgentTurnsForActiveSessions();
    }
  });

  // Force re-evaluation of timestamps every second while open
  const [, setTick] = createSignal(0);
  createEffect(() => {
    if (!app.showCommandPalette() || app.commandPaletteMode() !== "switcher") return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    onCleanup(() => clearInterval(interval));
  });

  const allTiles = createMemo<TileData[]>(() => {
    const tags = app.terminalTags();
    const seenAt = app.sessionSeenAt();
    const previews = app.sessionPreview();
    const claudeIds = app.agentSessionIdBySession();
    const codex = app.codexState();
    const activeId = app.activeSessionId();
    const transcripts = app.lastAgentTurn();
    return app.sessions.map((s) => {
      const state = app.getSessionState(s.id);
      const claudeTagged = Boolean(claudeIds[s.id]);
      const codexTagged = Boolean(codex[s.id]);
      const agentKind: TileData["agentKind"] = claudeTagged
        ? "claude"
        : codexTagged
        ? "codex"
        : null;
      const fullAgentId = claudeIds[s.id] ?? null;
      const agentSessionShort =
        fullAgentId && fullAgentId.length > 0
          ? fullAgentId.replace(/-/g, "").slice(-6)
          : null;

      const transcript = transcripts[s.id];
      let previewLines: string[];
      let previewSource: TileData["previewSource"];
      if (transcript && transcript.text.trim().length > 0) {
        previewLines = transcript.text
          .split("\n")
          .slice(-TRANSCRIPT_PREVIEW_LINES);
        previewSource = "transcript";
      } else {
        const tail = (previews[s.id] ?? []).slice(-TILE_PREVIEW_LINES);
        previewLines = tail;
        previewSource = tail.length > 0 ? "scrollback" : "empty";
      }

      return {
        id: s.id,
        title: s.title,
        directory: s.directory ?? null,
        command: s.command ?? null,
        tags: tags[s.id] ?? [],
        state,
        seenAt: seenAt[s.id] ?? s.createdAt,
        previewLines,
        previewSource,
        isActive: s.id === activeId,
        agentKind,
        agentSessionShort,
        agentModel: transcript?.model ?? null,
      };
    });
  });

  const counts = createMemo(() => {
    const tiles = allTiles();
    const inbox = new Set(app.inboxSessionIds());
    return {
      all: tiles.length,
      active: tiles.filter((t) => t.state === "working").length,
      attention: tiles.filter((t) => inbox.has(t.id)).length,
      recent: tiles.length,
    };
  });

  const filteredByTab = createMemo<TileData[]>(() => {
    const tab = filter();
    const tiles = allTiles();
    const inbox = new Set(app.inboxSessionIds());
    switch (tab) {
      case "active":
        return tiles.filter((t) => t.state === "working");
      case "attention":
        return tiles.filter((t) => inbox.has(t.id));
      case "recent":
        return [...tiles].sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0));
      default:
        return tiles;
    }
  });

  const searched = createMemo<TileData[]>(() => {
    const q = app.commandQuery().trim().toLowerCase();
    const tiles = filteredByTab();
    if (!q) return tiles;
    return tiles.filter((t) => {
      const haystack = [
        t.title,
        t.directory ?? "",
        t.command ?? "",
        t.tags.join(" "),
        t.previewLines.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  // Partition into "Needs Attention" + "Recently Updated"
  const sections = createMemo(() => {
    const tiles = searched();
    const inbox = new Set(app.inboxSessionIds());
    const attention = tiles.filter((t) => inbox.has(t.id));
    const other = tiles
      .filter((t) => !inbox.has(t.id))
      .sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0));
    return { attention, other };
  });

  // Flattened order for keyboard navigation
  const flatOrder = createMemo<string[]>(() => {
    const { attention, other } = sections();
    return [...attention.map((t) => t.id), ...other.map((t) => t.id)];
  });

  const close = () => {
    app.setShowCommandPalette(false);
    app.setCommandQuery("");
  };

  const selectIdx = (idx: number) => {
    const order = flatOrder();
    const id = order[idx];
    if (!id) return;
    app.selectSession(id);
    close();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const order = flatOrder();
    if (order.length === 0) return;

    // Cmd+number jumps
    if (e.metaKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const idx = parseInt(e.key, 10) - 1;
      if (idx < order.length) selectIdx(idx);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      selectIdx(app.switcherIndex());
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      app.setSwitcherIndex((i) => Math.min(order.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      app.setSwitcherIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const cols = currentColumns();
      app.setSwitcherIndex((i) => Math.min(order.length - 1, i + cols));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const cols = currentColumns();
      app.setSwitcherIndex((i) => Math.max(0, i - cols));
      return;
    }
  };

  // Cheap reactive lookup of how many columns the grid currently renders.
  // We compute it off window width rather than measuring DOM each keystroke.
  const currentColumns = () => {
    const w = window.innerWidth;
    if (w > 1700) return 5;
    if (w > 1400) return 4;
    if (w > 1100) return 3;
    return 2;
  };

  return (
    <Show when={app.showCommandPalette() && app.commandPaletteMode() === "switcher"}>
      <div class="switcher-overlay" onClick={close}>
        <div class="switcher-modal" onClick={(e) => e.stopPropagation()}>
          {/* Header: search + keyboard hints */}
          <div class="switcher-header">
            <div class="switcher-search">
              <svg
                class="switcher-search-icon"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                ref={(el) => (inputRef = el)}
                class="switcher-search-input"
                placeholder="Jump to a session, agent, tag, or command…"
                spellcheck={false}
                value={app.commandQuery()}
                onInput={(e) => {
                  app.setCommandQuery(e.currentTarget.value);
                  app.setSwitcherIndex(0);
                }}
                onKeyDown={onKeyDown}
              />
            </div>
            <div class="switcher-hints">
              <span class="switcher-hint">
                <kbd>↑</kbd>
                <kbd>↓</kbd> Navigate
              </span>
              <span class="switcher-hint">
                <kbd>⏎</kbd> Open
              </span>
              <span class="switcher-hint">
                <kbd>⌘1–9</kbd> Jump
              </span>
              <span class="switcher-hint">
                <kbd>⌘⇧K</kbd> Commands
              </span>
            </div>
          </div>

          {/* Filter tabs + sort controls */}
          <div class="switcher-toolbar">
            <div class="switcher-tabs">
              <TabPill
                label="All Sessions"
                count={counts().all}
                active={filter() === "all"}
                onClick={() => {
                  setFilter("all");
                  app.setSwitcherIndex(0);
                }}
              />
              <TabPill
                label="Active"
                count={counts().active}
                active={filter() === "active"}
                tone="active"
                onClick={() => {
                  setFilter("active");
                  app.setSwitcherIndex(0);
                }}
              />
              <TabPill
                label="Needs Attention"
                count={counts().attention}
                active={filter() === "attention"}
                tone="attention"
                onClick={() => {
                  setFilter("attention");
                  app.setSwitcherIndex(0);
                }}
              />
              <TabPill
                label="Recent"
                count={counts().recent}
                active={filter() === "recent"}
                onClick={() => {
                  setFilter("recent");
                  app.setSwitcherIndex(0);
                }}
              />
            </div>
            <div class="switcher-controls">
              <span class="switcher-meta">
                {counts().all} sessions
                <Show when={counts().active > 0}>
                  <span class="switcher-meta-dim"> · {counts().active} active</span>
                </Show>
              </span>
            </div>
          </div>

          {/* Grid sections */}
          <div class="switcher-body">
            <Show when={sections().attention.length > 0}>
              <SwitcherSection
                title="Needs Attention"
                count={sections().attention.length}
                tone="attention"
              >
                <For each={sections().attention}>
                  {(tile) => (
                    <SessionTile
                      tile={tile}
                      indexInFlat={flatOrder().indexOf(tile.id)}
                      focusedIndex={app.switcherIndex()}
                      onClick={() => {
                        app.setSwitcherIndex(flatOrder().indexOf(tile.id));
                        selectIdx(flatOrder().indexOf(tile.id));
                      }}
                      onHover={() =>
                        app.setSwitcherIndex(flatOrder().indexOf(tile.id))
                      }
                    />
                  )}
                </For>
              </SwitcherSection>
            </Show>

            <Show when={sections().other.length > 0}>
              <SwitcherSection
                title={filter() === "recent" ? "Recently Updated" : "All Sessions"}
                count={sections().other.length}
              >
                <For each={sections().other}>
                  {(tile) => (
                    <SessionTile
                      tile={tile}
                      indexInFlat={flatOrder().indexOf(tile.id)}
                      focusedIndex={app.switcherIndex()}
                      onClick={() => {
                        app.setSwitcherIndex(flatOrder().indexOf(tile.id));
                        selectIdx(flatOrder().indexOf(tile.id));
                      }}
                      onHover={() =>
                        app.setSwitcherIndex(flatOrder().indexOf(tile.id))
                      }
                    />
                  )}
                </For>
              </SwitcherSection>
            </Show>

            <Show when={flatOrder().length === 0}>
              <div class="switcher-empty">
                <span>No sessions match "{app.commandQuery()}"</span>
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="switcher-footer">
            <div class="switcher-footer-hints">
              <kbd>↑</kbd>
              <kbd>↓</kbd>
              <kbd>←</kbd>
              <kbd>→</kbd>
              <span>navigate</span>
              <span class="switcher-footer-sep">·</span>
              <kbd>⏎</kbd>
              <span>open</span>
              <span class="switcher-footer-sep">·</span>
              <kbd>esc</kbd>
              <span>close</span>
            </div>
            <div class="switcher-footer-stats">
              {counts().all} sessions
              <Show when={counts().attention > 0}>
                <span class="switcher-footer-attention">
                  {" "}
                  · {counts().attention} need attention
                </span>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

function TabPill(props: {
  label: string;
  count: number;
  active: boolean;
  tone?: "active" | "attention";
  onClick: () => void;
}) {
  return (
    <button
      class={`switcher-tab ${props.active ? "active" : ""} ${
        props.tone ? `tone-${props.tone}` : ""
      }`}
      onClick={props.onClick}
    >
      <span class="switcher-tab-label">{props.label}</span>
      <span class="switcher-tab-count">{props.count}</span>
    </button>
  );
}

function SwitcherSection(props: {
  title: string;
  count: number;
  tone?: "attention";
  children: any;
}) {
  return (
    <div class="switcher-section">
      <div class="switcher-section-header">
        <Show when={props.tone === "attention"}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="switcher-section-icon attention"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </Show>
        <span class="switcher-section-title">{props.title}</span>
        <span class="switcher-section-count">{props.count}</span>
      </div>
      <div class="switcher-grid">{props.children}</div>
    </div>
  );
}

function SessionTile(props: {
  tile: TileData;
  indexInFlat: number;
  focusedIndex: number;
  onClick: () => void;
  onHover: () => void;
}) {
  const focused = () => props.indexInFlat === props.focusedIndex;
  const stateLabel = () => {
    if (props.tile.state === "working") return "Active";
    if (props.tile.state === "idle") return "Waiting";
    return "Idle";
  };
  const stateTone = () => {
    if (props.tile.state === "working") return "active";
    if (props.tile.state === "idle") return "waiting";
    return "idle";
  };
  const breadcrumb = () => {
    const parts = props.tile.tags.slice(0, 3);
    return parts.length > 0 ? parts.join(" · ") : "untagged";
  };

  return (
    <button
      class={`switcher-tile tone-${stateTone()} ${focused() ? "focused" : ""} ${
        props.tile.isActive ? "is-active-session" : ""
      }`}
      onClick={props.onClick}
      onPointerEnter={props.onHover}
    >
      {/* Top row: title + status pill */}
      <div class="switcher-tile-top">
        <span class="switcher-tile-title" title={props.tile.title}>
          {props.tile.title}
        </span>
        <span class={`switcher-tile-pill tone-${stateTone()}`}>
          <span class="switcher-tile-pill-dot" />
          {stateLabel()}
        </span>
      </div>

      {/* Tag breadcrumb */}
      <div class="switcher-tile-tags">{breadcrumb()}</div>

      {/* Agent + model */}
      <Show when={props.tile.agentKind}>
        <div class="switcher-tile-agent">
          <span
            class={`switcher-tile-agent-avatar kind-${props.tile.agentKind}`}
          >
            {props.tile.agentKind === "claude" ? "C" : "Cx"}
          </span>
          <span class="switcher-tile-agent-name">
            {props.tile.agentKind === "claude" ? "Claude Code" : "Codex"}
            <Show when={props.tile.agentModel}>
              <span class="switcher-tile-agent-sep"> · </span>
              <span class="switcher-tile-agent-id">{props.tile.agentModel}</span>
            </Show>
            <Show when={props.tile.agentSessionShort}>
              <span class="switcher-tile-agent-sep"> · </span>
              <span class="switcher-tile-agent-id">
                {props.tile.agentSessionShort}
              </span>
            </Show>
          </span>
        </div>
      </Show>

      {/* Directory */}
      <Show when={props.tile.directory}>
        <div class="switcher-tile-dir" title={props.tile.directory!}>
          {props.tile.directory}
        </div>
      </Show>

      {/* Command */}
      <Show when={props.tile.command}>
        <div class="switcher-tile-cmd" title={props.tile.command!}>
          {props.tile.command}
        </div>
      </Show>

      {/* Output preview — agent transcript when available, scrollback otherwise */}
      <div class={`switcher-tile-preview source-${props.tile.previewSource}`}>
        <div class="switcher-tile-preview-label">
          {props.tile.previewSource === "transcript"
            ? "Last reply"
            : props.tile.previewSource === "scrollback"
            ? "Terminal tail"
            : ""}
        </div>
        <div class="switcher-tile-preview-body">
          <Show
            when={props.tile.previewLines.length > 0}
            fallback={<div class="switcher-tile-preview-empty">no recent output</div>}
          >
            <For each={props.tile.previewLines}>
              {(line) => (
                <div
                  class={`switcher-tile-preview-line line-${classifyPreviewLine(line)} ${
                    props.tile.previewSource === "transcript" ? "is-transcript" : ""
                  }`}
                >
                  {line || " "}
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>

      {/* Footer: updated time + sparkline stub + duration */}
      <div class="switcher-tile-footer">
        <span class={`switcher-tile-updated tone-${stateTone()}`}>
          updated {formatAgo(props.tile.seenAt)}
        </span>
        <span class="switcher-tile-spark" aria-hidden="true">
          {/* TODO: real bytes/sec sparkline once we sample pty output */}
          <span style={{ height: "35%" }} />
          <span style={{ height: "50%" }} />
          <span style={{ height: "40%" }} />
          <span style={{ height: "60%" }} />
          <span style={{ height: "45%" }} />
          <span style={{ height: "55%" }} />
          <span style={{ height: "40%" }} />
        </span>
      </div>
    </button>
  );
}
