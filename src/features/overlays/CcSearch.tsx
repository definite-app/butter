import { For, Show } from "solid-js";
import { useAppContext } from "../../app/context/AppContext";
import type { CcSearchResult } from "../../app/types";

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function formatIndexAge(min: number | null): string {
  if (min === null) return "";
  if (min < 1) return "index fresh";
  if (min < 60) return `index ${Math.round(min)}m old`;
  const h = min / 60;
  if (h < 24) return `index ${Math.round(h)}h old`;
  return `index ${Math.round(h / 24)}d old`;
}

function lastPathSegment(dir: string | null): string {
  if (!dir) return "";
  const parts = dir.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dir;
}

function resultTitle(result: CcSearchResult): string {
  const title = result.title?.trim();
  if (title) return title;
  const seg = lastPathSegment(result.cwd) || lastPathSegment(result.project_dir);
  return seg || `Session ${result.session_id.slice(0, 8)}`;
}

/** Split text into matched / unmatched parts for highlighting. */
function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  while (i <= text.length) {
    const idx = lower.indexOf(ql, i);
    if (idx < 0) {
      if (i < text.length) parts.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) parts.push({ text: text.slice(i, idx), match: false });
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
  }
  return parts;
}

export function CcSearch() {
  const app = useAppContext();
  let listRef: HTMLDivElement | undefined;

  const scrollActiveIntoView = () => {
    queueMicrotask(() => {
      listRef
        ?.querySelector(".cc-search-result.active")
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const results = app.ccSearchResults();
    if (e.key === "Escape") {
      e.preventDefault();
      app.closeCcSearch();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      app.setCcSearchIndex((prev) => Math.min(prev + 1, Math.max(results.length - 1, 0)));
      scrollActiveIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      app.setCcSearchIndex((prev) => Math.max(prev - 1, 0));
      scrollActiveIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = results[app.ccSearchIndex()];
      if (result) app.resumeCcSearchResult(result);
    }
  };

  return (
    <Show when={app.showCcSearch()}>
      <div class="cc-search-overlay" onClick={() => app.closeCcSearch()}>
        <div class="cc-search" onClick={(e) => e.stopPropagation()}>
          <input
            class="cc-search-input"
            placeholder="Search past Claude Code conversations…"
            value={app.ccSearchQuery()}
            ref={(el) => app.setCcSearchInputRef(el || undefined)}
            spellcheck={false}
            autocomplete="off"
            onInput={(e) => app.updateCcSearchQuery(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />

          <div class="cc-search-list" ref={(el) => (listRef = el)}>
            <Show when={app.ccSearchError()}>
              <div class="cc-search-empty cc-search-error">{app.ccSearchError()}</div>
            </Show>

            <Show when={!app.ccSearchError() && app.ccSearchQuery().trim().length < 2}>
              <div class="cc-search-empty">Type at least 2 characters to search.</div>
            </Show>

            <Show
              when={
                !app.ccSearchError() &&
                app.ccSearchQuery().trim().length >= 2 &&
                app.ccSearchResults().length === 0
              }
            >
              <div class="cc-search-empty">
                {app.ccSearchLoading() ? "Searching…" : "No conversations found."}
              </div>
            </Show>

            <For each={app.ccSearchResults()}>
              {(result, index) => (
                <div
                  class={`cc-search-result ${index() === app.ccSearchIndex() ? "active" : ""}`}
                  onClick={() => app.resumeCcSearchResult(result)}
                  onMouseEnter={() => app.setCcSearchIndex(index())}
                >
                  <div class="cc-search-result-head">
                    <span class="cc-search-result-title">{resultTitle(result)}</span>
                    <span class="cc-search-result-time">{timeAgo(result.latest_match)}</span>
                  </div>
                  <div class="cc-search-result-meta">
                    <Show when={result.project_dir || result.cwd}>
                      <span class="cc-search-result-path">
                        {result.project_dir || result.cwd}
                      </span>
                    </Show>
                    <Show when={result.git_branch}>
                      <span class="cc-search-result-branch">⌥ {result.git_branch}</span>
                    </Show>
                    <span class="cc-search-result-count">
                      {result.match_count} match{result.match_count === 1 ? "" : "es"}
                    </span>
                  </div>
                  <For each={result.snippets}>
                    {(snippet) => (
                      <div class="cc-search-snippet">
                        <span class="cc-search-snippet-role">
                          {snippet.role === "user" ? "›" : "•"}
                        </span>
                        <span class="cc-search-snippet-text">
                          <For each={highlightParts(snippet.text, app.ccSearchQuery())}>
                            {(part) =>
                              part.match ? <mark>{part.text}</mark> : <>{part.text}</>
                            }
                          </For>
                        </span>
                      </div>
                    )}
                  </For>
                  <div class="cc-search-result-actions">
                    <button
                      class="cc-search-action-btn"
                      title="Copy `claude --resume` command"
                      onClick={(e) => {
                        e.stopPropagation();
                        void app.copyCcResumeCommand(result);
                      }}
                    >
                      Copy resume
                    </button>
                    <button
                      class="cc-search-action-btn"
                      title="Copy the full text of every matching message"
                      onClick={(e) => {
                        e.stopPropagation();
                        void app.copyCcMatch(result);
                      }}
                    >
                      Copy match
                    </button>
                    <button
                      class="cc-search-action-btn"
                      title="Copy the full conversation transcript"
                      onClick={(e) => {
                        e.stopPropagation();
                        void app.copyCcThread(result);
                      }}
                    >
                      Copy thread
                    </button>
                    <button
                      class="cc-search-action-btn"
                      title="Open the raw session JSON in a temp file"
                      onClick={(e) => {
                        e.stopPropagation();
                        void app.openCcSessionFile(result);
                      }}
                    >
                      Open JSON
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>

          <div class="cc-search-footer">
            <div class="cc-search-footer-hints">
              <span>↑↓ Navigate</span>
              <span>↩ Resume in new terminal</span>
              <span>Esc Close</span>
            </div>
            <Show when={app.ccSearchMeta()}>
              {(meta) => (
                <span class="cc-search-footer-meta">
                  {meta().elapsed_ms} ms
                  <Show when={meta().db_age_min !== null}>
                    {" · "}
                    {formatIndexAge(meta().db_age_min)}
                  </Show>
                </span>
              )}
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
