import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

export interface PaletteItem {
  id: string;
  label: string;
  description?: string | null;
}

export function PaletteDialog<T extends PaletteItem>(props: {
  placeholder: string;
  value: string;
  items: readonly T[];
  activeIndex: number;
  emptyText: JSX.Element;
  loadingText?: string;
  errorText?: string | null;
  setInputRef?: (el?: HTMLInputElement) => void;
  onInput: (value: string) => void;
  onActiveIndexChange: (index: number) => void;
  onSelect: (item: T) => void;
  onClose: () => void;
  itemDescription?: (item: T) => JSX.Element;
}) {
  const moveActiveIndex = (delta: number) => {
    props.onActiveIndexChange(
      Math.max(0, Math.min(props.activeIndex + delta, Math.max(props.items.length - 1, 0))),
    );
  };

  return (
    <div
      class="command-palette-overlay"
      onClick={props.onClose}
    >
      <div
        class="command-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          class="command-palette-input"
          placeholder={props.placeholder}
          value={props.value}
          ref={(el) => props.setInputRef?.(el || undefined)}
          spellcheck={false}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              props.onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              moveActiveIndex(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              moveActiveIndex(-1);
            } else if (e.key === "Enter") {
              // The command may move focus to another input (1thread's composer);
              // don't let this Enter type a newline there.
              e.preventDefault();
              const item = props.items[props.activeIndex];
              if (item) {
                props.onSelect(item);
              }
            }
          }}
        />
        <div class="command-palette-list">
          <Show when={!props.loadingText} fallback={<div class="command-palette-empty">{props.loadingText}</div>}>
            <Show when={!props.errorText} fallback={<div class="command-palette-empty error">{props.errorText}</div>}>
              <For each={props.items}>
                {(item, index) => (
                  <button
                    class={`command-palette-item ${index() === props.activeIndex ? "active" : ""}`}
                    onClick={() => props.onSelect(item)}
                  >
                    <div class="command-palette-item-title">{item.label}</div>
                    <Show when={props.itemDescription?.(item) || item.description}>
                      {(description) => (
                        <div class="command-palette-item-sub">
                          {description()}
                        </div>
                      )}
                    </Show>
                  </button>
                )}
              </For>
              <Show when={props.items.length === 0}>
                <div class="command-palette-empty">{props.emptyText}</div>
              </Show>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}

export function CommandPalette() {
  const app = useAppContext();

  return (
    <Show when={app.showCommandPalette() && app.commandPaletteMode() === "commands"}>
      <PaletteDialog
        placeholder="Type a command..."
        value={app.commandQuery()}
        items={app.filteredCommands()}
        activeIndex={app.commandIndex()}
        emptyText="No matches"
        setInputRef={app.setCommandInputRef}
        onInput={(value) => {
          app.setCommandQuery(value);
          app.setCommandIndex(0);
        }}
        onActiveIndexChange={app.setCommandIndex}
        onClose={() => app.setShowCommandPalette(false)}
        onSelect={(command) => {
          command.action();
          // A command that switches the palette's mode (Recordings) keeps it open.
          if (app.commandPaletteMode() === "commands") app.setShowCommandPalette(false);
          app.setCommandQuery("");
        }}
      />
    </Show>
  );
}
