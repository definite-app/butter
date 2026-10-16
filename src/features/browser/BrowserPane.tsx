import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";
import type { BrowserApp } from "../../app/types";

const Icon = (props: { path: string; size?: number }) => (
  <svg
    width={props.size ?? 14}
    height={props.size ?? 14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    innerHTML={props.path}
  />
);

const ICONS = {
  back: `<path d="m15 18-6-6 6-6"/>`,
  forward: `<path d="m9 18 6-6-6-6"/>`,
  reload: `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`,
  maximize: `<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>`,
  minimize: `<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>`,
  inspect: `<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>`,
  close: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  caret: `<path d="m6 15 6-6 6 6"/>`,
};

/** A terminal's browser pane, or a pinned app's (`app` set: full-window,
 * not tied to a terminal). */
export function BrowserPane(props: { sessionId: string; app?: BrowserApp }) {
  const app = useAppContext();
  const [address, setAddress] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  let hostRef: HTMLDivElement | undefined;
  let addressInputRef: HTMLInputElement | undefined;

  const browserState = () => app.browserSessions()[props.sessionId] || null;
  const profile = () => app.browserProfileFor(browserState()?.profileId);
  const profileMenuOpen = () => app.browserProfileMenuFor() === props.sessionId;
  const fullscreen = () => (props.app ? app.appFullWindow() : app.browserFullscreen());
  const preview = () => app.browserPreviews()[props.sessionId] || null;
  const addressSuggestions = createMemo(() => app.getBrowserUrlSuggestions(props.sessionId, address()));
  const [showSuggestions, setShowSuggestions] = createSignal(false);
  const [highlightedSuggestion, setHighlightedSuggestion] = createSignal(-1);

  const syncBounds = () => {
    const host = hostRef;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    void app.updateBrowserPaneBounds(props.sessionId, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  };

  const navigate = (override?: string) => {
    const next = (override ?? address()).trim();
    if (!next) return;
    void app.navigateBrowser(props.sessionId, next);
    setEditing(false);
    setShowSuggestions(false);
    setHighlightedSuggestion(-1);
    addressInputRef?.blur();
  };

  // The profile menu sits over the page (the page hides while it's open), so
  // close it on Escape or a click anywhere else.
  createEffect(() => {
    if (!profileMenuOpen()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") app.setBrowserProfileMenuFor(null);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".butter-browser-profile-picker")) app.setBrowserProfileMenuFor(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    });
  });

  createEffect(() => {
    const state = browserState();
    if (!editing()) {
      setAddress(state?.url || "");
    }
  });

  onMount(() => {
    const host = hostRef;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      syncBounds();
      requestAnimationFrame(() => app.fitTerminalSession(props.sessionId));
    });
    observer.observe(host);
    window.addEventListener("resize", syncBounds);
    requestAnimationFrame(() => {
      syncBounds();
      app.fitTerminalSession(props.sessionId);
    });
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      if (browserState()?.open) {
        void app.setBrowserVisibility(props.sessionId, false);
      }
      requestAnimationFrame(() => app.fitTerminalSession(props.sessionId));
    });
  });

  return (
    <section
      class={`butter-browser-pane ${fullscreen() ? "fullscreen" : ""} ${props.app ? "app" : ""}`}
    >
      <div class="butter-browser-toolbar">
        <div class="butter-browser-toolbar-actions">
          <button
            class="butter-browser-toolbar-btn icon"
            type="button"
            title="Back"
            aria-label="Back"
            disabled={!browserState()?.canGoBack}
            onClick={() => void app.goBackBrowser(props.sessionId)}
          >
            <Icon path={ICONS.back} />
          </button>
          <button
            class="butter-browser-toolbar-btn icon"
            type="button"
            title="Forward"
            aria-label="Forward"
            disabled={!browserState()?.canGoForward}
            onClick={() => void app.goForwardBrowser(props.sessionId)}
          >
            <Icon path={ICONS.forward} />
          </button>
          <button
            class="butter-browser-toolbar-btn icon"
            type="button"
            title="Reload"
            aria-label="Reload"
            onClick={() => void app.reloadBrowser(props.sessionId)}
          >
            <Icon path={ICONS.reload} />
          </button>
        </div>
        <div class="butter-browser-address-wrap">
          <input
            class="butter-browser-address"
            ref={(el) => (addressInputRef = el)}
            value={address()}
            autocomplete="off"
            spellcheck={false}
            placeholder="https://example.com"
            onFocus={() => {
              setEditing(true);
              setShowSuggestions(true);
              setHighlightedSuggestion(-1);
            }}
            onBlur={() => {
              // Delay so mousedown on a suggestion fires first.
              setTimeout(() => {
                setEditing(false);
                setShowSuggestions(false);
              }, 120);
            }}
            onInput={(event) => {
              setAddress(event.currentTarget.value);
              setShowSuggestions(true);
              setHighlightedSuggestion(-1);
            }}
            onKeyDown={(event) => {
              const list = addressSuggestions();
              if (event.key === "Enter") {
                event.preventDefault();
                const idx = highlightedSuggestion();
                if (idx >= 0 && list[idx]) {
                  navigate(list[idx]);
                } else {
                  navigate();
                }
              } else if (event.key === "Escape") {
                setEditing(false);
                setShowSuggestions(false);
                setAddress(browserState()?.url || "");
                addressInputRef?.blur();
              } else if (event.key === "ArrowDown") {
                if (list.length === 0) return;
                event.preventDefault();
                setShowSuggestions(true);
                setHighlightedSuggestion((prev) =>
                  Math.min(prev + 1, list.length - 1)
                );
              } else if (event.key === "ArrowUp") {
                if (list.length === 0) return;
                event.preventDefault();
                setHighlightedSuggestion((prev) => Math.max(prev - 1, -1));
              }
            }}
          />
          <Show when={showSuggestions() && addressSuggestions().length > 0}>
            <div class="butter-browser-address-suggestions" role="listbox">
              {addressSuggestions()
                .slice(0, 10)
                .map((url, index) => (
                  <button
                    class={`butter-browser-address-suggestion ${index === highlightedSuggestion() ? "active" : ""}`}
                    type="button"
                    role="option"
                    aria-selected={index === highlightedSuggestion()}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      navigate(url);
                    }}
                    onMouseEnter={() => setHighlightedSuggestion(index)}
                  >
                    {url}
                  </button>
                ))}
            </div>
          </Show>
        </div>
        <div class="butter-browser-toolbar-actions">
          <Show when={browserState()?.loading}>
            <span class="butter-browser-loading" aria-label="Loading" title="Loading" />
          </Show>
          <button
            class="butter-browser-toolbar-btn icon"
            type="button"
            title={fullscreen() ? "Exit Full Screen (⌘⇧F)" : "Full Screen (⌘⇧F)"}
            aria-label={fullscreen() ? "Exit Full Screen" : "Full Screen"}
            onClick={() => void app.toggleBrowserFullscreen()}
          >
            <Icon path={fullscreen() ? ICONS.minimize : ICONS.maximize} />
          </button>
          <button
            class="butter-browser-toolbar-btn icon"
            type="button"
            title="Open Inspector"
            aria-label="Open Inspector"
            onClick={() => void app.openBrowserInspector(props.sessionId)}
          >
            <Icon path={ICONS.inspect} />
          </button>
          <button
            class="butter-browser-toolbar-btn icon close"
            type="button"
            title={props.app ? "Back to terminals (the app keeps running)" : "Close Browser"}
            aria-label={props.app ? "Back to terminals" : "Close Browser"}
            onClick={() =>
              props.app ? app.closeActiveApp() : void app.closeBrowserForSession(props.sessionId)
            }
          >
            <Icon path={ICONS.close} />
          </button>
        </div>
      </div>
      <div class="butter-browser-host-shell">
        <div class="butter-browser-host" ref={(el) => (hostRef = el)}>
          <Show when={preview()}>
            {(src) => <img class="butter-browser-preview" src={src()} alt="" draggable={false} />}
          </Show>
        </div>
      </div>
      <footer class="butter-browser-footer">
        <div class="butter-browser-profile-picker">
          <button
            class={`butter-browser-profile-chip ${profileMenuOpen() ? "open" : ""}`}
            type="button"
            title="This pane's browser profile: its own cookies, logins and site data"
            aria-haspopup="menu"
            aria-expanded={profileMenuOpen()}
            onClick={() => {
              if (profileMenuOpen()) {
                app.setBrowserProfileMenuFor(null);
              } else {
                void app.refreshBrowserConfig();
                app.setBrowserProfileMenuFor(props.sessionId);
              }
            }}
          >
            <span class="butter-profile-dot" style={{ background: profile().color }} />
            <span class="butter-browser-profile-name">{profile().name}</span>
            <Icon path={ICONS.caret} size={11} />
          </button>
          <Show when={profileMenuOpen()}>
            <div class="butter-browser-profile-menu" role="menu">
              <div class="butter-browser-profile-menu-label">Profile</div>
              <For each={app.browserConfig().profiles}>
                {(entry) => (
                  <button
                    class={`butter-browser-profile-option ${entry.id === profile().id ? "current" : ""}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={entry.id === profile().id}
                    onClick={() => {
                      if (entry.id === profile().id) {
                        app.setBrowserProfileMenuFor(null);
                      } else {
                        void app.switchBrowserProfile(props.sessionId, entry.id);
                      }
                    }}
                  >
                    <span class="butter-profile-dot" style={{ background: entry.color }} />
                    <span class="butter-browser-profile-option-name">{entry.name}</span>
                    <Show when={entry.id === profile().id}>
                      <Icon path={ICONS.check} size={12} />
                    </Show>
                  </button>
                )}
              </For>
              <div class="butter-browser-profile-menu-sep" />
              <button
                class="butter-browser-profile-option manage"
                type="button"
                role="menuitem"
                onClick={() => app.openBrowserProfiles()}
              >
                Manage profiles…
              </button>
            </div>
          </Show>
        </div>
        <span class="butter-browser-footer-value" title={browserState()?.title || ""}>
          {props.app ? props.app.name : browserState()?.title || ""}
        </span>
      </footer>
      <Show when={browserState()?.lastError}>
        <div class="butter-browser-error">{browserState()?.lastError}</div>
      </Show>
    </section>
  );
}
