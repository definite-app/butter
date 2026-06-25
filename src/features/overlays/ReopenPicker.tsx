import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";

type RowState = { selected: boolean; restart: boolean };

/**
 * Startup picker for reopening the terminals that were open at last exit.
 * Each row shows the terminal, its directory, when it was last active, and —
 * if an agent (Claude/Codex) was running — a badge plus a per-row toggle to
 * resume that agent's conversation on reopen.
 */
export function ReopenPicker() {
  const app = useAppContext();
  const [rows, setRows] = createSignal<Record<string, RowState>>({});

  // (Re)initialize selection whenever the candidate set changes. Default: check
  // terminals that had an agent (or were last active) and arm their restart.
  createEffect(() => {
    const candidates = app.restoreCandidates();
    const preferred = app.pendingRestoreActiveId();
    const next: Record<string, RowState> = {};
    for (const c of candidates) {
      const hasAgent = Boolean(c.agent_kind);
      next[c.id] = { selected: hasAgent || c.id === preferred, restart: hasAgent };
    }
    setRows(next);
  });

  const toggleSelected = (id: string) =>
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], selected: !prev[id]?.selected } }));
  const toggleRestart = (id: string) =>
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], restart: !prev[id]?.restart } }));

  const selectedCount = createMemo(() => {
    const r = rows();
    return app.restoreCandidates().filter((c) => r[c.id]?.selected).length;
  });

  const reopenSelected = () => {
    const r = rows();
    const selections = app
      .restoreCandidates()
      .filter((c) => r[c.id]?.selected)
      .map((c) => ({ id: c.id, restartAgent: Boolean(r[c.id]?.restart) }));
    app.reopenSessionsFromPicker(selections);
  };

  const reopenAll = () => {
    const r = rows();
    const selections = app.restoreCandidates().map((c) => ({
      id: c.id,
      restartAgent: r[c.id]?.restart ?? Boolean(c.agent_kind),
    }));
    app.reopenSessionsFromPicker(selections);
  };

  const fmtDir = (dir?: string | null) =>
    dir ? dir.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~") : "";

  const fmtAgo = (sec?: number | null) => {
    if (!sec) return "";
    const s = Math.floor(Date.now() / 1000) - sec;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  const agentLabel = (kind?: string | null) =>
    kind === "claude" ? "Claude" : kind === "codex" ? "Codex" : null;

  return (
    <Show when={app.restorePromptOpen()}>
      <div class="modal-overlay">
        <div class="reopen-card" onClick={(e) => e.stopPropagation()}>
          <div class="reopen-header">
            <div class="reopen-title">Reopen previous terminals</div>
            <div class="reopen-subtitle">
              {app.restoreCandidates().length} terminal
              {app.restoreCandidates().length === 1 ? "" : "s"} from your last session
            </div>
          </div>

          <div class="reopen-list">
            <For each={app.restoreCandidates()}>
              {(c) => {
                const state = () => rows()[c.id] ?? { selected: false, restart: false };
                const label = agentLabel(c.agent_kind);
                return (
                  <div
                    class="reopen-row"
                    classList={{ selected: state().selected }}
                    onClick={() => toggleSelected(c.id)}
                  >
                    <input
                      type="checkbox"
                      class="reopen-check"
                      checked={state().selected}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelected(c.id)}
                    />
                    <div class="reopen-row-main">
                      <div class="reopen-row-title">{c.title || "Terminal"}</div>
                      <div class="reopen-row-meta">
                        <span class="reopen-dir">{fmtDir(c.directory)}</span>
                        <Show when={fmtAgo(c.last_accessed_at ?? c.created_at)}>
                          <span class="reopen-dot">·</span>
                          <span class="reopen-ago">
                            {fmtAgo(c.last_accessed_at ?? c.created_at)}
                          </span>
                        </Show>
                      </div>
                    </div>
                    <Show
                      when={label}
                      fallback={<span class="reopen-noagent">no agent</span>}
                    >
                      <span
                        class="reopen-badge"
                        classList={{
                          claude: c.agent_kind === "claude",
                          codex: c.agent_kind === "codex",
                        }}
                      >
                        {label}
                      </span>
                      <button
                        type="button"
                        class="reopen-restart"
                        classList={{ on: state().restart }}
                        title={
                          state().restart
                            ? "Will resume this agent's conversation"
                            : "Reopen without restarting the agent"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleRestart(c.id);
                        }}
                      >
                        ↻ resume
                      </button>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>

          <div class="reopen-actions">
            <button class="reopen-btn ghost" onClick={() => app.dismissReopenPicker()}>
              New terminal
            </button>
            <div class="reopen-actions-right">
              <button class="reopen-btn" onClick={reopenAll}>
                Reopen all
              </button>
              <button
                class="reopen-btn primary"
                disabled={selectedCount() === 0}
                onClick={reopenSelected}
              >
                Reopen {selectedCount() > 0 ? selectedCount() : ""} selected
              </button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
