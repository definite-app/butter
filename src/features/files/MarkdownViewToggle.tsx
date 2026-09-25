import { Show, createMemo, onCleanup } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

const isToggleShortcut = (event: KeyboardEvent) =>
  (event.key === "e" || event.key === "E") &&
  event.metaKey &&
  !event.shiftKey &&
  !event.altKey &&
  !event.ctrlKey;

/**
 * Edit / Preview switch shown in the workspace header while a markdown file
 * tab is active. Cmd+E toggles between the two (same key as Obsidian).
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
    // Capture phase: runs before Monaco's own Cmd+E (find with selection).
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
            title="Edit markdown (⌘E)"
            onClick={() => app.setMarkdownViewMode(tab().id, "source")}
          >
            Edit
          </button>
          <button
            type="button"
            class={mode() === "preview" ? "active" : ""}
            aria-pressed={mode() === "preview"}
            title="Preview markdown (⌘E)"
            onClick={() => app.setMarkdownViewMode(tab().id, "preview")}
          >
            Preview
          </button>
        </div>
      )}
    </Show>
  );
}
