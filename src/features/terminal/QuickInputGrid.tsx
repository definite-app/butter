import { For, Show, createMemo, createSignal } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

const MAX_VISIBLE_TAGS = 5;

export function QuickInputGrid() {
  const app = useAppContext();
  const isIdleFocus = () => app.quickViewMode() === "idle-focus";
  const [showTagOverflow, setShowTagOverflow] = createSignal(false);

  const quickViewSessions = createMemo(() => {
    const byId = new Map<string, (typeof app.sessions)[number]>();
    for (const session of app.sessions) {
      byId.set(session.id, session);
    }
    const result: (typeof app.sessions)[number][] = [];
    for (const id of app.quickViewSessionIds()) {
      const session = byId.get(id);
      if (session) result.push(session);
    }
    return result;
  });

  // All tags including "Untagged"
  const allFilterTags = createMemo(() => {
    return [...app.tags(), "Untagged"];
  });

  const visibleTags = createMemo(() => {
    return allFilterTags().slice(0, MAX_VISIBLE_TAGS);
  });

  const overflowTags = createMemo(() => {
    return allFilterTags().slice(MAX_VISIBLE_TAGS);
  });

  const overflowCount = createMemo(() => overflowTags().length);

  const isTagActive = (tag: string) => {
    if (tag === "Untagged") {
      return app.quickViewShowUntagged();
    }
    return app.quickViewSelectedTags().has(tag);
  };

  const toggleTag = (tag: string) => {
    if (tag === "Untagged") {
      app.toggleQuickViewUntagged();
    } else {
      app.toggleQuickViewTag(tag);
    }
  };

  return (
    <Show when={app.quickInputActive()}>
      <div class={`quick-input-grid ${isIdleFocus() ? "idle-focus" : ""}`}>
        <div class="quick-input-header-bar">
          {/* Left: View Toggle */}
          <div class="quick-input-view-toggle-group">
            <div
              class={`quick-input-toggle-indicator ${isIdleFocus() ? "right" : "left"}`}
            />
            <button
              class={`quick-input-view-toggle ${!isIdleFocus() ? "active" : ""}`}
              type="button"
              aria-pressed={!isIdleFocus()}
              onClick={() => app.setQuickViewMode("grid")}
            >
              Grid
            </button>
            <button
              class={`quick-input-view-toggle ${isIdleFocus() ? "active" : ""}`}
              type="button"
              aria-pressed={isIdleFocus()}
              onClick={() => app.setQuickViewMode("idle-focus")}
            >
              Idle Focus
            </button>
          </div>

          {/* Center: Tag Filters */}
          <div class="quick-input-filter-row">
            <For each={visibleTags()}>
              {(tag, i) => (
                <button
                  class={`quick-input-filter-pill ${isTagActive(tag) ? "active" : ""}`}
                  type="button"
                  aria-pressed={isTagActive(tag)}
                  onClick={() => toggleTag(tag)}
                  style={{ "--pill-index": i() }}
                >
                  {tag}
                </button>
              )}
            </For>
            <Show when={overflowCount() > 0}>
              <div class="quick-input-filter-overflow-wrapper">
                <button
                  class={`quick-input-filter-overflow ${showTagOverflow() ? "open" : ""}`}
                  type="button"
                  onClick={() => setShowTagOverflow(!showTagOverflow())}
                  style={{ "--pill-index": MAX_VISIBLE_TAGS }}
                >
                  +{overflowCount()} more
                </button>
                <Show when={showTagOverflow()}>
                  <div class="quick-input-overflow-dropdown">
                    <For each={overflowTags()}>
                      {(tag) => (
                        <button
                          class={`quick-input-overflow-item ${isTagActive(tag) ? "active" : ""}`}
                          type="button"
                          aria-pressed={isTagActive(tag)}
                          onClick={() => toggleTag(tag)}
                        >
                          {tag}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>

          {/* Right: Actions */}
          <div class="quick-input-header-actions">
            <button
              class="quick-input-clear-link"
              type="button"
              onClick={() => app.clearQuickViewFilters()}
              title="Clear Quick View filters"
            >
              Clear filters
            </button>
            <button
              class="quick-input-close"
              type="button"
              onClick={() => app.toggleQuickInputView()}
              title="Close Quick View"
              aria-label="Close Quick View"
            >
              <svg
                class="quick-input-close-icon"
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              >
                <line x1="2" y1="2" x2="10" y2="10" />
                <line x1="10" y1="2" x2="2" y2="10" />
              </svg>
            </button>
          </div>
        </div>
        <Show
          when={quickViewSessions().length > 0}
          fallback={<div class="quick-input-empty">No terminals match filters</div>}
        >
          <For each={quickViewSessions()}>
            {(session, index) => {
              const previewLines = () => app.sessionPreview()[session.id] || [];
              const draft = () => app.sessionInputDraft()[session.id] || "";
              const sessionTags = () => app.terminalTags()[session.id] || [];
              const isActive = () => app.activeSessionId() === session.id;
              const hasPty = () => Boolean(app.ptyBySession()[session.id]);
              const isIdle = () => app.getSessionState(session.id) === "idle";

              return (
                <div
                  class={`quick-input-cell ${isActive() ? "active" : ""} ${isIdle() ? "idle" : ""}`}
                  style={{ "--stagger-index": index() }}
                >
                  <div class="quick-input-header">
                    <button
                      class="quick-input-title"
                      type="button"
                      onClick={() => app.exitQuickInputToSession(session.id)}
                      title="Open full terminal"
                    >
                      {session.title}
                    </button>
                    <Show when={sessionTags().length > 0}>
                      <div class="quick-input-tags">
                        <For each={sessionTags().slice(0, 3)}>
                          {(tag) => <span class="quick-input-tag">{tag}</span>}
                        </For>
                        <Show when={sessionTags().length > 3}>
                          <span class="quick-input-tag-more">
                            +{sessionTags().length - 3}
                          </span>
                        </Show>
                      </div>
                    </Show>
                    <Show when={isIdle()}>
                      <span class="quick-input-idle-chip">
                        {isIdleFocus() ? "Awaiting input" : "Idle"}
                      </span>
                    </Show>
                    <Show when={isActive()}>
                      <span class="quick-input-badge">Active</span>
                    </Show>
                  </div>
                  <button
                    class="quick-input-preview"
                    type="button"
                    onClick={() => app.exitQuickInputToSession(session.id)}
                    title="Open full terminal"
                  >
                    <Show
                      when={previewLines().length > 0}
                      fallback={<div class="quick-input-placeholder">No output yet</div>}
                    >
                      <For each={previewLines()}>
                        {(line) => <div class="quick-input-line">{line}</div>}
                      </For>
                    </Show>
                  </button>
                  <div class="quick-input-input-row">
                    <input
                      ref={(el) => app.registerQuickInputRef(session.id, el || undefined)}
                      class="quick-input-input"
                      type="text"
                      spellcheck={false}
                      value={draft()}
                      placeholder={hasPty() ? "Type a command..." : "Type a command to start"}
                      onInput={(e) => {
                        const val = e.currentTarget.value;
                        app.setSessionInputDraft((prev) => ({ ...prev, [session.id]: val }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          e.stopPropagation();
                          void app.sendQuickInputToSession(session.id);
                        }
                      }}
                    />
                  </div>
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </Show>
  );
}
