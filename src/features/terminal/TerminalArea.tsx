import { For, Show, Suspense, createMemo, createSignal, lazy, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";
import { BrowserPane } from "../browser/BrowserPane";
import { MarkdownViewToggle } from "../files/MarkdownViewToggle";
import { HeaderActionMenu } from "./HeaderActionMenu";
import { TerminalStack } from "./TerminalStack";

const DEFAULT_BROWSER_PANEL_WIDTH = 540;
const MIN_BROWSER_PANEL_WIDTH = 360;
const MIN_TERMINAL_COLUMN_WIDTH = 360;
const BROWSER_RESIZER_WIDTH = 10;
const BROWSER_PANEL_WIDTH_STORAGE_KEY = "butter.browser-pane-width";
const FileWorkspacePane = lazy(async () => {
  const mod = await import("../files/FileWorkspacePane");
  return { default: mod.FileWorkspacePane };
});

export function TerminalArea() {
  const app = useAppContext();
  const [browserPanelWidth, setBrowserPanelWidth] = createSignal(DEFAULT_BROWSER_PANEL_WIDTH);
  const [workspaceWidth, setWorkspaceWidth] = createSignal<number | null>(null);
  const [isResizingBrowser, setIsResizingBrowser] = createSignal(false);
  let workspaceRef: HTMLDivElement | undefined;
  let stopBrowserResize: (() => void) | undefined;
  const showBrowserPane = createMemo(() => {
    return app.activeWorkspaceTabKind() === "terminal" && app.activeBrowserOpen();
  });

  const clampBrowserPanelWidth = (width: number) => {
    const containerWidth = workspaceWidth() ?? workspaceRef?.getBoundingClientRect().width ?? 0;
    if (containerWidth <= 0) {
      return Math.max(MIN_BROWSER_PANEL_WIDTH, Math.round(width));
    }

    const maxWidth = Math.max(
      MIN_BROWSER_PANEL_WIDTH,
      containerWidth - MIN_TERMINAL_COLUMN_WIDTH - BROWSER_RESIZER_WIDTH,
    );

    return Math.max(MIN_BROWSER_PANEL_WIDTH, Math.min(Math.round(width), maxWidth));
  };

  const setBrowserPanelWidthClamped = (width: number, persist = true) => {
    const nextWidth = clampBrowserPanelWidth(width);
    setBrowserPanelWidth(nextWidth);
    if (persist) {
      window.localStorage.setItem(BROWSER_PANEL_WIDTH_STORAGE_KEY, String(nextWidth));
    }
    return nextWidth;
  };

  const browserPanelWidthPx = createMemo(() => clampBrowserPanelWidth(browserPanelWidth()));

  const stopActiveBrowserResize = () => {
    stopBrowserResize?.();
    stopBrowserResize = undefined;
  };

  const startBrowserResize = (event: PointerEvent) => {
    if (!showBrowserPane()) return;
    event.preventDefault();
    stopActiveBrowserResize();

    const startX = event.clientX;
    const startWidth = browserPanelWidthPx();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    setIsResizingBrowser(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      setBrowserPanelWidthClamped(startWidth - delta);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setIsResizingBrowser(false);
      stopBrowserResize = undefined;

      const sessionId = app.activeSessionId();
      if (sessionId) {
        requestAnimationFrame(() => app.fitTerminalSession(sessionId));
      }
    };

    stopBrowserResize = handlePointerUp;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  onMount(() => {
    const storedWidth = Number(window.localStorage.getItem(BROWSER_PANEL_WIDTH_STORAGE_KEY));
    if (Number.isFinite(storedWidth) && storedWidth > 0) {
      setBrowserPanelWidthClamped(storedWidth, false);
    }

    const workspace = workspaceRef;
    if (!workspace) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setWorkspaceWidth(entry.contentRect.width);
      setBrowserPanelWidth((current) => clampBrowserPanelWidth(current));
    });

    observer.observe(workspace);
    setWorkspaceWidth(workspace.getBoundingClientRect().width);
    setBrowserPanelWidth((current) => clampBrowserPanelWidth(current));

    onCleanup(() => {
      observer.disconnect();
      stopActiveBrowserResize();
    });
  });

  return (
    <main class="butter-web-main">
      <div class="butter-web-bar">
        <div class="butter-web-bar-title">
          <Show when={app.activeSessionId()}>
            {(sessionId) => (
              <div class="butter-workspace-tabs" role="tablist" aria-label="Workspace tabs">
                <For each={app.pinnedFileTabs()}>
                  {(tab) => {
                    const isActive = () => app.activeWorkspaceFileTab()?.id === tab.id;
                    const isDirty = () => tab.kind === "text_file" && tab.dirty;
                    return (
                      <div
                        class={`butter-workspace-tab pinned file ${isActive() ? "active" : ""} ${isDirty() ? "dirty" : ""}`}
                        role="tab"
                        aria-selected={isActive()}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          app.openFileTabContextMenu(tab, { x: event.clientX, y: event.clientY });
                        }}
                      >
                        <button
                          class="butter-workspace-tab-main"
                          onClick={() => app.selectFileWorkspaceTab(sessionId(), tab.id)}
                          title={`Pinned: ${tab.path}`}
                        >
                          <span class="butter-workspace-tab-icon pin-icon" aria-hidden="true">
                            <svg viewBox="0 0 14 14">
                              <path d="M5 2 L9 2 L8.25 5 L11 7.5 L8 7.5 L7 12 L6 7.5 L3 7.5 L5.75 5 Z" />
                            </svg>
                          </span>
                          <span class="butter-workspace-tab-label">{tab.displayName}</span>
                        </button>
                        <span class="butter-workspace-tab-trailing">
                          <span class="butter-workspace-tab-trailing-dot" aria-hidden="true" />
                          <button
                            class="butter-workspace-tab-trailing-close"
                            type="button"
                            title={`Unpin ${tab.displayName}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              app.unpinFileTab(tab.id);
                            }}
                          >
                            <svg viewBox="0 0 14 14" aria-hidden="true">
                              <path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5" />
                            </svg>
                          </button>
                        </span>
                      </div>
                    );
                  }}
                </For>

                <div
                  class={`butter-workspace-tab terminal ${app.activeWorkspaceTabKind() === "terminal" ? "active" : ""}`}
                  role="tab"
                  aria-selected={app.activeWorkspaceTabKind() === "terminal"}
                >
                  <Show
                    when={app.renamingSessionId() === sessionId()}
                    fallback={
                      <button
                        class="butter-workspace-tab-main"
                        onClick={() => app.selectTerminalWorkspaceTab(sessionId())}
                        onDblClick={() => app.openRename(sessionId())}
                      >
                        <span class="butter-workspace-tab-icon" aria-hidden="true">
                          <svg viewBox="0 0 14 14">
                            <path d="M3 4 L6 7 L3 10" />
                            <path d="M7.5 10 L11 10" />
                          </svg>
                        </span>
                        <span class="butter-workspace-tab-label">
                          {app.sessions.find((session) => session.id === sessionId())?.title || "Terminal"}
                        </span>
                      </button>
                    }
                  >
                    <input
                      class="butter-workspace-tab-input"
                      ref={(el) => app.setRenameInputRef(el || undefined)}
                      value={app.renameValue()}
                      spellcheck={false}
                      onInput={(e) => app.setRenameValue(e.currentTarget.value)}
                      onBlur={() => app.closeRename(true)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          app.closeRename(true);
                        } else if (e.key === "Escape") {
                          app.closeRename(false);
                        }
                      }}
                    />
                  </Show>
                </div>

                <For each={app.activeSessionFileTabs()}>
                  {(tab) => {
                    const isActive = () => app.activeWorkspaceFileTab()?.id === tab.id;
                    const isDirty = () => tab.kind === "text_file" && tab.dirty;
                    return (
                      <div
                        class={`butter-workspace-tab file ${isActive() ? "active" : ""} ${isDirty() ? "dirty" : ""}`}
                        role="tab"
                        aria-selected={isActive()}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          app.openFileTabContextMenu(tab, { x: event.clientX, y: event.clientY });
                        }}
                      >
                        <button
                          class="butter-workspace-tab-main"
                          onClick={() => app.selectFileWorkspaceTab(sessionId(), tab.id)}
                        >
                          <span class="butter-workspace-tab-icon" aria-hidden="true">
                            <Show
                              when={tab.kind === "image_file"}
                              fallback={
                                <svg viewBox="0 0 14 14">
                                  <path d="M3 1.75 L8.25 1.75 L11 4.5 L11 12.25 L3 12.25 Z" />
                                  <path d="M8.25 1.75 L8.25 4.5 L11 4.5" />
                                  <path d="M4.75 7 L9.25 7 M4.75 9 L9.25 9 M4.75 5 L6.75 5" />
                                </svg>
                              }
                            >
                              <svg viewBox="0 0 14 14">
                                <rect x="2" y="2.5" width="10" height="9" rx="1" />
                                <circle cx="5" cy="5.5" r="0.9" />
                                <path d="M2 10 L5 7.5 L7.5 9.5 L10.5 6 L12 7.5 L12 11.5" />
                              </svg>
                            </Show>
                          </span>
                          <span class="butter-workspace-tab-label">{tab.displayName}</span>
                        </button>
                        <button
                          class="butter-workspace-tab-pin"
                          type="button"
                          title={`Pin ${tab.displayName} to all terminals`}
                          onClick={(event) => {
                            event.stopPropagation();
                            app.pinFileTab(sessionId(), tab.id);
                          }}
                        >
                          <svg viewBox="0 0 14 14" aria-hidden="true">
                            <path d="M5 2 L9 2 L8.25 5 L11 7.5 L8 7.5 L7 12 L6 7.5 L3 7.5 L5.75 5 Z" />
                          </svg>
                        </button>
                        <span class="butter-workspace-tab-trailing">
                          <span class="butter-workspace-tab-trailing-dot" aria-hidden="true" />
                          <button
                            class="butter-workspace-tab-trailing-close"
                            type="button"
                            title={`Close ${tab.displayName}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              app.closeFileWorkspaceTab(sessionId(), tab.id);
                            }}
                          >
                            <svg viewBox="0 0 14 14" aria-hidden="true">
                              <path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5" />
                            </svg>
                          </button>
                        </span>
                      </div>
                    );
                  }}
                </For>
              </div>
            )}
          </Show>
        </div>
        <div class="butter-web-bar-actions">
          <Show when={app.activeWorkspaceTabKind() === "terminal" && app.searchOpen()}>
            <div class="butter-web-search">
              <input
                ref={(el) => app.setSearchInputRef(el || undefined)}
                class="butter-web-search-input"
                type="search"
                spellcheck={false}
                placeholder="Find in scrollback"
                value={app.searchQuery()}
                onInput={(e) => app.setSearchQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    app.runSearch(e.shiftKey ? "prev" : "next");
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    app.closeSearch();
                  }
                }}
              />
              <button
                class="butter-web-search-btn"
                type="button"
                title="Previous match"
                onClick={() => app.runSearch("prev")}
              >
                Prev
              </button>
              <button
                class="butter-web-search-btn"
                type="button"
                title="Next match"
                onClick={() => app.runSearch("next")}
              >
                Next
              </button>
              <button
                class="butter-web-search-close"
                type="button"
                title="Close search"
                onClick={() => app.closeSearch()}
              >
                X
              </button>
              <Show when={app.searchFeedback()}>
                <span class="butter-web-search-feedback">{app.searchFeedback()}</span>
              </Show>
            </div>
          </Show>
          <MarkdownViewToggle />
          <HeaderActionMenu />
        </div>
      </div>
      <div
        ref={(el) => (workspaceRef = el)}
        class={`butter-web-workspace ${showBrowserPane() ? "browser-open" : ""} ${
          isResizingBrowser() ? "resizing" : ""
        }`}
        style={
          showBrowserPane()
            ? ({ "--browser-panel-width": `${browserPanelWidthPx()}px` } as JSX.CSSProperties)
            : undefined
        }
      >
        <div class="butter-web-terminal-column">
          <Show
            when={app.activeWorkspaceTabKind() === "terminal"}
            fallback={
              <Suspense fallback={<div class="butter-file-placeholder">Loading editor…</div>}>
                <Show when={app.activeWorkspaceFileTab()}>
                  {(tab) => <FileWorkspacePane tab={tab()} />}
                </Show>
              </Suspense>
            }
          >
            <TerminalStack />
          </Show>
        </div>
        <Show when={app.activeSessionId()} keyed>
          {(sessionId) => (
            <Show when={showBrowserPane()}>
              <>
                <div
                  class="butter-web-browser-resizer"
                  role="separator"
                  aria-label="Resize browser panel"
                  aria-orientation="vertical"
                  title="Drag to resize browser"
                  onDblClick={() => setBrowserPanelWidthClamped(DEFAULT_BROWSER_PANEL_WIDTH)}
                  onPointerDown={startBrowserResize}
                />
                <BrowserPane sessionId={sessionId} />
              </>
            </Show>
          )}
        </Show>
      </div>
    </main>
  );
}
