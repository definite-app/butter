import { Show, createMemo, onCleanup } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

// Cmd+Option+P. Match on event.code: with Option held, macOS reports
// event.key as "π". (Cmd+E is taken: the Rust side registers it as a global
// show/hide-window shortcut.)
const isToggleShortcut = (event: KeyboardEvent) =>
  event.code === "KeyP" &&
  event.metaKey &&
  event.altKey &&
  !event.shiftKey &&
  !event.ctrlKey;

/**
 * Edit / Preview switch shown in the workspace header while a markdown file
 * tab is active. Cmd+Option+P toggles between the two.
 */
export function MarkdownViewToggle() {
  const app = useAppContext();

  const activeMarkdown = createMemo(() => {
    const tab = app.activeWorkspaceFileTab();
    return tab && app.isMarkdownTab(tab) ? tab : null;
  });

  const mode = createMemo(() => {
    const tab = activeMarkdown();
    return tab ? app.getMarkdownViewMode(tab.id) : "source";
  });

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!isToggleShortcut(event)) return;
    const tab = activeMarkdown();
    if (!tab) return;
    // Capture phase: runs before Monaco sees the key.
    event.preventDefault();
    event.stopPropagation();
    app.toggleMarkdownViewMode(tab.id);
  };
  window.addEventListener("keydown", handleKeyDown, true);
  onCleanup(() => window.removeEventListener("keydown", handleKeyDown, true));

  return (
    <Show when={activeMarkdown()}>
      {(tab) => (
        <div class="butter-md-view-toggle" role="group" aria-label="Markdown view">
          <button
            type="button"
            class={mode() === "source" ? "active" : ""}
            aria-pressed={mode() === "source"}
            title="Edit markdown (⌥⌘P)"
            onClick={() => app.setMarkdownViewMode(tab().id, "source")}
          >
            Edit
          </button>
          <button
            type="button"
            class={mode() === "preview" ? "active" : ""}
            aria-pressed={mode() === "preview"}
            title="Preview markdown (⌥⌘P)"
            onClick={() => app.setMarkdownViewMode(tab().id, "preview")}
          >
            Preview
          </button>
        </div>
      )}
    </Show>
  );
}
