import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";
import type { PaletteCommand } from "../../app/useAppModel";

export interface PaletteItem {
  id: string;
  label: string;
  description?: string | null;
  /** Items with a group get a header where the group starts. */
  group?: string;
  /** Muted text on the right, such as a key binding. */
  hint?: string;
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
  /** Tab on the active item; return true when handled. */
  onTab?: (item: T) => boolean;
  /** Enter with this set submits the input instead of selecting an item. */
  onSubmit?: (value: string) => void;
  /** Backspace in an empty input. */
  onBackspaceEmpty?: () => void;
  /** Escape; defaults to onClose. */
  onEscape?: () => void;
  /** A label in front of the input, such as the command asking for text. */
  inputPrefix?: string | null;
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
        <div class="command-palette-input-row">
          <Show when={props.inputPrefix}>
            {(prefix) => <span class="command-palette-input-prefix">{prefix()}</span>}
          </Show>
          <input
            class="command-palette-input"
            placeholder={props.placeholder}
            value={props.value}
            ref={(el) => props.setInputRef?.(el || undefined)}
            spellcheck={false}
            onInput={(e) => props.onInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                (props.onEscape ?? props.onClose)();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                moveActiveIndex(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                moveActiveIndex(-1);
              } else if (e.key === "Tab" && props.onTab) {
                const item = props.items[props.activeIndex];
                if (item && props.onTab(item)) e.preventDefault();
              } else if (e.key === "Backspace" && props.onBackspaceEmpty && !e.currentTarget.value) {
                e.preventDefault();
                props.onBackspaceEmpty();
              } else if (e.key === "Enter") {
                // The command may move focus to another input (1thread's composer);
                // don't let this Enter type a newline there.
                e.preventDefault();
                if (props.onSubmit) {
                  props.onSubmit(e.currentTarget.value);
                  return;
                }
                const item = props.items[props.activeIndex];
                if (item) {
                  props.onSelect(item);
                }
              }
            }}
          />
        </div>
        <div class="command-palette-list">
          <Show when={!props.loadingText} fallback={<div class="command-palette-empty">{props.loadingText}</div>}>
            <Show when={!props.errorText} fallback={<div class="command-palette-empty error">{props.errorText}</div>}>
              <For each={props.items}>
                {(item, index) => (
                  <>
                    <Show when={item.group && item.group !== props.items[index() - 1]?.group}>
                      <div class="command-palette-group">{item.group}</div>
                    </Show>
                    <button
                      class={`command-palette-item palette-row ${index() === props.activeIndex ? "active" : ""}`}
                      onClick={() => props.onSelect(item)}
                    >
                      <div class="command-palette-item-main">
                        <div class="command-palette-item-title">{item.label}</div>
                        <Show when={props.itemDescription?.(item) || item.description}>
                          {(description) => (
                            <div class="command-palette-item-sub">
                              {description()}
                            </div>
                          )}
                        </Show>
                      </div>
                      <Show when={item.hint}>
                        <span class="command-palette-item-hint">{item.hint}</span>
                      </Show>
                    </button>
                  </>
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

  const askForQuery = (command: PaletteCommand) => {
    app.setPaletteArgCommand(command);
    app.setPaletteArgValue("");
  };

  return (
    <Show when={app.showCommandPalette() && app.commandPaletteMode() === "commands"}>
      <Show
        when={app.paletteArgCommand()}
        fallback={
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
            onTab={(command) => {
              if (!command.runWithQuery) return false;
              askForQuery(command);
              return true;
            }}
            onSelect={(command) => {
              // A browser.toml command with {query} asks for text first.
              if (command.runWithQuery) {
                askForQuery(command);
                return;
              }
              void command.action();
              // A command that switches the palette's mode (Recordings) keeps it open.
              if (app.commandPaletteMode() === "commands") app.setShowCommandPalette(false);
              app.setCommandQuery("");
            }}
          />
        }
      >
        {(command) => (
          <PaletteDialog
            placeholder={`Text for ${command().queryPrompt || command().label}, then Enter`}
            inputPrefix={command().queryPrompt || command().label}
            value={app.paletteArgValue()}
            items={[]}
            activeIndex={0}
            emptyText={
              <span>
                <kbd>↵</kbd> open · <kbd>esc</kbd> back to commands
              </span>
            }
            setInputRef={app.setCommandInputRef}
            onInput={app.setPaletteArgValue}
            onActiveIndexChange={() => {}}
            onSelect={() => {}}
            onClose={() => app.setShowCommandPalette(false)}
            onEscape={() => app.clearPaletteArg()}
            onBackspaceEmpty={() => app.clearPaletteArg()}
            onSubmit={(value) => {
              const run = command().runWithQuery;
              app.setShowCommandPalette(false);
              app.setCommandQuery("");
              run?.(value);
            }}
          />
        )}
      </Show>
    </Show>
  );
}
