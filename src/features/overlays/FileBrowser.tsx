import { For, Show } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

export function FileBrowser() {
  const app = useAppContext();

  const handleKeyDown = (e: KeyboardEvent) => {
    const actionEntry = app.fileBrowserActionEntry();

    // If in action sub-menu mode, handle keys there
    if (actionEntry) {
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        app.setFileBrowserActionEntry(null);
        return;
      }
      const actions = app.fileBrowserActions(actionEntry);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        app.setFileBrowserActionIndex((prev) =>
          Math.min(prev + 1, actions.length - 1)
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        app.setFileBrowserActionIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const action = actions[app.fileBrowserActionIndex()];
        if (action) action.action();
      }
      return;
    }

    // Normal file browser keys
    if (e.key === "Escape") {
      app.setShowFileBrowser(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      app.setFileBrowserIndex((prev) =>
        Math.min(prev + 1, Math.max(app.filteredFileBrowserEntries().length - 1, 0))
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      app.setFileBrowserIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      const entry = app.filteredFileBrowserEntries()[app.fileBrowserIndex()];
      if (entry) {
        void app.activateFileBrowserEntry(entry, { openExternally: e.metaKey });
      }
    } else if (e.key === "Backspace" && app.fileBrowserQuery() === "") {
      void app.navigateToParent();
    }
  };

  return (
    <Show when={app.showFileBrowser()}>
      <div
        class="file-browser-overlay"
        onClick={() => app.setShowFileBrowser(false)}
      >
        <div
          class="file-browser"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="file-browser-header">
            <div class="file-browser-path">
              <button
                class="file-browser-parent-btn"
                title="Go to parent directory"
                onClick={() => void app.navigateToParent()}
              >
                &larr;
              </button>
              <span class="file-browser-path-text">{app.fileBrowserPath()}</span>
            </div>
            <div class="file-browser-header-actions">
              <button
                class={`file-browser-toggle-hidden ${app.showHiddenFiles() ? "active" : ""}`}
                title="Toggle hidden files"
                onClick={() => {
                  app.setShowHiddenFiles((prev) => !prev);
                  app.setFileBrowserIndex(0);
                }}
              >
                .*
              </button>
            </div>
          </div>
          <input
            class="file-browser-input"
            placeholder="Search files and folders..."
            value={app.fileBrowserQuery()}
            ref={(el) => app.setFileBrowserInputRef(el || undefined)}
            spellcheck={false}
            onInput={(e) => {
              const val = e.currentTarget.value;
              app.setFileBrowserQuery(val);
              app.setFileBrowserIndex(0);
              app.setFileBrowserActionEntry(null);
              app.debouncedSearch(val);
            }}
            onKeyDown={handleKeyDown}
          />

          <Show when={app.fileBrowserActionEntry()}>
            {(entry) => (
              <div class="file-browser-actions-menu">
                <div class="file-browser-actions-header">
                  <span class="file-browser-actions-filename">{entry().name}</span>
                </div>
                <For each={app.fileBrowserActions(entry())}>
                  {(action, index) => (
                    <button
                      class={`file-browser-actions-item ${index() === app.fileBrowserActionIndex() ? "active" : ""}`}
                      onClick={() => action.action()}
                      onMouseEnter={() => app.setFileBrowserActionIndex(index())}
                    >
                      <span class="file-browser-actions-icon">{action.icon}</span>
                      {action.label}
                    </button>
                  )}
                </For>
              </div>
            )}
          </Show>

          <Show when={!app.fileBrowserActionEntry()}>
            <div class="file-browser-list">
              <Show when={app.fileBrowserLoading()}>
                <div class="file-browser-empty">Loading...</div>
              </Show>
              <Show when={!app.fileBrowserLoading() && app.fileBrowserSearching() && app.filteredFileBrowserEntries().length === 0}>
                <div class="file-browser-empty">Searching...</div>
              </Show>
              <Show when={!app.fileBrowserLoading()}>
                <For each={app.filteredFileBrowserEntries()}>
                  {(entry, index) => (
                    <button
                      class={`file-browser-item ${index() === app.fileBrowserIndex() ? "active" : ""}`}
                      onClick={() => {
                        void app.activateFileBrowserEntry(entry);
                      }}
                      onMouseEnter={() => app.setFileBrowserIndex(index())}
                    >
                      <span class={`file-browser-icon ${entry.is_dir ? "dir" : "file"}`}>
                        {entry.is_dir ? "\u{1F4C1}" : "\u{1F4C4}"}
                      </span>
                      <span class="file-browser-name">
                        {entry.relative_path !== entry.name
                          ? entry.relative_path + (entry.is_dir ? "/" : "")
                          : entry.name + (entry.is_dir ? "/" : "")}
                      </span>
                      <div class="file-browser-meta">
                        <Show when={!entry.is_dir && entry.size !== null}>
                          <span class="file-browser-size">{app.formatSize(entry.size)}</span>
                        </Show>
                      </div>
                    </button>
                  )}
                </For>
                <Show when={app.filteredFileBrowserEntries().length === 0}>
                  <div class="file-browser-empty">No files found</div>
                </Show>
              </Show>
            </div>
          </Show>

          <div class="file-browser-footer">
            <Show when={app.fileBrowserActionEntry()} fallback={
              <>
                <span>↑↓ Navigate</span>
                <span>Enter Actions</span>
                <span>⌘↩ Open</span>
                <span>⌫ Parent</span>
                <span>Esc Close</span>
              </>
            }>
              <span>↑↓ Navigate</span>
              <span>Enter Select</span>
              <span>⌫ Back</span>
              <span>Esc Close</span>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
