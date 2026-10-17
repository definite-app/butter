import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useAppContext } from "../../app/context/AppContext";
import {
  PERMISSION_COPY,
  canAct,
  groupPermissions,
  signerName,
  stateLabel,
  stateTone,
  type PermissionKind,
  type PermissionStatus,
  type PermissionsReport,
} from "./logic";

/** Permissions: what macOS lets Butter, its terminals and ButterRec do.
 * Opened from Cmd+K, and once at launch after the app's signature changes. */
export function Permissions() {
  const app = useAppContext();
  const [report, setReport] = createSignal<PermissionsReport | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [confirmReset, setConfirmReset] = createSignal(false);

  const close = () => {
    app.setShowPermissions(false);
    setConfirmReset(false);
    setNote(null);
    setError(null);
  };

  const refresh = async () => {
    try {
      setReport(await invoke<PermissionsReport>("permissions_status"));
    } catch (err) {
      setError(String(err));
    }
  };

  // Re-check on open and whenever the window comes back, so rows follow
  // toggles flipped in System Settings.
  createEffect(() => {
    if (!app.showPermissions()) return;
    void refresh();
    const onFocus = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmReset()) setConfirmReset(false);
      else close();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("keydown", onKey, true);
    });
  });

  const request = async (item: PermissionStatus) => {
    setBusy(item.kind);
    setError(null);
    setNote(null);
    try {
      const result = await invoke<string>("permission_request", { kind: item.kind satisfies PermissionKind });
      if (result === "opened_settings") {
        const who =
          PERMISSION_COPY[item.kind].group === "butter_rec"
            ? "ButterRec"
            : report()?.bundle_id.endsWith(".dev")
              ? "Butter Dev"
              : "Butter";
        setNote(
          item.kind === "screen_recording"
            ? `Turn on ${who} in System Settings. macOS may only apply it after ${who} restarts.`
            : `Turn on ${who} in System Settings; this updates when you come back.`,
        );
      }
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setConfirmReset(false);
    setBusy("reset");
    setError(null);
    try {
      await invoke("permissions_reset_stale");
      setNote("Cleared. macOS asks again the next time each permission is used.");
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const signingText = () => {
    const signing = report()?.signing;
    if (!signing) return "";
    if (!signing.requirement) return "Not running from an app bundle; permissions belong to the process that started it.";
    if (signing.ad_hoc) {
      return "Signed ad-hoc: macOS sees every install as a new app and these reset. Install with scripts/install-app.sh and a signing certificate to keep them.";
    }
    return `Signed by ${signerName(signing.requirement) ?? "a certificate"}; permissions carry over between installs.`;
  };

  const groupNote = (groupId: string, items: PermissionStatus[]) => {
    if (groupId !== "butter_rec") return null;
    if (items.every((i) => i.state === "not_installed")) return "Not installed. Build it with recorder/build.sh.";
    if (items.every((i) => i.state === "not_running")) return "Its daemon isn't running. Start it with butter-rec install.";
    return null;
  };

  return (
    <Show when={app.showPermissions()}>
      <div class="butter-profiles-overlay" onClick={close}>
        <div class="butter-profiles butter-permissions" role="dialog" aria-label="Permissions" onClick={(e) => e.stopPropagation()}>
          <header class="butter-profiles-header">
            <div>
              <div class="butter-profiles-title">Permissions</div>
              <div class="butter-profiles-subtitle">What macOS lets Butter, its terminals and ButterRec do.</div>
            </div>
            <div class="butter-profiles-header-actions">
              <button class="butter-profiles-icon-btn" type="button" aria-label="Close" onClick={close}>
                ✕
              </button>
            </div>
          </header>

          <Show when={error()}>
            <div class="butter-profiles-error">{error()}</div>
          </Show>
          <Show when={note()}>
            <div class="butter-permissions-note">{note()}</div>
          </Show>

          <div class="butter-profiles-list">
            <Show when={report()} fallback={<div class="butter-permissions-loading">Checking…</div>}>
              {(current) => (
                <For each={groupPermissions(current().items)}>
                  {(group) => (
                    <section class="butter-permissions-group">
                      <div class="butter-permissions-group-title">{group.title}</div>
                      <Show when={groupNote(group.id, group.items)}>
                        {(text) => <div class="butter-permissions-group-note">{text()}</div>}
                      </Show>
                      <For each={group.items}>
                        {(item) => (
                          <div class="butter-permissions-row">
                            <span class={`butter-permissions-dot ${stateTone(item.state)}`} />
                            <div class="butter-permissions-text">
                              <div class="butter-permissions-name">{PERMISSION_COPY[item.kind].name}</div>
                              <div class="butter-permissions-reason">{PERMISSION_COPY[item.kind].reason}</div>
                            </div>
                            <span class="butter-permissions-state">{stateLabel(item)}</span>
                            <div class="butter-permissions-action">
                              <Show when={canAct(item.state)}>
                                <button
                                  class={`butter-profiles-btn ${item.state === "denied" || item.state === "not_determined" ? "primary" : ""}`}
                                  type="button"
                                  disabled={busy() !== null}
                                  title={item.can_prompt ? "Ask macOS" : "Open this pane in System Settings"}
                                  onClick={() => void request(item)}
                                >
                                  {busy() === item.kind
                                    ? "Waiting…"
                                    : item.state === "denied" || item.state === "not_determined"
                                      ? "Grant"
                                      : "Settings"}
                                </button>
                              </Show>
                            </div>
                          </div>
                        )}
                      </For>
                    </section>
                  )}
                </For>
              )}
            </Show>
          </div>

          <footer class="butter-profiles-footer butter-permissions-footer">
            <div class={`butter-permissions-signing ${report()?.signing.ad_hoc && report()?.signing.requirement ? "warn" : ""}`}>
              {signingText()}
            </div>
            <Show
              when={confirmReset()}
              fallback={
                <button
                  class="butter-profiles-btn"
                  type="button"
                  disabled={busy() !== null}
                  title="If a toggle is on in System Settings but doesn't work, an older build left it behind"
                  onClick={() => setConfirmReset(true)}
                >
                  {busy() === "reset" ? "Resetting…" : "Reset stale grants…"}
                </button>
              }
            >
              <div class="butter-permissions-confirm">
                <span>
                  Forget every permission macOS has for {report()?.bundle_id ?? "this app"}? macOS asks again on next
                  use.
                </span>
                <button class="butter-profiles-btn" type="button" onClick={() => setConfirmReset(false)}>
                  Keep
                </button>
                <button class="butter-profiles-btn danger" type="button" onClick={() => void reset()}>
                  Reset
                </button>
              </div>
            </Show>
          </footer>
        </div>
      </div>
    </Show>
  );
}
