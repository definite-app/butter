import "@xterm/xterm/css/xterm.css";
import "../App.css";
import { Match, Show, Switch, createSignal, onCleanup } from "solid-js";
import { useAppContext } from "./context/AppContext";
import { Sidebar } from "../features/sidebar/Sidebar";
import { TerminalArea } from "../features/terminal/TerminalArea";
import { CanvasView } from "../features/canvas/CanvasView";
import { TeamMode } from "../features/team/TeamMode";
import { OneThread } from "../features/thread/OneThread";
import { FooterBar } from "../features/footer/FooterBar";
import { CommandPalette } from "../features/overlays/CommandPalette";
import { TerminalSwitcher } from "../features/overlays/TerminalSwitcher";
import { FileBrowser } from "../features/overlays/FileBrowser";
import { CcSearch } from "../features/overlays/CcSearch";
import { ContextMenus } from "../features/overlays/ContextMenus";
import { ConfirmModal } from "../features/overlays/ConfirmModal";
import { ReopenPicker } from "../features/overlays/ReopenPicker";
import { PresetEditor } from "../features/presets/PresetEditor";
import { ScratchpadModal } from "../features/scratchpad/ScratchpadModal";
import { ImageEditorModal } from "../features/overlays/ImageEditorModal";

export function AppShell() {
  const app = useAppContext();
  const [sidebarPeeking, setSidebarPeeking] = createSignal(false);
  let peekTimer: ReturnType<typeof setTimeout> | undefined;

  const startPeekTimer = () => {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => setSidebarPeeking(true), 1000);
  };

  const cancelPeekTimer = () => {
    clearTimeout(peekTimer);
  };

  const closePeek = () => {
    clearTimeout(peekTimer);
    setSidebarPeeking(false);
  };

  onCleanup(() => clearTimeout(peekTimer));
  const isFullscreenView = () => app.appView() === "team" || app.appView() === "thread";
  const showAppSidebar = () => !isFullscreenView() && !app.sidebarHidden() && !app.quickInputActive();
  const showSidebarPeek = () => !isFullscreenView() && app.sidebarHidden() && !app.quickInputActive();

  return (
    <div class="butter-web-shell">
      <div class={`butter-web-layout ${app.quickInputActive() ? "quick-input-active" : ""} ${app.sidebarHidden() && !app.quickInputActive() ? "sidebar-collapsed" : ""}`}>
        <Show when={showAppSidebar()}>
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
        <Show when={showSidebarPeek()}>
          <div
            class={`sidebar-peek-zone ${sidebarPeeking() ? "peeking" : ""}`}
            onMouseLeave={closePeek}
          >
            <button
              class="sidebar-reopen-btn"
              onClick={() => { closePeek(); app.showSidebar(); }}
              onMouseEnter={startPeekTimer}
              onMouseLeave={cancelPeekTimer}
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
            <Show when={sidebarPeeking()}>
              <div class="sidebar-peek-container">
                <Sidebar />
              </div>
            </Show>
          </div>
        </Show>
        <Switch>
          <Match when={app.appView() === "team"}>
            <TeamMode />
          </Match>
          <Match when={app.appView() === "thread"}>
            <OneThread />
          </Match>
          <Match when={app.appView() === "canvas"}>
            <CanvasView />
          </Match>
          <Match when={true}>
            <TerminalArea />
          </Match>
        </Switch>
      </div>
      <FooterBar />
      <CommandPalette />
      <TerminalSwitcher />
      <FileBrowser />
      <CcSearch />
      <ContextMenus />
      <ReopenPicker />
      <PresetEditor />
      <ScratchpadModal />
      <ImageEditorModal />
      <ConfirmModal />
    </div>
  );
}
