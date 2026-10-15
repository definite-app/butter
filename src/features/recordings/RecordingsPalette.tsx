import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { useAppContext } from "../../app/context/AppContext";
import {
  askAgentCommand,
  expandHome,
  filterDictations,
  filterMeetings,
  formatDuration,
  meetingDate,
  meetingReady,
  meetingStatusLabel,
  oneLine,
  timeAgo,
  type Dictation,
  type MeetingSummary,
} from "./logic";
import "./RecordingsPalette.css";

type Row =
  | { kind: "meeting"; key: string; meeting: MeetingSummary }
  | { kind: "dictation"; key: string; dictation: Dictation };

const MEETING_LIMIT = 50;
const DICTATION_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 150;
const REFRESH_MS = 5000;
const COPIED_CLOSE_MS = 450;

/**
 * butter-rec's meetings and dictations, read from disk (Cmd+Shift+K →
 * "Recordings"). Enter opens a meeting's transcript in a file tab or copies a
 * dictation; Cmd+Enter starts a Claude session about the meeting.
 */
export function RecordingsPalette() {
  const app = useAppContext();
  const [query, setQuery] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [meetings, setMeetings] = createSignal<MeetingSummary[]>([]);
  const [recentDictations, setRecentDictations] = createSignal<Dictation[]>([]);
  // Backend search over the whole history, so older dictations turn up too.
  const [searchedDictations, setSearchedDictations] = createSignal<Dictation[] | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [copiedKey, setCopiedKey] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const isOpen = () => app.showCommandPalette() && app.commandPaletteMode() === "recordings";

  const close = () => {
    if (closeTimer) clearTimeout(closeTimer);
    app.setShowCommandPalette(false);
  };

  const loadMeetings = async () => {
    const list = await invoke<MeetingSummary[]>("recordings_list_meetings", { limit: MEETING_LIMIT });
    setMeetings(list);
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [, dictations] = await Promise.all([
        loadMeetings(),
        invoke<Dictation[]>("recordings_list_dictations", { limit: DICTATION_LIMIT, search: null }),
      ]);
      setRecentDictations(dictations);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  createEffect(
    on(isOpen, (open) => {
      if (!open) return;
      setQuery("");
      setActiveIndex(0);
      setSearchedDictations(null);
      setCopiedKey(null);
      setNow(Date.now());
      requestAnimationFrame(() => inputRef?.focus());
      void load();
    })
  );

  // Keep in-progress meetings' statuses and relative times current while open.
  createEffect(() => {
    if (!isOpen()) return;
    const interval = setInterval(() => {
      setNow(Date.now());
      void loadMeetings().catch(() => undefined);
    }, REFRESH_MS);
    onCleanup(() => clearInterval(interval));
  });

  onCleanup(() => {
    if (searchTimer) clearTimeout(searchTimer);
    if (closeTimer) clearTimeout(closeTimer);
  });

  const updateQuery = (value: string) => {
    setQuery(value);
    setActiveIndex(0);
    if (searchTimer) clearTimeout(searchTimer);
    const trimmed = value.trim();
    if (!trimmed) {
      setSearchedDictations(null);
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        // The backend matches the whole string; filterDictations then
        // requires every term, so search by the longest one.
        const longest = trimmed.split(/\s+/).sort((a, b) => b.length - a.length)[0];
        const found = await invoke<Dictation[]>("recordings_list_dictations", {
          limit: DICTATION_LIMIT,
          search: longest,
        });
        if (query().trim() === trimmed) setSearchedDictations(found);
      } catch (err) {
        console.error("Dictation search failed:", err);
      }
    }, SEARCH_DEBOUNCE_MS);
  };

  const meetingRows = createMemo<Row[]>(() =>
    filterMeetings(meetings(), query(), now()).map((meeting) => ({
      kind: "meeting",
      key: `m:${meeting.id}`,
      meeting,
    }))
  );

  const dictationRows = createMemo<Row[]>(() =>
    filterDictations(searchedDictations() ?? recentDictations(), query()).map((dictation, i) => ({
      kind: "dictation",
      key: `d:${dictation.at}:${i}`,
      dictation,
    }))
  );

  const rows = createMemo(() => [...meetingRows(), ...dictationRows()]);
  const activeRow = () => rows()[activeIndex()];

  const moveActive = (delta: number) => {
    const last = Math.max(rows().length - 1, 0);
    setActiveIndex((prev) => Math.max(0, Math.min(prev + delta, last)));
    queueMicrotask(() => listRef?.querySelector(".recordings-row.active")?.scrollIntoView({ block: "nearest" }));
  };

  const copyDictation = async (row: Extract<Row, { kind: "dictation" }>) => {
    try {
      await navigator.clipboard.writeText(row.dictation.text);
      setCopiedKey(row.key);
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(close, COPIED_CLOSE_MS);
    } catch (err) {
      setError(`Couldn't copy: ${String(err)}`);
    }
  };

  const openTranscript = async (meeting: MeetingSummary) => {
    if (!meetingReady(meeting)) return;
    close();
    // File tabs live in the terminal workspace and need a terminal to hang off.
    if (app.appView() !== "terminal") app.setAppView("terminal");
    const sessionId = app.activeSessionId() ?? app.createSession();
    await app.openFileInButter(meeting.transcript_path, sessionId);
  };

  const askAgent = async (meeting: MeetingSummary) => {
    if (!meetingReady(meeting)) return;
    close();
    const configured = app.appConfig()?.general.default_directory?.trim() || "~";
    const home = await homeDir().catch(() => null);
    const directory = home ? expandHome(configured, home) : undefined;
    app.setAppView("terminal");
    app.createSession(undefined, askAgentCommand(meeting), directory, `claude · ${meeting.title}`);
  };

  const runPrimary = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "dictation") void copyDictation(row);
    else void openTranscript(row.meeting);
  };

  const runSecondary = (row: Row | undefined) => {
    if (row?.kind === "meeting") void askAgent(row.meeting);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey) runSecondary(activeRow());
      else runPrimary(activeRow());
    } else if (e.key === "Backspace" && !query()) {
      // Back to the command list this mode was opened from.
      e.preventDefault();
      app.setCommandPaletteMode("commands");
      app.setCommandQuery("");
      app.setCommandIndex(0);
    }
  };

  const indexOf = (row: Row) => rows().indexOf(row);

  const renderRow = (row: Row) => {
    const index = () => indexOf(row);
    const disabled = () => row.kind === "meeting" && !meetingReady(row.meeting);
    return (
      <button
        class="recordings-row"
        classList={{ active: index() === activeIndex(), disabled: disabled() }}
        onMouseMove={() => setActiveIndex(index())}
        onClick={(e) => (e.metaKey ? runSecondary(row) : runPrimary(row))}
        title={row.kind === "meeting" && row.meeting.error ? row.meeting.error : undefined}
      >
        <Show
          when={row.kind === "meeting" ? row.meeting : null}
          fallback={
            <>
              <span class="recordings-row-title">
                {row.kind === "dictation" ? oneLine(row.dictation.text) : ""}
              </span>
              <span class="recordings-row-meta">
                {copiedKey() === row.key
                  ? <span class="recordings-copied">Copied</span>
                  : row.kind === "dictation" ? timeAgo(row.dictation.at, now()) : ""}
              </span>
            </>
          }
        >
          {(meeting) => (
            <>
              <span class="recordings-row-title">{meeting().title}</span>
              <span class="recordings-row-meta">
                <Show when={meetingStatusLabel(meeting())}>
                  {(label) => (
                    <span class={`recordings-status recordings-status-${meeting().status}`}>{label()}</span>
                  )}
                </Show>
                <span>{meetingDate(meeting().started_at, now())}</span>
                <Show when={formatDuration(meeting().duration)}>
                  {(duration) => <span>{duration()}</span>}
                </Show>
              </span>
            </>
          )}
        </Show>
      </button>
    );
  };

  return (
    <Show when={isOpen()}>
      <div class="command-palette-overlay" onClick={close}>
        <div class="command-palette recordings-palette" onClick={(e) => e.stopPropagation()}>
          <input
            class="command-palette-input"
            placeholder="Search meetings and dictations..."
            value={query()}
            ref={(el) => (inputRef = el)}
            spellcheck={false}
            autocomplete="off"
            onInput={(e) => updateQuery(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <div class="command-palette-list recordings-list" ref={(el) => (listRef = el)}>
            <Show when={error()}>
              {(message) => <div class="command-palette-empty error">{message()}</div>}
            </Show>
            <Show when={meetingRows().length > 0}>
              <div class="recordings-section">Meetings</div>
              <For each={meetingRows()}>{renderRow}</For>
            </Show>
            <Show when={dictationRows().length > 0}>
              <div class="recordings-section">Dictations</div>
              <For each={dictationRows()}>{renderRow}</For>
            </Show>
            <Show when={!error() && rows().length === 0}>
              <div class="command-palette-empty">
                {loading()
                  ? "Loading..."
                  : query().trim()
                    ? "No matches"
                    : "No recordings yet. Start one with butter-rec (ctrl+opt+m for a meeting)."}
              </div>
            </Show>
          </div>
          <div class="recordings-footer">
            <Show
              when={activeRow()?.kind === "meeting"}
              fallback={<span>↩ Copy</span>}
            >
              <span>↩ Open transcript</span>
              <span>⌘↩ Ask an agent</span>
            </Show>
            <span>Esc Close</span>
          </div>
        </div>
      </div>
    </Show>
  );
}
