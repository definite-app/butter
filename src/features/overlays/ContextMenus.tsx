import { For, Show } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

export function ContextMenus() {
  const app = useAppContext();

  return (
    <>
      <Show when={app.contextMenuFor()}>
        {(menu) => (
          <div
            class="context-menu-overlay"
            onClick={() => app.setContextMenuFor(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              app.setContextMenuFor(null);
            }}
          >
            <div
              class="context-menu"
              style={{
                left: `${menu().x}px`,
                top: `${menu().y}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                class="context-menu-item"
                onClick={() => {
                  void app.closeSession(menu().id);
                  app.setContextMenuFor(null);
                }}
              >
                <span class="context-menu-icon">×</span>
                Close
              </button>
              <button
                class="context-menu-item"
                onClick={() => {
                  void app.closeOtherSessions(menu().id);
                  app.setContextMenuFor(null);
                }}
                disabled={app.sessions.length <= 1}
              >
                <span class="context-menu-icon">◇</span>
                Close Others
              </button>
              <button
                class="context-menu-item destructive"
                onClick={() => {
                  void app.closeAllSessions();
                  app.setContextMenuFor(null);
                }}
              >
                <span class="context-menu-icon">⊗</span>
                Close All
              </button>
              <div class="context-menu-divider" />
              <button
                class="context-menu-item"
                onClick={() => {
                  app.openRename(menu().id);
                  app.setContextMenuFor(null);
                }}
              >
                <span class="context-menu-icon">✎</span>
                Rename
              </button>
              <button
                class="context-menu-item"
                onClick={() => {
                  void app.forkSession(menu().id);
                  app.setContextMenuFor(null);
                }}
              >
                <span class="context-menu-icon">F</span>
                Fork
              </button>
              <button
                class="context-menu-item"
                onClick={() => {
                  void app.addCanvasTerminalObject(menu().id);
                  app.setContextMenuFor(null);
                }}
              >
                <span class="context-menu-icon">▦</span>
                Add to Canvas
              </button>
              <div class="context-menu-divider" />
              <div class="context-menu-item has-submenu">
                <span class="context-menu-icon">#</span>
                Tags
                <span class="context-menu-arrow">›</span>
                <div class="context-submenu">
                  <For each={app.tags()}>
                    {(tag) => {
                      const isActive = () =>
                        (app.terminalTags()[menu().id] || []).includes(tag);
                      return (
                        <button
                          class={`context-menu-item ${isActive() ? "active" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            app.toggleTagForTerminal(menu().id, tag);
                          }}
                        >
                          <span class="context-menu-icon">{isActive() ? "✓" : ""}</span>
                          {tag}
                        </button>
                      );
                    }}
                  </For>
                  <Show when={app.tags().length === 0}>
                    <div class="context-menu-empty">No tags defined</div>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={app.sidebarContextMenu()}>
        {(menu) => (
          <div
            class="context-menu-overlay"
            onClick={() => app.setSidebarContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              app.setSidebarContextMenu(null);
            }}
          >
            <div
              class="context-menu"
              style={{
                left: `${menu().x}px`,
                top: `${menu().y}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                class="context-menu-item"
                onClick={() => {
                  app.createSession();
                  app.setSidebarContextMenu(null);
                }}
              >
                <span class="context-menu-icon">+</span>
                New Terminal
              </button>
              <Show when={app.presets().length > 0}>
                <div class="context-menu-divider" />
                <For each={app.presets()}>
                  {(preset) => (
                    <button
                      class="context-menu-item"
                      onClick={() => {
                        void app.launchPresetSession(preset);
                        app.setSidebarContextMenu(null);
                      }}
                    >
                      <span class="context-menu-icon">▸</span>
                      {preset.name}
                    </button>
                  )}
                </For>
              </Show>
              <Show when={app.recentlyClosedSessions().length > 0}>
                <div class="context-menu-divider" />
                <button
                  class="context-menu-item"
                  onClick={() => {
                    void app.reopenLastClosedSession();
                    app.setSidebarContextMenu(null);
                  }}
                >
                  <span class="context-menu-icon">↺</span>
                  Reopen Last Closed
                </button>
                <For each={app.recentlyClosedSessions().slice(0, 5)}>
                  {(session) => (
                    <button
                      class="context-menu-item"
                      onClick={() => {
                        void app.reopenClosedSession(session.id);
                        app.setSidebarContextMenu(null);
                      }}
                    >
                      <span class="context-menu-icon">↩</span>
                      {session.title}
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show when={app.canvasContextMenu()}>
        {(menu) => (
          <div
            class="context-menu-overlay"
            onClick={() => app.setCanvasContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              app.setCanvasContextMenu(null);
            }}
          >
            <div
              class="context-menu"
              style={{
                left: `${menu().x}px`,
                top: `${menu().y}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                class="context-menu-item"
                onClick={() => {
                  const sessionId = app.createSession();
                  void app.addCanvasTerminalObject(sessionId);
                  app.setCanvasContextMenu(null);
                }}
              >
                <span class="context-menu-icon">+</span>
                New Terminal
              </button>

              <Show when={app.presets().length > 0}>
                <div class="context-menu-divider" />
                <For each={app.presets()}>
                  {(preset) => (
                    <button
                      class="context-menu-item"
                      onClick={() => {
                        void (async () => {
                          const sessionId = await app.launchPresetSession(preset);
                          if (sessionId) {
                            await app.addCanvasTerminalObject(sessionId);
                          }
                          app.setCanvasContextMenu(null);
                        })();
                      }}
                    >
                      <span class="context-menu-icon">▸</span>
                      {preset.name}
                    </button>
                  )}
                </For>
              </Show>

              <div class="context-menu-divider" />
              <button
                class={`context-menu-item ${app.canvasBoard().activeTool === "select" ? "active" : ""}`}
                onClick={() => {
                  app.setCanvasTool("select");
                  app.setCanvasContextMenu(null);
                }}
              >
                <span class="context-menu-icon">↖</span>
                Tool: Select
              </button>
              <button
                class={`context-menu-item ${app.canvasBoard().activeTool === "pen" ? "active" : ""}`}
                onClick={() => {
                  app.setCanvasTool("pen");
                  app.setCanvasContextMenu(null);
                }}
              >
                <span class="context-menu-icon">✎</span>
                Tool: Pen
              </button>
              <button
                class="context-menu-item"
                onClick={() => {
                  const id = app.addCanvasTextObject();
                  requestAnimationFrame(() => {
                    const input = document.querySelector<HTMLTextAreaElement>(
                      `textarea[data-canvas-text-id="${id}"]`
                    );
                    input?.focus();
                    input?.setSelectionRange(input.value.length, input.value.length);
                  });
                  app.setCanvasContextMenu(null);
                }}
              >
                <span class="context-menu-icon">T</span>
                Add Text
              </button>
              <button
                class="context-menu-item"
                onClick={() => {
                  app.clearCanvasStrokes();
                  app.setCanvasContextMenu(null);
                }}
              >
                <span class="context-menu-icon">⌫</span>
                Clear Drawing
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={app.folderContextMenu()}>
        {(menu) => (
          <div
            class="context-menu-overlay"
            onClick={() => app.setFolderContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              app.setFolderContextMenu(null);
            }}
          >
            <div
              class="context-menu"
              style={{
                left: `${menu().x}px`,
                top: `${menu().y}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                class="context-menu-item"
                onClick={() => {
                  app.createSession();
                  const newId = app.sessions[app.sessions.length - 1]?.id;
                  if (newId && menu().tag !== "__untagged__") {
                    app.addTagToTerminal(newId, menu().tag);
                  }
                  app.setFolderContextMenu(null);
                }}
              >
                <span class="context-menu-icon">+</span>
                New in {menu().tag === "__untagged__" ? "Untagged" : menu().tag}
              </button>
              <div class="context-menu-divider" />
              <button
                class="context-menu-item"
                onClick={() => {
                  app.toggleFolderCollapse(menu().tag);
                  app.setFolderContextMenu(null);
                }}
              >
                <span class="context-menu-icon">
                  {app.collapsedFolders().has(menu().tag) ? "▸" : "▾"}
                </span>
                {app.collapsedFolders().has(menu().tag) ? "Expand" : "Collapse"}
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={app.filePathContextMenu()}>
        {(menu) => {
          const fileName = () => menu().path.split("/").pop() || menu().path;
          return (
            <div
              class="context-menu-overlay"
              onClick={() => app.setFilePathContextMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                app.setFilePathContextMenu(null);
              }}
            >
              <div
                class="context-menu"
                style={{
                  left: `${menu().x}px`,
                  top: `${menu().y}px`,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <Show
                  when={app.canOpenPathInButter(menu().path)}
                  fallback={<div class="context-menu-header">{fileName()}</div>}
                >
                  <button
                    class="context-menu-item context-menu-header-action"
                    title="Open in Butter"
                    onClick={() => app.filePathMenuOpenInButter(menu().path, menu().sessionId)}
                  >
                    <span class="context-menu-icon">
                      <svg viewBox="0 0 14 14"><rect x="2.25" y="2.25" width="9.5" height="9.5" rx="1.5" /></svg>
                    </span>
                    {fileName()}
                  </button>
                </Show>
                <div class="context-menu-divider" />
                <button
                  class="context-menu-item"
                  onClick={() => app.filePathMenuCopyPath(menu().path)}
                >
                  <span class="context-menu-icon">
                    <svg viewBox="0 0 14 14"><rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1" /><path d="M9.5 4.5 V2.5 Q2.5 2.5 2.5 2.5 V9.5 H4.5" /></svg>
                  </span>
                  Copy Path
                </button>
                <button
                  class="context-menu-item"
                  onClick={() => app.filePathMenuCopyRelative(menu().path, menu().sessionId)}
                >
                  <span class="context-menu-icon">
                    <svg viewBox="0 0 14 14"><rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1" /><path d="M9.5 4.5 V2.5 Q2.5 2.5 2.5 2.5 V9.5 H4.5" /></svg>
                  </span>
                  Copy Relative Path
                </button>
                <div class="context-menu-divider" />
                <button
                  class="context-menu-item"
                  onClick={() => app.filePathMenuOpenDefault(menu().path)}
                >
                  <span class="context-menu-icon">
                    <svg viewBox="0 0 14 14"><path d="M4 10 L10 4 M5.5 4 L10 4 L10 8.5" /></svg>
                  </span>
                  Open File
                </button>
                <button
                  class="context-menu-item"
                  onClick={() => app.filePathMenuOpenInVSCode(menu().path)}
                >
                  <span class="context-menu-icon">
                    <svg viewBox="0 0 14 14"><path d="M5 4 L2.5 7 L5 10 M9 4 L11.5 7 L9 10" /></svg>
                  </span>
                  Open in VS Code
                </button>
                <button
                  class="context-menu-item"
                  onClick={() => app.filePathMenuRevealInFinder(menu().path)}
                >
                  <span class="context-menu-icon">
                    <svg viewBox="0 0 14 14"><circle cx="6" cy="6" r="3.5" /><path d="M8.75 8.75 L11.5 11.5" /></svg>
                  </span>
                  Reveal in Finder
                </button>
                <div class="context-menu-divider" />
                <button
                  class="context-menu-item"
                  onClick={() => app.filePathMenuBrowse(menu().path)}
                >
                  <span class="context-menu-icon">
                    <svg viewBox="0 0 14 14"><rect x="2" y="2" width="4.25" height="4.25" rx="0.5" /><rect x="7.75" y="2" width="4.25" height="4.25" rx="0.5" /><rect x="2" y="7.75" width="4.25" height="4.25" rx="0.5" /><rect x="7.75" y="7.75" width="4.25" height="4.25" rx="0.5" /></svg>
                  </span>
                  Browse in File Browser
                </button>
              </div>
            </div>
          );
        }}
      </Show>

      <Show when={app.fileTabContextMenu()}>
        {(menu) => (
          <div
            class="context-menu-overlay"
            onClick={() => app.setFileTabContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              app.setFileTabContextMenu(null);
            }}
          >
            <div
              class="context-menu"
              style={{
                left: `${menu().x}px`,
                top: `${menu().y}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div class="context-menu-header">{menu().displayName}</div>
              <div class="context-menu-divider" />
              <button
                class="context-menu-item"
                onClick={() => app.fileTabMenuCopyPath(menu().path)}
              >
                <span class="context-menu-icon">⎘</span>
                Copy Path
              </button>
              <button
                class="context-menu-item"
                onClick={() => app.fileTabMenuCopyRelative(menu().path)}
              >
                <span class="context-menu-icon">⎘</span>
                Copy Relative Path
              </button>
              <div class="context-menu-divider" />
              <button
                class="context-menu-item"
                onClick={() => app.fileTabMenuTogglePin(menu().tabId, menu().ownerSessionId)}
              >
                <span class="context-menu-icon">{menu().isPinned ? "◎" : "◉"}</span>
                {menu().isPinned ? "Unpin Tab" : "Pin Tab"}
              </button>
              <button
                class="context-menu-item"
                onClick={() => app.fileTabMenuClose(menu().tabId, menu().ownerSessionId)}
              >
                <span class="context-menu-icon">×</span>
                Close Tab
              </button>
              <button
                class="context-menu-item"
                onClick={() => app.fileTabMenuReloadFromDisk(menu().tabId)}
              >
                <span class="context-menu-icon">↻</span>
                Reload from Disk
              </button>
              <div class="context-menu-divider" />
              <button
                class="context-menu-item"
                onClick={() => app.fileTabMenuOpenDefault(menu().path)}
              >
                <span class="context-menu-icon">↗</span>
                Open File
              </button>
              <button
                class="context-menu-item"
                onClick={() => app.fileTabMenuOpenInVSCode(menu().path)}
              >
                <span class="context-menu-icon">◇</span>
                Open in VS Code
              </button>
              <button
                class="context-menu-item"
                onClick={() => app.fileTabMenuRevealInFinder(menu().path)}
              >
                <span class="context-menu-icon">⌕</span>
                Reveal in Finder
              </button>
              <div class="context-menu-divider" />
              <button
                class="context-menu-item"
                onClick={() => app.fileTabMenuBrowse(menu().path)}
              >
                <span class="context-menu-icon">▦</span>
                Browse in File Browser
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={app.urlContextMenu()}>
        {(menu) => {
          const displayUrl = () => {
            try {
              const u = new URL(menu().url);
              return u.hostname + u.pathname;
            } catch {
              return menu().url;
            }
          };
          return (
            <div
              class="context-menu-overlay"
              onClick={() => app.setUrlContextMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                app.setUrlContextMenu(null);
              }}
            >
              <div
                class="context-menu"
                style={{
                  left: `${menu().x}px`,
                  top: `${menu().y}px`,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div class="context-menu-header">{displayUrl()}</div>
                <div class="context-menu-divider" />
                <button
                  class="context-menu-item"
                  onClick={() => app.urlMenuOpen(menu().url)}
                >
                  <span class="context-menu-icon">↗</span>
                  Open in Browser
                </button>
                <button
                  class="context-menu-item"
                  onClick={() => app.urlMenuCopy(menu().url)}
                >
                  <span class="context-menu-icon">⎘</span>
                  Copy URL
                </button>
              </div>
            </div>
          );
        }}
      </Show>
    </>
  );
}
