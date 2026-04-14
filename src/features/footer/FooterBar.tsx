import { For, Show, createMemo } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";
import type { ClipboardHistoryEntry, PasteQueueItem } from "../../app/types";

type UnifiedClipEntry = {
  key: string;
  id: number | null;
  kind: "text" | "image" | "recording";
  source: string;
  text: string | null;
  imagePath: string | null;
  filename: string | null;
  byteLen: number | null;
  createdAt: number; // unix seconds
  original: "history" | "queue";
  queueItem?: PasteQueueItem;
};

function formatBytes(n: number | null): string {
  if (n === null || n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(createdAtSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - createdAtSec);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function textPreview(text: string | null): string {
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 300 ? collapsed.slice(0, 300) + "…" : collapsed;
}

function entryPreview(entry: UnifiedClipEntry): string {
  if (entry.kind === "image") {
    const size = formatBytes(entry.byteLen);
    return size ? `Image · ${size}` : "Image";
  }
  if (entry.kind === "recording") {
    return entry.filename ? `Recording · ${entry.filename}` : "Recording";
  }
  return textPreview(entry.text);
}

function kindGlyph(kind: UnifiedClipEntry["kind"]): string {
  if (kind === "image") return "🖼";
  if (kind === "recording") return "🎬";
  return "•";
}

function historyToUnified(entry: ClipboardHistoryEntry): UnifiedClipEntry {
  return {
    key: `h-${entry.id}`,
    id: entry.id,
    kind: entry.kind,
    source: entry.sourceApp?.trim() || "—",
    text: entry.text,
    imagePath: entry.imagePath,
    filename: entry.imagePath ? entry.imagePath.split("/").pop() ?? null : null,
    byteLen: entry.byteLen,
    createdAt: entry.createdAt,
    original: "history",
  };
}

function queueToUnified(item: PasteQueueItem, index: number, nowSec: number): UnifiedClipEntry {
  // Queue items have no timestamp; synthesize one just after the most-recent
  // history entry so they float to the top in creation order.
  return {
    key: `q-${item.path}`,
    id: null,
    kind: item.kind,
    source: "Butter",
    text: null,
    imagePath: item.kind === "image" ? item.path : null,
    filename: item.filename,
    byteLen: null,
    createdAt: nowSec + (1000 - index), // newest queue item first
    original: "queue",
    queueItem: item,
  };
}

export function FooterBar() {
  const app = useAppContext();

  const recordingState = createMemo(() => app.recordingState());
  const recordingLabel = createMemo(() => {
    const state = recordingState();
    if (state === "recording") return "Stop";
    if (state === "processing") return "Transcribing";
    if (state === "error") return "Retry";
    return "Record";
  });
  const recordingTitle = createMemo(() => {
    const error = app.recordingError();
    if (error) return error;
    const state = recordingState();
    if (state === "recording") return "Stop recording";
    if (state === "processing") return "Processing recording";
    return "Start screen + mic recording";
  });

  const unifiedEntries = createMemo<UnifiedClipEntry[]>(() => {
    const now = Math.floor(Date.now() / 1000);
    const queue = app.pasteQueue().map((item, i) => queueToUnified(item, i, now));
    const history = app.clipboardHistory().map(historyToUnified);
    const merged = [...queue, ...history];
    merged.sort((a, b) => b.createdAt - a.createdAt);
    // De-duplicate by filename for images that appear both in queue and history
    // (queue wins because it carries paste-specific metadata).
    const seen = new Set<string>();
    const deduped: UnifiedClipEntry[] = [];
    for (const entry of merged) {
      const dedupKey =
        entry.kind === "image" && entry.filename
          ? `img:${entry.filename}`
          : entry.key;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      deduped.push(entry);
    }
    return deduped;
  });

  const filteredEntries = createMemo<UnifiedClipEntry[]>(() => {
    const q = app.clipboardHistoryQuery().trim().toLowerCase();
    const list = unifiedEntries();
    if (!q) return list;
    return list.filter((entry) => {
      const body = (entry.text ?? entry.imagePath ?? entry.filename ?? "").toLowerCase();
      return body.includes(q) || entry.source.toLowerCase().includes(q);
    });
  });

  const latestEntry = () => unifiedEntries()[0] ?? null;
  const totalCount = () => unifiedEntries().length;
  const selectionCount = () => {
    const selected = app.clipboardHistorySelected();
    const filteredIds = new Set(
      filteredEntries()
        .map((e) => e.id)
        .filter((id): id is number => id !== null)
    );
    let n = 0;
    selected.forEach((id) => {
      if (filteredIds.has(id)) n++;
    });
    return n;
  };

  const toggleEntrySelection = (entry: UnifiedClipEntry) => {
    if (entry.id === null) return; // queue-only items can't be multi-selected yet
    app.toggleClipboardHistorySelection(entry.id);
  };

  const onCopyClick = async () => {
    await app.copyFromClipboardHistory();
  };

  const onRowPrimaryClick = (entry: UnifiedClipEntry) => {
    if (entry.original === "queue" && entry.queueItem) {
      // Preserve existing Recent Media behaviors for queue items.
      if (entry.kind === "image") {
        const sessionId = app.activeSessionId();
        if (sessionId) {
          void app.writeImagePathToSession(sessionId, entry.queueItem.path, "queue");
        }
        return;
      }
      if (entry.kind === "recording") {
        void app.openPathExternally(entry.queueItem.path);
        return;
      }
    }
    // History entry: clicking toggles selection.
    toggleEntrySelection(entry);
  };

  const chipThumbItem = () => {
    const latest = latestEntry();
    if (!latest) return null;
    if (latest.kind === "image" && latest.original === "queue" && latest.queueItem?.url) {
      return { url: latest.queueItem.url, filename: latest.queueItem.filename };
    }
    return null;
  };

  return (
    <div class="butter-web-footer">
      <div class="butter-web-footer-sidebar" style={{ width: `${app.sidebarWidth()}px` }}>
        <div
          class={`butter-web-paste-dock ${app.showClipboardDrawer() ? "open" : ""}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="butter-web-paste-dock-row">
            <button
              class={`butter-web-recorder-chip ${recordingState()}`}
              type="button"
              disabled={recordingState() === "processing"}
              title={recordingTitle()}
              onClick={() => {
                if (recordingState() === "recording") {
                  void app.stopScreenRecording();
                } else {
                  void app.startScreenRecording();
                }
              }}
            >
              <span class="butter-web-recorder-dot" />
              <span class="butter-web-recorder-label">{recordingLabel()}</span>
            </button>
            <button
              class={`butter-web-image-chip ${app.showClipboardDrawer() ? "open" : ""}`}
              type="button"
              aria-expanded={app.showClipboardDrawer()}
              onClick={() => void app.toggleClipboardDrawer()}
              title={app.showClipboardDrawer() ? "Hide clipboard" : "Show clipboard"}
            >
              <Show
                when={chipThumbItem()}
                fallback={
                  <div class="butter-web-image-chip-thumb-fallback">
                    {latestEntry()?.kind === "recording"
                      ? "REC"
                      : latestEntry()?.kind === "image"
                      ? "IMG"
                      : "📋"}
                  </div>
                }
              >
                {(thumb) => (
                  <img
                    class="butter-web-image-chip-thumb"
                    src={thumb().url}
                    alt={thumb().filename}
                  />
                )}
              </Show>
              <Show when={totalCount() > 0}>
                <span class="butter-web-image-chip-badge">{totalCount()}</span>
              </Show>
            </button>
          </div>
          <Show when={app.showClipboardDrawer()}>
            <div class="butter-web-paste-queue clip-drawer">
              <div class="clip-drawer-header">
                <input
                  class="clip-drawer-search"
                  placeholder="Search…"
                  value={app.clipboardHistoryQuery()}
                  spellcheck={false}
                  ref={(el) => app.setClipboardHistoryInputRef(el || undefined)}
                  onInput={(e) => {
                    app.setClipboardHistoryQuery(e.currentTarget.value);
                    app.setClipboardHistoryIndex(0);
                  }}
                />
                <Show when={selectionCount() > 0}>
                  <button
                    class="clip-drawer-copy"
                    type="button"
                    onClick={onCopyClick}
                    title="Copy selected entries merged with source labels"
                  >
                    Copy ({selectionCount()})
                  </button>
                </Show>
                <button
                  class="clip-drawer-clear"
                  type="button"
                  title="Close"
                  onClick={() => app.closeClipboardDrawer()}
                >
                  ×
                </button>
              </div>
              <Show
                when={filteredEntries().length > 0}
                fallback={
                  <div class="clip-drawer-empty">
                    <div class="clip-drawer-empty-glyph">📋</div>
                    <div>
                      {totalCount() === 0
                        ? "No clipboard history yet."
                        : "No matches"}
                    </div>
                  </div>
                }
              >
                <div class="clip-drawer-list">
                  <For each={filteredEntries()}>
                    {(entry, index) => {
                      const selected = () =>
                        entry.id !== null && app.clipboardHistorySelected().has(entry.id);
                      const active = () => index() === app.clipboardHistoryIndex();
                      return (
                        <div
                          class={`clip-row ${active() ? "active" : ""} ${selected() ? "selected" : ""} ${entry.original === "queue" ? "queue-item" : ""}`}
                          onMouseEnter={(e) => {
                            if (
                              entry.original === "queue" &&
                              entry.kind === "image" &&
                              entry.queueItem
                            ) {
                              void app.showPasteHover(entry.queueItem, e.currentTarget);
                            }
                          }}
                          onMouseMove={(e) => {
                            if (
                              entry.original === "queue" &&
                              entry.kind === "image" &&
                              entry.queueItem &&
                              app.pasteHover()
                            ) {
                              app.setPasteHoverPosition(entry.queueItem, e.currentTarget);
                            }
                          }}
                          onMouseLeave={() => app.setPasteHover(null)}
                        >
                          <button
                            class="clip-row-main"
                            type="button"
                            onClick={() => onRowPrimaryClick(entry)}
                          >
                            <span class="clip-row-glyph">{kindGlyph(entry.kind)}</span>
                            <span class="clip-row-source">{entry.source}</span>
                            <span class="clip-row-preview">{entryPreview(entry)}</span>
                            <span class="clip-row-age">{formatAge(entry.createdAt)}</span>
                            <span class="clip-row-check">{selected() ? "✓" : ""}</span>
                          </button>
                          <Show when={entry.kind === "image" && entry.queueItem}>
                            <button
                              class="clip-row-action"
                              type="button"
                              title="Edit image"
                              onClick={(e) => {
                                e.stopPropagation();
                                app.openImageEditor(
                                  entry.queueItem!.path,
                                  entry.queueItem!.filename
                                );
                              }}
                            >
                              ✎
                            </button>
                          </Show>
                          <Show when={entry.kind === "recording" && entry.queueItem}>
                            <button
                              class="clip-row-action"
                              type="button"
                              title="Copy path"
                              onClick={(e) => {
                                e.stopPropagation();
                                void app.copyPathToClipboard(entry.queueItem!.path);
                              }}
                            >
                              ⧉
                            </button>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
              <div class="clip-drawer-footer">
                <span class="clip-drawer-hint">
                  click to select · ↵ copy · ⌘A all · ⌘⌫ delete
                </span>
                <span class="clip-drawer-count">
                  {totalCount()} {totalCount() === 1 ? "item" : "items"}
                </span>
                <Show when={totalCount() > 0}>
                  <button
                    class="clip-drawer-clear-all"
                    type="button"
                    title="Clear all clipboard history"
                    onClick={() => void app.clearClipboardHistory()}
                  >
                    Clear
                  </button>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </div>
      <div class="butter-web-footer-main">
        <Show when={app.shouldShowFooterPresetMenu()}>
          <div class="butter-web-footer-preset-group" onClick={(e) => e.stopPropagation()}>
            <button
              class="butter-web-footer-preset-main"
              onClick={() => app.setFooterPresetMenuOpen(false)}
            >
              {app.resolvedFooterPreset()?.name || "Preset"}
            </button>
            <button
              class="butter-web-new-toggle butter-web-footer-preset-toggle"
              onClick={(e) => {
                e.stopPropagation();
                app.setFooterPresetMenuOpen((prev) => !prev);
              }}
            >
              <span class={`butter-web-new-caret ${app.footerPresetMenuOpen() ? "open" : ""}`}>
                ▾
              </span>
            </button>
            <Show when={app.footerPresetMenuOpen()}>
              <div class="butter-web-new-menu butter-web-footer-preset-menu" onClick={(e) => e.stopPropagation()}>
                <div class="butter-web-new-menu-header">
                  <span>Footer Presets</span>
                </div>
                <For each={app.footerPresets()}>
                  {(preset) => (
                    <div class="butter-web-new-menu-row" style={{ position: "relative" }}>
                      <button
                        class={`butter-web-new-menu-item ${
                          app.resolvedFooterPreset()?.id === preset.id ? "active" : ""
                        }`}
                        onClick={() => {
                          app.setFooterPresetSelection(preset.id);
                          app.setFooterPresetMenuOpen(false);
                        }}
                      >
                        <div class="butter-web-new-menu-name">{preset.name}</div>
                        <Show when={preset.directory || preset.command}>
                          <div class="butter-web-new-menu-sub">
                            {preset.directory ? preset.directory : preset.command}
                          </div>
                        </Show>
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
        <input
          class="butter-web-footer-input"
          placeholder={app.footerPlaceholder()}
          value={app.footerInput()}
          disabled={!app.footerInputEnabled()}
          spellcheck={false}
          onInput={(e) => app.setFooterInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              app.sendFooterInput();
            }
          }}
        />
      </div>
      <Show when={app.safePasteHover()}>
        {(hover) => (
          <div
            class="butter-web-paste-queue-preview-floating"
            style={{
              left: `${hover().x}px`,
              bottom: "60px",
            }}
          >
            <img src={hover().url} alt={hover().name} />
            <div class="butter-web-paste-queue-preview-label">{hover().name}</div>
          </div>
        )}
      </Show>
    </div>
  );
}
