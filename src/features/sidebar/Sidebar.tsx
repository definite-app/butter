import { For, Show, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";
import { useAppContext } from "../../app/context/AppContext";
import type { DbSession, SessionAgentInfo } from "../../app/types";
import { buildAgentResumeCommand } from "../../utils/agentResume";

export function Sidebar() {
  const app = useAppContext();
  const isRecentView = () => app.sidebarSessionView() === "recent";
  const isFoldersView = () => app.sidebarSessionView() === "folders";
  const isClosedView = () => app.sidebarSessionView() === "closed";
  const isInboxView = () => app.sidebarSessionView() === "inbox";
  type MetadataField = {
    key: string;
    value: string;
    copyable?: boolean;
    copyLabel?: string;
  };
  type MetadataPopoverState = {
    tokenPrefix: string;
    title: string;
    fields: MetadataField[];
    left: number;
    top: number;
  };
  const [copiedFieldToken, setCopiedFieldToken] = createSignal<string | null>(null);
  const [metadataPopover, setMetadataPopover] = createSignal<MetadataPopoverState | null>(null);
  const [inboxPreview, setInboxPreview] = createSignal<{
    sessionId: string;
    lines: string[];
    left: number;
    top: number;
  } | null>(null);
  let inboxPreviewHideTimer: ReturnType<typeof setTimeout> | null = null;
  let copiedFieldTimer: ReturnType<typeof setTimeout> | null = null;
  let metadataHideTimer: ReturnType<typeof setTimeout> | null = null;

  onCleanup(() => {
    if (copiedFieldTimer) {
      clearTimeout(copiedFieldTimer);
    }
    if (metadataHideTimer) {
      clearTimeout(metadataHideTimer);
    }
    if (inboxPreviewHideTimer) {
      clearTimeout(inboxPreviewHideTimer);
    }
  });

  const showInboxPreview = (el: HTMLElement, sessionId: string) => {
    if (inboxPreviewHideTimer) {
      clearTimeout(inboxPreviewHideTimer);
      inboxPreviewHideTimer = null;
    }
    const preview = app.sessionPreview()[sessionId];
    if (!preview || preview.length === 0) return;
    // Show last 12 lines of output
    const lines = preview.slice(-12);
    const rect = el.getBoundingClientRect();
    const POPOVER_WIDTH = 400;
    const viewportPadding = 12;
    let left = rect.right + viewportPadding;
    if (left + POPOVER_WIDTH > window.innerWidth - viewportPadding) {
      left = Math.max(viewportPadding, rect.left - POPOVER_WIDTH - viewportPadding);
    }
    const top = Math.max(viewportPadding, rect.top);
    setInboxPreview({ sessionId, lines, left, top });
  };

  const hideInboxPreview = (delay = 120) => {
    if (inboxPreviewHideTimer) clearTimeout(inboxPreviewHideTimer);
    inboxPreviewHideTimer = setTimeout(() => {
      setInboxPreview(null);
    }, delay);
  };

  const formatOptional = (value: string | null | undefined): string => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : "(none)";
  };

  const formatAgoFromMillis = (value: number | null | undefined): string => {
    if (!value) return "(none)";
    const diffMs = Math.max(0, Date.now() - value);
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  };

  const boolLabel = (value: boolean): string => (value ? "true" : "false");

  const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

  // The same builder the reopen picker runs (recorded flags, else the launch
  // command's), so the copied command matches what a restart would type.
  const buildResumeCommand = (
    info: SessionAgentInfo | null,
    directory: string | null | undefined
  ): string | null => {
    if (!info?.agentSessionId?.trim()) return null;
    const resumeCommand = buildAgentResumeCommand(info);
    const cwd = directory?.trim();
    if (!cwd) return resumeCommand;
    return `cd ${shellQuote(cwd)} && ${resumeCommand}`;
  };

  // A Claude conversation id from the hook log, when no agent snapshot has one.
  const hookResumeInfo = (
    agentSessionId: string | null | undefined,
    command: string | null | undefined
  ): SessionAgentInfo | null =>
    agentSessionId
      ? { kind: "claude", agentSessionId, cwd: null, lastSeenAt: 0, command: command ?? null }
      : null;

  const markCopied = (token: string) => {
    setCopiedFieldToken(token);
    if (copiedFieldTimer) {
      clearTimeout(copiedFieldTimer);
    }
    copiedFieldTimer = setTimeout(() => {
      setCopiedFieldToken(null);
    }, 1400);
  };

  const copyMetadataField = async (token: string, value: string) => {
    if (!value || value === "(none)") return;
    try {
      await app.copyPathToClipboard(value);
      markCopied(token);
    } catch (err) {
      console.warn("[sidebar] failed to copy metadata field", err);
    }
  };

  const clearMetadataHideTimer = () => {
    if (metadataHideTimer) {
      clearTimeout(metadataHideTimer);
      metadataHideTimer = null;
    }
  };

  const scheduleMetadataPopoverHide = (delay = 110) => {
    clearMetadataHideTimer();
    metadataHideTimer = setTimeout(() => {
      setMetadataPopover(null);
    }, delay);
  };

  const openMetadataPopover = (
    anchorEl: HTMLElement,
    tokenPrefix: string,
    title: string,
    fields: MetadataField[]
  ) => {
    const POPOVER_WIDTH = 420;
    const POPOVER_MAX_HEIGHT = 286; // ~30% taller than prior 220px list
    const viewportPadding = 12;
    const rect = anchorEl.getBoundingClientRect();
    let left = rect.right + viewportPadding;
    if (left + POPOVER_WIDTH > window.innerWidth - viewportPadding) {
      left = Math.max(viewportPadding, rect.left - POPOVER_WIDTH - viewportPadding);
    }
    let top = rect.top + rect.height * 0.5 - POPOVER_MAX_HEIGHT * 0.5;
    const maxTop = Math.max(viewportPadding, window.innerHeight - POPOVER_MAX_HEIGHT - viewportPadding);
    top = Math.min(Math.max(top, viewportPadding), maxTop);
    setMetadataPopover({
      tokenPrefix,
      title,
      fields,
      left: Math.round(left),
      top: Math.round(top),
    });
    clearMetadataHideTimer();
  };

  const buildOpenSessionMetadata = (id: string): MetadataField[] => {
    const session = app.sessions.find((entry) => entry.id === id);
    if (!session) return [];
    const agentSessionId = app.agentSessionIdBySession()[id];
    const live = app.sessionAgentInfo()[id];
    const resumeInfo = live?.agentSessionId
      ? { ...live, command: session.command ?? null }
      : hookResumeInfo(agentSessionId, session.command);
    const resumeCommand = buildResumeCommand(resumeInfo, live?.cwd ?? session.directory);
    const tags = app.terminalTags()[id] || [];
    const seenAt = app.sessionSeenAt()[id];
    const ptyId = app.ptyBySession()[id];
    const previewLineCount = app.sessionPreview()[id]?.length ?? 0;
    const isActive = app.activeSessionId() === id;

    return [
      { key: "session_id", value: session.id },
      { key: "agent_session_id", value: formatOptional(agentSessionId) },
      {
        key: "resume",
        value: resumeCommand ?? "(none)",
        copyable: Boolean(resumeCommand),
        copyLabel: "Resume",
      },
      { key: "title", value: session.title },
      { key: "directory", value: formatOptional(session.directory) },
      { key: "command", value: formatOptional(session.command) },
      { key: "created_at", value: formatAgoFromMillis(session.createdAt), copyable: false },
      { key: "last_seen_at", value: formatAgoFromMillis(seenAt), copyable: false },
      { key: "pty_id", value: formatOptional(ptyId) },
      { key: "activity_state", value: app.getSessionState(id), copyable: false },
      { key: "tags_count", value: String(tags.length), copyable: false },
      { key: "tags", value: tags.length > 0 ? tags.join(", ") : "(none)" },
      { key: "preview_line_count", value: String(previewLineCount), copyable: false },
      { key: "is_active", value: boolLabel(isActive), copyable: false },
      { key: "is_closed", value: "false", copyable: false },
    ];
  };

  const buildClosedSessionMetadata = (session: DbSession): MetadataField[] => {
    const agentSessionId = app.agentSessionIdBySession()[session.id];
    const kind = session.agent_kind;
    const resumeInfo: SessionAgentInfo | null =
      (kind === "claude" || kind === "codex") && session.agent_session_id
        ? {
            kind,
            agentSessionId: session.agent_session_id,
            cwd: session.agent_cwd,
            lastSeenAt: session.agent_last_seen_at ?? 0,
            command: session.command,
            flags: session.agent_flags ?? null,
          }
        : hookResumeInfo(agentSessionId, session.command);
    const resumeCommand = buildResumeCommand(
      resumeInfo,
      session.agent_cwd ?? session.directory
    );
    return [
      { key: "session_id", value: session.id },
      { key: "agent_session_id", value: formatOptional(agentSessionId) },
      {
        key: "resume",
        value: resumeCommand ?? "(none)",
        copyable: Boolean(resumeCommand),
        copyLabel: "Resume",
      },
      { key: "title", value: session.title },
      { key: "directory", value: formatOptional(session.directory) },
      { key: "command", value: formatOptional(session.command) },
      { key: "created_at", value: formatAgoFromMillis(session.created_at * 1000), copyable: false },
      {
        key: "last_accessed_at",
        value: formatAgoFromMillis(session.last_accessed_at ? session.last_accessed_at * 1000 : null),
        copyable: false,
      },
      { key: "is_closed", value: boolLabel(session.is_closed), copyable: false },
      {
        key: "closed_at",
        value: formatAgoFromMillis(session.closed_at ? session.closed_at * 1000 : null),
        copyable: false,
      },
    ];
  };

  const renderSessionItem = (id: string, draggable = true) => {
    const session = app.sessions.find((entry) => entry.id === id);
    if (!session) return null;
    const isActive = () => app.activeSessionId() === id && !app.activeAppId();
    const extraTagCount = () => {
      const allTags = app.terminalTags()[id] || [];
      return allTags.length > 1 ? allTags.length - 1 : 0;
    };

    return (
      <div
        class={`butter-web-session has-metadata-hover ${isActive() ? "active" : ""} ${draggable && app.draggingSessionId() === id ? "dragging" : ""} ${draggable && app.dragOverSessionId() === id ? "drag-over" : ""}`}
        onClick={() => app.selectSession(id)}
        onDblClick={() => app.openRename(id)}
        onPointerDown={(e) => {
          if (draggable) {
            app.beginPointerDrag(id, e);
          }
        }}
        onPointerEnter={(e) => {
          openMetadataPopover(
            e.currentTarget as HTMLElement,
            `open:${id}`,
            "Session Metadata",
            buildOpenSessionMetadata(id)
          );
        }}
        onPointerLeave={() => scheduleMetadataPopoverHide()}
        onContextMenu={(e) => {
          e.preventDefault();
          app.setContextMenuFor({ id, x: e.clientX, y: e.clientY });
        }}
        data-session-id={id}
      >
        <div class="terminal-icon">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="4 17 10 11 4 5"></polyline>
            <line x1="12" y1="19" x2="20" y2="19"></line>
          </svg>
          {(() => {
            const state = app.getSessionState(id);
            if (state === "working") return <span class="activity-badge" />;
            if (state === "idle") return <span class="activity-badge awaiting" />;
            return null;
          })()}
        </div>
        <div class="session-content">
          <Show
            when={app.renamingSessionId() === id}
            fallback={
              <span class="terminal-title">{session.title}</span>
            }
          >
            <input
              class="sidebar-rename-input"
              ref={(el) => el && app.setRenameInputRef(el)}
              value={app.renameValue()}
              spellcheck={false}
              onClick={(e) => e.stopPropagation()}
              onInput={(e) => app.setRenameValue(e.currentTarget.value)}
              onBlur={() => app.closeRename(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  app.closeRename(true);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  app.closeRename(false);
                }
              }}
            />
          </Show>
        </div>
        <div class="session-tags" onClick={(e) => e.stopPropagation()}>
          <Show when={extraTagCount() > 0}>
            <span class="terminal-extra-tags">+{extraTagCount()}</span>
          </Show>
          <button
            class="session-close-btn"
            onClick={(e) => {
              e.stopPropagation();
              void app.closeSession(id);
            }}
            title="Terminate and close terminal"
          >
            ×
          </button>
        </div>
        <Show when={app.tagMenuOpenFor() === id}>
          <div class="tag-drawer" onClick={(e) => e.stopPropagation()}>
            <div class="tag-drawer-header">
              <span>Tags</span>
              <button
                class="tag-drawer-close"
                onClick={() => app.setTagMenuOpenFor(null)}
              >
                ×
              </button>
            </div>
            <div class="tag-drawer-input">
              <input
                class="tag-drawer-field"
                value={app.newTagName()}
                placeholder="Add tag..."
                spellcheck={false}
                onInput={(e) => app.setNewTagName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    app.createTagAndAssign(id);
                  }
                }}
              />
            </div>
            <div class="tag-drawer-list">
              <Show when={app.tagQuery() && !app.hasExactTagMatch()}>
                <button
                  class="tag-drawer-item create"
                  onClick={() => app.createTagAndAssign(id)}
                >
                  Create "{app.tagQuery()}"
                </button>
              </Show>
              <For each={app.matchingTags()}>
                {(tag) => {
                  const isTagActive = () =>
                    (app.terminalTags()[id] || []).includes(tag);
                  return (
                    <button
                      class={`tag-drawer-item ${isTagActive() ? "active" : ""}`}
                      onClick={() => app.toggleTagForTerminal(id, tag)}
                    >
                      <span>{tag}</span>
                      <span>{isTagActive() ? "✓" : ""}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>
      </div>
    );
  };

  return (
    <aside
      class="butter-web-sidebar"
      style={{ width: `${app.sidebarWidth()}px` }}
      onClick={() => {
        app.setTagMenuOpenFor(null);
        app.setShowPresetMenu(false);
        app.setShowFilterMenu(false);
        app.setContextMenuFor(null);
        app.setSidebarContextMenu(null);
        app.setCanvasContextMenu(null);
        app.setFolderContextMenu(null);
        setMetadataPopover(null);
      }}
    >
      <div class="butter-web-header">
        {/* All action buttons in one unified group */}
        <div class="header-actions" onClick={(e) => e.stopPropagation()}>
          <button
            class="header-action-btn"
            onClick={() => app.hideSidebar()}
            title="Hide Sidebar"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M10.5 3.5L5.5 8l5 4.5" />
            </svg>
          </button>
          <button
            class={`header-action-btn ${isFoldersView() ? "active" : ""}`}
            onClick={() => app.setSidebarSessionViewMode("folders")}
            title="Tagged view"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M2.5 4.5h4l1.2 1.2h5.8v6.3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1z" />
              <path d="M2.5 4.5v-1a1 1 0 0 1 1-1h2.8l1.2 1.2h3.2" />
            </svg>
          </button>
          <button
            class={`header-action-btn ${isRecentView() ? "active" : ""}`}
            onClick={() => app.setSidebarSessionViewMode("recent")}
            title="Recent view"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="8" cy="8" r="5.5" />
              <path d="M8 4.8v3.6l2.2 1.3" />
            </svg>
          </button>
          <button
            class={`header-action-btn ${isClosedView() ? "active" : ""}`}
            onClick={() => app.setSidebarSessionViewMode("closed")}
            title="Show recently closed terminals"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3.2 8a4.8 4.8 0 1 0 1.6-3.6" />
              <path d="M2.6 3.4v2.7h2.7" />
            </svg>
          </button>
          <button
            class={`header-action-btn ${isInboxView() ? "active" : ""}`}
            onClick={() => app.setSidebarSessionViewMode("inbox")}
            title="Inbox — terminals waiting for input"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M2.5 9.5h3.2l1 1.5h2.6l1-1.5h3.2" />
              <path d="M3.8 4.2l-1.3 5.3v3h11v-3l-1.3-5.3a1 1 0 0 0-1-.7H4.8a1 1 0 0 0-1 .7z" />
            </svg>
            <Show when={app.inboxSessionIds().length > 0}>
              <span class="inbox-badge">{app.inboxSessionIds().length}</span>
            </Show>
          </button>
        </div>

        <div class="butter-web-new-group" onClick={(e) => e.stopPropagation()}>
          <button
            class="butter-web-new-main"
            onClick={() => {
              app.setShowPresetMenu(false);
              app.createSession();
            }}
          >
            New
          </button>
          <button
            class="butter-web-new-toggle"
            onClick={(e) => {
              e.stopPropagation();
              app.setShowPresetMenu((prev) => !prev);
            }}
          >
            <span class={`butter-web-new-caret ${app.showPresetMenu() ? "open" : ""}`}>
              ▾
            </span>
          </button>
          <Show when={app.showPresetMenu()}>
            <div class="butter-web-new-menu" onClick={(e) => e.stopPropagation()}>
              <div class="butter-web-new-menu-header">
                <span>Presets</span>
                <button
                  class="butter-web-new-menu-add"
                  onClick={() => app.openPresetEditor()}
                >
                  +
                </button>
              </div>
              <Show when={app.presets().length === 0}>
                <div class="butter-web-new-menu-empty">No presets yet</div>
              </Show>
              <For each={app.presets()}>
                {(preset) => (
                  <div class="butter-web-new-menu-row" style={{ position: "relative" }}>
                    <button
                      class="butter-web-new-menu-item"
                      onClick={() => {
                        app.setShowPresetMenu(false);
                        void app.launchPresetSession(preset);
                      }}
                    >
                      <div class="butter-web-new-menu-name">{preset.name}</div>
                      <Show when={preset.directory || preset.command}>
                        <div class="butter-web-new-menu-sub">
                          {preset.directory ? preset.directory : preset.command}
                        </div>
                      </Show>
                    </button>
                    <button
                      class="butter-web-new-menu-edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        app.openPresetEditor(preset);
                      }}
                    >
                      ✎
                    </button>
                  </div>
                )}
              </For>
              <div class="butter-web-new-menu-footer">
                <button
                  class="butter-web-new-menu-config"
                  onClick={async () => {
                    app.setShowPresetMenu(false);
                    const path = await invoke<string>("get_config_path");
                    await Command.create("open", [path]).execute();
                  }}
                >
                  Edit in config.toml
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>
      <Show when={app.browserConfig().apps.length > 0}>
        <div class="sidebar-apps" onClick={(e) => e.stopPropagation()}>
          <div class="sidebar-apps-label">Apps</div>
          <For each={app.browserConfig().apps}>
            {(entry) => {
              const isActive = () => app.activeAppId() === entry.id;
              const isLoaded = () => app.browserSessions()[`app:${entry.id}`]?.open ?? false;
              const profile = () => app.browserProfileFor(entry.profile);
              return (
                <button
                  type="button"
                  class={`sidebar-app ${isActive() ? "active" : ""}`}
                  title={`${entry.name} · ${entry.url} · profile: ${profile().name}`}
                  onClick={() => (isActive() ? app.closeActiveApp() : void app.openApp(entry.id))}
                >
                  <span class="sidebar-app-icon" aria-hidden="true">
                    {entry.name.trim().charAt(0).toUpperCase() || "•"}
                  </span>
                  <span class="sidebar-app-name">{entry.name}</span>
                  <Show when={entry.profile !== "default"}>
                    <span class="butter-profile-dot" style={{ background: profile().color }} />
                  </Show>
                  <Show when={isLoaded() && !isActive()}>
                    <span class="sidebar-app-loaded" title="Loaded in the background" />
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <div
        class={`butter-web-session-list ${app.draggingSessionId() ? "dragging" : ""}`}
        onScroll={() => setMetadataPopover(null)}
        onContextMenu={(e) => {
          const target = e.target as HTMLElement;
          if (!target.closest(".butter-web-session") && !target.closest(".session-folder-header")) {
            e.preventDefault();
            app.setContextMenuFor(null);
            app.setFolderContextMenu(null);
            app.setCanvasContextMenu(null);
            app.setSidebarContextMenu({ x: e.clientX, y: e.clientY });
          }
        }}
        onPointerMove={(e) => {
          if (app.sidebarSessionView() !== "folders") return;
          const sourceId = app.draggingSessionId();
          if (!sourceId) return;
          const target = (e.target as HTMLElement | null)?.closest<HTMLElement>(
            ".butter-web-session"
          );
          const targetId = target?.dataset.sessionId || null;
          if (!targetId || targetId === sourceId) {
            app.setDragOverSessionId(null);
            return;
          }
          const sourceTags = app.terminalTags()[sourceId] || [];
          const targetTags = app.terminalTags()[targetId] || [];
          const sourceFolder = sourceTags[0] || "__untagged__";
          const targetFolder = targetTags[0] || "__untagged__";
          if (sourceFolder === targetFolder) {
            app.reorderSessions(sourceId, targetId);
            app.setDragOverSessionId(targetId);
          }
        }}
      >
        <Show when={isRecentView()}>
          <div class="recent-session-list">
            <For each={app.recentSessionIds()}>
              {(id) => renderSessionItem(id, false)}
            </For>
          </div>
        </Show>

        <Show when={isFoldersView()}>
          <For each={app.sessionFolders()}>
            {(folder) => {
              const isCollapsed = () => app.collapsedFolders().has(folder.tag);
              const isUntagged = folder.tag === "__untagged__";
              const isDragOver = () => app.dragOverFolder() === folder.tag;

              return (
                <div class="session-folder">
                  <div
                    class={`session-folder-header ${isCollapsed() ? "collapsed" : ""} ${isDragOver() ? "drag-over" : ""}`}
                    onClick={() => app.toggleFolderCollapse(folder.tag)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      app.setFolderContextMenu({ tag: folder.tag, x: e.clientX, y: e.clientY });
                    }}
                    onPointerEnter={() => {
                      if (app.draggingSessionId()) {
                        app.setDragOverFolder(folder.tag);
                      }
                    }}
                    onPointerLeave={() => app.setDragOverFolder(null)}
                  >
                    <span class="folder-chevron">▾</span>
                    <span class={`folder-name ${isUntagged ? "muted" : ""}`}>
                      {folder.displayName}
                    </span>
                    <span class="folder-count">{folder.sessionIds.length}</span>
                    <Show when={isCollapsed() && folder.hasActiveSession}>
                      <span class="folder-active-dot" />
                    </Show>
                  </div>

                  <Show when={!isCollapsed()}>
                    <div class="session-folder-items">
                      <For each={folder.sessionIds}>
                        {(id) => renderSessionItem(id)}
                      </For>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>

        <Show when={isInboxView()}>
          <div class="inbox-section">
            <div class="inbox-header">
              <span class="inbox-title">Waiting for Input</span>
              <span class="inbox-count">{app.inboxSessionIds().length}</span>
            </div>
            <Show
              when={app.inboxSessionIds().length > 0}
              fallback={<div class="inbox-empty">No terminals waiting for input</div>}
            >
              <div class="inbox-list">
                <For each={app.inboxSessionIds()}>
                  {(id) => {
                    const session = () => app.sessions.find((s) => s.id === id);
                    return (
                      <Show when={session()}>
                        <div
                          class={`inbox-item ${app.activeSessionId() === id ? "active" : ""}`}
                          onClick={() => app.selectSession(id)}
                          onPointerEnter={(e) => showInboxPreview(e.currentTarget as HTMLElement, id)}
                          onPointerLeave={() => hideInboxPreview()}
                        >
                          <div class="inbox-item-icon">
                            <span class="activity-badge awaiting" />
                          </div>
                          <div class="inbox-item-content">
                            <span class="inbox-item-title">{session()!.title}</span>
                            <Show when={session()!.directory}>
                              <span class="inbox-item-sub">{session()!.directory}</span>
                            </Show>
                          </div>
                          <button
                            class="inbox-item-dismiss"
                            onClick={(e) => {
                              e.stopPropagation();
                              app.dismissFromInbox(id);
                            }}
                            title="Dismiss from inbox"
                          >
                            ×
                          </button>
                        </div>
                      </Show>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={isClosedView()}>
          <div class="recently-closed-section in-sidebar-view">
            <div class="recently-closed-header">
              <span class="recently-closed-title">Recently Closed</span>
              <button
                class="recently-closed-reopen-last"
                onClick={() => {
                  void app.reopenLastClosedSession();
                }}
                title="Reopen most recently closed terminal (Cmd+Shift+T)"
              >
                Reopen Last
              </button>
            </div>
            <Show
              when={app.recentlyClosedSessions().length > 0}
              fallback={<div class="recently-closed-empty">No recently closed terminals</div>}
            >
              <div class="recently-closed-list">
                <For each={app.recentlyClosedSessions().slice(0, 12)}>
                  {(session) => (
                    <div
                      class="recently-closed-item has-metadata-hover"
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        void app.reopenClosedSession(session.id);
                      }}
                      onPointerEnter={(e) => {
                        openMetadataPopover(
                          e.currentTarget as HTMLElement,
                          `closed:${session.id}`,
                          "Closed Session Metadata",
                          buildClosedSessionMetadata(session)
                        );
                      }}
                      onPointerLeave={() => scheduleMetadataPopoverHide()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          void app.reopenClosedSession(session.id);
                        }
                      }}
                    >
                      <span class="recently-closed-item-title">{session.title}</span>
                      <Show when={session.directory || session.command}>
                        <span class="recently-closed-item-sub">
                          {session.directory || session.command}
                        </span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={inboxPreview()}>
        {(preview) => (
          <div
            class="inbox-preview-popover"
            style={{
              left: `${preview().left}px`,
              top: `${preview().top}px`,
            }}
            onPointerEnter={() => {
              if (inboxPreviewHideTimer) {
                clearTimeout(inboxPreviewHideTimer);
                inboxPreviewHideTimer = null;
              }
            }}
            onPointerLeave={() => hideInboxPreview(80)}
          >
            <For each={preview().lines}>
              {(line) => <div class="inbox-preview-line">{line}</div>}
            </For>
          </div>
        )}
      </Show>
      <Show when={metadataPopover()}>
        {(popover) => (
          <div
            class="session-metadata-popover"
            style={{
              left: `${popover().left}px`,
              top: `${popover().top}px`,
            }}
            onPointerEnter={() => clearMetadataHideTimer()}
            onPointerLeave={() => scheduleMetadataPopoverHide(80)}
            onClick={(e) => {
              e.stopPropagation();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.stopPropagation();
            }}
          >
            <div class="session-metadata-header">{popover().title}</div>
            <div class="session-metadata-list">
              <For each={popover().fields}>
                {(field) => {
                  const token = `${popover().tokenPrefix}:${field.key}`;
                  const canCopy = (field.copyable ?? true) && field.value !== "(none)";
                  return (
                    <div class="session-metadata-row">
                      <span class="session-metadata-key">{field.key}</span>
                      <code class="session-metadata-value" title={field.value}>
                        {field.value}
                      </code>
                      <Show when={canCopy}>
                        <button
                          class="session-metadata-copy"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            void copyMetadataField(token, field.value);
                          }}
                        >
                          {copiedFieldToken() === token ? "Copied" : field.copyLabel || "Copy"}
                        </button>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        )}
      </Show>
    </aside>
  );
}
