import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

type MenuItem =
  | { kind: "divider"; id: string }
  | {
      kind: "action";
      id: string;
      label: string;
      icon: () => JSX.Element;
      shortcut?: string;
      disabled?: boolean;
      active?: boolean;
      destructive?: boolean;
      onSelect: () => void;
    };

const EyeIcon = () => (
  <svg viewBox="0 0 14 14">
    <path d="M1.5 7 Q4 3 7 3 Q10 3 12.5 7 Q10 11 7 11 Q4 11 1.5 7 Z" />
    <circle cx="7" cy="7" r="1.75" />
  </svg>
);

const EditIcon = () => (
  <svg viewBox="0 0 14 14">
    <path d="M2 12 L2 10 L9 3 L11 5 L4 12 Z" />
    <path d="M8 4 L10 6" />
  </svg>
);

const SaveIcon = () => (
  <svg viewBox="0 0 14 14">
    <path d="M2.5 2.5 H9 L11.5 5 V11.5 H2.5 Z" />
    <rect x="4.5" y="2.5" width="4" height="3" />
    <rect x="4.5" y="8" width="5" height="3.5" />
  </svg>
);

const DownloadIcon = () => (
  <svg viewBox="0 0 14 14">
    <path d="M7 2.5 V8.5 M4.25 6 L7 8.75 L9.75 6" />
    <path d="M3 11 H11" />
  </svg>
);

const GlobeIcon = () => (
  <svg viewBox="0 0 14 14">
    <circle cx="7" cy="7" r="4.75" />
    <path d="M2.25 7 H11.75" />
    <ellipse cx="7" cy="7" rx="2.4" ry="4.75" />
  </svg>
);

const ClipboardIcon = () => (
  <svg viewBox="0 0 14 14">
    <rect x="3.5" y="2.75" width="7" height="9" rx="0.75" />
    <rect x="5.25" y="1.75" width="3.5" height="2" rx="0.5" />
  </svg>
);

const EraserIcon = () => (
  <svg viewBox="0 0 14 14">
    <path d="M9.25 2.25 L11.75 4.75 L6.5 10 L4 7.5 Z" />
    <path d="M4 7.5 L2.25 9.25 L4.75 11.75 L6.5 10" />
    <path d="M5.5 11.75 H11.75" />
  </svg>
);

const PowerIcon = () => (
  <svg viewBox="0 0 14 14">
    <path d="M4.25 4 Q1.75 6 2.5 9 Q3.75 12 7 12 Q10.25 12 11.5 9 Q12.25 6 9.75 4" />
    <path d="M7 2 V7" />
  </svg>
);

export function HeaderActionMenu() {
  const app = useAppContext();
  const [open, setOpen] = createSignal(false);

  const statusLabel = createMemo(() => {
    const tab = app.activeWorkspaceFileTab();
    if (!tab) return "xterm.js · local shell";
    if (tab.kind === "text_file") {
      return tab.dirty ? "Monaco · unsaved changes" : "Monaco · editable file";
    }
    return "Image preview";
  });

  const isDirty = createMemo(() => {
    const tab = app.activeWorkspaceFileTab();
    return !!(tab && tab.kind === "text_file" && tab.dirty);
  });

  const activeTextFile = createMemo(() => {
    const tab = app.activeWorkspaceFileTab();
    return tab && tab.kind === "text_file" ? tab : null;
  });

  const activeMarkdown = createMemo(() => {
    const tab = activeTextFile();
    return tab && app.isMarkdownTab(tab) ? tab : null;
  });

  const activeMarkdownMode = createMemo(() => {
    const tab = activeMarkdown();
    return tab ? app.getMarkdownViewMode(tab.id) : "source";
  });

  const menuItems = createMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [];
    const markdown = activeMarkdown();
    const textFile = activeTextFile();
    const sessionId = app.activeSessionId();
    const isTerminal = app.activeWorkspaceTabKind() === "terminal";

    if (markdown) {
      const inPreview = activeMarkdownMode() === "preview";
      items.push({
        kind: "action",
        id: "preview",
        label: inPreview ? "Show source" : "Show preview",
        shortcut: "⌥⌘P",
        active: inPreview,
        icon: inPreview ? EditIcon : EyeIcon,
        onSelect: () => app.toggleMarkdownViewMode(markdown.id),
      });
    }

    if (textFile) {
      items.push({
        kind: "action",
        id: "save",
        label: "Save",
        shortcut: "⌘S",
        disabled: textFile.loading || !textFile.dirty,
        icon: SaveIcon,
        onSelect: () => void app.saveActiveTextFileTab(),
      });
    }

    if (markdown) {
      items.push({ kind: "divider", id: "md-divider" });
      items.push({
        kind: "action",
        id: "export-pdf",
        label: "Export as PDF",
        icon: DownloadIcon,
        onSelect: () => app.exportActiveMarkdownAsPdf(),
      });
    }

    if (isTerminal && !textFile && sessionId) {
      const browserOpen = !!app.browserSessions()[sessionId]?.open;
      items.push({
        kind: "action",
        id: "toggle-browser",
        label: browserOpen ? "Hide browser pane" : "Show browser pane",
        active: browserOpen,
        icon: GlobeIcon,
        onSelect: () => {
          if (browserOpen) {
            void app.closeBrowserForSession(sessionId);
          } else {
            void app.openBrowserForSession(sessionId);
          }
        },
      });
      items.push({
        kind: "action",
        id: "copy-terminal-output",
        label: "Copy terminal output",
        icon: ClipboardIcon,
        onSelect: () => void app.copyTerminalOutputToClipboard(sessionId),
      });
      items.push({
        kind: "action",
        id: "clear-terminal",
        label: "Clear terminal",
        icon: EraserIcon,
        onSelect: () => app.clearTerminalForSession(sessionId),
      });
      items.push({ kind: "divider", id: "terminal-divider" });
      items.push({
        kind: "action",
        id: "close-terminal",
        label: "Close terminal",
        icon: PowerIcon,
        destructive: true,
        onSelect: () => void app.closeSession(sessionId),
      });
    }

    return items;
  });

  const hasMenu = createMemo(() => menuItems().length > 0);

  const handleSelect = (item: MenuItem) => {
    if (item.kind !== "action" || item.disabled) return;
    item.onSelect();
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open()) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  window.addEventListener("keydown", handleKeyDown);
  onCleanup(() => window.removeEventListener("keydown", handleKeyDown));

  return (
    <div class="butter-header-menu-wrap">
      <Show
        when={hasMenu()}
        fallback={
          <span
            class={`butter-web-status ${isDirty() ? "dirty" : ""}`}
            aria-live="polite"
          >
            <span class="butter-web-status-dot" aria-hidden="true" />
            <span class="butter-web-status-label">{statusLabel()}</span>
          </span>
        }
      >
        <button
          type="button"
          class={`butter-web-status as-trigger ${isDirty() ? "dirty" : ""} ${open() ? "open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open()}
          onClick={() => setOpen((value) => !value)}
        >
          <span class="butter-web-status-dot" aria-hidden="true" />
          <span class="butter-web-status-label">{statusLabel()}</span>
          <svg class="butter-web-status-chevron" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.75 L6 7.75 L9 4.75" />
          </svg>
        </button>
      </Show>
      <Show when={open() && hasMenu()}>
        <div class="butter-header-menu-overlay" onClick={() => setOpen(false)} />
        <div class="butter-header-menu" role="menu">
          <For each={menuItems()}>
            {(item) => {
              if (item.kind === "divider") {
                return <div class="butter-header-menu-divider" />;
              }
              return (
                <button
                  type="button"
                  role="menuitem"
                  class={`butter-header-menu-item ${item.active ? "active" : ""} ${item.destructive ? "destructive" : ""}`}
                  disabled={item.disabled}
                  onClick={() => handleSelect(item)}
                >
                  <span class="butter-header-menu-icon">{item.icon()}</span>
                  <span class="butter-header-menu-label">{item.label}</span>
                  <Show when={item.shortcut}>
                    <span class="butter-header-menu-shortcut">{item.shortcut}</span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
