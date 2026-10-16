import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

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
  trash: `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`,
};

export function BrowserPane(props: { sessionId: string }) {
  const app = useAppContext();
  const [address, setAddress] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const [clearingProfile, setClearingProfile] = createSignal(false);
  let hostRef: HTMLDivElement | undefined;
  let addressInputRef: HTMLInputElement | undefined;

  const browserState = () => app.browserSessions()[props.sessionId] || null;
  const profilePath = () => browserState()?.profilePath || null;
  const profileDescription = () =>
    profilePath()
      ? "Cookies, storage, and logins are shared with other sessions using this project or directory."
      : "Using Butter's default shared browser profile.";
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

  const profileLabel = () => (profilePath() ? "Scoped" : "Shared");

  const clearProfileState = async () => {
    const confirmed = await app.askConfirm({
      title: "Clear browser profile?",
      message:
        "This clears cookies, local storage, cache, and saved URL history for this profile, and resets every open browser pane that shares it.",
      confirmLabel: "Clear profile",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!confirmed) return;
    setClearingProfile(true);
    try {
      await app.clearBrowserProfileState(props.sessionId);
    } finally {
      setClearingProfile(false);
    }
  };

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
    <section class={`butter-browser-pane ${app.browserFullscreen() ? "fullscreen" : ""}`}>
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
            title={app.browserFullscreen() ? "Exit Full Screen" : "Full Screen"}
            aria-label={app.browserFullscreen() ? "Exit Full Screen" : "Full Screen"}
            onClick={() => void app.toggleBrowserFullscreen()}
          >
            <Icon path={app.browserFullscreen() ? ICONS.minimize : ICONS.maximize} />
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
            title="Close Browser"
            aria-label="Close Browser"
            onClick={() => void app.closeBrowserForSession(props.sessionId)}
          >
            <Icon path={ICONS.close} />
          </button>
        </div>
      </div>
      <div class="butter-browser-host-shell">
        <div class="butter-browser-host" ref={(el) => (hostRef = el)} />
      </div>
      <footer class="butter-browser-footer" title={profileDescription()}>
        <span class={`butter-browser-footer-badge ${profilePath() ? "scoped" : "shared"}`}>
          {profileLabel()}
        </span>
        <span
          class={`butter-browser-footer-value ${profilePath() ? "" : "empty"}`}
          title={profilePath() || "Shared default profile"}
        >
          {profilePath() || "Shared default profile"}
        </span>
        <button
          class="butter-browser-footer-action danger icon"
          type="button"
          disabled={clearingProfile()}
          onClick={() => void clearProfileState()}
          title={clearingProfile() ? "Clearing profile…" : "Clear profile state"}
          aria-label="Clear profile state"
        >
          <Icon path={ICONS.trash} size={13} />
        </button>
      </footer>
      <Show when={browserState()?.lastError}>
        <div class="butter-browser-error">{browserState()?.lastError}</div>
      </Show>
    </section>
  );
}
