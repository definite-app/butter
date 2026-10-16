import { For, Show } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

export function PresetEditor() {
  const app = useAppContext();

  return (
    <Show when={app.showPresetEditor()}>
      <div class="preset-modal" onClick={app.closePresetEditor}>
        <div class="preset-card" onClick={(e) => e.stopPropagation()}>
          <div class="preset-card-header">
            <span>
              {app.presets().some((p) => p.id === app.editingPreset()?.id)
                ? "Preset"
                : "New Preset"}
            </span>
            <button class="preset-close" onClick={app.closePresetEditor}>
              ×
            </button>
          </div>
          <div class="preset-editor-body">
            <div class="preset-field">
              <label>Name</label>
              <input
                type="text"
                value={app.editingPreset()?.name || ""}
                onInput={(e) =>
                  app.setEditingPreset({ ...app.editingPreset()!, name: e.currentTarget.value })
                }
                placeholder="e.g. Backend"
              />
            </div>
            <div class="preset-field">
              <label>Directory</label>
              <input
                type="text"
                value={app.editingPreset()?.directory || ""}
                onInput={(e) =>
                  app.setEditingPreset({ ...app.editingPreset()!, directory: e.currentTarget.value })
                }
                placeholder="e.g. ~/projects"
              />
            </div>
            <div class="preset-field">
              <label>Command</label>
              <input
                type="text"
                value={app.editingPreset()?.command || ""}
                onInput={(e) =>
                  app.setEditingPreset({ ...app.editingPreset()!, command: e.currentTarget.value })
                }
                placeholder="Optional command to run"
              />
            </div>
            <div class="preset-field">
              <label>Footer command preset</label>
              <div class="preset-footer-toggle">
                <input
                  type="checkbox"
                  checked={app.editingPreset()?.footer || false}
                  onChange={(e) =>
                    app.setEditingPreset({ ...app.editingPreset()!, footer: e.currentTarget.checked })
                  }
                />
                <span>Enable in footer quick input</span>
              </div>
            </div>
            <div class="preset-field">
              <label>Worktree preset</label>
              <div class="preset-footer-toggle">
                <input
                  type="checkbox"
                  checked={app.editingPreset()?.worktree || false}
                  onChange={(e) =>
                    app.setEditingPreset({ ...app.editingPreset()!, worktree: e.currentTarget.checked })
                  }
                />
                <span>Create a new git worktree + branch</span>
              </div>
            </div>
            <div class="preset-field">
              <label>Browser profile</label>
              <select
                class="preset-select"
                value={app.browserProfileFor(app.editingPreset()?.browserProfile).id}
                onFocus={() => void app.refreshBrowserConfig()}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  app.setEditingPreset({
                    ...app.editingPreset()!,
                    browserProfile: value === "default" ? undefined : value,
                  });
                }}
              >
                <For each={app.browserConfig().profiles}>
                  {(profile) => <option value={profile.id}>{profile.name}</option>}
                </For>
              </select>
            </div>
            <div class="preset-field">
              <label>Tags</label>
              <div class="preset-tags">
                <For each={app.tags()}>
                  {(tag) => {
                    const isActive = () => (app.editingPreset()?.tags || []).includes(tag);
                    return (
                      <button
                        class={`preset-tag ${isActive() ? "active" : ""}`}
                        onClick={() => app.toggleTagForPreset(tag)}
                      >
                        {tag}
                      </button>
                    );
                  }}
                </For>
                <div class="preset-tag-new">
                  <input
                    class="preset-tag-input"
                    value={app.newPresetTagName()}
                    placeholder="Add tag..."
                    spellcheck={false}
                    onInput={(e) => app.setNewPresetTagName(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        app.createTagAndAssignToPreset();
                      }
                    }}
                  />
                  <button
                    class="preset-tag-add"
                    onClick={() => app.createTagAndAssignToPreset()}
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
            <div class="preset-actions">
              <Show when={app.editingPreset() && app.presets().some((p) => p.id === app.editingPreset()?.id)}>
                <button
                  class="preset-delete"
                  onClick={() => app.deletePreset(app.editingPreset()!.id)}
                >
                  Delete
                </button>
              </Show>
              <div class="preset-actions-right">
                <button class="preset-cancel" onClick={app.closePresetEditor}>
                  Cancel
                </button>
                <button class="preset-save" onClick={app.savePreset}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
