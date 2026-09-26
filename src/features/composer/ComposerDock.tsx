import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
// Editing contributions (word ops, clipboard, undo of cursor moves, line ops).
import "monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations";
import "monaco-editor/esm/vs/editor/contrib/wordPartOperations/browser/wordPartOperations";
import "monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo";
import "monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/min/vs/editor/editor.main.css";
import { useAppContext } from "../../app/context/AppContext";
import type { FileBrowserEntry } from "../../app/types";
import { extractImageFromClipboard } from "../../utils/clipboard";
import { ensureMonacoEnvironment } from "../files/monacoEnv";
import {
  SECTION_LABEL,
  capBySection,
  currentWord,
  isRemoteCommand,
  matchSessions,
  prefixCompletion,
  relativeTime,
  stripSigil,
  wordsOf,
  type Suggestion,
} from "./logic";
import { jevRanker, jevStatus, rankCandidatesLocally, type RankerName } from "./ranker";
import "./ComposerDock.css";

/** One keycap per key, so symbols like ⌘ ⇧ ↵ stay legible instead of running together. */
function Keys(props: { keys: string[] }) {
  return (
    <span class="composer-keys">
      <For each={props.keys}>{(k) => <kbd>{k}</kbd>}</For>
    </span>
  );
}

interface HistoryEntry {
  session_id: string;
  session_title: string;
  text: string;
  sent_at: number;
  path: string;
}

interface DraftState {
  path: string;
  text: string;
}

interface ComposerAction {
  name: string;
  invoke: string;
  description: string;
  kind: string;
  scope: string;
  harness: "claude" | "codex";
}

const HEIGHT_KEY = "butter.composer-height";
const PRESS_ENTER_KEY = "butter.composer-press-enter";
const DEFAULT_HEIGHT = 330;
const MIN_HEIGHT = 170;
const MIN_TERMINAL_HEIGHT = 120;
const AUTOSAVE_MS = 400;
const SUGGEST_DEBOUNCE_MS = 90;
const FILE_SEARCH_DEBOUNCE_MS = 140;
const EDITOR_FONT = '"SF Pro Text", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';

const readNumber = (key: string, fallback: number) => {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

const readBool = (key: string, fallback: boolean) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
};

const writeStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable; keep the in-memory value
  }
};

const firstLine = (text: string, max = 90) => {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const HARNESS_LABEL: Record<"claude" | "codex", string> = { claude: "Claude", codex: "Codex" };

// Module-level caches shared by every dock instance.
const actionsCache = new Map<string, Promise<ComposerAction[]>>();
const fileSearchCache = new Map<string, FileBrowserEntry[]>();

const loadActions = (cwd: string | null, harness: "claude" | "codex") => {
  const key = `${harness}\u0000${cwd ?? ""}`;
  // The backend caches too and rescans when a skills dir mtime changes, so a
  // short-lived frontend cache (per dock open) is enough.
  let pending = actionsCache.get(key);
  if (!pending) {
    pending = invoke<ComposerAction[]>("composer_list_actions", { cwd, harness }).catch(() => []);
    actionsCache.set(key, pending);
    setTimeout(() => actionsCache.delete(key), 30_000);
  }
  return pending;
};

export function ComposerDock(props: { sessionId: string }) {
  const app = useAppContext();
  const paneSession = () => app.sessions.find((s) => s.id === props.sessionId);

  const [height, setHeight] = createSignal(readNumber(HEIGHT_KEY, DEFAULT_HEIGHT));
  const [tab, setTab] = createSignal<"draft" | "history">("draft");
  const [pressEnter, setPressEnter] = createSignal(readBool(PRESS_ENTER_KEY, true));
  const [targetId, setTargetId] = createSignal(props.sessionId);
  const [text, setText] = createSignal("");
  const [draftPath, setDraftPath] = createSignal("");
  const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved" | "error">("idle");
  const [history, setHistory] = createSignal<HistoryEntry[]>([]);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);

  const [rows, setRows] = createSignal<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [navigated, setNavigated] = createSignal(false);
  const [rankedBy, setRankedBy] = createSignal<RankerName>("local");
  const [listPos, setListPos] = createSignal<{ left: number; top?: number; bottom?: number } | null>(null);
  const [ghost, setGhost] = createSignal("");
  const [jevOn, setJevOn] = createSignal(false);

  const [wisprAvailable, setWisprAvailable] = createSignal(false);
  const [handsFree, setHandsFree] = createSignal(false);

  const [cwd, setCwd] = createSignal<string | null>(null);
  const [actions, setActions] = createSignal<ComposerAction[]>([]);

  let rootRef: HTMLElement | undefined;
  let editorHost: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  let model: monaco.editor.ITextModel | undefined;
  let ghostDecorations: monaco.editor.IEditorDecorationsCollection | undefined;
  let ctxSuggest: monaco.editor.IContextKey<boolean> | undefined;
  let ctxGhost: monaco.editor.IContextKey<boolean> | undefined;
  let ctxChosen: monaco.editor.IContextKey<boolean> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let suggestTimer: ReturnType<typeof setTimeout> | undefined;
  let fileTimer: ReturnType<typeof setTimeout> | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let suggestSeq = 0;
  let dismissedAt: string | null = null;
  let loaded = false;
  let applyingProgrammaticEdit = false;
  const disposables: monaco.IDisposable[] = [];

  const sessionTitle = () => paneSession()?.title || "session";
  const target = () => app.sessions.find((s) => s.id === targetId());
  const targetIsPane = () => targetId() === props.sessionId;
  const targetAgent = createMemo(() => app.sessionAgentKind(targetId()));
  const targetRemote = () => isRemoteCommand(target()?.command);
  const sessionHistory = createMemo(() => history().filter((h) => h.session_id === props.sessionId));
  const earlierDrafts = createMemo(() => history().map((h) => h.text));
  const isEmpty = () => !text().trim();

  const showNotice = (message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setNotice(null), 4000);
  };

  // ----- draft file -----------------------------------------------------

  const saveNow = async () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!loaded) return;
    setSaveState("saving");
    try {
      const path = await invoke<string>("composer_save_draft", {
        sessionId: props.sessionId,
        title: sessionTitle(),
        text: model?.getValue() ?? text(),
      });
      setDraftPath(path);
      setSaveState("saved");
    } catch (err) {
      console.warn("[composer] save failed", err);
      setSaveState("error");
    }
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    setSaveState("saving");
    saveTimer = setTimeout(() => void saveNow(), AUTOSAVE_MS);
  };

  const refreshHistory = async () => {
    try {
      setHistory(await invoke<HistoryEntry[]>("composer_history", { limit: 500 }));
    } catch {
      setHistory([]);
    }
  };

  // ----- sending ----------------------------------------------------------

  const stopHandsFree = () => {
    if (!handsFree()) return;
    setHandsFree(false);
    void invoke("dictation_hands_free", { start: false }).catch(() => {});
  };

  const send = async (withEnter: boolean) => {
    if (!model || sending()) return;
    const body = model.getValue();
    if (!body.trim()) return;
    stopHandsFree();
    closeSuggestions();
    const sid = targetId();
    setSending(true);
    try {
      const ok = await app.sendComposerText(sid, body, withEnter);
      if (!ok) {
        showNotice("Could not send: that terminal has no running process.");
        return;
      }
      clearTimeout(saveTimer);
      saveTimer = undefined;
      try {
        const entry = await invoke<HistoryEntry>("composer_record_sent", {
          sessionId: props.sessionId,
          title: sessionTitle(),
          text: body,
        });
        setHistory((prev) => [entry, ...prev]);
      } catch (err) {
        console.warn("[composer] record sent failed", err);
      }
      applyingProgrammaticEdit = true;
      model.setValue("");
      applyingProgrammaticEdit = false;
      setText("");
      setGhostText("");
      try {
        const next = await invoke<DraftState>("composer_load_draft", {
          sessionId: props.sessionId,
          title: sessionTitle(),
        });
        setDraftPath(next.path);
      } catch {
        // path refreshes on the next save
      }
      setSaveState("idle");
      if (!withEnter) {
        // Insert: let the user finish the line in the terminal.
        app.focusTerminal(sid);
      } else {
        editor?.focus();
      }
    } finally {
      setSending(false);
    }
  };

  // ----- ghost text ---------------------------------------------------------

  const setGhostText = (value: string) => {
    setGhost(value);
    ctxGhost?.set(!!value);
    if (!ghostDecorations || !editor) return;
    const pos = editor.getPosition();
    if (!value || !pos) {
      ghostDecorations.clear();
      return;
    }
    ghostDecorations.set([
      {
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        options: {
          showIfCollapsed: true,
          after: { content: value, inlineClassName: "composer-ghost" },
        },
      },
    ]);
  };

  const updateGhost = () => {
    if (!editor || !model) return;
    const pos = editor.getPosition();
    const selection = editor.getSelection();
    if (!pos || (selection && !selection.isEmpty())) {
      setGhostText("");
      return;
    }
    const line = model.getLineContent(pos.lineNumber);
    if (pos.column - 1 !== line.length) {
      setGhostText("");
      return;
    }
    setGhostText(prefixCompletion(line, earlierDrafts()));
  };

  const acceptGhost = () => {
    const value = ghost();
    const pos = editor?.getPosition();
    if (!value || !editor || !pos) return;
    setGhostText("");
    editor.executeEdits("composer-ghost", [
      {
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        text: value,
        forceMoveMarkers: true,
      },
    ]);
  };

  // ----- suggestions ------------------------------------------------------

  const closeSuggestions = () => {
    suggestSeq++;
    setRows([]);
    setListPos(null);
    setNavigated(false);
    setActiveIndex(0);
    ctxSuggest?.set(false);
  };

  createEffect(() => {
    const chosen = navigated();
    ctxChosen?.set(chosen);
  });

  const positionList = (lineNumber: number, column: number) => {
    if (!editor) return;
    const coords = editor.getScrolledVisiblePosition({ lineNumber, column });
    const dom = editor.getDomNode();
    if (!coords || !dom) return;
    const rect = dom.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left + coords.left - 10, window.innerWidth - 580));
    const caretTop = rect.top + coords.top;
    const below = caretTop + coords.height + 6;
    const estimated = 44 + rows().length * 38 + 34;
    if (window.innerHeight - below >= Math.min(estimated, 340)) {
      setListPos({ left, top: below });
    } else {
      setListPos({ left, bottom: window.innerHeight - caretTop + 6 });
    }
  };

  const fileCandidates = async (query: string, dir: string): Promise<Suggestion[]> => {
    const key = `${dir}\u0000${query.toLowerCase()}`;
    let entries = fileSearchCache.get(key);
    if (!entries) {
      entries = await invoke<FileBrowserEntry[]>("search_directory", {
        path: dir,
        query,
        includeHidden: false,
      }).catch(() => [] as FileBrowserEntry[]);
      if (fileSearchCache.size > 300) fileSearchCache.clear();
      fileSearchCache.set(key, entries);
    }
    return entries.slice(0, 40).map((entry) => ({
      id: `file:${entry.path}`,
      section: "files" as const,
      label: `@${entry.relative_path}${entry.is_dir ? "/" : ""}`,
      hint: entry.is_dir ? "folder" : "",
      matchText: entry.relative_path,
      value: `${entry.relative_path}${entry.is_dir ? "/" : ""}`,
    }));
  };

  const computeSuggestions = async () => {
    if (!editor || !model) return;
    const pos = editor.getPosition();
    if (!pos) return;
    const line = model.getLineContent(pos.lineNumber);
    const before = line.slice(0, pos.column - 1);
    const { word, start } = currentWord(before);
    const query = stripSigil(word);
    const key = `${pos.lineNumber}:${start}`;
    if (query.length < 2 || dismissedAt === key) {
      closeSuggestions();
      return;
    }
    const seq = ++suggestSeq;
    const now = Date.now();

    // Send to: sessions matching the word being typed or the draft's first word.
    const firstWord = wordsOf(model.getLineContent(1))[0];
    const words = [...new Set([query.toLowerCase(), ...(firstWord ? [firstWord] : [])])];
    const seenAt = app.sessionSeenAt();
    const sendRows: Suggestion[] = matchSessions(
      words,
      app.sessions.map((s) => ({ id: s.id, title: s.title, tags: app.terminalTags()[s.id] ?? [] })),
      [targetId()]
    )
      .slice(0, 2)
      .map((m) => ({
        id: `send:${m.session.id}`,
        section: "send" as const,
        label: m.session.title,
        hint: `${app.sessionAgentLabel(m.session.id)}${
          seenAt[m.session.id] ? ` · ${relativeTime(seenAt[m.session.id], now)}` : ""
        }`,
        matchText: m.session.title,
        value: m.session.id,
      }));

    const actionRows: Suggestion[] =
      targetAgent() === "shell"
        ? []
        : actions().map((a) => ({
            id: `action:${a.harness}:${a.invoke}`,
            section: "actions" as const,
            label: a.description ? firstLine(a.description, 80) : a.invoke,
            hint: a.invoke,
            matchText: a.name,
            extraText: a.description,
            badge: HARNESS_LABEL[a.harness],
            value: a.invoke,
          }));

    const draftRows: Suggestion[] = history()
      .slice(0, 200)
      .map((h, i) => ({
        id: `draft:${h.sent_at}:${i}`,
        section: "drafts" as const,
        label: firstLine(h.text),
        hint: relativeTime(h.sent_at, now),
        matchText: "",
        extraText: h.text,
        timestamp: h.sent_at,
        value: h.text,
      }));

    const publish = (candidates: Suggestion[]) => {
      if (seq !== suggestSeq) return null;
      const ranked = capBySection([...sendRows, ...rankCandidatesLocally(candidates, query)]);
      if (!ranked.length) {
        setRows([]);
        setListPos(null);
        ctxSuggest?.set(false);
        return ranked;
      }
      const previousIds = rows().map((r) => r.id).join("|");
      setRows(ranked);
      setRankedBy("local");
      if (ranked.map((r) => r.id).join("|") !== previousIds) {
        setActiveIndex(0);
        setNavigated(false);
      }
      ctxSuggest?.set(true);
      positionList(pos.lineNumber, start + 1);
      return ranked;
    };

    // Local rows first (instant), then files, then the optional Jev rerank.
    publish([...actionRows, ...draftRows]);
    const dir = cwd();
    let fileRows: Suggestion[] = [];
    if (dir && !targetRemote()) {
      await new Promise((resolve) => {
        clearTimeout(fileTimer);
        fileTimer = setTimeout(resolve, FILE_SEARCH_DEBOUNCE_MS);
      });
      if (seq !== suggestSeq) return;
      fileRows = await fileCandidates(query, dir);
    }
    const localRows = publish([...fileRows, ...actionRows, ...draftRows]);
    if (!localRows || localRows.length < 2 || !jevOn()) return;
    const result = await jevRanker.rank(localRows, {
      draft: model.getValue(),
      query,
      workspace: dir ?? "",
    });
    if (seq !== suggestSeq || result.rankedBy !== "jev") return;
    if (!navigated()) {
      setRows(result.rows);
      setRankedBy("jev");
    }
  };

  const scheduleSuggestions = () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => void computeSuggestions(), SUGGEST_DEBOUNCE_MS);
  };

  const replaceCurrentWord = (replacement: string, wholeLinePrefix = false) => {
    if (!editor || !model) return;
    const pos = editor.getPosition();
    if (!pos) return;
    const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
    const startCol = wholeLinePrefix ? 1 : currentWord(before).start + 1;
    editor.executeEdits("composer-suggest", [
      {
        range: new monaco.Range(pos.lineNumber, startCol, pos.lineNumber, pos.column),
        text: replacement,
        forceMoveMarkers: true,
      },
    ]);
  };

  const acceptSuggestion = (row: Suggestion | undefined) => {
    if (!row || !editor) return;
    const pos = editor.getPosition();
    if (pos) {
      const before = model?.getLineContent(pos.lineNumber).slice(0, pos.column - 1) ?? "";
      dismissedAt = `${pos.lineNumber}:${currentWord(before).start}`;
    }
    closeSuggestions();
    switch (row.section) {
      case "send":
        setTargetId(row.value);
        break;
      case "files":
        replaceCurrentWord(`@${row.value} `);
        break;
      case "actions":
        replaceCurrentWord(`${row.value} `);
        break;
      case "drafts":
        replaceCurrentWord(row.value, true);
        break;
    }
    editor.focus();
  };

  const moveSelection = (delta: number) => {
    const count = rows().length;
    if (!count) return;
    setNavigated(true);
    setActiveIndex((i) => (i + delta + count) % count);
  };

  // ----- dictation ----------------------------------------------------------

  const toggleHandsFree = async () => {
    editor?.focus();
    if (handsFree()) {
      stopHandsFree();
      return;
    }
    try {
      await invoke("dictation_hands_free", { start: true });
      setHandsFree(true);
    } catch (err) {
      showNotice(`Dictation unavailable: ${String(err)}`);
    }
  };

  // ----- attachments --------------------------------------------------------

  const insertAtCursor = (value: string) => {
    if (!editor) return;
    const selection = editor.getSelection();
    if (!selection) return;
    const pos = selection.getStartPosition();
    const lineBefore = model?.getLineContent(pos.lineNumber).slice(0, pos.column - 1) ?? "";
    const prefix = lineBefore && !/\s$/.test(lineBefore) ? " " : "";
    editor.executeEdits("composer-attach", [
      { range: selection, text: `${prefix}${value} `, forceMoveMarkers: true },
    ]);
    editor.focus();
  };

  const handleEditorPaste = async (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!data) return;
    const hasImage =
      Array.from(data.items).some((item) => item.type.startsWith("image/")) ||
      !!extractImageFromClipboard(data);
    if (!hasImage) return;
    // Text wins when both are present (e.g. copying from a web page).
    if (data.types.includes("text/plain") && data.getData("text/plain").trim()) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    try {
      const path = await invoke<string>("save_clipboard_image");
      insertAtCursor(path);
    } catch (err) {
      console.warn("[composer] save_clipboard_image failed", err);
      showNotice("Could not read the image from the clipboard.");
    }
  };

  const attachClipboardOrPick = async () => {
    try {
      const path = await invoke<string>("save_clipboard_image");
      insertAtCursor(path);
      return;
    } catch {
      // no image on the clipboard: pick a file instead
    }
    fileInput?.click();
  };

  const handleFilePicked = async (file: File | undefined) => {
    if (!file) return;
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "-");
      const path = await invoke<string>("save_recording_file", {
        filename: `composer-${Date.now()}-${safeName}`,
        bytes,
      });
      insertAtCursor(path);
    } catch (err) {
      console.warn("[composer] attach failed", err);
      showNotice("Could not attach that file.");
    }
  };

  // ----- resize -------------------------------------------------------------

  const maxHeight = () => {
    const column = rootRef?.parentElement;
    const total = column?.getBoundingClientRect().height ?? window.innerHeight;
    return Math.max(MIN_HEIGHT, total - MIN_TERMINAL_HEIGHT);
  };

  const startResize = (event: PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height();
    let frame = 0;
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    const move = (e: PointerEvent) => {
      const next = Math.round(Math.max(MIN_HEIGHT, Math.min(startHeight + (startY - e.clientY), maxHeight())));
      setHeight(next);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => app.fitTerminalSession(props.sessionId));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = "";
      writeStorage(HEIGHT_KEY, String(height()));
      requestAnimationFrame(() => app.fitTerminalSession(props.sessionId));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ----- lifecycle ----------------------------------------------------------

  const closeDock = () => {
    stopHandsFree();
    app.setComposerOpen(props.sessionId, false);
  };

  const handleEscape = () => {
    if (rows().length) {
      const pos = editor?.getPosition();
      if (pos && model) {
        const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
        dismissedAt = `${pos.lineNumber}:${currentWord(before).start}`;
      }
      closeSuggestions();
      return;
    }
    if (ghost()) {
      setGhostText("");
      return;
    }
    if (handsFree()) {
      stopHandsFree();
      return;
    }
    closeDock();
  };

  const setupEditor = (host: HTMLDivElement, initial: string) => {
    ensureMonacoEnvironment();
    const uri = monaco.Uri.parse(`inmemory://butter-composer/${encodeURIComponent(props.sessionId)}.md`);
    monaco.editor.getModel(uri)?.dispose();
    model = monaco.editor.createModel(initial, "markdown", uri);
    editor = monaco.editor.create(host, {
      model,
      theme: "vs-dark",
      automaticLayout: true,
      ariaLabel: "Composer draft",
      wordWrap: "on",
      wrappingIndent: "none",
      wrappingStrategy: "advanced",
      lineNumbers: "off",
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 0,
      lineNumbersMinChars: 0,
      renderLineHighlight: "none",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: { vertical: "auto", horizontal: "hidden", verticalScrollbarSize: 8, useShadows: false },
      fontFamily: EDITOR_FONT,
      fontSize: 14.5,
      lineHeight: 23,
      letterSpacing: 0,
      padding: { top: 12, bottom: 12 },
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: "off",
      parameterHints: { enabled: false },
      occurrencesHighlight: "off",
      selectionHighlight: false,
      matchBrackets: "never",
      renderWhitespace: "none",
      guides: { indentation: false },
      contextmenu: false,
      links: false,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      cursorBlinking: "smooth",
      cursorWidth: 2,
      fixedOverflowWidgets: true,
      stickyScroll: { enabled: false },
      tabSize: 2,
      accessibilitySupport: "off",
    });
    ghostDecorations = editor.createDecorationsCollection();
    editor.createContextKey("butterComposer", true);
    ctxSuggest = editor.createContextKey("butterComposerSuggest", false);
    ctxGhost = editor.createContextKey("butterComposerGhost", false);
    ctxChosen = editor.createContextKey("butterComposerChosen", false);

    const K = monaco.KeyCode;
    const M = monaco.KeyMod;
    const action = (id: string, keybindings: number[], context: string, run: () => void) => {
      disposables.push(
        editor!.addAction({
          id: `butter.composer.${id}`,
          label: `Composer: ${id}`,
          keybindings,
          keybindingContext: context,
          run,
        })
      );
    };
    action("send", [M.CtrlCmd | K.Enter], "butterComposer", () => void send(pressEnter()));
    action("insert", [M.CtrlCmd | M.Shift | K.Enter], "butterComposer", () => void send(false));
    action("toggle", [M.CtrlCmd | K.KeyI], "butterComposer", () => app.toggleComposer());
    action("escape", [K.Escape], "butterComposer", handleEscape);
    action("down", [K.DownArrow], "butterComposer && butterComposerSuggest", () => moveSelection(1));
    action("up", [K.UpArrow], "butterComposer && butterComposerSuggest", () => moveSelection(-1));
    // Enter accepts only after the user picked a row with the arrows, so a
    // plain Enter still starts a new line while the list is showing.
    action("accept-enter", [K.Enter], "butterComposer && butterComposerSuggest && butterComposerChosen", () =>
      acceptSuggestion(rows()[activeIndex()])
    );
    action("accept-tab", [K.Tab], "butterComposer && (butterComposerSuggest || butterComposerGhost)", () => {
      if (ghost() && !navigated()) acceptGhost();
      else acceptSuggestion(rows()[activeIndex()]);
    });

    disposables.push(
      editor.onDidChangeModelContent(() => {
        if (!model) return;
        setText(model.getValue());
        if (applyingProgrammaticEdit) return;
        scheduleSave();
        updateGhost();
        scheduleSuggestions();
      }),
      editor.onDidChangeCursorPosition((e) => {
        if (e.reason === monaco.editor.CursorChangeReason.Explicit || e.source === "mouse") {
          updateGhost();
          closeSuggestions();
        }
      }),
      editor.onDidBlurEditorText(() => {
        // Keep the list while clicking into it (mousedown prevents blur).
        setTimeout(() => {
          if (!editor?.hasTextFocus()) closeSuggestions();
        }, 120);
      })
    );

    const domNode = editor.getDomNode();
    if (domNode) {
      const listener = (e: ClipboardEvent) => void handleEditorPaste(e);
      domNode.addEventListener("paste", listener, true);
      disposables.push({ dispose: () => domNode.removeEventListener("paste", listener, true) });
    }
    const end = model.getFullModelRange().getEndPosition();
    editor.setPosition(end);
    requestAnimationFrame(() => editor?.focus());
  };

  onMount(() => {
    app.registerComposerFocus(() => editor?.focus());
    void (async () => {
      let initial = "";
      try {
        const draft = await invoke<DraftState>("composer_load_draft", {
          sessionId: props.sessionId,
          title: sessionTitle(),
        });
        initial = draft.text;
        setDraftPath(draft.path);
        if (draft.text) setSaveState("saved");
      } catch (err) {
        console.warn("[composer] load failed", err);
      }
      setText(initial);
      if (editorHost) setupEditor(editorHost, initial);
      loaded = true;
    })();
    void refreshHistory();
    void invoke<boolean>("dictation_available")
      .then(setWisprAvailable)
      .catch(() => setWisprAvailable(false));
    void jevStatus().then((s) => setJevOn(!!s?.configured));
    requestAnimationFrame(() => app.fitTerminalSession(props.sessionId));
  });

  // Target session context: cwd (for Files) and harness-specific skills.
  createEffect(
    on([targetId, targetAgent], ([sid, agent]) => {
      setActions([]);
      void (async () => {
        const dir = await app.getSessionCwd(sid);
        if (targetId() !== sid) return;
        setCwd(dir);
        // Index both harnesses on open; show the one the target runs.
        const [claude, codex] = await Promise.all([loadActions(dir, "claude"), loadActions(dir, "codex")]);
        if (targetId() !== sid) return;
        setActions(agent === "claude" ? claude : agent === "codex" ? codex : []);
      })();
    })
  );

  // A routed target that closes falls back to this terminal.
  createEffect(() => {
    if (!target()) setTargetId(props.sessionId);
  });

  createEffect(on(earlierDrafts, () => updateGhost(), { defer: true }));

  onCleanup(() => {
    app.registerComposerFocus(undefined);
    clearTimeout(suggestTimer);
    clearTimeout(fileTimer);
    clearTimeout(noticeTimer);
    if (saveTimer) void saveNow();
    stopHandsFree();
    disposables.forEach((d) => d.dispose());
    editor?.dispose();
    model?.dispose();
    requestAnimationFrame(() => app.fitTerminalSession(props.sessionId));
  });

  const loadFromHistory = (entry: HistoryEntry) => {
    setTab("draft");
    if (!editor || !model) return;
    editor.executeEdits("composer-history", [
      { range: model.getFullModelRange(), text: entry.text, forceMoveMarkers: true },
    ]);
    editor.setPosition(model.getFullModelRange().getEndPosition());
    requestAnimationFrame(() => editor?.focus());
  };

  const statusText = () => {
    if (notice()) return notice();
    if (saveState() === "saving") return "Saving…";
    if (saveState() === "error") return "Could not save draft";
    if (saveState() === "saved") return "Saved · Markdown";
    return null;
  };

  const MicIcon = (p: { size: number; stroke: string; width?: number }) => (
    <svg
      width={p.size}
      height={p.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.stroke}
      stroke-width={p.width ?? 2}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );

  const dictateTitle = () =>
    wisprAvailable()
      ? handsFree()
        ? "Stop Wispr Flow hands-free dictation"
        : "Start Wispr Flow hands-free dictation; text lands at the cursor. You can also hold fn ⇧."
      : "Wispr Flow is not installed. Hold fn ⇧ if you use another dictation app.";

  return (
    <section
      ref={(el) => (rootRef = el)}
      class={`composer-dock ${handsFree() ? "dictating" : ""}`}
      style={{ height: `${height()}px` }}
      aria-label="Composer"
    >
      <div
        class="composer-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer"
        title="Drag to resize"
        onPointerDown={startResize}
        onDblClick={() => {
          setHeight(DEFAULT_HEIGHT);
          writeStorage(HEIGHT_KEY, String(DEFAULT_HEIGHT));
          requestAnimationFrame(() => app.fitTerminalSession(props.sessionId));
        }}
      >
        <span />
      </div>

      <div class="composer-header">
        <button
          type="button"
          class={`composer-tab ${tab() === "draft" ? "active" : ""}`}
          aria-pressed={tab() === "draft"}
          onClick={() => {
            setTab("draft");
            requestAnimationFrame(() => editor?.focus());
          }}
        >
          Draft
        </button>
        <button
          type="button"
          class={`composer-tab ${tab() === "history" ? "active" : ""}`}
          aria-pressed={tab() === "history"}
          onClick={() => {
            closeSuggestions();
            setTab("history");
          }}
        >
          History <span class="composer-count">{sessionHistory().length}</span>
        </button>
        <Show when={handsFree()}>
          <span class="composer-listening" title="Wispr Flow hands-free dictation was started from here">
            <span class="dot" />
            Hands-free
          </span>
        </Show>
        <span class="composer-spacer" />
        <span class="composer-target" title={target()?.title}>
          <Show
            when={!targetIsPane()}
            fallback={<>to this terminal · {app.sessionAgentLabel(targetId())}</>}
          >
            to <b>{target()?.title ?? "session"}</b> · {app.sessionAgentLabel(targetId())}
            <button
              type="button"
              class="composer-target-reset"
              title="Send to this terminal instead"
              onClick={() => {
                setTargetId(props.sessionId);
                editor?.focus();
              }}
            >
              ×
            </button>
          </Show>
        </span>
        <label class="composer-enter-toggle">
          <input
            type="checkbox"
            checked={pressEnter()}
            onChange={(e) => {
              setPressEnter(e.currentTarget.checked);
              writeStorage(PRESS_ENTER_KEY, e.currentTarget.checked ? "1" : "0");
              editor?.focus();
            }}
          />
          Press Enter after sending
        </label>
      </div>

      <div class="composer-body">
        <div
          class={`composer-editor-frame ${tab() === "draft" ? "" : "hidden"}`}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault();
              editor?.focus();
            }
          }}
        >
          <div class="composer-editor" ref={(el) => (editorHost = el)} />
          <Show when={isEmpty() && !handsFree()}>
            <div class="composer-empty">
              <button
                type="button"
                class="composer-mic"
                aria-label="Dictate with Wispr Flow"
                title={dictateTitle()}
                disabled={!wisprAvailable()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void toggleHandsFree()}
              >
                <MicIcon size={24} stroke="var(--accent-primary)" width={1.8} />
              </button>
              <div class="composer-empty-text">
                <span>
                  Hold <Keys keys={["fn", "⇧"]} /> to talk
                </span>
                <span class="sub">or click the mic · Wispr Flow · or start typing</span>
              </div>
            </div>
          </Show>
        </div>
        <Show when={tab() === "history"}>
          <div class="composer-history">
            <Show
              when={sessionHistory().length}
              fallback={<div class="composer-history-empty">Nothing sent from this terminal yet.</div>}
            >
              <For each={sessionHistory()}>
                {(entry) => (
                  <button
                    type="button"
                    class="composer-history-row"
                    title="Load into the draft"
                    onClick={() => loadFromHistory(entry)}
                  >
                    <span class="text">{entry.text}</span>
                    <span class="when">{relativeTime(entry.sent_at, Date.now())}</span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>

      <div class="composer-footer">
        <button
          type="button"
          class="composer-attach"
          title="Attach an image: uses the clipboard image if there is one, otherwise opens a file picker. ⌘V in the draft pastes images too."
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void attachClipboardOrPick()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 8" />
          </svg>
          Attach or paste an image
        </button>
        <input
          ref={(el) => (fileInput = el)}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            void handleFilePicked(file);
          }}
        />
        <button
          type="button"
          class={`composer-dictate ${handsFree() ? "on" : ""}`}
          title={dictateTitle()}
          disabled={!wisprAvailable()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void toggleHandsFree()}
        >
          <Show
            when={handsFree()}
            fallback={
              <>
                <MicIcon size={13} stroke="currentColor" />
                Dictate <Keys keys={["fn", "⇧"]} />
              </>
            }
          >
            <span class="composer-bars" aria-hidden="true">
              <For each={[6, 12, 18, 10, 16, 8, 14]}>{(h) => <span style={{ height: `${h}px` }} />}</For>
            </span>
            Stop dictation
          </Show>
        </button>
        <span class="composer-spacer" />
        <span class="composer-status" title={draftPath()}>
          <Show when={statusText()} fallback={<><Keys keys={["⌘", "I"]} /> hides · draft is kept</>}>
            {statusText()}
          </Show>
        </span>
        <button
          type="button"
          class="composer-insert"
          disabled={isEmpty() || sending()}
          title="Paste into the terminal without pressing Enter"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void send(false)}
        >
          Insert <Keys keys={["⇧", "⌘", "↵"]} />
        </button>
        <button
          type="button"
          class="composer-send"
          disabled={isEmpty() || sending()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void send(pressEnter())}
        >
          Send <Keys keys={["⌘", "↵"]} />
        </button>
      </div>

      <Show when={rows().length > 0 ? listPos() : null}>
        {(pos) => (
          <div
            class="composer-suggest"
            role="listbox"
            aria-label="Suggestions"
            style={{
              left: `${pos().left}px`,
              ...(pos().top !== undefined ? { top: `${pos().top}px` } : { bottom: `${pos().bottom}px` }),
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <For each={rows()}>
              {(row, index) => (
                <>
                  <Show when={index() === 0 || rows()[index() - 1]?.section !== row.section}>
                    <span class="composer-suggest-section">{SECTION_LABEL[row.section]}</span>
                  </Show>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index() === activeIndex()}
                    class={`composer-suggest-row ${row.section} ${index() === activeIndex() ? "active" : ""}`}
                    onMouseEnter={() => setActiveIndex(index())}
                    onClick={() => acceptSuggestion(row)}
                  >
                    <Show when={row.section === "send"}>
                      <span class="dot" />
                      <span class="label">
                        Route this draft to the <b>{row.label}</b> session
                      </span>
                    </Show>
                    <Show when={row.section === "files"}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9C9CA3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                        <path d="M14 3v5h5" />
                      </svg>
                      <span class="label mono">{row.label}</span>
                    </Show>
                    <Show when={row.section === "actions"}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
                      </svg>
                      <span class="label">{row.label}</span>
                      <Show when={row.badge}>
                        <span class={`badge ${row.badge?.toLowerCase()}`}>{row.badge}</span>
                      </Show>
                    </Show>
                    <Show when={row.section === "drafts"}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9C9CA3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                        <path d="M3 3v5h5" />
                        <path d="M12 7v5l3 2" />
                      </svg>
                      <span class="label muted">{row.label}</span>
                    </Show>
                    <span class="composer-spacer" />
                    <span class={`hint ${row.section === "actions" ? "mono" : ""}`}>{row.hint}</span>
                  </button>
                </>
              )}
            </For>
            <div class="composer-suggest-footer">
              <span>
                <Keys keys={["tab"]} /> accept
              </span>
              <span>
                <Keys keys={["↑", "↓"]} /> choose
              </span>
              <span>
                <Keys keys={["esc"]} /> dismiss
              </span>
              <span class="composer-spacer" />
              <span title={jevOn() ? "TypeSafe Jev reranks within ~300 ms when it answers in time" : "Set [typesafe] api_key in config.toml to rank with Jev"}>
                {rankedBy() === "jev" ? "Ranked by Jev" : "Local"}
              </span>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}
