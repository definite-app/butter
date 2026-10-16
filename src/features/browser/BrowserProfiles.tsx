import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";
import type { BrowserProfile } from "../../app/types";

// Muted swatches that sit well on the warm dark surfaces; the first is
// Butter yellow.
const SWATCHES = ["#F5D76E", "#7AA2F7", "#9ECE6A", "#E0AF68", "#BB9AF7", "#F7768E", "#7DCFFF", "#C0CAF5"];

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Browser Profiles: what each profile is used by and which sites it keeps
 * data for. Opened from Cmd+K or a pane's profile chip. */
export function BrowserProfiles() {
  const app = useAppContext();
  const [sites, setSites] = createSignal<Record<string, string[] | null>>({});
  const [siteErrors, setSiteErrors] = createSignal<Record<string, string>>({});
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");
  const [confirmClear, setConfirmClear] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [newColor, setNewColor] = createSignal(SWATCHES[1]);
  const [error, setError] = createSignal<string | null>(null);

  const close = () => {
    app.setShowBrowserProfiles(false);
    setRenaming(null);
    setConfirmClear(null);
    setCreating(false);
    setError(null);
  };

  const loadSites = async (profileId: string) => {
    try {
      const list = await app.browserProfileSites(profileId);
      setSites((prev) => ({ ...prev, [profileId]: list }));
      setSiteErrors((prev) => {
        const next = { ...prev };
        delete next[profileId];
        return next;
      });
    } catch (err) {
      setSiteErrors((prev) => ({ ...prev, [profileId]: String(err) }));
    }
  };

  // Fetch every profile's sites when the view opens.
  // Not on every browser.toml refresh, so a rename doesn't blank the list.
  createEffect(
    on(app.showBrowserProfiles, (open) => {
      if (!open) return;
      setSites({});
      for (const profile of app.browserConfig().profiles) void loadSites(profile.id);
    }),
  );
  // Profiles added to browser.toml while the view is open.
  createEffect(
    on(
      () => app.browserConfig().profiles.map((p) => p.id),
      (ids) => {
        if (!app.showBrowserProfiles()) return;
        const known = sites();
        for (const id of ids) if (!(id in known)) void loadSites(id);
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!app.showBrowserProfiles()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (renaming()) setRenaming(null);
      else if (creating()) setCreating(false);
      else close();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const saveRename = (profile: BrowserProfile) => {
    const name = renameValue().trim();
    setRenaming(null);
    if (!name || name === profile.name) return;
    void run(`rename:${profile.id}`, () => app.updateBrowserProfile(profile.id, { name }));
  };

  const setColor = (profile: BrowserProfile, color: string) => {
    if (color === profile.color) return;
    void run(`color:${profile.id}`, () => app.updateBrowserProfile(profile.id, { color }));
  };

  const clearProfile = (profile: BrowserProfile) => {
    setConfirmClear(null);
    void run(`clear:${profile.id}`, async () => {
      await app.clearBrowserProfile(profile.id);
      await loadSites(profile.id);
    });
  };

  const removeSite = (profile: BrowserProfile, site: string) => {
    void run(`site:${profile.id}:${site}`, async () => {
      await app.removeBrowserProfileSite(profile.id, site);
      await loadSites(profile.id);
    });
  };

  const create = () => {
    const name = newName().trim();
    if (!name) return;
    void run("create", async () => {
      const profile = await app.createBrowserProfile(name, newColor());
      setCreating(false);
      setNewName("");
      await loadSites(profile.id);
    });
  };

  const usageText = (profileId: string) => {
    const usage = app.browserProfileUsage(profileId);
    const parts: string[] = [];
    if (usage.presets.length > 0) {
      parts.push(
        usage.presets.length <= 2
          ? `Presets: ${usage.presets.map((p) => p.name).join(", ")}`
          : plural(usage.presets.length, "preset"),
      );
    }
    if (usage.apps.length > 0) parts.push(`Apps: ${usage.apps.map((a) => a.name).join(", ")}`);
    if (usage.openPanes > 0) parts.push(plural(usage.openPanes, "open pane"));
    return parts.length > 0 ? parts.join(" · ") : "Not used by a preset or app";
  };

  return (
    <Show when={app.showBrowserProfiles()}>
      <div class="butter-profiles-overlay" onClick={close}>
        <div class="butter-profiles" role="dialog" aria-label="Browser profiles" onClick={(e) => e.stopPropagation()}>
          <header class="butter-profiles-header">
            <div>
              <div class="butter-profiles-title">Browser profiles</div>
              <div class="butter-profiles-subtitle">
                Each keeps its own cookies, logins and site data.
              </div>
            </div>
            <div class="butter-profiles-header-actions">
              <button
                class="butter-profiles-link"
                type="button"
                title={app.browserConfig().path}
                onClick={() => void app.openBrowserConfigFile()}
              >
                Edit browser.toml
              </button>
              <button class="butter-profiles-icon-btn" type="button" aria-label="Close" onClick={close}>
                ✕
              </button>
            </div>
          </header>

          <Show when={app.browserConfig().errors.length > 0}>
            <div class="butter-profiles-warnings">
              <For each={app.browserConfig().errors}>{(line) => <div>{line}</div>}</For>
            </div>
          </Show>
          <Show when={error()}>
            <div class="butter-profiles-error">{error()}</div>
          </Show>

          <div class="butter-profiles-list">
            <For each={app.browserConfig().profiles}>
              {(profile) => (
                <section class="butter-profile-card">
                  <div class="butter-profile-row">
                    <span class="butter-profile-dot large" style={{ background: profile.color }} />
                    <div class="butter-profile-heading">
                      <Show
                        when={renaming() === profile.id}
                        fallback={
                          <button
                            class="butter-profile-name"
                            type="button"
                            title="Rename"
                            onClick={() => {
                              setRenameValue(profile.name);
                              setRenaming(profile.id);
                            }}
                          >
                            {profile.name}
                          </button>
                        }
                      >
                        <input
                          class="butter-profile-rename"
                          value={renameValue()}
                          ref={(el) => requestAnimationFrame(() => el.select())}
                          onInput={(e) => setRenameValue(e.currentTarget.value)}
                          onBlur={() => saveRename(profile)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              saveRename(profile);
                            }
                          }}
                        />
                      </Show>
                      <div class="butter-profile-meta">
                        <span class="butter-profile-id">{profile.id}</span>
                        <span>{usageText(profile.id)}</span>
                      </div>
                    </div>
                    <div class="butter-profile-actions">
                      <Show
                        when={confirmClear() === profile.id}
                        fallback={
                          <button
                            class="butter-profiles-btn"
                            type="button"
                            disabled={busy() === `clear:${profile.id}`}
                            title="Delete cookies, logins, storage and cache; reloads its open panes"
                            onClick={() => setConfirmClear(profile.id)}
                          >
                            {busy() === `clear:${profile.id}` ? "Clearing…" : "Clear data"}
                          </button>
                        }
                      >
                        <button class="butter-profiles-btn" type="button" onClick={() => setConfirmClear(null)}>
                          Keep
                        </button>
                        <button class="butter-profiles-btn danger" type="button" onClick={() => clearProfile(profile)}>
                          Clear everything
                        </button>
                      </Show>
                    </div>
                  </div>

                  <div class="butter-profile-swatches" aria-label="Color">
                    <For each={SWATCHES}>
                      {(color) => (
                        <button
                          class={`butter-profile-swatch ${color.toLowerCase() === profile.color.toLowerCase() ? "current" : ""}`}
                          type="button"
                          style={{ background: color }}
                          aria-label={`Color ${color}`}
                          onClick={() => setColor(profile, color)}
                        />
                      )}
                    </For>
                  </div>

                  <div class="butter-profile-sites">
                    <Show
                      when={sites()[profile.id]}
                      fallback={
                        <span class="butter-profile-sites-empty">
                          {siteErrors()[profile.id] ? `Couldn't read site data: ${siteErrors()[profile.id]}` : "Loading sites…"}
                        </span>
                      }
                    >
                      {(list) => (
                        <Show when={list().length > 0} fallback={<span class="butter-profile-sites-empty">No site data</span>}>
                          <For each={list()}>
                            {(site) => (
                              <span class="butter-profile-site">
                                <span>{site}</span>
                                <button
                                  type="button"
                                  class="butter-profile-site-remove"
                                  title={`Remove ${site}'s cookies and storage`}
                                  aria-label={`Remove ${site}'s data`}
                                  disabled={busy() === `site:${profile.id}:${site}`}
                                  onClick={() => removeSite(profile, site)}
                                >
                                  ✕
                                </button>
                              </span>
                            )}
                          </For>
                        </Show>
                      )}
                    </Show>
                  </div>
                </section>
              )}
            </For>
          </div>

          <footer class="butter-profiles-footer">
            <Show
              when={creating()}
              fallback={
                <button class="butter-profiles-btn primary" type="button" onClick={() => setCreating(true)}>
                  New profile
                </button>
              }
            >
              <div class="butter-profiles-create">
                <span class="butter-profile-dot large" style={{ background: newColor() }} />
                <input
                  class="butter-profile-rename"
                  placeholder="Profile name, such as Work"
                  value={newName()}
                  ref={(el) => requestAnimationFrame(() => el.focus())}
                  onInput={(e) => setNewName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      create();
                    }
                  }}
                />
                <div class="butter-profile-swatches inline">
                  <For each={SWATCHES}>
                    {(color) => (
                      <button
                        class={`butter-profile-swatch ${color === newColor() ? "current" : ""}`}
                        type="button"
                        style={{ background: color }}
                        aria-label={`Color ${color}`}
                        onClick={() => setNewColor(color)}
                      />
                    )}
                  </For>
                </div>
                <button class="butter-profiles-btn" type="button" onClick={() => setCreating(false)}>
                  Cancel
                </button>
                <button
                  class="butter-profiles-btn primary"
                  type="button"
                  disabled={!newName().trim() || busy() === "create"}
                  onClick={create}
                >
                  Create
                </button>
              </div>
            </Show>
          </footer>
        </div>
      </div>
    </Show>
  );
}
