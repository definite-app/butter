import { For, Show } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

export function CommandPalette() {
  const app = useAppContext();

  return (
    <Show when={app.showCommandPalette()}>
      <div
        class="command-palette-overlay"
        onClick={() => app.setShowCommandPalette(false)}
      >
        <div
          class="command-palette"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            class="command-palette-input"
            placeholder="Type a command..."
            value={app.commandQuery()}
            ref={(el) => app.setCommandInputRef(el || undefined)}
            spellcheck={false}
            onInput={(e) => {
              app.setCommandQuery(e.currentTarget.value);
              app.setCommandIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                app.setShowCommandPalette(false);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                app.setCommandIndex((prev) =>
                  Math.min(prev + 1, Math.max(app.filteredCommands().length - 1, 0))
                );
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                app.setCommandIndex((prev) => Math.max(prev - 1, 0));
              } else if (e.key === "Enter") {
                const command = app.filteredCommands()[app.commandIndex()];
                if (command) {
                  command.action();
                  app.setShowCommandPalette(false);
                  app.setCommandQuery("");
                }
              }
            }}
          />
          <div class="command-palette-list">
            <For each={app.filteredCommands()}>
              {(command, index) => (
                <button
                  class={`command-palette-item ${index() === app.commandIndex() ? "active" : ""}`}
                  onClick={() => {
                    command.action();
                    app.setShowCommandPalette(false);
                    app.setCommandQuery("");
                  }}
                >
                  <div class="command-palette-item-title">{command.label}</div>
                  <Show when={command.description}>
                    <div class="command-palette-item-sub">
                      {command.description}
                    </div>
                  </Show>
                </button>
              )}
            </For>
            <Show when={app.filteredCommands().length === 0}>
              <div class="command-palette-empty">No matches</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
