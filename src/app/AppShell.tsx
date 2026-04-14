import "@xterm/xterm/css/xterm.css";
import "../App.css";
import { Show } from "solid-js";
import { useAppContext } from "./context/AppContext";
import { Sidebar } from "../features/sidebar/Sidebar";
import { TerminalArea } from "../features/terminal/TerminalArea";
import { CanvasView } from "../features/canvas/CanvasView";
import { FooterBar } from "../features/footer/FooterBar";
import { CommandPalette } from "../features/overlays/CommandPalette";
import { FileBrowser } from "../features/overlays/FileBrowser";
import { ContextMenus } from "../features/overlays/ContextMenus";
import { ConfirmModal } from "../features/overlays/ConfirmModal";
import { RestorePrompt } from "../features/overlays/RestorePrompt";
import { PresetEditor } from "../features/presets/PresetEditor";
import { ScratchpadModal } from "../features/scratchpad/ScratchpadModal";
import { ImageEditorModal } from "../features/overlays/ImageEditorModal";

export function AppShell() {
  const app = useAppContext();

  return (
    <div class="butter-web-shell">
      <div class={`butter-web-layout ${app.quickInputActive() ? "quick-input-active" : ""} ${app.sidebarHidden() && !app.quickInputActive() ? "sidebar-collapsed" : ""}`}>
        <Show when={!app.sidebarHidden() && !app.quickInputActive()}>
          <>
            <Sidebar />
            <div
              class={`sidebar-resize-handle ${app.isResizingSidebar() ? "active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                app.setIsResizingSidebar(true);
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
              }}
            />
          </>
        </Show>
        <Show when={app.sidebarHidden() && !app.quickInputActive()}>
          <button
            class="sidebar-reopen-btn"
            onClick={() => app.showSidebar()}
            title="Show Sidebar"
            aria-label="Show Sidebar"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M9 3v18" />
              <path d="m14 9 3 3-3 3" />
            </svg>
          </button>
        </Show>
        <Show when={app.appView() === "terminal"} fallback={<CanvasView />}>
          <TerminalArea />
        </Show>
      </div>
      <FooterBar />
      <CommandPalette />
      <FileBrowser />
      <ContextMenus />
      <RestorePrompt />
      <PresetEditor />
      <ScratchpadModal />
      <ImageEditorModal />
      <ConfirmModal />
    </div>
  );
}
