import { createSignal, createMemo, onMount, onCleanup, createEffect } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  sendNotification,
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import {
  readImage as readClipboardImage,
  readText as readClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import { SearchAddon as XtermSearchAddon } from "@xterm/addon-search";
import { WebLinksAddon as XtermWebLinksAddon } from "@xterm/addon-web-links";
import { open as openUrl, Command } from "@tauri-apps/plugin-shell";
import { homeDir } from "@tauri-apps/api/path";
import { inferImageMimeType, extractImageFromClipboard } from "../utils/clipboard";
import { buildFooterCommand } from "../utils/shell";
import { captureScrollback, getLastLinesFromBuffer } from "../utils/terminal";
import { generateWorktreeSlug, generateWorktreeSuffix } from "../utils/worktree";
import { DEFAULT_TAGS, FOOTER_PRESET_STORAGE_KEY } from "./constants";
import type {
  AppView,
  AppConfig,
  BrowserBounds,
  BrowserSessionState,
  CanvasBoard,
  CanvasFileKind,
  CanvasObject,
  CanvasPoint,
  CanvasStroke,
  CanvasTool,
  CcFetchResponse,
  CcSearchResponse,
  CcSearchResult,
  ClipboardHistoryEntry,
  ConfigPreset,
  DbScrollback,
  DbSession,
  FileBrowserEntry,
  PasteQueueItem,
  RecordingClipboardEvent,
  RecorderState,
  RecordingTranscriptionResult,
  SearchDirection,
  TerminalPreset,
  WebSession,
  WorkspaceFileTab,
  WorkspaceFileTabKind,
} from "./types";

const APP_VIEW_STORAGE_KEY = "app-view";
const CANVAS_BOARD_STORAGE_KEY = "canvas-board-v1";
const SIDEBAR_HIDDEN_STORAGE_KEY = "sidebar-hidden";
const BROWSER_URL_HISTORY_STORAGE_KEY = "butter.browser-url-history.v1";
const BROWSER_URL_HISTORY_LIMIT = 250;
const DEFAULT_BROWSER_HISTORY_PROFILE_KEY = "__default__";
const CANVAS_TEXT_FILE_LIMIT_BYTES = 512 * 1024;
const BUTTER_TEXT_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
const TERMINAL_WORKSPACE_TAB_ID = "__terminal__";
const PINNED_WORKSPACE_OWNER_ID = "__pinned__";
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);
const IMAGE_FILE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
]);
const TEXT_FILE_EXTENSIONS = new Set([
  "txt",
  "md",
  "mdx",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "cfg",
  "log",
  "csv",
  "tsv",
  "sql",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
  "astro",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "rs",
  "py",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "sh",
  "zsh",
  "bash",
  "fish",
  "env",
  "xml",
  "lock",
]);
const TEXT_FILE_BASENAMES = new Set([
  "makefile",
  "dockerfile",
  "vagrantfile",
  "gemfile",
  "rakefile",
  "procfile",
]);

type BrowserUrlHistoryStore = Record<string, string[]>;

const asNumber = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const asString = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;

const createCanvasId = () => `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const getPathDisplayName = (path: string) => {
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  return trimmed.split("/").pop() || trimmed;
};
const getPathExtension = (path: string) => {
  const fileName = getPathDisplayName(path);
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return "";
  return fileName.slice(dotIndex + 1).toLowerCase();
};
const getButterWorkspaceFileKind = (path: string): WorkspaceFileTabKind | null => {
  const fileName = getPathDisplayName(path);
  const ext = getPathExtension(fileName);
  if (IMAGE_FILE_EXTENSIONS.has(ext)) return "image_file";
  if (TEXT_FILE_EXTENSIONS.has(ext)) return "text_file";
  if (TEXT_FILE_BASENAMES.has(fileName.toLowerCase())) return "text_file";
  return null;
};

const isMarkdownPath = (path: string): boolean => {
  return MARKDOWN_EXTENSIONS.has(getPathExtension(path));
};

const browserHistoryProfileKey = (profilePath?: string | null) => {
  const value = (profilePath || "").trim();
  return value || DEFAULT_BROWSER_HISTORY_PROFILE_KEY;
};

const shouldStoreBrowserUrl = (url: string) => {
  const value = url.trim();
  if (!value || value === "about:blank") return false;
  if (value.startsWith("javascript:")) return false;
  return true;
};

const readBrowserUrlHistoryStore = (): BrowserUrlHistoryStore => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(BROWSER_URL_HISTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const next: BrowserUrlHistoryStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const urls = value
        .filter((entry): entry is string => typeof entry === "string" && shouldStoreBrowserUrl(entry))
        .slice(0, BROWSER_URL_HISTORY_LIMIT);
      if (urls.length > 0) {
        next[key] = urls;
      }
    }
    return next;
  } catch {
    return {};
  }
};

const writeBrowserUrlHistoryStore = (store: BrowserUrlHistoryStore) => {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(store).length === 0) {
      window.localStorage.removeItem(BROWSER_URL_HISTORY_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(BROWSER_URL_HISTORY_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore localStorage failures.
  }
};

const recordBrowserUrlVisit = (profilePath: string | null | undefined, url: string) => {
  if (!shouldStoreBrowserUrl(url)) return;
  const key = browserHistoryProfileKey(profilePath);
  const store = readBrowserUrlHistoryStore();
  const current = store[key] || [];
  const next = [url, ...current.filter((entry) => entry !== url)].slice(0, BROWSER_URL_HISTORY_LIMIT);
  const unchanged =
    next.length === current.length && next.every((entry, index) => entry === current[index]);
  if (unchanged) return;
  store[key] = next;
  writeBrowserUrlHistoryStore(store);
};

const getBrowserUrlHistory = (profilePath: string | null | undefined, query = "") => {
  const key = browserHistoryProfileKey(profilePath);
  const urls = readBrowserUrlHistoryStore()[key] || [];
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return urls;
  return urls.filter((url) => url.toLowerCase().includes(normalizedQuery));
};

const clearBrowserUrlHistory = (profilePath: string | null | undefined) => {
  const key = browserHistoryProfileKey(profilePath);
  const store = readBrowserUrlHistoryStore();
  if (!(key in store)) return;
  delete store[key];
  writeBrowserUrlHistoryStore(store);
};

const defaultCanvasBoard = (): CanvasBoard => ({
  objects: [],
  strokes: [],
  activeTool: "select",
  selectedObjectId: null,
  selectedObjectIds: [],
  zoom: 1,
});

const parseCanvasPoint = (value: unknown): CanvasPoint | null => {
  if (!value || typeof value !== "object") return null;
  const point = value as Record<string, unknown>;
  return {
    x: asNumber(point.x, 0),
    y: asNumber(point.y, 0),
  };
};

const parseCanvasStroke = (value: unknown): CanvasStroke | null => {
  if (!value || typeof value !== "object") return null;
  const stroke = value as Record<string, unknown>;
  const tool = stroke.tool === "pen" || stroke.tool === "pencil" ? "pen" : null;
  if (tool !== "pen") return null;
  const rawPoints = Array.isArray(stroke.points) ? stroke.points : [];
  const points = rawPoints
    .map((point) => parseCanvasPoint(point))
    .filter((point): point is CanvasPoint => point !== null);
  if (points.length < 2) return null;
  return { tool, points };
};

const parseCanvasObject = (value: unknown): CanvasObject | null => {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const type = asString(obj.type);
  const base = {
    id: asString(obj.id, createCanvasId()),
    x: asNumber(obj.x, 96),
    y: asNumber(obj.y, 96),
    w: Math.max(120, asNumber(obj.w, 320)),
    h: Math.max(90, asNumber(obj.h, 220)),
    z: Math.max(1, asNumber(obj.z, 1)),
  };

  if (type === "text") {
    return {
      ...base,
      type,
      text: asString(obj.text, ""),
    };
  }

  if (type === "image") {
    const path = asString(obj.path);
    if (!path) return null;
    return {
      ...base,
      type,
      path,
      name: asString(obj.name, path.split("/").pop() || "Image"),
    };
  }

  if (type === "terminal") {
    const sessionId = asString(obj.sessionId);
    if (!sessionId) return null;
    return {
      ...base,
      type,
      sessionId,
    };
  }

  if (type === "file") {
    const path = asString(obj.path);
    if (!path) return null;
    const fileKind =
      obj.fileKind === "text" || obj.fileKind === "image" || obj.fileKind === "binary"
        ? obj.fileKind
        : "binary";
    return {
      ...base,
      type,
      path,
      name: asString(obj.name, path.split("/").pop() || "File"),
      fileKind,
      textContent: obj.textContent && typeof obj.textContent === "string" ? obj.textContent : undefined,
      error: obj.error && typeof obj.error === "string" ? obj.error : undefined,
    };
  }

  return null;
};

const parseCanvasBoard = (raw: string | null): CanvasBoard => {
  if (!raw) return defaultCanvasBoard();
  try {
    const parsedRaw = JSON.parse(raw) as Record<string, unknown>;
    const parsed = parsedRaw as Partial<CanvasBoard>;
    const objects = Array.isArray(parsed.objects)
      ? parsed.objects
          .map((obj) => parseCanvasObject(obj))
          .filter((obj): obj is CanvasObject => obj !== null)
      : [];
    const strokes = Array.isArray(parsed.strokes)
      ? parsed.strokes
          .map((stroke) => parseCanvasStroke(stroke))
          .filter((stroke): stroke is CanvasStroke => stroke !== null)
      : [];
    const activeToolRaw = typeof parsedRaw.activeTool === "string" ? parsedRaw.activeTool : "";
    const activeTool: CanvasTool =
      activeToolRaw === "pen" || activeToolRaw === "pencil"
        ? "pen"
        : activeToolRaw === "select"
          ? "select"
          : "select";
    const selectedObjectId =
      parsed.selectedObjectId && typeof parsed.selectedObjectId === "string"
        ? parsed.selectedObjectId
        : null;
    const rawSelectedObjectIds = Array.isArray(parsedRaw.selectedObjectIds)
      ? parsedRaw.selectedObjectIds.filter((id): id is string => typeof id === "string")
      : selectedObjectId
        ? [selectedObjectId]
        : [];
    const objectIdSet = new Set(objects.map((obj) => obj.id));
    const selectedObjectIds = rawSelectedObjectIds.filter((id) => objectIdSet.has(id));
    const primarySelectedObjectId =
      selectedObjectId && objectIdSet.has(selectedObjectId)
        ? selectedObjectId
        : selectedObjectIds.length > 0
          ? selectedObjectIds[0]
          : null;
    const zoom =
      typeof parsedRaw.zoom === "number" && Number.isFinite(parsedRaw.zoom)
        ? Math.min(3, Math.max(0.25, parsedRaw.zoom))
        : 1;
    return {
      objects,
      strokes,
      activeTool,
      selectedObjectId: primarySelectedObjectId,
      selectedObjectIds,
      zoom,
    };
  } catch {
    return defaultCanvasBoard();
  }
};

export function useAppModel() {
  const SIDEBAR_SESSION_VIEW_STORAGE_KEY = "sidebar-session-view";
  type SidebarSessionView = "folders" | "recent" | "closed" | "inbox";
  const parseSidebarSessionView = (): SidebarSessionView => {
    const raw = localStorage.getItem(SIDEBAR_SESSION_VIEW_STORAGE_KEY);
    if (raw === "folders" || raw === "closed" || raw === "inbox") return raw;
    return "recent";
  };
  const [sessions, setSessions] = createStore<WebSession[]>([]);
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null);
  const [tags, setTags] = createSignal<string[]>(DEFAULT_TAGS);
  const [pasteQueue, setPasteQueue] = createSignal<PasteQueueItem[]>([]);
  const [pasteHover, setPasteHover] = createSignal<{
    url: string;
    name: string;
    path: string;
    x: number;
    y: number;
  } | null>(null);
  const safePasteHover = createMemo(() => {
    const hover = pasteHover();
    if (!hover) return null;
    if (!hover.url || !hover.url.startsWith("blob:")) return null;
    return hover;
  });

  createEffect(() => {
    const hover = pasteHover();
    if (hover && (!hover.url || !hover.url.startsWith("blob:"))) {
      setPasteHover(null);
    }
  });
  const pasteQueueLimit = 100;
  const terminalPasteSuppressMs = 650;
  let lastTerminalPasteAt = 0;
  let lastTerminalPasteSessionId: string | null = null;
  let clipboardWarm = false;
  let clipboardWarmInFlight: Promise<void> | null = null;
  let lastClipboardTypes: string[] | null = null;
  let lastClipboardTypesAt = 0;
  let lastCmdBackspaceAt = 0;
  const cmdBackspaceRepeatMs = 500;
  const [selectedTags, setSelectedTags] = createSignal<Set<string>>(new Set());
  const [showUntagged, setShowUntagged] = createSignal(false);
  const [sidebarSessionView, setSidebarSessionView] = createSignal<SidebarSessionView>(
    parseSidebarSessionView()
  );
  const [terminalTags, setTerminalTags] = createSignal<Record<string, string[]>>({});
  const [tagMenuOpenFor, setTagMenuOpenFor] = createSignal<string | null>(null);
  const [newTagName, setNewTagName] = createSignal("");
  const [sessionSeenAt, setSessionSeenAt] = createSignal<Record<string, number>>({});
  const [ptyBySession, setPtyBySession] = createSignal<Record<string, string>>({});
  const [browserSessions, setBrowserSessions] = createSignal<Record<string, BrowserSessionState>>({});
  const [fileTabsBySession, setFileTabsBySession] = createSignal<Record<string, WorkspaceFileTab[]>>({});
  const [pinnedFileTabs, setPinnedFileTabs] = createSignal<WorkspaceFileTab[]>([]);
  const [activeWorkspaceTabBySession, setActiveWorkspaceTabBySession] = createSignal<Record<string, string>>({});
  // Per-tab markdown view mode ("source" | "preview"). Stored outside the
  // tab data model since it's UI state, not file content. Missing entry → "source".
  const [markdownViewModeByTab, setMarkdownViewModeByTab] = createSignal<Record<string, "source" | "preview">>({});
  const [_lastOutputAt, setLastOutputAt] = createSignal<Record<string, number>>({});
  const [sessionPreview, setSessionPreview] = createSignal<Record<string, string[]>>({});
  const [sessionInputDraft, setSessionInputDraft] = createSignal<Record<string, string>>({});
  const [agentSessionIdBySession, setAgentSessionIdBySession] = createSignal<Record<string, string>>({});

  interface LastAssistantTurn {
    text: string;
    timestamp: string | null;
    model: string | null;
  }
  const [lastAgentTurn, setLastAgentTurn] = createSignal<Record<string, LastAssistantTurn>>({});

  async function refreshLastAgentTurnsForActiveSessions() {
    const agentIds = agentSessionIdBySession();
    const codexStateMap = codexState();
    const claudeJobs: Promise<readonly [string, LastAssistantTurn] | null>[] = [];
    const codexJobs: Promise<readonly [string, LastAssistantTurn] | null>[] = [];

    // Claude Code: look up by hook-captured agent session id.
    for (const [sessionId, agentSessionId] of Object.entries(agentIds)) {
      claudeJobs.push(
        (async () => {
          try {
            const turn = await invoke<LastAssistantTurn | null>("cc_last_assistant_turn", {
              agentSessionId,
            });
            return turn ? ([sessionId, turn] as const) : null;
          } catch {
            return null;
          }
        })()
      );
    }

    // Codex: we don't track the codex session id, so match by cwd. Only
    // attempt sessions that look like codex (command contains codex, OR the
    // codex notify hook has fired for this session). Skip ones already
    // resolved as Claude to avoid double-fetching.
    for (const s of sessions) {
      if (agentIds[s.id]) continue;
      const cmd = (s.command ?? "").toLowerCase();
      const looksLikeCodex =
        /(^|\s|\/)codex(\s|$)/.test(cmd) || Boolean(codexStateMap[s.id]);
      if (!looksLikeCodex) continue;
      const cwd = s.directory;
      if (!cwd) continue;
      codexJobs.push(
        (async () => {
          try {
            const turn = await invoke<LastAssistantTurn | null>("codex_last_assistant_turn", {
              cwd,
            });
            return turn ? ([s.id, turn] as const) : null;
          } catch {
            return null;
          }
        })()
      );
    }

    if (claudeJobs.length === 0 && codexJobs.length === 0) return;
    const results = await Promise.all([...claudeJobs, ...codexJobs]);
    setLastAgentTurn((prev) => {
      const next = { ...prev };
      for (const r of results) {
        if (r) next[r[0]] = r[1];
      }
      return next;
    });
  }
  const [claudeState, setClaudeState] = createSignal<Record<string, string>>({});
  const [codexState, setCodexState] = createSignal<Record<string, string>>({});
  let prevClaudeState: Record<string, string> = {};
  let prevCodexState: Record<string, string> = {};
  let lastNotifiedSessionId: string | null = null;
  const [idleTick, setIdleTick] = createSignal(0);
  const [presets, setPresets] = createSignal<TerminalPreset[]>([]);
  const [appConfig, setAppConfig] = createSignal<AppConfig | null>(null);
  const [restorePromptOpen, setRestorePromptOpen] = createSignal(false);
  const [restoreDecision, setRestoreDecision] = createSignal<"pending" | "yes" | "no">("no");
  const [pendingRestoreActiveId, setPendingRestoreActiveId] = createSignal<string | null>(null);
  const [showPresetEditor, setShowPresetEditor] = createSignal(false);
  const [editingPreset, setEditingPreset] = createSignal<TerminalPreset | null>(null);
  const [newPresetTagName, setNewPresetTagName] = createSignal("");
  const [showPresetMenu, setShowPresetMenu] = createSignal(false);
  const [footerPresetMenuOpen, setFooterPresetMenuOpen] = createSignal(false);
  const [footerPresetId, setFooterPresetId] = createSignal<string | null>(
    localStorage.getItem(FOOTER_PRESET_STORAGE_KEY)
  );
  const [footerInput, setFooterInput] = createSignal("");
  const [showFilterMenu, setShowFilterMenu] = createSignal(false);
  const [appView, setAppView] = createSignal<AppView>(
    localStorage.getItem(APP_VIEW_STORAGE_KEY) === "canvas" ? "canvas" : "terminal"
  );
  const [showCommandPalette, setShowCommandPalette] = createSignal(false);
  const [commandPaletteMode, setCommandPaletteMode] = createSignal<"commands" | "switcher">(
    "commands"
  );
  const [switcherIndex, setSwitcherIndex] = createSignal(0);
  const [showClipboardDrawer, setShowClipboardDrawer] = createSignal(false);
  const [clipboardHistory, setClipboardHistory] = createSignal<ClipboardHistoryEntry[]>([]);
  const [clipboardHistoryQuery, setClipboardHistoryQuery] = createSignal("");
  const [clipboardHistoryIndex, setClipboardHistoryIndex] = createSignal(0);
  const [clipboardHistorySelected, setClipboardHistorySelected] = createSignal<Set<number>>(
    new Set(),
    { equals: false }
  );
  let clipboardHistoryInputRef: HTMLInputElement | undefined;
  const [canvasBoard, setCanvasBoard] = createSignal<CanvasBoard>(
    parseCanvasBoard(localStorage.getItem(CANVAS_BOARD_STORAGE_KEY)),
    { equals: false }
  );
  const [scratchpadOpen, setScratchpadOpen] = createSignal(false);
  const [imageEditorOpen, setImageEditorOpen] = createSignal(false);
  const [imageEditorPath, setImageEditorPath] = createSignal<string | null>(null);
  const [imageEditorName, setImageEditorName] = createSignal<string | null>(null);
  const [commandQuery, setCommandQuery] = createSignal("");
  const [commandIndex, setCommandIndex] = createSignal(0);
  const [recentlyClosedSessions, setRecentlyClosedSessions] = createSignal<DbSession[]>([]);
  let commandInputRef: HTMLInputElement | undefined;
  const [draggingSessionId, setDraggingSessionId] = createSignal<string | null>(null);
  const [dragOverSessionId, setDragOverSessionId] = createSignal<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");
  const [contextMenuFor, setContextMenuFor] = createSignal<{ id: string; x: number; y: number } | null>(null);
  const [sidebarContextMenu, setSidebarContextMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [canvasContextMenu, setCanvasContextMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [sidebarWidth, setSidebarWidth] = createSignal(280); // Default width
  const [sidebarHidden, setSidebarHidden] = createSignal(
    localStorage.getItem(SIDEBAR_HIDDEN_STORAGE_KEY) === "1"
  );
  const [isResizingSidebar, setIsResizingSidebar] = createSignal(false);
  const [quickInputActive, setQuickInputActive] = createSignal(false);
  const [quickViewMode, setQuickViewModeSignal] = createSignal<"grid" | "idle-focus">("grid");
  const [quickViewSelectedTags, setQuickViewSelectedTags] = createSignal<Set<string>>(new Set());
  const [quickViewShowUntagged, setQuickViewShowUntagged] = createSignal(false);
  const [quickViewIdleOnly, setQuickViewIdleOnly] = createSignal(false);
  const [quickViewGridIdleOnly, setQuickViewGridIdleOnly] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchFeedback, setSearchFeedback] = createSignal<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = createSignal<Set<string>>(new Set());
  const [dragOverFolder, setDragOverFolder] = createSignal<string | null>(null);
  const [folderContextMenu, setFolderContextMenu] = createSignal<{
    tag: string;
    x: number;
    y: number;
  } | null>(null);
  const [filePathContextMenu, setFilePathContextMenu] = createSignal<{
    path: string;
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);
  const [fileTabContextMenu, setFileTabContextMenu] = createSignal<{
    tabId: string;
    ownerSessionId: string;
    path: string;
    displayName: string;
    isPinned: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [urlContextMenu, setUrlContextMenu] = createSignal<{
    url: string;
    x: number;
    y: number;
  } | null>(null);
  // Tab history navigation (like browser back/forward)
  const [tabHistory, setTabHistory] = createSignal<string[]>([]);
  const [tabHistoryIndex, setTabHistoryIndex] = createSignal(-1);
  let isNavigatingHistory = false; // Flag to prevent adding to history during navigation
  // File browser state
  const [showFileBrowser, setShowFileBrowser] = createSignal(false);
  const [fileBrowserPath, setFileBrowserPath] = createSignal("");
  const [fileBrowserQuery, setFileBrowserQuery] = createSignal("");
  const [fileBrowserEntries, setFileBrowserEntries] = createSignal<FileBrowserEntry[]>([]);
  const [fileBrowserSearchResults, setFileBrowserSearchResults] = createSignal<FileBrowserEntry[]>([]);
  const [fileBrowserIndex, setFileBrowserIndex] = createSignal(0);
  const [fileBrowserLoading, setFileBrowserLoading] = createSignal(false);
  const [fileBrowserSearching, setFileBrowserSearching] = createSignal(false);
  const [showHiddenFiles, setShowHiddenFiles] = createSignal(false);
  const [fileBrowserActionEntry, setFileBrowserActionEntry] = createSignal<FileBrowserEntry | null>(null);
  const [fileBrowserActionIndex, setFileBrowserActionIndex] = createSignal(0);

  // ===== Conversation history search (cc-search) =====
  const [showCcSearch, setShowCcSearch] = createSignal(false);
  const [ccSearchQuery, setCcSearchQuery] = createSignal("");
  const [ccSearchResults, setCcSearchResults] = createSignal<CcSearchResult[]>([]);
  const [ccSearchIndex, setCcSearchIndex] = createSignal(0);
  const [ccSearchLoading, setCcSearchLoading] = createSignal(false);
  const [ccSearchError, setCcSearchError] = createSignal<string | null>(null);
  const [ccSearchMeta, setCcSearchMeta] = createSignal<{
    elapsed_ms: number;
    db_age_min: number | null;
  } | null>(null);
  let ccSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let ccSearchSeq = 0;
  let ccSearchInputRef: HTMLInputElement | undefined;
  const [recordingState, setRecordingState] = createSignal<RecorderState>("idle");
  const [recordingStartedAt, setRecordingStartedAt] = createSignal<number | null>(null);
  const [recordingError, setRecordingError] = createSignal<string | null>(null);
  const [lastRecording, setLastRecording] = createSignal<RecordingTranscriptionResult | null>(null);
  const [recordingClipboardEvents, setRecordingClipboardEvents] = createSignal<
    RecordingClipboardEvent[]
  >([]);
  let fileBrowserInputRef: HTMLInputElement | undefined;
  let fileBrowserSearchTimer: ReturnType<typeof setTimeout> | undefined;

  let renameInputRef: HTMLInputElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  let recorderDisplayStream: MediaStream | null = null;
  let recorderMicStream: MediaStream | null = null;
  let recorderCombinedStream: MediaStream | null = null;
  let recorderInstance: MediaRecorder | null = null;
  let recorderChunks: Blob[] = [];
  let recorderShuttingDown = false;

  const terminalHosts = new Map<string, HTMLDivElement>();
  const terminalInstances = new Map<string, { term: XtermTerminal; fit: XtermFitAddon; search: XtermSearchAddon }>();
  const terminalHostCleanup = new Map<string, () => void>();
  const lastPtySizeBySession = new Map<string, { rows: number; cols: number }>();
  const commandRunFor = new Set<string>();
  const autoTitleLookupInFlight = new Set<string>();
  const autoTitleResolvedAgentSessions = new Set<string>();
  const quickInputRefs = new Map<string, HTMLInputElement>();
  const fileTabFindHandlers = new Map<string, () => void>();

  const getSessionFileTabs = (sessionId: string | null | undefined): WorkspaceFileTab[] => {
    if (!sessionId) return [];
    return fileTabsBySession()[sessionId] || [];
  };

  const getActiveWorkspaceTabIdForSession = (sessionId: string | null | undefined): string => {
    if (!sessionId) return TERMINAL_WORKSPACE_TAB_ID;
    return activeWorkspaceTabBySession()[sessionId] || TERMINAL_WORKSPACE_TAB_ID;
  };

  const setSessionFileTabs = (
    sessionId: string,
    updater: (tabs: WorkspaceFileTab[]) => WorkspaceFileTab[]
  ) => {
    setFileTabsBySession((prev) => {
      const current = prev[sessionId] || [];
      const nextTabs = updater(current);
      if (nextTabs === current) return prev;
      const next = { ...prev };
      if (nextTabs.length > 0) {
        next[sessionId] = nextTabs;
      } else {
        delete next[sessionId];
      }
      return next;
    });
  };

  // Dispatcher that routes tab updates to either the pinned store or a session store
  // based on the tab's ownerSessionId. Lets pin-aware code reuse the same update closure.
  const updateFileTabsForOwner = (
    ownerSessionId: string,
    updater: (tabs: WorkspaceFileTab[]) => WorkspaceFileTab[]
  ) => {
    if (ownerSessionId === PINNED_WORKSPACE_OWNER_ID) {
      setPinnedFileTabs((prev) => {
        const next = updater(prev);
        return next === prev ? prev : next;
      });
    } else {
      setSessionFileTabs(ownerSessionId, updater);
    }
  };

  const findPinnedFileTab = (tabId: string): WorkspaceFileTab | undefined =>
    pinnedFileTabs().find((tab) => tab.id === tabId);

  const setActiveWorkspaceTabForSession = (sessionId: string, tabId: string) => {
    setActiveWorkspaceTabBySession((prev) => ({ ...prev, [sessionId]: tabId }));
  };

  const revokeWorkspaceFileTabResources = (tab: WorkspaceFileTab) => {
    if (tab.kind === "image_file" && tab.imageUrl) {
      URL.revokeObjectURL(tab.imageUrl);
    }
    fileTabFindHandlers.delete(tab.id);
    setMarkdownViewModeByTab((prev) => {
      if (!(tab.id in prev)) return prev;
      const next = { ...prev };
      delete next[tab.id];
      return next;
    });
  };

  const removeWorkspaceTabStateForSession = (sessionId: string) => {
    const ownedTabs = getSessionFileTabs(sessionId);
    for (const tab of ownedTabs) {
      revokeWorkspaceFileTabResources(tab);
    }
    setFileTabsBySession((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setActiveWorkspaceTabBySession((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  };

  const activeWorkspaceFileTab = createMemo<WorkspaceFileTab | null>(() => {
    const sessionId = activeSessionId();
    if (!sessionId) return null;
    const activeTabId = getActiveWorkspaceTabIdForSession(sessionId);
    if (activeTabId === TERMINAL_WORKSPACE_TAB_ID) return null;
    const pinnedMatch = findPinnedFileTab(activeTabId);
    if (pinnedMatch) return pinnedMatch;
    const match = getSessionFileTabs(sessionId).find((tab) => tab.id === activeTabId);
    return match || null;
  });

  const activeWorkspaceTabKind = createMemo<"terminal" | WorkspaceFileTabKind>(() => {
    return activeWorkspaceFileTab()?.kind || "terminal";
  });

  const activeSessionFileTabs = createMemo(() => {
    const sessionId = activeSessionId();
    return getSessionFileTabs(sessionId);
  });

  const focusTerminal = (id: string) => {
    if (quickInputActive()) return;
    const instance = terminalInstances.get(id);
    if (!instance) return;
    instance.term.focus();
    terminalHosts.get(id)?.focus();
    const textarea = (instance.term as unknown as { textarea?: HTMLTextAreaElement }).textarea;
    textarea?.focus();
  };

  const clearTerminalHostInteractions = (id: string) => {
    const cleanup = terminalHostCleanup.get(id);
    if (cleanup) {
      cleanup();
      terminalHostCleanup.delete(id);
    }
  };

  const focusTerminalInstance = (term: XtermTerminal) => {
    term.focus();
    const textarea = (term as unknown as { textarea?: HTMLTextAreaElement }).textarea;
    if (textarea) {
      textarea.readOnly = false;
      textarea.focus();
      console.log("[xterm] focus textarea", {
        readOnly: textarea.readOnly,
        disabled: textarea.disabled,
        active: document.activeElement === textarea,
      });
    } else {
      console.log("[xterm] focus textarea missing");
    }
  };

  const bindTerminalHostInteractions = (
    id: string,
    host: HTMLDivElement,
    term: XtermTerminal
  ) => {
    clearTerminalHostInteractions(id);
    const focusXterm = () => focusTerminalInstance(term);
    host.tabIndex = 0;
    host.style.outline = "none";
    host.style.cursor = "text";
    host.addEventListener("mousedown", focusXterm);
    host.addEventListener("click", focusXterm);
    host.addEventListener("pointerdown", focusXterm);
    host.addEventListener("touchstart", focusXterm, { passive: true });
    terminalHostCleanup.set(id, () => {
      host.removeEventListener("mousedown", focusXterm);
      host.removeEventListener("click", focusXterm);
      host.removeEventListener("pointerdown", focusXterm);
      host.removeEventListener("touchstart", focusXterm);
    });
  };

  const attachTerminalToHost = (id: string, host: HTMLDivElement, term: XtermTerminal) => {
    const terminalElement = term.element;
    if (terminalElement && terminalElement.parentElement !== host) {
      host.replaceChildren(terminalElement);
    }
    bindTerminalHostInteractions(id, host, term);
  };

  const canFitTerminalHost = (host: HTMLDivElement | undefined) =>
    Boolean(host && host.isConnected && host.clientWidth > 0 && host.clientHeight > 0);

  const stopMediaStreamTracks = (stream: MediaStream | null) => {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore track stop errors.
      }
    }
  };

  const clearRecorderResources = () => {
    stopMediaStreamTracks(recorderCombinedStream);
    stopMediaStreamTracks(recorderDisplayStream);
    stopMediaStreamTracks(recorderMicStream);
    recorderCombinedStream = null;
    recorderDisplayStream = null;
    recorderMicStream = null;
    recorderInstance = null;
    recorderChunks = [];
  };

  const formatRecordingTimestamp = (now = new Date()) => {
    const parts = [
      now.getFullYear(),
      `${now.getMonth() + 1}`.padStart(2, "0"),
      `${now.getDate()}`.padStart(2, "0"),
    ].join("");
    const time = [
      `${now.getHours()}`.padStart(2, "0"),
      `${now.getMinutes()}`.padStart(2, "0"),
      `${now.getSeconds()}`.padStart(2, "0"),
    ].join("");
    return `${parts}-${time}`;
  };

  const chooseRecordingMimeType = (): string => {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
      return "";
    }
    const candidates = [
      "video/mp4;codecs=h264,aac",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
  };

  const extensionForMimeType = (mimeType: string) => {
    const lower = mimeType.toLowerCase();
    if (lower.includes("mp4")) return "mp4";
    if (lower.includes("quicktime") || lower.includes("mov")) return "mov";
    return "webm";
  };

  const normalizeClipboardText = (value: string) => value.replace(/\r\n/g, "\n").trim();

  const recordClipboardCopyEvent = async (event: ClipboardEvent) => {
    if (recordingState() !== "recording") return;
    const startedAt = recordingStartedAt();
    if (!startedAt) return;
    let text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text) {
      try {
        text = await readClipboardText();
      } catch {
        text = "";
      }
    }
    const normalized = normalizeClipboardText(text);
    if (!normalized) return;
    const entry: RecordingClipboardEvent = {
      timestampMs: Math.max(0, Date.now() - startedAt),
      text: normalized.slice(0, 4000),
    };
    setRecordingClipboardEvents((prev) => [...prev.slice(-99), entry]);
  };

  const finalizeScreenRecording = async (chunks: Blob[], mimeType: string) => {
    if (recorderShuttingDown) return;
    setRecordingStartedAt(null);
    if (chunks.length === 0) {
      setRecordingState("error");
      setRecordingError("Recording captured no data.");
      return;
    }

    const blob = new Blob(chunks, { type: mimeType || "video/webm" });
    if (blob.size === 0) {
      setRecordingState("error");
      setRecordingError("Recording saved no usable bytes.");
      return;
    }

    const extension = extensionForMimeType(mimeType);
    const filename = `record-${formatRecordingTimestamp()}.${extension}`;
    let savedPath = "";

    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      savedPath = await invoke<string>("save_recording_file", {
        filename,
        bytes: Array.from(bytes),
      });
      enqueueRecordingPath(savedPath);
    } catch (err) {
      console.warn("[record] save_recording_file failed", err);
      setRecordingState("error");
      setRecordingError(`Failed to save recording: ${String(err)}`);
      return;
    }

    try {
      const clipboardEvents = recordingClipboardEvents();
      const result = await invoke<RecordingTranscriptionResult>("transcribe_recording_file", {
        path: savedPath,
        clipboardEvents,
      });
      setLastRecording(result);
      setRecordingError(null);
      setRecordingState("idle");
      setRecordingClipboardEvents([]);
    } catch (err) {
      console.warn("[record] transcribe_recording_file failed", err);
      setRecordingState("error");
      setRecordingError(
        `Recording saved at ${savedPath}, but transcription failed: ${String(err)}`
      );
    }
  };

  const startScreenRecording = async () => {
    if (recordingState() === "recording" || recordingState() === "processing") return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setRecordingState("error");
      setRecordingError("Screen recording is not available in this runtime.");
      return;
    }

    setRecordingState("processing");
    setRecordingError(null);
    setRecordingClipboardEvents([]);

    try {
      recorderDisplayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: 30,
        },
        audio: false,
      });
      recorderMicStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      const combinedTracks: MediaStreamTrack[] = [
        ...recorderDisplayStream.getVideoTracks(),
        ...recorderMicStream.getAudioTracks(),
      ];
      recorderCombinedStream = new MediaStream(combinedTracks);

      const selectedMimeType = chooseRecordingMimeType();
      recorderInstance = selectedMimeType
        ? new MediaRecorder(recorderCombinedStream, { mimeType: selectedMimeType })
        : new MediaRecorder(recorderCombinedStream);
      recorderChunks = [];

      recorderDisplayStream.getVideoTracks().forEach((track) => {
        track.addEventListener("ended", () => {
          if (recordingState() === "recording") {
            void stopScreenRecording();
          }
        });
      });

      recorderInstance.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) {
          recorderChunks.push(event.data);
        }
      });

      recorderInstance.addEventListener("stop", () => {
        const chunks = recorderChunks;
        const mimeType = recorderInstance?.mimeType || selectedMimeType || "video/webm";
        clearRecorderResources();
        void finalizeScreenRecording(chunks, mimeType);
      });

      recorderInstance.addEventListener("error", (event) => {
        console.warn("[record] media recorder error", event);
        clearRecorderResources();
        setRecordingStartedAt(null);
        setRecordingState("error");
        setRecordingError("Recording failed due to a media recorder error.");
      });

      recorderInstance.start(1000);
      setRecordingStartedAt(Date.now());
      setRecordingState("recording");
    } catch (err) {
      console.warn("[record] failed to start recording", err);
      clearRecorderResources();
      setRecordingStartedAt(null);
      setRecordingState("error");
      setRecordingError(
        `Failed to start recording. Confirm screen and microphone permissions are granted. (${String(err)})`
      );
    }
  };

  const stopScreenRecording = async () => {
    if (recordingState() !== "recording") return;
    setRecordingState("processing");
    setRecordingStartedAt(null);
    if (!recorderInstance || recorderInstance.state === "inactive") {
      clearRecorderResources();
      setRecordingState("idle");
      return;
    }
    try {
      recorderInstance.requestData();
    } catch {
      // Some runtimes do not support requestData in this state.
    }
    try {
      recorderInstance.stop();
    } catch (err) {
      console.warn("[record] stop failed", err);
      clearRecorderResources();
      setRecordingState("error");
      setRecordingError(`Failed to stop recording cleanly: ${String(err)}`);
    }
  };

  // Session persistence helpers (now backed by SQLite)
  // Track migration state (for debugging/future use)
  const [_dbMigrated, setDbMigrated] = createSignal(false);
  const mapDbSessionToWebSession = (dbSession: DbSession): WebSession => ({
    id: dbSession.id,
    title: dbSession.title,
    createdAt: dbSession.created_at * 1000,
    directory: dbSession.directory || undefined,
    command: dbSession.command || undefined,
  });

  // Create session in database
  async function dbCreateSession(session: WebSession) {
    try {
      await invoke("db_create_session", {
        req: {
          id: session.id,
          title: session.title,
          directory: session.directory || null,
          command: session.command || null,
        },
      });
    } catch (err) {
      console.error("Failed to create session in DB:", err);
    }
  }

  // Update session in database
  async function dbUpdateSession(id: string, updates: { title?: string; directory?: string }) {
    try {
      await invoke("db_update_session", {
        id,
        req: {
          title: updates.title || null,
          directory: updates.directory || null,
          last_accessed_at: Math.floor(Date.now() / 1000),
        },
      });
    } catch (err) {
      console.error("Failed to update session in DB:", err);
    }
  }

  // Close session in database (soft delete)
  async function dbCloseSession(id: string) {
    try {
      await invoke("db_close_session", { id });
    } catch (err) {
      console.error("Failed to close session in DB:", err);
    }
  }

  async function dbReopenSession(id: string) {
    try {
      await invoke("db_reopen_session", { id });
      return true;
    } catch (err) {
      console.error("Failed to reopen session in DB:", err);
      return false;
    }
  }

  async function dbListClosedSessions(limit = 20): Promise<DbSession[]> {
    try {
      return await invoke<DbSession[]>("db_list_closed_sessions", { limit });
    } catch (err) {
      console.error("Failed to list closed sessions in DB:", err);
      return [];
    }
  }

  async function refreshRecentlyClosedSessions(limit = 20) {
    const closedSessions = await dbListClosedSessions(limit);
    setRecentlyClosedSessions(closedSessions.filter((session) => session.is_closed));
  }

  // Save scrollback to database (debounced)
  const scrollbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const SCROLLBACK_SAVE_DELAY = 30000; // 30 seconds
  const PREVIEW_LINES = 100;

  function scheduleScrollbackSave(sessionId: string) {
    // Clear existing timer
    const existing = scrollbackTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    // Schedule new save
    const timer = setTimeout(() => {
      void saveScrollbackForSession(sessionId);
      scrollbackTimers.delete(sessionId);
    }, SCROLLBACK_SAVE_DELAY);
    scrollbackTimers.set(sessionId, timer);
  }

  async function saveScrollbackForSession(sessionId: string) {
    const instance = terminalInstances.get(sessionId);
    if (!instance) return;

    const content = captureScrollback(instance.term);
    if (!content) return;

    try {
      await invoke("db_save_scrollback", { sessionId, content });
    } catch (err) {
      console.error("Failed to save scrollback:", err);
    }
  }

  function updateSessionPreview(sessionId: string) {
    const instance = terminalInstances.get(sessionId);
    if (!instance) return;
    const lines = getLastLinesFromBuffer(instance.term, PREVIEW_LINES);
    setSessionPreview((prev) => ({ ...prev, [sessionId]: lines }));
  }

  // Save all scrollback immediately (for app close)
  async function saveAllScrollback() {
    const promises: Promise<void>[] = [];
    for (const [sessionId] of terminalInstances) {
      // Clear any pending timers
      const timer = scrollbackTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      scrollbackTimers.delete(sessionId);

      promises.push(saveScrollbackForSession(sessionId));
    }
    await Promise.all(promises);
  }

  // Legacy localStorage functions (kept for migration)
  function saveActiveSessionId(id: string | null) {
    if (id) {
      localStorage.setItem("terminal-active-session", id);
    } else {
      localStorage.removeItem("terminal-active-session");
    }
  }

  function saveSessionSeenAt(seenAt: Record<string, number>) {
    localStorage.setItem("terminal-session-seen", JSON.stringify(seenAt));
  }

  const focusSearchInput = () => {
    window.setTimeout(() => {
      if (searchInputRef) {
        searchInputRef.focus();
        searchInputRef.select();
      }
    }, 0);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchFeedback(null);
    const active = activeSessionId();
    if (active) {
      const instance = terminalInstances.get(active);
      instance?.term.clearSelection?.();
      instance?.search.clearDecorations();
    }
  };

  const runSearch = (direction: SearchDirection, options?: { resetPosition?: boolean }) => {
    const query = searchQuery().trim();
    if (!query) {
      setSearchFeedback(null);
      return false;
    }
    const active = activeSessionId();
    if (!active) return false;
    const instance = terminalInstances.get(active);
    if (!instance) return false;

    // Butter highlight decoration for search matches
    const decorationOptions = {
      matchBackground: "#F5D76E",
      matchBorder: "#F5D76E",
      matchOverviewRuler: "#F5D76E",
      activeMatchBackground: "#D4B85A",
      activeMatchBorder: "#D4B85A",
      activeMatchColorOverviewRuler: "#D4B85A",
    };

    let found: boolean;
    if (direction === "next") {
      found = instance.search.findNext(query, { decorations: decorationOptions, incremental: !options?.resetPosition });
    } else {
      found = instance.search.findPrevious(query, { decorations: decorationOptions, incremental: !options?.resetPosition });
    }

    setSearchFeedback(found ? null : "No match");
    return found;
  };

  createEffect(() => {
    const isOpen = searchOpen();
    const query = searchQuery();
    const active = activeSessionId();
    if (!isOpen || !active) return;
    const instance = terminalInstances.get(active);
    if (!query.trim()) {
      setSearchFeedback(null);
      instance?.search.clearDecorations();
      return;
    }
    runSearch("next", { resetPosition: true });
  });

  // Sessions are now persisted to SQLite on create/update/close
  // No need for auto-save effect

  // Auto-save active session when it changes
  createEffect(() => {
    saveActiveSessionId(activeSessionId());
  });

  // Auto-save session seen times when they change
  createEffect(() => {
    const seenAt = sessionSeenAt();
    if (Object.keys(seenAt).length > 0) {
      saveSessionSeenAt(seenAt);
    }
  });

  createEffect(() => {
    localStorage.setItem(SIDEBAR_SESSION_VIEW_STORAGE_KEY, sidebarSessionView());
  });

  createEffect(() => {
    localStorage.setItem(APP_VIEW_STORAGE_KEY, appView());
  });

  createEffect(() => {
    localStorage.setItem(CANVAS_BOARD_STORAGE_KEY, JSON.stringify(canvasBoard()));
  });

  createEffect(() => {
    localStorage.setItem(SIDEBAR_HIDDEN_STORAGE_KEY, sidebarHidden() ? "1" : "0");
  });

  // Close dropdown menus when clicking outside
  createEffect(() => {
    const presetOpen = showPresetMenu();
    const filterOpen = showFilterMenu();
    const footerOpen = footerPresetMenuOpen();
    if (!presetOpen && !filterOpen && !footerOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".butter-web-new-group")) {
        setShowPresetMenu(false);
      }
      if (!target.closest(".filter-menu") && !target.closest(".filter-button-wrapper")) {
        setShowFilterMenu(false);
      }
      if (!target.closest(".butter-web-footer-preset-group")) {
        setFooterPresetMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    onCleanup(() => document.removeEventListener("mousedown", handleClickOutside));
  });

  const activeFilterCount = createMemo(() => {
    let count = selectedTags().size;
    if (showUntagged()) count++;
    return count;
  });

  const footerPresets = createMemo(() => presets().filter((preset) => preset.footer));
  const shouldShowFooterPresetMenu = createMemo(() => footerPresets().length > 1);
  const resolvedFooterPreset = createMemo(() => {
    const flagged = footerPresets();
    const savedId = footerPresetId();
    if (flagged.length > 0) {
      if (savedId) {
        const match = flagged.find((preset) => preset.id === savedId);
        if (match) return match;
      }
      return flagged[0];
    }
    const all = presets();
    if (all.length > 0) return all[0];
    return null;
  });
  const footerInputEnabled = createMemo(() => {
    const preset = resolvedFooterPreset();
    return !!(preset && preset.command && preset.command.trim());
  });
  const footerPlaceholder = createMemo(() => {
    if (presets().length === 0) return "No presets available";
    const preset = resolvedFooterPreset();
    if (!preset) return "No presets available";
    if (!preset.command || !preset.command.trim()) {
      return `Preset "${preset.name}" has no command`;
    }
    // Show command and directory for more context
    const cmd = preset.command.trim();
    const dir = preset.directory?.replace(/^~/, "~") || "~";
    return `${cmd} → ${dir}`;
  });

  createEffect(() => {
    const flagged = footerPresets();
    if (flagged.length === 0) return;
    const savedId = footerPresetId();
    if (!savedId || !flagged.some((preset) => preset.id === savedId)) {
      const fallbackId = flagged[0].id;
      setFooterPresetId(fallbackId);
      localStorage.setItem(FOOTER_PRESET_STORAGE_KEY, fallbackId);
    }
  });

  createEffect(() => {
    if (!shouldShowFooterPresetMenu() && footerPresetMenuOpen()) {
      setFooterPresetMenuOpen(false);
    }
  });

  const tagQuery = createMemo(() => newTagName().trim().toLowerCase());
  const matchingTags = createMemo(() => {
    const query = tagQuery();
    const list = tags();
    if (!query) return list;
    return list.filter((tag) => tag.toLowerCase().includes(query));
  });
  const hasExactTagMatch = createMemo(() => {
    const query = tagQuery();
    if (!query) return false;
    return tags().some((tag) => tag.toLowerCase() === query);
  });

  const nextCanvasPlacement = () => {
    const offset = canvasBoard().objects.length % 8;
    return {
      x: 96 + offset * 24,
      y: 96 + offset * 18,
    };
  };

  const clampCanvasZoom = (value: number) => {
    if (!Number.isFinite(value)) return 1;
    return Math.max(0.25, Math.min(3, Math.round(value * 100) / 100));
  };

  const setCanvasZoom = (zoom: number) => {
    setCanvasBoard((prev) => ({ ...prev, zoom: clampCanvasZoom(zoom) }));
  };

  const zoomInCanvas = () => {
    setCanvasBoard((prev) => ({ ...prev, zoom: clampCanvasZoom(prev.zoom + 0.1) }));
  };

  const zoomOutCanvas = () => {
    setCanvasBoard((prev) => ({ ...prev, zoom: clampCanvasZoom(prev.zoom - 0.1) }));
  };

  const nextCanvasZ = () => {
    const current = canvasBoard().objects;
    if (current.length === 0) return 1;
    return Math.max(...current.map((item) => item.z)) + 1;
  };

  const bringCanvasObjectToFront = (id: string, options?: { select?: boolean }) => {
    const z = nextCanvasZ();
    setCanvasBoard((prev) => ({
      ...prev,
      selectedObjectId: options?.select === false ? prev.selectedObjectId : id,
      selectedObjectIds: options?.select === false ? prev.selectedObjectIds : [id],
      objects: prev.objects.map((obj) => (obj.id === id ? { ...obj, z } : obj)),
    }));
  };

  const setCanvasTool = (tool: CanvasTool) => {
    setCanvasBoard((prev) => ({ ...prev, activeTool: tool }));
  };

  const hideSidebar = () => {
    setSidebarHidden(true);
    setIsResizingSidebar(false);
    setSidebarContextMenu(null);
  };

  const showSidebar = () => {
    setSidebarHidden(false);
  };

  const toggleSidebarVisibility = () => {
    if (sidebarHidden()) {
      showSidebar();
      return;
    }
    hideSidebar();
  };

  const setAppViewMode = (view: AppView) => {
    setAppView(view);
    setCanvasContextMenu(null);
    if (view === "terminal") {
      setCanvasBoard((prev) => ({
        ...prev,
        activeTool: "select",
        selectedObjectId: null,
        selectedObjectIds: [],
      }));
      return;
    }
    setQuickInputActive(false);
    if (searchOpen()) {
      closeSearch();
    }
  };

  const selectCanvasObject = (id: string | null, options?: { bringToFront?: boolean }) => {
    if (!id) {
      setCanvasBoard((prev) => ({ ...prev, selectedObjectId: null, selectedObjectIds: [] }));
      return;
    }
    if (!options?.bringToFront) {
      setCanvasBoard((prev) => ({ ...prev, selectedObjectId: id, selectedObjectIds: [id] }));
      return;
    }
    bringCanvasObjectToFront(id, { select: true });
  };

  const setCanvasSelectedObjects = (ids: string[]) => {
    const knownIds = new Set(canvasBoard().objects.map((obj) => obj.id));
    const ordered = ids.filter((id, index) => knownIds.has(id) && ids.indexOf(id) === index);
    setCanvasBoard((prev) => ({
      ...prev,
      selectedObjectIds: ordered,
      selectedObjectId: ordered.length > 0 ? ordered[0] : null,
    }));
  };

  const updateCanvasObjectBounds = (
    id: string,
    updates: Partial<Pick<CanvasObject, "x" | "y" | "w" | "h">>
  ) => {
    setCanvasBoard((prev) => ({
      ...prev,
      objects: prev.objects.map((obj) => {
        if (obj.id !== id) return obj;
        return {
          ...obj,
          x: typeof updates.x === "number" ? updates.x : obj.x,
          y: typeof updates.y === "number" ? updates.y : obj.y,
          w: typeof updates.w === "number" ? Math.max(120, updates.w) : obj.w,
          h: typeof updates.h === "number" ? Math.max(90, updates.h) : obj.h,
        };
      }),
    }));
  };

  const removeCanvasObject = (id: string) => {
    setCanvasBoard((prev) => {
      const nextSelectedObjectIds = prev.selectedObjectIds.filter((selectedId) => selectedId !== id);
      const nextSelectedObjectId = nextSelectedObjectIds.length > 0
        ? nextSelectedObjectIds[0]
        : prev.selectedObjectId === id
          ? null
          : prev.selectedObjectId;
      return {
        ...prev,
        objects: prev.objects.filter((obj) => obj.id !== id),
        selectedObjectId: nextSelectedObjectId,
        selectedObjectIds: nextSelectedObjectIds,
      };
    });
  };

  const removeSelectedCanvasObjects = () => {
    const selectedIds = canvasBoard().selectedObjectIds.length > 0
      ? canvasBoard().selectedObjectIds
      : canvasBoard().selectedObjectId
        ? [canvasBoard().selectedObjectId]
        : [];
    if (selectedIds.length === 0) return;
    const selectedSet = new Set(selectedIds);
    setCanvasBoard((prev) => ({
      ...prev,
      objects: prev.objects.filter((obj) => !selectedSet.has(obj.id)),
      selectedObjectId: null,
      selectedObjectIds: [],
    }));
  };

  const updateCanvasTextObject = (id: string, text: string) => {
    setCanvasBoard((prev) => ({
      ...prev,
      objects: prev.objects.map((obj) =>
        obj.id === id && obj.type === "text" ? { ...obj, text } : obj
      ),
    }));
  };

  const addCanvasTextObject = () => {
    const pos = nextCanvasPlacement();
    const id = createCanvasId();
    const obj: CanvasObject = {
      id,
      type: "text",
      text: "",
      x: pos.x,
      y: pos.y,
      w: 360,
      h: 220,
      z: nextCanvasZ(),
    };
    setCanvasBoard((prev) => ({
      ...prev,
      objects: [...prev.objects, obj],
      selectedObjectId: id,
      selectedObjectIds: [id],
    }));
    setAppViewMode("canvas");
    return id;
  };

  const addCanvasStroke = (stroke: CanvasStroke) => {
    if (stroke.points.length < 2) return;
    setCanvasBoard((prev) => ({
      ...prev,
      strokes: [...prev.strokes, stroke],
    }));
  };

  const clearCanvasStrokes = () => {
    setCanvasBoard((prev) => ({ ...prev, strokes: [] }));
  };

  const addCanvasImageObject = (path: string, name?: string, position?: { x: number; y: number }) => {
    const pos = position ?? nextCanvasPlacement();
    const id = createCanvasId();
    const obj: CanvasObject = {
      id,
      type: "image",
      path,
      name: name || path.split("/").pop() || "Image",
      x: pos.x,
      y: pos.y,
      w: 420,
      h: 280,
      z: nextCanvasZ(),
    };
    setCanvasBoard((prev) => ({
      ...prev,
      objects: [...prev.objects, obj],
      selectedObjectId: id,
      selectedObjectIds: [id],
    }));
    setAppViewMode("canvas");
    return id;
  };

  const visibleSidebarWidth = () => (sidebarHidden() || quickInputActive() ? 0 : sidebarWidth());

  const canvasCenteredPlacement = (w: number, h: number) => {
    const usableWidth = Math.max(420, window.innerWidth - visibleSidebarWidth() - 56);
    const usableHeight = Math.max(320, window.innerHeight - 140);
    return {
      x: Math.max(24, (usableWidth - w) / 2),
      y: Math.max(24, (usableHeight - h) / 2),
    };
  };

  const addCanvasImageFromClipboard = (path: string) => {
    const pos = canvasCenteredPlacement(420, 280);
    return addCanvasImageObject(path, undefined, pos);
  };

  const inferCanvasFileKind = (path: string): CanvasFileKind => {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    if (IMAGE_FILE_EXTENSIONS.has(ext)) return "image";
    if (TEXT_FILE_EXTENSIONS.has(ext)) return "text";
    return "binary";
  };

  const addCanvasFileObject = async (entry: FileBrowserEntry) => {
    const pos = nextCanvasPlacement();
    const name = entry.name || entry.path.split("/").pop() || "File";
    let fileKind = inferCanvasFileKind(entry.path);
    let textContent: string | undefined;
    let error: string | undefined;

    if (fileKind !== "image") {
      try {
        textContent = await invoke<string>("read_file_text", {
          path: entry.path,
          maxBytes: CANVAS_TEXT_FILE_LIMIT_BYTES,
        });
        fileKind = "text";
      } catch (err) {
        if (fileKind === "text") {
          error = err instanceof Error ? err.message : "Could not load file text";
        }
        fileKind = "binary";
      }
    }

    const id = createCanvasId();
    const obj: CanvasObject = {
      id,
      type: "file",
      path: entry.path,
      name,
      fileKind,
      textContent,
      error,
      x: pos.x,
      y: pos.y,
      w: 460,
      h: 300,
      z: nextCanvasZ(),
    };

    setCanvasBoard((prev) => ({
      ...prev,
      objects: [...prev.objects, obj],
      selectedObjectId: id,
      selectedObjectIds: [id],
    }));
    setAppViewMode("canvas");
    return id;
  };

  const fitTerminalSession = (sessionId: string) => {
    const instance = terminalInstances.get(sessionId);
    const host = terminalHosts.get(sessionId);
    if (!instance || !host) return;
    attachTerminalToHost(sessionId, host, instance.term);
    if (!canFitTerminalHost(host)) return;
    instance.fit.fit();
    void updatePtySize(sessionId);
  };

  const addCanvasTerminalObject = async (sessionId?: string) => {
    let targetSessionId = sessionId || activeSessionId();
    if (!targetSessionId) {
      targetSessionId = await createSession();
    }
    const existing = canvasBoard().objects.find(
      (obj) => obj.type === "terminal" && obj.sessionId === targetSessionId
    );
    if (existing) {
      bringCanvasObjectToFront(existing.id);
      setAppViewMode("canvas");
      setTimeout(() => fitTerminalSession(targetSessionId), 0);
      return existing.id;
    }

    const pos = nextCanvasPlacement();
    const id = createCanvasId();
    const obj: CanvasObject = {
      id,
      type: "terminal",
      sessionId: targetSessionId,
      x: pos.x,
      y: pos.y,
      w: 560,
      h: 340,
      z: nextCanvasZ(),
    };

    setCanvasBoard((prev) => ({
      ...prev,
      objects: [...prev.objects, obj],
      selectedObjectId: id,
      selectedObjectIds: [id],
    }));
    setAppViewMode("canvas");
    setTimeout(() => {
      void ensureTerminal(targetSessionId, { focus: false });
      fitTerminalSession(targetSessionId);
    }, 0);
    return id;
  };

  const commands = createMemo(() => {
    const inCanvas = appView() === "canvas";
    const base = [
      {
        id: "new-terminal",
        label: "New Terminal",
        description: "Create a new shell session",
        action: () => createSession(),
      },
      {
        id: "fork-terminal",
        label: "Fork Terminal",
        description: "Duplicate command + scrollback from active terminal",
        action: () => {
          const active = activeSessionId();
          if (active) {
            void forkSession(active);
          }
        },
      },
      {
        id: "new-preset",
        label: "Create Preset",
        description: "Save a directory + command combo",
        action: () => openPresetEditor(),
      },
      {
        id: "rename-terminal",
        label: "Rename Current Terminal",
        description: "Update the active terminal title",
        action: () => {
          const active = activeSessionId();
          if (active) {
            openRename(active);
          }
        },
      },
      {
        id: "toggle-urgent",
        label: "Toggle Tag Filter: urgent",
        description: "Filter terminals by urgent tag",
        action: () => toggleTagFilter("urgent"),
      },
      {
        id: "tag-current-urgent",
        label: "Tag Current Terminal: urgent",
        description: "Add urgent tag to the active terminal",
        action: () => {
          const active = activeSessionId();
          if (active) {
            addTagToTerminal(active, "urgent");
          }
        },
      },
      {
        id: "copy-terminal-output",
        label: "Copy Terminal Output",
        description: "Copy full scrollback of active terminal to clipboard",
        action: () => {
          const active = activeSessionId();
          if (active) {
            void copyTerminalOutputToClipboard(active);
          }
        },
      },
      {
        id: "close-terminal",
        label: "Close Terminal",
        description: "Close the active terminal session",
        action: () => {
          const active = activeSessionId();
          if (active) {
            void closeSession(active);
          }
        },
      },
      {
        id: "close-other-terminals",
        label: "Close Other Terminals",
        description: "Close all terminals except the active one",
        action: () => {
          const active = activeSessionId();
          if (active) {
            void closeOtherSessions(active);
          }
        },
      },
      {
        id: "close-all-terminals",
        label: "Close All Terminals",
        description: "Close all terminal sessions",
        action: () => {
          void closeAllSessions();
        },
      },
      {
        id: "reopen-last-closed-terminal",
        label: "Reopen Last Closed Terminal",
        description: "Restore the most recently closed terminal (Cmd+Shift+T)",
        action: () => {
          void reopenLastClosedSession();
        },
      },
      {
        id: "restore-sessions",
        label: "Restore Previous Sessions",
        description: "Restore terminal sessions from last time",
        action: () => {
          void restorePreviousSessions();
        },
      },
      {
        id: "file-browser",
        label: "Browse Files",
        description: inCanvas
          ? "Browse files to add to canvas (Cmd+Shift+E)"
          : "Browse directory of current terminal (Cmd+Shift+E)",
        action: () => void openFileBrowser(),
      },
      {
        id: "cc-search",
        label: "Search Conversation History",
        description: "Full-text search past Claude Code sessions (Cmd+Shift+H)",
        action: () => openCcSearch(),
      },
      {
        id: "quick-input",
        label: "Quick Input View",
        description: "Send commands to any terminal at a glance",
        action: () => toggleQuickInputView(),
      },
      {
        id: "exit-quick-input",
        label: "Exit Quick Input View",
        description: "Return to focused terminal view",
        action: () => setQuickInputActive(false),
      },
      {
        id: "scratchpad",
        label: "Open Scratchpad",
        description: "Quick notes and commands",
        action: () => setScratchpadOpen(true),
      },
      {
        id: "open-config",
        label: "Open Config File",
        description: "Edit settings in ~/.config/butter/config.toml",
        action: async () => {
          const path = await invoke<string>("get_config_path");
          await Command.create("open", [path]).execute();
        },
      },
      {
        id: "toggle-sidebar",
        label: sidebarHidden() ? "Show Sidebar" : "Hide Sidebar",
        description: sidebarHidden()
          ? "Reveal the left terminal sidebar"
          : "Collapse the left terminal sidebar",
        action: () => toggleSidebarVisibility(),
      },
    ];

    const viewCommands = [
      {
        id: "open-terminal-view",
        label: "Open Terminal View",
        description: "Return to the default terminal layout",
        action: () => setAppViewMode("terminal"),
      },
      {
        id: "open-canvas-view",
        label: "Open Canvas View",
        description: "Switch to canvas workspace",
        action: () => setAppViewMode("canvas"),
      },
    ];

    const canvasCommands = inCanvas
      ? [
          {
            id: "canvas-add-text",
            label: "Canvas: Add Text",
            description: "Insert editable text object",
            action: () => addCanvasTextObject(),
          },
          {
            id: "canvas-tool-select",
            label: "Canvas Tool: Select",
            description: "Move and resize canvas objects",
            action: () => setCanvasTool("select"),
          },
          {
            id: "canvas-tool-pen",
            label: "Canvas Tool: Pen",
            description: "Draw with pen on canvas",
            action: () => setCanvasTool("pen"),
          },
          {
            id: "canvas-add-terminal",
            label: "Canvas: Add Terminal",
            description: "Embed active terminal session on canvas",
            action: () => void addCanvasTerminalObject(),
          },
          {
            id: "canvas-clear-drawing",
            label: "Canvas: Clear Drawing",
            description: "Clear all pen/pencil strokes",
            action: () => clearCanvasStrokes(),
          },
        ]
      : [];

    const sessionCommands = sessions.map((session) => ({
      id: `focus-${session.id}`,
      label: `Focus Terminal: ${session.title}`,
      description: session.directory || session.command || "Switch active terminal",
      action: () => selectSession(session.id),
    }));

    const recentlyClosedCommands = recentlyClosedSessions().slice(0, 8).map((session) => ({
      id: `reopen-closed-${session.id}`,
      label: `Reopen Closed: ${session.title}`,
      description: session.directory || session.command || "Restore closed terminal session",
      action: () => {
        void reopenClosedSession(session.id);
      },
    }));

    const presetCommands = presets().map((preset) => ({
      id: `preset-${preset.id}`,
      label: `New from Preset: ${preset.name}`,
      description: preset.directory || preset.command || "Launch preset terminal",
      action: () => void launchPresetSession(preset),
    }));

    return [
      ...viewCommands,
      ...canvasCommands,
      ...base,
      ...recentlyClosedCommands,
      ...presetCommands,
      ...sessionCommands,
    ];
  });

  const filteredCommands = createMemo(() => {
    const query = commandQuery().trim().toLowerCase();
    if (!query) return commands();
    return commands().filter((command) => {
      const haystack = `${command.label} ${command.description ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  });

  // File browser: visible entries - shows search results when searching, directory listing otherwise
  const filteredFileBrowserEntries = createMemo(() => {
    const query = fileBrowserQuery().trim().toLowerCase();
    const searchResults = fileBrowserSearchResults();

    if (query && query.length >= 2 && searchResults.length > 0) {
      // Show recursive search results
      let results = searchResults;
      if (!showHiddenFiles()) {
        results = results.filter((e) => !e.is_hidden);
      }
      return results;
    }

    // No deep search results yet: filter current directory listing locally
    let entries = fileBrowserEntries();
    if (!showHiddenFiles()) {
      entries = entries.filter((e) => !e.is_hidden);
    }
    if (query) {
      entries = entries.filter((e) => e.name.toLowerCase().includes(query));
    }
    return entries;
  });

  // File browser: load directory contents (non-recursive)
  const loadDirectory = async (dirPath: string) => {
    setFileBrowserLoading(true);
    setFileBrowserSearchResults([]);
    setFileBrowserActionEntry(null);
    if (fileBrowserSearchTimer) clearTimeout(fileBrowserSearchTimer);
    try {
      const entries = await invoke<FileBrowserEntry[]>("list_directory", { path: dirPath });
      setFileBrowserEntries(entries);
      setFileBrowserPath(dirPath);
      setFileBrowserQuery("");
      setFileBrowserIndex(0);
    } catch (e) {
      console.error("Failed to list directory:", e);
    } finally {
      setFileBrowserLoading(false);
    }
  };

  // File browser: recursive search (runs off main thread via Tauri async command)
  const searchDirectory = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 2) {
      setFileBrowserSearchResults([]);
      setFileBrowserSearching(false);
      return;
    }
    setFileBrowserSearching(true);
    try {
      const results = await invoke<FileBrowserEntry[]>("search_directory", {
        path: fileBrowserPath(),
        query: trimmed,
        includeHidden: showHiddenFiles(),
      });
      // Only update if the query hasn't changed since we started
      if (fileBrowserQuery().trim() === trimmed) {
        setFileBrowserSearchResults(results);
        setFileBrowserIndex(0);
      }
    } catch (e) {
      console.error("Failed to search directory:", e);
    } finally {
      setFileBrowserSearching(false);
    }
  };

  const debouncedSearch = (query: string) => {
    if (fileBrowserSearchTimer) clearTimeout(fileBrowserSearchTimer);
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 2) {
      setFileBrowserSearchResults([]);
      setFileBrowserSearching(false);
      return;
    }
    setFileBrowserSearching(true);
    fileBrowserSearchTimer = setTimeout(() => void searchDirectory(query), 300);
  };

  // ===== Conversation history search (cc-search) =====

  const setCcSearchInputRef = (el: HTMLInputElement | undefined) => {
    ccSearchInputRef = el;
  };

  const runCcSearch = (raw: string) => {
    const query = raw.trim();
    if (ccSearchTimer) clearTimeout(ccSearchTimer);
    const mySeq = ++ccSearchSeq;
    if (query.length < 2) {
      setCcSearchResults([]);
      setCcSearchLoading(false);
      setCcSearchError(null);
      setCcSearchMeta(null);
      setCcSearchIndex(0);
      return;
    }
    setCcSearchLoading(true);
    ccSearchTimer = setTimeout(() => {
      void (async () => {
        try {
          const resp = await invoke<CcSearchResponse>("cc_search", {
            query,
            limit: 30,
          });
          if (mySeq !== ccSearchSeq) return; // a newer keystroke won
          if (resp.error) {
            setCcSearchError(resp.error);
            setCcSearchResults([]);
            setCcSearchMeta(null);
          } else {
            setCcSearchError(null);
            setCcSearchResults(resp.results ?? []);
            setCcSearchMeta({
              elapsed_ms: resp.elapsed_ms ?? 0,
              db_age_min: resp.db_age_min ?? null,
            });
          }
          setCcSearchIndex(0);
        } catch (err) {
          if (mySeq !== ccSearchSeq) return;
          setCcSearchError(String(err));
          setCcSearchResults([]);
          setCcSearchMeta(null);
        } finally {
          if (mySeq === ccSearchSeq) setCcSearchLoading(false);
        }
      })();
    }, 150);
  };

  const openCcSearch = () => {
    setShowCcSearch(true);
    setCcSearchIndex(0);
    setCcSearchError(null);
    if (ccSearchQuery().trim().length >= 2) runCcSearch(ccSearchQuery());
    queueMicrotask(() => ccSearchInputRef?.focus());
  };

  const closeCcSearch = () => {
    if (ccSearchTimer) clearTimeout(ccSearchTimer);
    ccSearchSeq++;
    setShowCcSearch(false);
    setCcSearchLoading(false);
  };

  const updateCcSearchQuery = (value: string) => {
    setCcSearchQuery(value);
    runCcSearch(value);
  };

  const resumeCcSearchResult = (result: CcSearchResult) => {
    const shortId = result.session_id.slice(0, 8);
    const title = result.title?.trim() || `Resume ${shortId}`;
    const directory = result.cwd?.trim() || undefined;
    createSession(undefined, `claude --resume ${result.session_id}`, directory, title);
    closeCcSearch();
  };

  const copyCcResumeCommand = async (result: CcSearchResult) => {
    try {
      await navigator.clipboard.writeText(`claude --resume ${result.session_id}`);
    } catch (err) {
      console.error("Failed to copy resume command:", err);
    }
  };

  const copyCcText = async (result: CcSearchResult, mode: "match" | "thread") => {
    try {
      const resp = await invoke<CcFetchResponse>("cc_fetch", {
        sessionId: result.session_id,
        mode,
        query: mode === "match" ? ccSearchQuery().trim() : null,
      });
      if (resp.error) {
        setCcSearchError(resp.error);
        return;
      }
      await navigator.clipboard.writeText(resp.text ?? "");
    } catch (err) {
      console.error(`Failed to copy ${mode} text:`, err);
      setCcSearchError(String(err));
    }
  };

  const copyCcMatch = (result: CcSearchResult) => copyCcText(result, "match");
  const copyCcThread = (result: CcSearchResult) => copyCcText(result, "thread");

  const openCcSessionFile = async (result: CcSearchResult) => {
    if (!result.file_path) {
      setCcSearchError("No transcript file recorded for this session.");
      return;
    }
    try {
      const tmpPath = await invoke<string>("cc_export_session", {
        filePath: result.file_path,
      });
      closeCcSearch();
      await openFileInButter(tmpPath);
    } catch (err) {
      console.error("Failed to open session file:", err);
      setCcSearchError(String(err));
    }
  };

  // ===== Clipboard history =====

  const refreshClipboardHistory = async () => {
    try {
      const entries = await invoke<ClipboardHistoryEntry[]>("clipboard_history_list");
      setClipboardHistory(entries);
      setClipboardHistorySelected((prev) => {
        const ids = new Set(entries.map((e) => e.id));
        const next = new Set<number>();
        prev.forEach((id) => {
          if (ids.has(id)) next.add(id);
        });
        return next;
      });
      setClipboardHistoryIndex((prev) =>
        Math.max(0, Math.min(prev, Math.max(0, entries.length - 1)))
      );
    } catch (err) {
      console.warn("[clipboard-history] list failed", err);
    }
  };

  const openClipboardDrawer = async () => {
    setShowClipboardDrawer(true);
    setClipboardHistoryIndex(0);
    await refreshClipboardHistory();
    queueMicrotask(() => clipboardHistoryInputRef?.focus());
  };

  const closeClipboardDrawer = () => {
    setShowClipboardDrawer(false);
    setClipboardHistoryQuery("");
    setClipboardHistorySelected(new Set<number>());
  };

  const toggleClipboardDrawer = async () => {
    if (showClipboardDrawer()) {
      closeClipboardDrawer();
    } else {
      await openClipboardDrawer();
    }
  };

  const filteredClipboardHistory = createMemo(() => {
    const q = clipboardHistoryQuery().trim().toLowerCase();
    const list = clipboardHistory();
    if (!q) return list;
    return list.filter((entry) => {
      const text = (entry.text ?? entry.imagePath ?? "").toLowerCase();
      const source = (entry.sourceApp ?? "").toLowerCase();
      return text.includes(q) || source.includes(q);
    });
  });

  const toggleClipboardHistorySelection = (id: number) => {
    setClipboardHistorySelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteClipboardHistoryEntry = async (id: number) => {
    try {
      await invoke("clipboard_history_delete", { id });
      await refreshClipboardHistory();
    } catch (err) {
      console.warn("[clipboard-history] delete failed", err);
    }
  };

  const clearClipboardHistory = async () => {
    try {
      await invoke("clipboard_history_clear");
      setPasteQueue([]);
      await refreshClipboardHistory();
    } catch (err) {
      console.warn("[clipboard-history] clear failed", err);
    }
  };

  const selectAllClipboardHistory = () => {
    const list = filteredClipboardHistory();
    const next = new Set<number>();
    for (const entry of list) next.add(entry.id);
    setClipboardHistorySelected(next);
  };

  /** Merge the selected entries (or the active one) and write to the system pasteboard. */
  const copyFromClipboardHistory = async () => {
    const list = filteredClipboardHistory();
    if (list.length === 0) return;
    const selected = clipboardHistorySelected();
    let ids: number[];
    if (selected.size > 0) {
      ids = list.filter((e) => selected.has(e.id)).map((e) => e.id);
    } else {
      const idx = Math.max(0, Math.min(clipboardHistoryIndex(), list.length - 1));
      ids = [list[idx].id];
    }
    if (ids.length === 0) return;
    try {
      await invoke<string>("clipboard_history_compose", {
        ids,
        separator: "\n\n",
        includeSource: true,
      });
      closeClipboardDrawer();
    } catch (err) {
      console.warn("[clipboard-history] compose failed", err);
    }
  };

  // File browser: open the browser at the current terminal's working directory
  const openFileBrowser = async () => {
    const activeId = activeSessionId();
    let startPath = "~";
    if (activeId) {
      const ptyId = ptyBySession()[activeId];
      if (ptyId) {
        try {
          const cwd = await invoke<string>("get_pty_cwd", { id: ptyId });
          if (cwd) startPath = cwd;
        } catch {
          // Fall back to home
        }
      }
    }
    setShowFileBrowser(true);
    await loadDirectory(startPath);
  };

  // File browser: navigate to parent directory
  const navigateToParent = async () => {
    const current = fileBrowserPath();
    if (!current || current === "/") return;
    const parent = current.replace(/\/[^/]+\/?$/, "") || "/";
    await loadDirectory(parent);
  };

  // File browser: format file size for display
  const formatSize = (bytes: number | null): string => {
    if (bytes === null) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const canOpenPathInButter = (path: string) => {
    return getButterWorkspaceFileKind(path) !== null;
  };

  const registerFileTabFindHandler = (tabId: string, handler?: () => void) => {
    if (handler) {
      fileTabFindHandlers.set(tabId, handler);
    } else {
      fileTabFindHandlers.delete(tabId);
    }
  };

  const focusActiveFileTabFind = () => {
    const activeTab = activeWorkspaceFileTab();
    if (!activeTab || activeTab.kind !== "text_file") return;
    fileTabFindHandlers.get(activeTab.id)?.();
  };

  const selectTerminalWorkspaceTab = (sessionId: string) => {
    setActiveWorkspaceTabForSession(sessionId, TERMINAL_WORKSPACE_TAB_ID);
    if (activeSessionId() === sessionId) {
      requestAnimationFrame(() => focusTerminal(sessionId));
    }
  };

  const selectFileWorkspaceTab = (sessionId: string, tabId: string) => {
    if (activeSessionId() !== sessionId) {
      selectSession(sessionId);
    }
    setActiveWorkspaceTabForSession(sessionId, tabId);
  };

  const updateTextFileTabContent = (sessionId: string, tabId: string, content: string) => {
    updateFileTabsForOwner(sessionId, (tabs) =>
      tabs.map((tab) =>
        tab.id === tabId && tab.kind === "text_file"
          ? {
              ...tab,
              content,
              dirty: content !== tab.savedContent,
              error: null,
            }
          : tab
      )
    );
  };

  const saveActiveTextFileTab = async () => {
    const activeTab = activeWorkspaceFileTab();
    if (!activeTab || activeTab.kind !== "text_file" || activeTab.loading) return;
    try {
      await invoke("write_file_text", {
        path: activeTab.path,
        content: activeTab.content,
      });
      updateFileTabsForOwner(activeTab.ownerSessionId, (tabs) =>
        tabs.map((tab) =>
          tab.id === activeTab.id && tab.kind === "text_file"
            ? {
                ...tab,
                savedContent: tab.content,
                dirty: false,
                error: null,
              }
            : tab
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateFileTabsForOwner(activeTab.ownerSessionId, (tabs) =>
        tabs.map((tab) =>
          tab.id === activeTab.id && tab.kind === "text_file"
            ? { ...tab, error: message }
            : tab
        )
      );
    }
  };

  const isMarkdownTab = (tab: WorkspaceFileTab | null | undefined): boolean => {
    return tab?.kind === "text_file" && isMarkdownPath(tab.path);
  };

  const getMarkdownViewMode = (tabId: string): "source" | "preview" => {
    return markdownViewModeByTab()[tabId] || "source";
  };

  const setMarkdownViewMode = (tabId: string, mode: "source" | "preview") => {
    setMarkdownViewModeByTab((prev) => {
      if (prev[tabId] === mode) return prev;
      return { ...prev, [tabId]: mode };
    });
  };

  const toggleMarkdownViewMode = (tabId: string) => {
    setMarkdownViewMode(tabId, getMarkdownViewMode(tabId) === "preview" ? "source" : "preview");
  };

  const exportActiveMarkdownAsPdf = () => {
    console.log("[pdf-export] start");
    const tab = activeWorkspaceFileTab();
    if (!tab || tab.kind !== "text_file" || !isMarkdownPath(tab.path)) {
      console.warn("[pdf-export] aborting: no active markdown tab", { tab });
      return;
    }
    console.log("[pdf-export] tab:", { id: tab.id, path: tab.path, displayName: tab.displayName });
    setMarkdownViewMode(tab.id, "preview");
    console.log("[pdf-export] forced preview mode, waiting 2 frames for render");

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        console.log("[pdf-export] frames elapsed, querying preview content");
        const source = document.querySelector<HTMLElement>(
          ".butter-markdown-preview-content"
        );
        if (!source) {
          console.error("[pdf-export] aborting: preview content not in DOM");
          return;
        }
        console.log("[pdf-export] source found, innerHTML length:", source.innerHTML.length);

        const renderedHtml = source.innerHTML;
        const safeTitle = tab.displayName
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        const root = document.getElementById("root");
        if (!root) {
          console.error("[pdf-export] #root not found — cannot detach app for print");
          return;
        }

        // Build a standalone print container with inline styles. No dependency
        // on App.css — fully self-contained so the main webview's print
        // operation can't be confused by app-level dark theme rules.
        const printRoot = document.createElement("div");
        printRoot.id = "butter-pdf-print-root";
        printRoot.setAttribute("style", [
          "position: static",
          "display: block",
          "background: #ffffff",
          "color: #000000",
          "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
          "font-size: 14px",
          "line-height: 1.6",
          "padding: 48px 56px",
          "max-width: 820px",
          "margin: 0 auto",
          "user-select: text",
          "-webkit-user-select: text",
        ].join("; "));
        printRoot.innerHTML = `
<style>
  #butter-pdf-print-root h1,
  #butter-pdf-print-root h2,
  #butter-pdf-print-root h3,
  #butter-pdf-print-root h4,
  #butter-pdf-print-root h5,
  #butter-pdf-print-root h6 {
    margin: 1.6em 0 0.6em;
    font-weight: 600;
    line-height: 1.25;
    color: #000000;
  }
  #butter-pdf-print-root h1 { font-size: 2em; border-bottom: 1px solid #dddddd; padding-bottom: 0.3em; }
  #butter-pdf-print-root h2 { font-size: 1.5em; border-bottom: 1px solid #dddddd; padding-bottom: 0.3em; }
  #butter-pdf-print-root h3 { font-size: 1.25em; }
  #butter-pdf-print-root p { margin: 0 0 1em; color: #000000; }
  #butter-pdf-print-root a { color: #0645ad; text-decoration: underline; }
  #butter-pdf-print-root code {
    background: #f3f3f3;
    color: #000000;
    padding: 0.1em 0.35em;
    border-radius: 3px;
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.88em;
  }
  #butter-pdf-print-root pre {
    background: #f5f5f5;
    border: 1px solid #dddddd;
    border-radius: 4px;
    padding: 12px 14px;
    overflow: visible;
    margin: 0 0 1em;
    color: #000000;
    white-space: pre-wrap;
  }
  #butter-pdf-print-root pre code {
    background: transparent;
    padding: 0;
    font-size: 0.88em;
    color: #000000;
  }
  #butter-pdf-print-root blockquote {
    border-left: 3px solid #888888;
    background: #fafafa;
    color: #333333;
    padding: 0.2em 1em;
    margin: 0 0 1em;
  }
  #butter-pdf-print-root ul,
  #butter-pdf-print-root ol { margin: 0 0 1em; padding-left: 1.6em; color: #000000; }
  #butter-pdf-print-root li { margin: 0.2em 0; color: #000000; }
  #butter-pdf-print-root table {
    border-collapse: collapse;
    margin: 0 0 1em;
    width: 100%;
  }
  #butter-pdf-print-root th,
  #butter-pdf-print-root td {
    border: 1px solid #cccccc;
    padding: 8px 12px;
    text-align: left;
    color: #000000;
  }
  #butter-pdf-print-root th { background: #f0f0f0; font-weight: 600; }
  #butter-pdf-print-root hr { border: none; border-top: 1px solid #cccccc; margin: 2em 0; }
  #butter-pdf-print-root img { max-width: 100%; }
  #butter-pdf-print-root .butter-pdf-header {
    font-size: 11px;
    color: #888888;
    padding-bottom: 10px;
    margin-bottom: 20px;
    border-bottom: 1px solid #dddddd;
  }
  @media print {
    @page { margin: 2cm 2cm 2.5cm; }
    #butter-pdf-print-root { padding: 0 !important; max-width: none !important; }
    #butter-pdf-print-root h1,
    #butter-pdf-print-root h2,
    #butter-pdf-print-root h3,
    #butter-pdf-print-root h4,
    #butter-pdf-print-root h5,
    #butter-pdf-print-root h6 { page-break-after: avoid; }
    #butter-pdf-print-root pre,
    #butter-pdf-print-root img,
    #butter-pdf-print-root table { page-break-inside: avoid; }
  }
</style>
<div class="butter-pdf-header">${safeTitle}</div>
<article>${renderedHtml}</article>`;

        // Stash the original body/html inline styles so we can restore them.
        // The global stylesheet sets html/body to height:100%; overflow:hidden
        // which forces the print snapshot onto a single viewport-sized page —
        // we need block flow with auto height for WKWebView to paginate.
        const htmlEl = document.documentElement;
        const originalBodyBg = document.body.style.background;
        const originalBodyColor = document.body.style.color;
        const originalBodyHeight = document.body.style.height;
        const originalBodyOverflow = document.body.style.overflow;
        const originalHtmlHeight = htmlEl.style.height;
        const originalHtmlOverflow = htmlEl.style.overflow;

        // Detach #root from <body>. We keep a reference and re-attach on
        // cleanup. SolidJS's reactive state lives in JS closures, not the
        // DOM hierarchy, so moving #root around is safe — DOM nodes retain
        // their listeners and identity when re-parented.
        console.log("[pdf-export] detaching #root from body");
        root.remove();
        document.body.style.background = "#ffffff";
        document.body.style.color = "#000000";
        // Release the viewport-height lockout so content can paginate.
        document.body.style.height = "auto";
        document.body.style.overflow = "visible";
        htmlEl.style.height = "auto";
        htmlEl.style.overflow = "visible";
        document.body.appendChild(printRoot);
        console.log("[pdf-export] print root appended to body (sole body child)");
        console.log(
          "[pdf-export] printRoot scrollHeight:", printRoot.scrollHeight,
          "body scrollHeight:", document.body.scrollHeight,
          "html scrollHeight:", htmlEl.scrollHeight,
          "body children:", document.body.children.length
        );

        let cleanedUp = false;
        let fallbackTimer: number | undefined;
        const cleanup = (reason: string) => {
          if (cleanedUp) return;
          cleanedUp = true;
          console.log("[pdf-export] cleanup:", reason);
          window.removeEventListener("focus", onFocus);
          window.removeEventListener("afterprint", onAfterPrint);
          if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
          printRoot.remove();
          // Re-attach #root as the first body child so nothing else that
          // may have been added gets pushed out of the way.
          document.body.insertBefore(root, document.body.firstChild);
          document.body.style.background = originalBodyBg;
          document.body.style.color = originalBodyColor;
          document.body.style.height = originalBodyHeight;
          document.body.style.overflow = originalBodyOverflow;
          htmlEl.style.height = originalHtmlHeight;
          htmlEl.style.overflow = originalHtmlOverflow;
          console.log("[pdf-export] #root re-attached, viewport styles restored");
        };
        const onFocus = () => {
          console.log("[pdf-export] window focus event");
          // Delay so the user sees the print sheet dismiss fully.
          setTimeout(() => cleanup("focus"), 200);
        };
        const onAfterPrint = () => {
          console.log("[pdf-export] afterprint event");
          cleanup("afterprint");
        };
        window.addEventListener("afterprint", onAfterPrint);
        window.addEventListener("focus", onFocus);
        fallbackTimer = window.setTimeout(() => cleanup("fallback-timer"), 60_000);

        // Defer print by 2 frames so the layout after body manipulation is
        // committed before the webview takes its print snapshot.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            try {
              console.log("[pdf-export] calling window.print() on main webview");
              window.print();
              console.log("[pdf-export] window.print() returned");
            } catch (err) {
              console.error("[pdf-export] window.print() threw:", err);
              cleanup("print-threw");
            }
          });
        });
      });
    });
  };

  // Re-read a single text file from disk and update the tab's content if it
  // differs from the last-saved content. Skips dirty tabs so local edits are
  // preserved. Errors (file deleted, permission denied, etc.) are logged and
  // swallowed — we don't want focus events to spam the user.
  const reloadTextFileTabFromDisk = async (tab: WorkspaceFileTab) => {
    if (tab.kind !== "text_file" || tab.loading) return;
    try {
      const content = await invoke<string>("read_file_text", {
        path: tab.path,
        maxBytes: BUTTER_TEXT_FILE_LIMIT_BYTES,
      });
      if (content === tab.savedContent) return;
      if (tab.dirty) {
        console.log(`[file-reload] skipping dirty tab: ${tab.path}`);
        return;
      }
      console.log(`[file-reload] external change detected: ${tab.path}`);
      updateFileTabsForOwner(tab.ownerSessionId, (tabs) =>
        tabs.map((t) =>
          t.id === tab.id && t.kind === "text_file"
            ? { ...t, content, savedContent: content, dirty: false, error: null }
            : t
        )
      );
    } catch (err) {
      console.log(`[file-reload] read failed for ${tab.path}:`, err);
    }
  };

  // Called on window focus: walks every open text tab (session + pinned) and
  // refreshes from disk. Non-blocking; each tab reloads in parallel.
  const reloadAllOpenTextFilesFromDisk = () => {
    const tabsToReload: WorkspaceFileTab[] = [];
    for (const tabs of Object.values(fileTabsBySession())) {
      for (const tab of tabs) {
        if (tab.kind === "text_file") tabsToReload.push(tab);
      }
    }
    for (const tab of pinnedFileTabs()) {
      if (tab.kind === "text_file") tabsToReload.push(tab);
    }
    if (tabsToReload.length === 0) return;
    for (const tab of tabsToReload) {
      void reloadTextFileTabFromDisk(tab);
    }
  };

  // Cheap stat-based polling for external file changes. Focus-based reload
  // misses the common case where the user runs Claude Code in a Butter
  // terminal — the window never loses focus. We poll mtime+size (not content)
  // at a short interval and only re-read the full content when the stat
  // actually changes, so this is cheap even with many tabs open.
  const lastKnownStatByPath = new Map<string, { mtimeMs: number; size: number }>();
  const pollOpenFilesForExternalChanges = async () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

    // Collect unique paths from both session and pinned tabs.
    const paths = new Set<string>();
    for (const tabs of Object.values(fileTabsBySession())) {
      for (const tab of tabs) {
        if (tab.kind === "text_file" && !tab.loading) paths.add(tab.path);
      }
    }
    for (const tab of pinnedFileTabs()) {
      if (tab.kind === "text_file" && !tab.loading) paths.add(tab.path);
    }
    if (paths.size === 0) return;

    // Drop stat entries for paths that are no longer open, so we don't leak
    // over a long session.
    for (const tracked of lastKnownStatByPath.keys()) {
      if (!paths.has(tracked)) lastKnownStatByPath.delete(tracked);
    }

    // Fire all stats in parallel.
    await Promise.all(
      Array.from(paths).map(async (path) => {
        try {
          const stat = await invoke<{ mtime_ms: number; size: number }>("stat_file", { path });
          const last = lastKnownStatByPath.get(path);
          lastKnownStatByPath.set(path, { mtimeMs: stat.mtime_ms, size: stat.size });
          // First observation — store baseline but don't reload.
          if (!last) return;
          // Unchanged — cheap short-circuit.
          if (last.mtimeMs === stat.mtime_ms && last.size === stat.size) return;
          // Changed on disk — reload every tab viewing this path.
          console.log(`[file-poll] change detected: ${path}`);
          const matching: WorkspaceFileTab[] = [];
          for (const tabs of Object.values(fileTabsBySession())) {
            for (const tab of tabs) {
              if (tab.kind === "text_file" && tab.path === path) matching.push(tab);
            }
          }
          for (const tab of pinnedFileTabs()) {
            if (tab.kind === "text_file" && tab.path === path) matching.push(tab);
          }
          for (const tab of matching) {
            void reloadTextFileTabFromDisk(tab);
          }
        } catch {
          // File deleted, permission denied, etc. — silently skip.
        }
      })
    );
  };

  const unpinFileTab = async (tabId: string, options?: { skipDirtyPrompt?: boolean }) => {
    const tab = findPinnedFileTab(tabId);
    if (!tab) return false;
    if (!options?.skipDirtyPrompt && tab.kind === "text_file" && tab.dirty) {
      const confirmed = await askConfirm({
        title: "Discard unsaved changes?",
        message: `${tab.displayName} has unsaved changes. Unpinning and closing it now will lose those changes.`,
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        destructive: true,
      });
      if (!confirmed) return false;
    }
    setPinnedFileTabs((prev) => prev.filter((entry) => entry.id !== tabId));
    revokeWorkspaceFileTabResources(tab);
    // Any sessions that were active on this pinned tab fall back to the terminal tab
    setActiveWorkspaceTabBySession((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [sid, activeId] of Object.entries(prev)) {
        if (activeId === tabId) {
          next[sid] = TERMINAL_WORKSPACE_TAB_ID;
          changed = true;
        } else {
          next[sid] = activeId;
        }
      }
      return changed ? next : prev;
    });
    return true;
  };

  const pinFileTab = (sessionId: string, tabId: string) => {
    // No-op if already pinned
    if (findPinnedFileTab(tabId)) return;
    const sessionTabs = getSessionFileTabs(sessionId);
    const tab = sessionTabs.find((entry) => entry.id === tabId);
    if (!tab) return;
    // Transfer tab object from the session store to the pinned store with
    // updated ownership. Tab id is preserved so active-tab references stay valid.
    const pinnedTab: WorkspaceFileTab =
      tab.kind === "text_file"
        ? { ...tab, ownerSessionId: PINNED_WORKSPACE_OWNER_ID }
        : { ...tab, ownerSessionId: PINNED_WORKSPACE_OWNER_ID };
    setSessionFileTabs(sessionId, (tabs) => tabs.filter((entry) => entry.id !== tabId));
    setPinnedFileTabs((prev) => [...prev, pinnedTab]);
  };

  const closeFileWorkspaceTab = async (sessionId: string, tabId: string) => {
    // Pinned tabs live in a global store; closing them = unpin.
    if (findPinnedFileTab(tabId)) {
      await unpinFileTab(tabId);
      return;
    }
    const tabs = getSessionFileTabs(sessionId);
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    const tab = tabs[index];
    if (tab.kind === "text_file" && tab.dirty) {
      const confirmed = await askConfirm({
        title: "Discard unsaved changes?",
        message: `${tab.displayName} has unsaved changes. If you close it now, those changes will be lost.`,
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        destructive: true,
      });
      if (!confirmed) return;
    }
    const nextTabs = [...tabs];
    nextTabs.splice(index, 1);
    const activeTabId = getActiveWorkspaceTabIdForSession(sessionId);
    if (activeTabId === tabId) {
      const nextActiveTabId = index > 0 ? nextTabs[index - 1]?.id ?? TERMINAL_WORKSPACE_TAB_ID : TERMINAL_WORKSPACE_TAB_ID;
      setActiveWorkspaceTabForSession(sessionId, nextActiveTabId);
    }
    setSessionFileTabs(sessionId, () => nextTabs);
    revokeWorkspaceFileTabResources(tab);
  };

  const openFileInButter = async (path: string, sessionId = activeSessionId()) => {
    if (!sessionId) return;
    const kind = getButterWorkspaceFileKind(path);
    if (!kind) return;

    // Pinned tabs are shared across all terminals — refocus if already pinned.
    const existingPinned = pinnedFileTabs().find((tab) => tab.path === path);
    if (existingPinned) {
      setActiveWorkspaceTabForSession(sessionId, existingPinned.id);
      if (activeSessionId() !== sessionId) {
        selectSession(sessionId);
      }
      return;
    }

    const existing = getSessionFileTabs(sessionId).find((tab) => tab.path === path);
    if (existing) {
      setActiveWorkspaceTabForSession(sessionId, existing.id);
      if (activeSessionId() !== sessionId) {
        selectSession(sessionId);
      }
      return;
    }

    const tabId = crypto.randomUUID();
    const displayName = getPathDisplayName(path);
    const activeTabId = getActiveWorkspaceTabIdForSession(sessionId);
    const existingTabs = getSessionFileTabs(sessionId);
    const activeFileIndex =
      activeTabId === TERMINAL_WORKSPACE_TAB_ID
        ? -1
        : existingTabs.findIndex((tab) => tab.id === activeTabId);
    const insertIndex = activeFileIndex >= 0 ? activeFileIndex + 1 : 0;
    const newTab: WorkspaceFileTab =
      kind === "text_file"
        ? {
            id: tabId,
            ownerSessionId: sessionId,
            path,
            displayName,
            kind,
            loading: true,
            error: null,
            content: "",
            savedContent: "",
            dirty: false,
          }
        : {
            id: tabId,
            ownerSessionId: sessionId,
            path,
            displayName,
            kind,
            loading: true,
            error: null,
            imageUrl: null,
            dirty: false,
          };

    setSessionFileTabs(sessionId, (tabs) => {
      const nextTabs = [...tabs];
      nextTabs.splice(insertIndex, 0, newTab);
      return nextTabs;
    });
    setActiveWorkspaceTabForSession(sessionId, tabId);
    if (activeSessionId() !== sessionId) {
      selectSession(sessionId);
    }

    if (kind === "text_file") {
      try {
        const content = await invoke<string>("read_file_text", {
          path,
          maxBytes: BUTTER_TEXT_FILE_LIMIT_BYTES,
        });
        setSessionFileTabs(sessionId, (tabs) =>
          tabs.map((tab) =>
            tab.id === tabId && tab.kind === "text_file"
              ? {
                  ...tab,
                  loading: false,
                  error: null,
                  content,
                  savedContent: content,
                  dirty: false,
                }
              : tab
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSessionFileTabs(sessionId, (tabs) =>
          tabs.map((tab) =>
            tab.id === tabId && tab.kind === "text_file"
              ? { ...tab, loading: false, error: message }
              : tab
          )
        );
      }
      return;
    }

    try {
      const bytes = await invoke<number[]>("read_file_binary", { path });
      const mimeType = inferImageMimeType(path) || "application/octet-stream";
      const imageUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
      let attached = false;
      setSessionFileTabs(sessionId, (tabs) =>
        tabs.map((tab) => {
          if (tab.id !== tabId || tab.kind !== "image_file") return tab;
          attached = true;
          return {
            ...tab,
            loading: false,
            error: null,
            imageUrl,
          };
        })
      );
      if (!attached) {
        URL.revokeObjectURL(imageUrl);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSessionFileTabs(sessionId, (tabs) =>
        tabs.map((tab) =>
          tab.id === tabId && tab.kind === "image_file"
            ? { ...tab, loading: false, error: message }
            : tab
        )
      );
    }
  };

  const copyFileBrowserEntry = async (entry: FileBrowserEntry) => {
    await navigator.clipboard.writeText(entry.path);
    setShowFileBrowser(false);
  };

  const getDirectoryPath = (path: string): string => {
    if (!path) return path;
    const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
    const lastSlash = trimmed.lastIndexOf("/");
    if (lastSlash < 0) return trimmed;
    if (lastSlash === 0) return "/";
    return trimmed.slice(0, lastSlash);
  };

  const copyFileBrowserDirectory = async (entry: FileBrowserEntry) => {
    const directoryPath = entry.is_dir ? entry.path : getDirectoryPath(entry.path);
    await navigator.clipboard.writeText(directoryPath);
    setShowFileBrowser(false);
  };

  const openFileBrowserEntryInCanvas = async (entry: FileBrowserEntry) => {
    if (entry.is_dir) {
      await loadDirectory(entry.path);
      return;
    }
    await addCanvasFileObject(entry);
    setShowFileBrowser(false);
  };

  const openFileBrowserEntry = async (entry: FileBrowserEntry) => {
    await Command.create("open", [entry.path]).execute();
    setShowFileBrowser(false);
  };

  // File path context menu actions (used when Cmd+clicking paths in terminal output)
  const filePathMenuOpenDefault = (path: string) => {
    void Command.create("open", [path]).execute().then((result) => {
      if (result.code !== 0) {
        // Fall back to file browser at parent dir
        const parentDir = path.replace(/\/[^/]+\/?$/, "") || "/";
        setShowFileBrowser(true);
        void loadDirectory(parentDir);
      }
    });
    setFilePathContextMenu(null);
  };

  const filePathMenuOpenInVSCode = (path: string) => {
    void Command.create("code", [path]).execute();
    setFilePathContextMenu(null);
  };

  const filePathMenuRevealInFinder = (path: string) => {
    void Command.create("open", ["-R", path]).execute();
    setFilePathContextMenu(null);
  };

  const filePathMenuCopyPath = (path: string) => {
    void navigator.clipboard.writeText(path);
    setFilePathContextMenu(null);
  };

  const filePathMenuCopyRelative = (path: string, sessionId: string) => {
    const ptyId = ptyBySession()[sessionId];
    if (ptyId) {
      void invoke<string>("get_pty_cwd", { id: ptyId }).then((cwd) => {
        if (cwd && path.startsWith(cwd)) {
          const relative = path.slice(cwd.replace(/\/$/, "").length + 1);
          void navigator.clipboard.writeText(relative || path);
        } else {
          void navigator.clipboard.writeText(path);
        }
        setFilePathContextMenu(null);
      });
    } else {
      void navigator.clipboard.writeText(path);
      setFilePathContextMenu(null);
    }
  };

  const filePathMenuBrowse = (path: string) => {
    const parentDir = path.replace(/\/[^/]+\/?$/, "") || "/";
    setShowFileBrowser(true);
    void loadDirectory(parentDir);
    setFilePathContextMenu(null);
  };

  const filePathMenuOpenInButter = (path: string, sessionId: string) => {
    void openFileInButter(path, sessionId);
    setFilePathContextMenu(null);
  };

  // Open the file-tab right-click menu. sessionId here is the tab's owner session
  // for regular tabs, or the sentinel for pinned tabs — callers should pass the
  // currently-active session as `contextSessionId` so relative-path helpers work.
  const openFileTabContextMenu = (
    tab: WorkspaceFileTab,
    position: { x: number; y: number }
  ) => {
    const isPinned = tab.ownerSessionId === PINNED_WORKSPACE_OWNER_ID;
    setFileTabContextMenu({
      tabId: tab.id,
      ownerSessionId: tab.ownerSessionId,
      path: tab.path,
      displayName: tab.displayName,
      isPinned,
      x: position.x,
      y: position.y,
    });
  };

  const fileTabMenuClose = (tabId: string, ownerSessionId: string) => {
    // closeFileWorkspaceTab dispatches to unpin for pinned tabs internally,
    // so the ownerSessionId value doesn't matter for the pinned case.
    closeFileWorkspaceTab(ownerSessionId, tabId);
    setFileTabContextMenu(null);
  };

  const fileTabMenuTogglePin = (tabId: string, ownerSessionId: string) => {
    if (ownerSessionId === PINNED_WORKSPACE_OWNER_ID) {
      unpinFileTab(tabId);
    } else {
      pinFileTab(ownerSessionId, tabId);
    }
    setFileTabContextMenu(null);
  };

  const fileTabMenuCopyPath = (path: string) => {
    void navigator.clipboard.writeText(path);
    setFileTabContextMenu(null);
  };

  const fileTabMenuCopyRelative = (path: string) => {
    // For both pinned and session tabs, resolve against the currently active
    // session's cwd — that's the user's current context regardless of where
    // the tab was originally opened from.
    const referenceSessionId = activeSessionId();
    const ptyId = referenceSessionId ? ptyBySession()[referenceSessionId] : null;
    if (ptyId) {
      void invoke<string>("get_pty_cwd", { id: ptyId }).then((cwd) => {
        if (cwd && path.startsWith(cwd)) {
          const relative = path.slice(cwd.replace(/\/$/, "").length + 1);
          void navigator.clipboard.writeText(relative || path);
        } else {
          void navigator.clipboard.writeText(path);
        }
        setFileTabContextMenu(null);
      });
    } else {
      void navigator.clipboard.writeText(path);
      setFileTabContextMenu(null);
    }
  };

  const fileTabMenuOpenDefault = (path: string) => {
    void Command.create("open", [path]).execute();
    setFileTabContextMenu(null);
  };

  const fileTabMenuOpenInVSCode = (path: string) => {
    void Command.create("code", [path]).execute();
    setFileTabContextMenu(null);
  };

  const fileTabMenuRevealInFinder = (path: string) => {
    void Command.create("open", ["-R", path]).execute();
    setFileTabContextMenu(null);
  };

  const fileTabMenuBrowse = (path: string) => {
    const parentDir = path.replace(/\/[^/]+\/?$/, "") || "/";
    setShowFileBrowser(true);
    void loadDirectory(parentDir);
    setFileTabContextMenu(null);
  };

  const fileTabMenuReloadFromDisk = async (tabId: string) => {
    const pinned = findPinnedFileTab(tabId);
    const sessionTab =
      pinned ??
      (() => {
        for (const tabs of Object.values(fileTabsBySession())) {
          const match = tabs.find((t) => t.id === tabId);
          if (match) return match;
        }
        return undefined;
      })();
    const tab = sessionTab;
    if (!tab || tab.kind !== "text_file") {
      setFileTabContextMenu(null);
      return;
    }
    // If dirty, confirm before clobbering local edits.
    if (tab.dirty) {
      const confirmed = await askConfirm({
        title: "Reload from disk?",
        message: `${tab.displayName} has unsaved changes. Reloading will overwrite them with the file's current contents on disk.`,
        confirmLabel: "Reload",
        cancelLabel: "Keep editing",
        destructive: true,
      });
      if (!confirmed) {
        setFileTabContextMenu(null);
        return;
      }
    }
    void (async () => {
      try {
        const content = await invoke<string>("read_file_text", {
          path: tab.path,
          maxBytes: BUTTER_TEXT_FILE_LIMIT_BYTES,
        });
        updateFileTabsForOwner(tab.ownerSessionId, (tabs) =>
          tabs.map((t) =>
            t.id === tab.id && t.kind === "text_file"
              ? { ...t, content, savedContent: content, dirty: false, error: null }
              : t
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        updateFileTabsForOwner(tab.ownerSessionId, (tabs) =>
          tabs.map((t) =>
            t.id === tab.id && t.kind === "text_file"
              ? { ...t, error: `Reload failed: ${message}` }
              : t
          )
        );
      }
    })();
    setFileTabContextMenu(null);
  };

  // URL context menu actions
  const urlMenuOpen = (url: string) => {
    void openUrl(url);
    setUrlContextMenu(null);
  };

  const urlMenuCopy = (url: string) => {
    void navigator.clipboard.writeText(url);
    setUrlContextMenu(null);
  };

  const fileBrowserActions = (entry: FileBrowserEntry) => [
    ...(entry.is_dir || !canOpenPathInButter(entry.path)
      ? []
      : [{
          id: "open-butter",
          label: "Open in Butter",
          icon: "▣",
          action: () => {
            void openFileInButter(entry.path);
            setShowFileBrowser(false);
            setFileBrowserActionEntry(null);
          },
        }]),
    { id: "copy-path", label: "Copy Path", icon: "⎘", action: () => void copyFileBrowserEntry(entry) },
    { id: "copy-dir", label: "Copy Directory Path", icon: "⎘", action: () => void copyFileBrowserDirectory(entry) },
    { id: "open-default", label: "Open File", icon: "↗", action: () => void openFileBrowserEntry(entry) },
    { id: "open-vscode", label: "Open in VS Code", icon: "◇", action: () => {
      void Command.create("code", [entry.path]).execute();
      setShowFileBrowser(false);
      setFileBrowserActionEntry(null);
    }},
    { id: "reveal-finder", label: "Reveal in Finder", icon: "⌕", action: () => {
      void Command.create("open", ["-R", entry.path]).execute();
      setShowFileBrowser(false);
      setFileBrowserActionEntry(null);
    }},
    ...(appView() === "canvas" ? [{ id: "add-canvas", label: "Add to Canvas", icon: "▦", action: () => void openFileBrowserEntryInCanvas(entry) }] : []),
  ];

  const activateFileBrowserEntry = async (
    entry: FileBrowserEntry,
    options?: { openExternally?: boolean }
  ) => {
    if (entry.is_dir) {
      await loadDirectory(entry.path);
      return;
    }
    if (options?.openExternally) {
      await openFileBrowserEntry(entry);
      return;
    }
    // Show file actions sub-menu
    setFileBrowserActionEntry(entry);
    setFileBrowserActionIndex(0);
  };

  createEffect(() => {
    if (!showCommandPalette()) return;
    requestAnimationFrame(() => {
      commandInputRef?.focus();
      commandInputRef?.select();
    });
  });

  createEffect(() => {
    if (!showFileBrowser()) return;
    requestAnimationFrame(() => {
      fileBrowserInputRef?.focus();
    });
  });

  createEffect(() => {
    const idx = fileBrowserIndex();
    if (!showFileBrowser()) return;
    requestAnimationFrame(() => {
      const list = document.querySelector(".file-browser-list");
      const items = list?.querySelectorAll(".file-browser-item");
      if (items && items[idx]) {
        items[idx].scrollIntoView({ block: "nearest" });
      }
    });
  });

  // Clean up search timer when file browser closes
  createEffect(() => {
    if (!showFileBrowser()) {
      if (fileBrowserSearchTimer) clearTimeout(fileBrowserSearchTimer);
      setFileBrowserSearching(false);
    }
  });

  createEffect(() => {
    const id = renamingSessionId();
    if (!id) return;
    requestAnimationFrame(() => {
      renameInputRef?.focus();
      renameInputRef?.select();
    });
  });

  createEffect(() => {
    if (activeWorkspaceTabKind() === "terminal") return;
    if (searchOpen()) {
      closeSearch();
    }
  });

  createEffect(() => {
    const activeId = activeSessionId();
    if (!activeId) return;
    if (appView() === "canvas") return;
    if (showCommandPalette()) return;
    if (showFileBrowser()) return;
    if (renamingSessionId()) return;
    if (scratchpadOpen()) return;
    if (quickInputActive()) return;
    if (activeWorkspaceTabKind() !== "terminal") return;
    // Delay focus to allow double-click rename to register first
    const focusIfNotRenaming = () => {
      if (renamingSessionId()) return;
      focusTerminal(activeId);
    };
    setTimeout(focusIfNotRenaming, 50);
    setTimeout(focusIfNotRenaming, 150);
    setTimeout(focusIfNotRenaming, 400);
  });

  createEffect(() => {
    if (!quickInputActive()) return;
    const list = sessions;
    for (const session of list) {
      updateSessionPreview(session.id);
    }
    const targetId = activeSessionId() || list[0]?.id;
    if (!targetId) return;
    requestAnimationFrame(() => {
      const input = quickInputRefs.get(targetId);
      if (input) {
        input.focus();
        input.select();
      }
    });
  });

  const filteredSessionIds = createMemo(() => {
    const list = sessions.map((session) => session.id);
    const filter = selectedTags();
    const includeUntagged = showUntagged();
    if (filter.size === 0 && !includeUntagged) {
      return list;
    }
    const tagsByTerminal = terminalTags();
    return list.filter((id) => {
      const entryTags = tagsByTerminal[id] || [];
      const hasTag = entryTags.some((tag) => filter.has(tag));
      const isUntagged = entryTags.length === 0;
      return (filter.size > 0 && hasTag) || (includeUntagged && isUntagged);
    });
  });

  const recentSessionIds = createMemo(() => {
    const ids = filteredSessionIds();
    const seenAt = sessionSeenAt();
    const active = activeSessionId();
    const createdAtBySession = new Map<string, number>();
    const order = new Map<string, number>();
    sessions.forEach((session, index) => {
      createdAtBySession.set(session.id, session.createdAt);
      order.set(session.id, index);
    });

    const scoreFor = (id: string) => seenAt[id] ?? createdAtBySession.get(id) ?? 0;

    return [...ids].sort((a, b) => {
      if (a === active && b !== active) return -1;
      if (b === active && a !== active) return 1;

      const scoreDiff = scoreFor(b) - scoreFor(a);
      if (scoreDiff !== 0) return scoreDiff;

      return (order.get(a) ?? 0) - (order.get(b) ?? 0);
    });
  });

  // Inbox: sessions waiting for user input
  // Sessions enter when agent goes idle, leave when user responds (working) or manually dismissed
  const [inboxDismissed, setInboxDismissed] = createSignal<Set<string>>(new Set());

  const inboxSessionIds = createMemo(() => {
    void idleTick();
    const dismissed = inboxDismissed();
    return sessions
      .map((s) => s.id)
      .filter((id) => {
        const state = getSessionState(id);
        // Remove from dismissed set when agent starts working again
        if (state === "working" && dismissed.has(id)) {
          setInboxDismissed((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
        return state === "idle" && !dismissed.has(id);
      });
  });

  function dismissFromInbox(sessionId: string) {
    setInboxDismissed((prev) => {
      const next = new Set(prev);
      next.add(sessionId);
      return next;
    });
  }

  const quickViewSessionIds = createMemo(() => {
    const list = sessions.map((session) => session.id);
    const filter = quickViewSelectedTags();
    const includeUntagged = quickViewShowUntagged();
    let filtered = list;
    if (filter.size > 0 || includeUntagged) {
      const tagsByTerminal = terminalTags();
      filtered = list.filter((id) => {
        const entryTags = tagsByTerminal[id] || [];
        const hasTag = entryTags.some((tag) => filter.has(tag));
        const isUntagged = entryTags.length === 0;
        return (filter.size > 0 && hasTag) || (includeUntagged && isUntagged);
      });
    }

    if (quickViewIdleOnly()) {
      filtered = filtered.filter((id) => getSessionState(id) === "idle");
    }

    const order = new Map<string, number>();
    filtered.forEach((id, index) => order.set(id, index));
    const rankFor = (id: string) => {
      const state = getSessionState(id);
      if (state === "idle") return 0;
      if (state === "working") return 1;
      return 2;
    };
    return [...filtered].sort((a, b) => {
      const rankDiff = rankFor(a) - rankFor(b);
      if (rankDiff !== 0) return rankDiff;
      return (order.get(a) ?? 0) - (order.get(b) ?? 0);
    });
  });

  // Reverse lookup: PTY ID -> session ID
  const sessionByPty = createMemo(() => {
    const map: Record<string, string> = {};
    for (const [sid, pid] of Object.entries(ptyBySession())) {
      map[pid] = sid;
    }
    return map;
  });

  function mergeActivityState(
    claude?: string,
    codex?: string
  ): "working" | "idle" | "unknown" {
    if (claude === "working" || codex === "working") return "working";
    if (claude === "idle" || codex === "idle") return "idle";
    return "unknown";
  }

  // Determine session activity state from DB-backed agent hook events
  function getSessionState(id: string): "working" | "idle" | "unknown" {
    void idleTick(); // re-evaluate on each tick
    return mergeActivityState(claudeState()[id], codexState()[id]);
  }

  // Session folders memo - groups sessions by their first tag
  interface SessionFolder {
    tag: string;
    displayName: string;
    sessionIds: string[];
    hasActiveSession: boolean;
  }

  const sessionFolders = createMemo<SessionFolder[]>(() => {
    const sessionIds = filteredSessionIds();
    const tagsByTerminal = terminalTags();
    const activeId = activeSessionId();

    const groupMap = new Map<string, string[]>();
    const untaggedIds: string[] = [];

    for (const id of sessionIds) {
      const sessionTags = tagsByTerminal[id] || [];
      const firstTag = sessionTags[0];

      if (firstTag) {
        if (!groupMap.has(firstTag)) {
          groupMap.set(firstTag, []);
        }
        groupMap.get(firstTag)!.push(id);
      } else {
        untaggedIds.push(id);
      }
    }

    const folders: SessionFolder[] = [];

    // Sort tags alphabetically
    const sortedTags = [...groupMap.keys()].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );

    for (const tag of sortedTags) {
      const ids = groupMap.get(tag)!;
      folders.push({
        tag,
        displayName: tag,
        sessionIds: ids,
        hasActiveSession: ids.includes(activeId || ""),
      });
    }

    // Untagged at bottom
    if (untaggedIds.length > 0) {
      folders.push({
        tag: "__untagged__",
        displayName: "Untagged",
        sessionIds: untaggedIds,
        hasActiveSession: untaggedIds.includes(activeId || ""),
      });
    }

    return folders;
  });

  function toggleFolderCollapse(folderTag: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderTag)) {
        next.delete(folderTag);
      } else {
        next.add(folderTag);
      }
      localStorage.setItem("collapsed-folders", JSON.stringify([...next]));
      return next;
    });
  }

  function setSidebarSessionViewMode(view: SidebarSessionView) {
    setSidebarSessionView(view);
  }

  function toggleSidebarSessionView() {
    setSidebarSessionView((prev) => (prev === "recent" ? "folders" : "recent"));
  }

  function saveTags(nextTags: string[]) {
    setTags(nextTags);
    // Save to config file
    const config = appConfig();
    if (config) {
      const updatedConfig = { ...config, tags: { list: nextTags } };
      setAppConfig(updatedConfig);
      void invoke("save_config", { config: updatedConfig });
    }
  }

  function saveTerminalTags(next: Record<string, string[]>) {
    setTerminalTags(next);
    localStorage.setItem("terminal-tags", JSON.stringify(next));
    // Also save to database for each changed session
    for (const [sessionId, tags] of Object.entries(next)) {
      void invoke("db_set_session_tags", { sessionId, tags }).catch((err) => {
        console.error("Failed to save tags to DB:", err);
      });
    }
  }

  function toggleTagFilter(tag: string) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }

  function clearFilters() {
    setSelectedTags(new Set<string>());
    setShowUntagged(false);
  }

  function toggleUntaggedFilter() {
    setShowUntagged((prev) => !prev);
  }

  function toggleQuickViewTag(tag: string) {
    setQuickViewSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }

  function clearQuickViewFilters() {
    setQuickViewSelectedTags(new Set<string>());
    setQuickViewShowUntagged(false);
  }

  function toggleQuickViewUntagged() {
    setQuickViewShowUntagged((prev) => !prev);
  }

  function toggleQuickViewIdleOnly() {
    if (quickViewMode() === "idle-focus") return;
    setQuickViewIdleOnly((prev) => {
      const next = !prev;
      setQuickViewGridIdleOnly(next);
      return next;
    });
  }

  function setQuickViewMode(mode: "grid" | "idle-focus") {
    const current = quickViewMode();
    if (mode === current) return;
    if (mode === "idle-focus") {
      setQuickViewGridIdleOnly(quickViewIdleOnly());
      setQuickViewIdleOnly(true);
    } else {
      setQuickViewIdleOnly(quickViewGridIdleOnly());
    }
    setQuickViewModeSignal(mode);
  }

  function toggleTagForTerminal(terminalId: string, tag: string) {
    const current = terminalTags();
    const existing = current[terminalId] || [];
    const hasTag = existing.includes(tag);
    const nextTags = hasTag
      ? existing.filter((t) => t !== tag)
      : [...existing, tag];
    saveTerminalTags({ ...current, [terminalId]: nextTags });
  }

  function addTagToTerminal(terminalId: string, tag: string) {
    const current = terminalTags();
    const existing = current[terminalId] || [];
    if (existing.includes(tag)) {
      return;
    }
    saveTerminalTags({ ...current, [terminalId]: [...existing, tag] });
  }

  function createTagAndAssign(terminalId?: string) {
    const raw = newTagName().trim().toLowerCase();
    if (!raw) return;
    if (!tags().includes(raw)) {
      saveTags([...tags(), raw]);
    }
    if (terminalId) {
      addTagToTerminal(terminalId, raw);
    }
    setNewTagName("");
  }

  function savePresets(nextPresets: TerminalPreset[]) {
    setPresets(nextPresets);
    // Save to config file
    const config = appConfig();
    if (config) {
      const configPresets: ConfigPreset[] = nextPresets.map((p) => ({
        id: p.id,
        name: p.name,
        directory: p.directory,
        command: p.command,
        tags: p.tags || [],
        ...(p.footer ? { footer: true } : {}),
        ...(p.worktree ? { worktree: true } : {}),
      }));
      const updatedConfig = { ...config, presets: { items: configPresets } };
      setAppConfig(updatedConfig);
      void invoke("save_config", { config: updatedConfig });
    }
  }

  function openPresetEditor(preset?: TerminalPreset) {
    setShowPresetMenu(false);
    setEditingPreset(
      preset || {
        id: crypto.randomUUID(),
        name: "",
        directory: "",
        command: "",
        tags: [],
        footer: false,
        worktree: false,
      }
    );
    setShowPresetEditor(true);
  }

  function closePresetEditor() {
    setShowPresetEditor(false);
    setEditingPreset(null);
    setNewPresetTagName("");
  }

  function savePreset() {
    const preset = editingPreset();
    if (!preset || !preset.name.trim()) return;
    const existingIndex = presets().findIndex((p) => p.id === preset.id);
    if (existingIndex >= 0) {
      const updated = [...presets()];
      updated[existingIndex] = preset;
      savePresets(updated);
    } else {
      savePresets([...presets(), preset]);
    }
    setShowPresetEditor(false);
    setEditingPreset(null);
    setNewPresetTagName("");
  }

  function deletePreset(id: string) {
    savePresets(presets().filter((p) => p.id !== id));
    if (editingPreset()?.id === id) {
      closePresetEditor();
    }
  }

  function toggleTagForPreset(tag: string) {
    const preset = editingPreset();
    if (!preset) return;
    const existing = preset.tags || [];
    const hasTag = existing.includes(tag);
    const nextTags = hasTag
      ? existing.filter((t) => t !== tag)
      : [...existing, tag];
    setEditingPreset({ ...preset, tags: nextTags });
  }

  function createTagAndAssignToPreset() {
    const raw = newPresetTagName().trim().toLowerCase();
    if (!raw) return;
    if (!tags().includes(raw)) {
      saveTags([...tags(), raw]);
    }
    const preset = editingPreset();
    if (!preset) return;
    const existing = preset.tags || [];
    if (!existing.includes(raw)) {
      setEditingPreset({ ...preset, tags: [...existing, raw] });
    }
    setNewPresetTagName("");
  }

  function selectSession(id: string) {
    const prevId = activeSessionId();
    setActiveSessionId(id);
    setSessionSeenAt((prev) => ({ ...prev, [id]: Date.now() }));

    // Add to tab history (unless we're navigating via back/forward)
    if (!isNavigatingHistory && id !== prevId) {
      const history = tabHistory();
      const currentIndex = tabHistoryIndex();
      // Truncate forward history and add new entry
      const newHistory = [...history.slice(0, currentIndex + 1), id];
      // Limit history size to prevent unbounded growth
      const trimmedHistory = newHistory.slice(-50);
      setTabHistory(trimmedHistory);
      setTabHistoryIndex(trimmedHistory.length - 1);
    }

    setTimeout(() => {
      terminalInstances.get(id)?.fit.fit();
      void updatePtySize(id);
      if (getActiveWorkspaceTabIdForSession(id) === TERMINAL_WORKSPACE_TAB_ID) {
        focusTerminal(id);
      }
    }, 0);
  }

  function navigateTabBack() {
    const history = tabHistory();
    const currentIndex = tabHistoryIndex();
    if (currentIndex > 0) {
      const newIndex = currentIndex - 1;
      const targetId = history[newIndex];
      // Verify the session still exists
      if (sessions.some((s) => s.id === targetId)) {
        isNavigatingHistory = true;
        setTabHistoryIndex(newIndex);
        setActiveSessionId(targetId);
        setSessionSeenAt((prev) => ({ ...prev, [targetId]: Date.now() }));
        setTimeout(() => {
          terminalInstances.get(targetId)?.fit.fit();
          void updatePtySize(targetId);
          if (getActiveWorkspaceTabIdForSession(targetId) === TERMINAL_WORKSPACE_TAB_ID) {
            focusTerminal(targetId);
          }
          isNavigatingHistory = false;
        }, 0);
      } else {
        // Session was closed, skip it
        setTabHistoryIndex(newIndex);
        navigateTabBack();
      }
    }
  }

  function navigateTabForward() {
    const history = tabHistory();
    const currentIndex = tabHistoryIndex();
    if (currentIndex < history.length - 1) {
      const newIndex = currentIndex + 1;
      const targetId = history[newIndex];
      // Verify the session still exists
      if (sessions.some((s) => s.id === targetId)) {
        isNavigatingHistory = true;
        setTabHistoryIndex(newIndex);
        setActiveSessionId(targetId);
        setSessionSeenAt((prev) => ({ ...prev, [targetId]: Date.now() }));
        setTimeout(() => {
          terminalInstances.get(targetId)?.fit.fit();
          void updatePtySize(targetId);
          if (getActiveWorkspaceTabIdForSession(targetId) === TERMINAL_WORKSPACE_TAB_ID) {
            focusTerminal(targetId);
          }
          isNavigatingHistory = false;
        }, 0);
      } else {
        // Session was closed, skip it
        setTabHistoryIndex(newIndex);
        navigateTabForward();
      }
    }
  }

  function toggleQuickInputView() {
    if (appView() === "canvas") return;
    const next = !quickInputActive();
    if (next) {
      setScratchpadOpen(false);
      if (searchOpen()) closeSearch();
    }
    setQuickInputActive(next);
  }

  function exitQuickInputToSession(id: string) {
    setQuickInputActive(false);
    selectSession(id);
  }

  async function sendQuickInputToSession(id: string) {
    const draft = sessionInputDraft()[id] ?? "";
    if (!draft.trim()) return;
    if (!terminalInstances.has(id)) {
      await ensureTerminal(id, { focus: false });
    }
    const instance = terminalInstances.get(id);
    if (instance) {
      // Paste the command so bracketed paste mode is respected, then send Enter.
      instance.term.paste(draft);
      instance.term.input("\r");
    } else {
      const ptyId = ptyBySession()[id];
      if (!ptyId) return;
      await invoke("pty_write", { id: ptyId, data: draft });
      await invoke("pty_write", { id: ptyId, data: "\r" });
    }
    setSessionInputDraft((prev) => ({ ...prev, [id]: "" }));
    scheduleScrollbackSave(id);
  }

  // Check if a session title was auto-assigned (not deliberately chosen by the user).
  // Auto-assigned titles include: "Terminal N", preset names, and directory basenames.
  function isAutoAssignedTitle(sessionId: string, title: string): boolean {
    const trimmed = title.trim();
    // "Terminal 1", "Terminal 2", etc.
    if (/^terminal\s+\d+$/i.test(trimmed)) return true;
    // Check if title matches the preset name or directory basename
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      if (session.directory) {
        const dirBasename = session.directory.replace(/\/$/, "").split("/").pop() || "";
        if (trimmed === dirBasename) return true;
        // Also match ~ expanded form
        if (trimmed === session.directory || trimmed === session.directory.replace(/^~/, "")) return true;
      }
      // Check if title matches a preset name
      const matchingPreset = presets().find(
        (p) => p.name === trimmed || p.directory?.replace(/\/$/, "").split("/").pop() === trimmed
      );
      if (matchingPreset) return true;
    }
    return false;
  }

  function maybeApplyAgentAutoTitles(agentSessionIds: Record<string, string>) {
    for (const [sessionId, agentSessionId] of Object.entries(agentSessionIds)) {
      if (!agentSessionId) continue;
      if (autoTitleResolvedAgentSessions.has(agentSessionId)) continue;
      if (autoTitleLookupInFlight.has(agentSessionId)) continue;

      const session = sessions.find((entry) => entry.id === sessionId);
      if (!session) continue;

      if (!isAutoAssignedTitle(sessionId, session.title)) {
        autoTitleResolvedAgentSessions.add(agentSessionId);
        continue;
      }

      autoTitleLookupInFlight.add(agentSessionId);
      void (async () => {
        try {
          const suggested = await invoke<string | null>("get_agent_first_prompt_title", {
            sessionId: agentSessionId,
          });
          if (!suggested || !suggested.trim()) return;

          const index = sessions.findIndex((entry) => entry.id === sessionId);
          if (index === -1) return;

          // Skip if title was user-renamed since we last checked
          if (!isAutoAssignedTitle(sessionId, sessions[index].title)) return;

          setSessions(index, "title", suggested);
          void dbUpdateSession(sessionId, { title: suggested });
        } catch (err) {
          console.error("Failed to auto-title session from first agent prompt:", err);
        } finally {
          autoTitleLookupInFlight.delete(agentSessionId);
          autoTitleResolvedAgentSessions.add(agentSessionId);
        }
      })();
    }
  }

  function updateSessionTitle(id: string, title: string) {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    const index = sessions.findIndex((s) => s.id === id);
    if (index !== -1) {
      setSessions(index, "title", nextTitle);
      // Persist to database
      void dbUpdateSession(id, { title: nextTitle });
    }
  }

  function openRename(id: string) {
    const session = sessions.find((entry) => entry.id === id);
    if (!session) return;
    setRenamingSessionId(id);
    setRenameValue(session.title);
  }

  function reorderSessions(sourceId: string, targetId: string | null) {
    setSessions(produce((draft) => {
      const sourceIndex = draft.findIndex((session) => session.id === sourceId);
      if (sourceIndex === -1) return;
      const [moved] = draft.splice(sourceIndex, 1);
      if (!targetId) {
        draft.push(moved);
        return;
      }
      const targetIndex = draft.findIndex((session) => session.id === targetId);
      if (targetIndex === -1) {
        draft.push(moved);
        return;
      }
      draft.splice(targetIndex, 0, moved);
    }));
  }

  function beginPointerDrag(id: string, event: PointerEvent) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, textarea, select, a")) return;
    event.preventDefault();
    setDraggingSessionId(id);
    setDragOverSessionId(null);
    setDragOverFolder(null);
    setTagMenuOpenFor(null);
    const endDrag = () => {
      // Handle folder drop - reassign session's first tag
      const targetFolder = dragOverFolder();
      const draggingId = draggingSessionId();
      if (targetFolder && draggingId) {
        const current = terminalTags();
        const existingTags = current[draggingId] || [];
        if (targetFolder === "__untagged__") {
          // Remove all tags to move to Untagged
          saveTerminalTags({ ...current, [draggingId]: [] });
        } else {
          // Replace first tag or add if none
          const newTags = existingTags.length > 0
            ? [targetFolder, ...existingTags.slice(1)]
            : [targetFolder];
          saveTerminalTags({ ...current, [draggingId]: newTags });
        }
      }
      setDraggingSessionId(null);
      setDragOverSessionId(null);
      setDragOverFolder(null);
    };
    window.addEventListener("pointerup", endDrag, { once: true });
    window.addEventListener("pointercancel", endDrag, { once: true });
  }

  function closeRename(commit: boolean) {
    const id = renamingSessionId();
    if (id && commit) {
      updateSessionTitle(id, renameValue());
    }
    setRenamingSessionId(null);
    setRenameValue("");
  }

  function clearTerminalForSession(id: string) {
    const instance = terminalInstances.get(id);
    instance?.term.clear();
  }

  async function closeSession(
    id: string,
    options?: {
      skipRecentlyClosedRefresh?: boolean;
    }
  ) {
    const ownedFileTabs = getSessionFileTabs(id);
    const dirtyTabs = ownedFileTabs.filter((tab) => tab.kind === "text_file" && tab.dirty);
    if (dirtyTabs.length > 0) {
      const confirmed = await askConfirm({
        title: "Discard unsaved changes?",
        message:
          dirtyTabs.length === 1
            ? `${dirtyTabs[0].displayName} has unsaved changes. Closing the terminal will lose those changes.`
            : `${dirtyTabs.length} open files have unsaved changes. Closing the terminal will lose those changes.`,
        confirmLabel: "Discard and close",
        cancelLabel: "Keep editing",
        destructive: true,
      });
      if (!confirmed) return;
    }

    await closeBrowserForSession(id);

    // Save scrollback before closing
    const instance = terminalInstances.get(id);
    if (instance) {
      // Cancel any pending scrollback timer
      const timer = scrollbackTimers.get(id);
      if (timer) clearTimeout(timer);
      scrollbackTimers.delete(id);

      // Save scrollback immediately
      await saveScrollbackForSession(id);
    }

    // Close PTY
    const ptyId = ptyBySession()[id];
    if (ptyId) {
      await invoke("pty_close", { id: ptyId });
      setPtyBySession((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }

    // Dispose terminal instance
    if (instance) {
      instance.term.dispose?.();
      instance.fit.dispose?.();
      terminalInstances.delete(id);
    }

    // Host refs are owned by mounted view components; only clear listeners here.
    clearTerminalHostInteractions(id);
    lastPtySizeBySession.delete(id);

    // Mark session as closed in database (soft delete - keeps scrollback)
    await dbCloseSession(id);

    // Remove session from list
    const index = sessions.findIndex((s) => s.id === id);
    if (index !== -1) {
      setSessions(produce((draft) => draft.splice(index, 1)));
    }

    // Clean up related state
    setTerminalTags((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSessionSeenAt((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setLastOutputAt((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setClaudeState((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setCodexState((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSessionPreview((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSessionInputDraft((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setBrowserSessions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    removeWorkspaceTabStateForSession(id);
    quickInputRefs.delete(id);

    // Update active session if needed
    if (activeSessionId() === id) {
      const remaining = sessions.filter((s) => s.id !== id);
      if (remaining.length > 0) {
        const nextIndex = Math.min(index, remaining.length - 1);
        setActiveSessionId(remaining[nextIndex].id);
      } else {
        // Create a new session if all are closed
        createSession();
      }
    }

    // Close context menu if open for this session
    if (contextMenuFor()?.id === id) {
      setContextMenuFor(null);
    }

    if (!options?.skipRecentlyClosedRefresh) {
      await refreshRecentlyClosedSessions();
    }
  }

  async function closeOtherSessions(keepId: string) {
    const toClose = sessions.filter((s) => s.id !== keepId).map((s) => s.id);
    for (const id of toClose) {
      await closeSession(id, { skipRecentlyClosedRefresh: true });
    }
    setActiveSessionId(keepId);
    await refreshRecentlyClosedSessions();
  }

  async function closeAllSessions() {
    // Close all and create a fresh one
    const toClose = sessions.map((s) => s.id);
    for (const id of toClose) {
      await closeSession(id, { skipRecentlyClosedRefresh: true });
    }
    await refreshRecentlyClosedSessions();
  }

  async function reopenClosedSession(id: string) {
    if (!id) return null;
    if (sessions.some((session) => session.id === id)) {
      selectSession(id);
      await refreshRecentlyClosedSessions();
      return id;
    }

    const reopened = await dbReopenSession(id);
    if (!reopened) return null;

    try {
      const dbSession = await invoke<DbSession | null>("db_get_session", { id });
      if (!dbSession || dbSession.is_closed) {
        await refreshRecentlyClosedSessions();
        return null;
      }

      const session = mapDbSessionToWebSession(dbSession);
      const existingIndex = sessions.findIndex((entry) => entry.id === id);
      if (existingIndex === -1) {
        setSessions(sessions.length, session);
      } else {
        setSessions(existingIndex, session);
      }

      try {
        const tagsForSession = await invoke<string[]>("db_get_session_tags", { sessionId: id });
        setTerminalTags((prev) => ({ ...prev, [id]: tagsForSession }));
      } catch (err) {
        console.error(`Failed to load tags for reopened session ${id}:`, err);
      }

      selectSession(id);
      await refreshRecentlyClosedSessions();
      return id;
    } catch (err) {
      console.error(`Failed to fetch reopened session ${id}:`, err);
      await refreshRecentlyClosedSessions();
      return null;
    }
  }

  async function reopenLastClosedSession() {
    const latest = (await dbListClosedSessions(1))[0];
    if (!latest) {
      setRecentlyClosedSessions([]);
      return null;
    }
    return reopenClosedSession(latest.id);
  }

  async function restorePreviousSessions() {
    try {
      const dbSessions = await invoke<DbSession[]>("db_list_sessions");
      if (dbSessions.length === 0) {
        console.log("[restore] No previous sessions found in database");
        return;
      }
      // Filter out sessions that are already loaded
      const existingIds = new Set(sessions.map((s) => s.id));
      const newSessions = dbSessions.filter((s) => !existingIds.has(s.id));
      if (newSessions.length === 0) {
        console.log("[restore] All previous sessions already loaded");
        return;
      }
      const startIndex = sessions.length;
      newSessions.forEach((dbSession, index) => {
        const session = mapDbSessionToWebSession(dbSession);
        setSessions(startIndex + index, session);
      });
      // Load tags for restored sessions
      const dbTags = await invoke<Record<string, string[]>>("db_get_all_session_tags");
      if (dbTags && Object.keys(dbTags).length > 0) {
        setTerminalTags((prev) => ({ ...prev, ...dbTags }));
      }
      // Initialize terminals for restored sessions
      setRestoreDecision("yes");
      console.log(`[restore] Restored ${newSessions.length} sessions from database`);
    } catch (err) {
      console.error("Failed to restore sessions:", err);
    }
  }

  async function updatePtySize(id: string) {
    const instance = terminalInstances.get(id);
    const ptyId = ptyBySession()[id];
    if (!instance || !ptyId) return;
    const rows = instance.term.rows;
    const cols = instance.term.cols;
    if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 1 || cols < 1) return;
    const prev = lastPtySizeBySession.get(id);
    if (prev && prev.rows === rows && prev.cols === cols) return;
    lastPtySizeBySession.set(id, { rows, cols });
    await invoke("pty_resize", {
      id: ptyId,
      rows,
      cols,
    });
  }

  async function ensureTerminal(id: string, options?: { focus?: boolean }) {
    if (terminalInstances.has(id)) return;
    const host = terminalHosts.get(id);
    if (!host) return;
    const session = sessions.find((entry) => entry.id === id);
    const shouldAutoFocus = options?.focus !== false;

    // Get theme settings from config or use defaults
    const config = appConfig();
    const appearance = config?.appearance;
    const theme = appearance?.theme;

    // Link handler for OSC 8 hyperlinks. Track hover so right-click can consume the URL.
    let hoveredOscUrl: string | null = null;
    const linkHandler = {
      activate: (event: MouseEvent, text: string) => {
        if (event.metaKey || event.ctrlKey) {
          void openUrl(text);
        }
      },
      hover: (_event: MouseEvent, text: string) => {
        hoveredOscUrl = text;
      },
      leave: () => {
        hoveredOscUrl = null;
      },
    };

    const baseOptions = {
      cursorBlink: appearance?.cursor_blink ?? true,
      cursorStyle: "block" as const,
      cursorInactiveStyle: "block" as const,
      fontFamily: appearance?.font_family
        ? `"${appearance.font_family}", "JetBrains Mono", "Fira Code", Menlo, monospace`
        : '"SF Mono", "JetBrains Mono", "Fira Code", Menlo, monospace',
      fontSize: appearance?.font_size ?? 14,
      lineHeight: appearance?.line_height ?? 1.3,
      scrollback: 5000,
      scrollSensitivity: 4,
      fastScrollSensitivity: 7,
      allowProposedApi: true,
      linkHandler,
      theme: {
        // Core - use config values or defaults
        background: theme?.background ?? "#27272a",
        foreground: theme?.foreground ?? "#d4d4d8",
        cursor: theme?.cursor ?? "#F5D76E",
        cursorAccent: theme?.background ?? "#27272a",
        selectionBackground: theme?.selection ?? "rgba(245, 215, 110, 0.25)",
        selectionForeground: "#fafafa",

        // Normal colors (use config values or defaults)
        black: theme?.black ?? "#27272a",
        red: theme?.red ?? "#f87171",
        green: theme?.green ?? "#4ade80",
        yellow: theme?.yellow ?? "#fbbf24",
        blue: theme?.blue ?? "#60a5fa",
        magenta: theme?.magenta ?? "#c084fc",
        cyan: theme?.cyan ?? "#22d3d3",
        white: theme?.white ?? "#a1a1aa",

        // Bright colors (derived from base colors with lighter variants)
        brightBlack: "#52525b",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#5eead4",
        brightWhite: "#fafafa",
      },
    };
    const term = new XtermTerminal(baseOptions);
    const fit = new XtermFitAddon();
    const search = new XtermSearchAddon();
    // WebLinksAddon for plain text URLs (Cmd+click to open)
    const webLinks = new XtermWebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey) {
        void openUrl(uri);
      }
    });
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(webLinks);
    term.open(host);
    attachTerminalToHost(id, host, term);
    if (canFitTerminalHost(host)) {
      fit.fit();
    }
    terminalInstances.set(id, { term, fit, search });
    setTimeout(() => updateSessionPreview(id), 0);

    // Register file path link provider (Cmd+click to show actions menu)
    // Pattern 1: explicit paths — /absolute, ~/home, ./relative
    const filePathRegex = /(?:^|[\s'"`({\[:])((\/[^\s'"`)\]}>]+|~\/[^\s'"`)\]}>]+|\.\/[^\s'"`)\]}>]+))/g;
    // Pattern 2: bare filenames with common extensions (e.g. package.json, app.py)
    const knownExts = "js|jsx|ts|tsx|mjs|cjs|py|rs|go|java|c|cpp|h|hpp|rb|swift|kt|scala|sh|bash|zsh|fish|pl|lua|r|m|mm|cs|fs|ex|exs|erl|hs|ml|php|json|jsonl|yaml|yml|toml|xml|ini|conf|cfg|env|csv|tsv|parquet|sql|sqlite|db|wal|md|mdx|txt|rst|tex|pdf|doc|docx|rtf|html|htm|css|scss|sass|less|svg|wasm|vue|svelte|astro|ipynb|lock|log|key|pem|crt|cert|tar|gz|zip|jar|war|dmg|iso|img|png|jpg|jpeg|gif|webp|ico|bmp|tiff|mp3|mp4|wav|avi|mov|mkv|Makefile|Dockerfile|Vagrantfile|Gemfile|Rakefile|Procfile";
    const bareFileRegex = new RegExp(`(?:^|[\\s'"\`({\\[:])([a-zA-Z0-9_][a-zA-Z0-9_.\\-]*\\.(?:${knownExts}))(?=$|[\\s'"\`)}\\]>:,;!?])`, "g");
    // Pattern 3: multi-segment relative files (e.g. projects/foo/ai_native.db) — requires ≥1 dir prefix + known extension
    const relativeFileRegex = new RegExp(`(?:^|[\\s'"\`({\\[:])((?:[a-zA-Z0-9_][a-zA-Z0-9_.\\-]*\\/)+[a-zA-Z0-9_][a-zA-Z0-9_.\\-]*\\.(?:${knownExts}))(?=$|[\\s'"\`)}\\]>:,;!?])`, "g");
    // Pattern 4: multi-segment relative dirs with trailing slash (e.g. projects/foo/validation_chunks/) — requires ≥2 segments
    const relativeDirRegex = /(?:^|[\s'"`({\[:])([a-zA-Z0-9_][a-zA-Z0-9_.\-]*(?:\/[a-zA-Z0-9_.\-]+)+\/)(?=$|[\s'"`)}\]>:,;!?])/g;

    const activateFileLink = (event: MouseEvent, text: string) => {
      if (event.metaKey || event.ctrlKey) {
        const showMenu = (resolvedPath: string) => {
          setFilePathContextMenu({
            path: resolvedPath,
            sessionId: id,
            x: event.clientX,
            y: event.clientY,
          });
        };
        if (text.startsWith("~/")) {
          void homeDir().then((home) => {
            showMenu(text.replace("~", home.replace(/\/$/, "")));
          });
        } else if (text.startsWith("/")) {
          showMenu(text);
        } else {
          // Bare filename or ./relative — resolve against cwd
          const currentPtyId = ptyBySession()[id];
          if (currentPtyId) {
            void invoke<string>("get_pty_cwd", { id: currentPtyId }).then((cwd) => {
              if (cwd) {
                const relative = text.startsWith("./") ? text.slice(2) : text;
                showMenu(cwd.replace(/\/$/, "") + "/" + relative);
              }
            });
          }
        }
      }
    };

    term.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const lineText = line.translateToString();
        const links: Array<{
          range: { start: { x: number; y: number }; end: { x: number; y: number } };
          text: string;
          activate: (event: MouseEvent, text: string) => void;
        }> = [];
        const covered = new Set<number>(); // track columns already linked

        // Pass 1: explicit paths (/abs, ~/, ./)
        let match;
        while ((match = filePathRegex.exec(lineText)) !== null) {
          let filePath = match[1];
          // Skip URL paths — e.g. `https://github.com/...` captures as `//github.com/...`.
          // Let WebLinksAddon own those.
          if (filePath.startsWith("//")) continue;
          const stripped = filePath.replace(/[.,;:!?)]+$/, "");
          if (stripped.length > 1) filePath = stripped;
          const matchStart = match.index + match[0].indexOf(match[1]);
          for (let i = matchStart; i < matchStart + filePath.length; i++) covered.add(i);
          links.push({
            range: {
              start: { x: matchStart + 1, y: bufferLineNumber },
              end: { x: matchStart + filePath.length + 1, y: bufferLineNumber },
            },
            text: filePath,
            activate: activateFileLink,
          });
        }
        filePathRegex.lastIndex = 0;

        // Pass 2: multi-segment relative files (dir/sub/file.ext)
        while ((match = relativeFileRegex.exec(lineText)) !== null) {
          const relPath = match[1];
          const matchStart = match.index + match[0].indexOf(relPath);
          if (covered.has(matchStart)) continue;
          for (let i = matchStart; i < matchStart + relPath.length; i++) covered.add(i);
          links.push({
            range: {
              start: { x: matchStart + 1, y: bufferLineNumber },
              end: { x: matchStart + relPath.length + 1, y: bufferLineNumber },
            },
            text: relPath,
            activate: activateFileLink,
          });
        }
        relativeFileRegex.lastIndex = 0;

        // Pass 3: multi-segment relative dirs with trailing slash (dir/sub/)
        while ((match = relativeDirRegex.exec(lineText)) !== null) {
          const relDir = match[1];
          const matchStart = match.index + match[0].indexOf(relDir);
          if (covered.has(matchStart)) continue;
          for (let i = matchStart; i < matchStart + relDir.length; i++) covered.add(i);
          links.push({
            range: {
              start: { x: matchStart + 1, y: bufferLineNumber },
              end: { x: matchStart + relDir.length + 1, y: bufferLineNumber },
            },
            text: relDir,
            activate: activateFileLink,
          });
        }
        relativeDirRegex.lastIndex = 0;

        // Pass 4: bare filenames with known extensions
        while ((match = bareFileRegex.exec(lineText)) !== null) {
          const fileName = match[1];
          const matchStart = match.index + match[0].indexOf(fileName);
          // Skip if already covered by a path match
          if (covered.has(matchStart)) continue;
          links.push({
            range: {
              start: { x: matchStart + 1, y: bufferLineNumber },
              end: { x: matchStart + fileName.length + 1, y: bufferLineNumber },
            },
            text: fileName,
            activate: activateFileLink,
          });
        }
        bareFileRegex.lastIndex = 0;

        callback(links.length > 0 ? links : undefined);
      },
    });

    // Right-click on file paths: find the file path at the clicked position and show context menu
    const findFilePathAtColumn = (lineText: string, col: number): string | null => {
      let match;
      // Check explicit paths
      const pathRe = new RegExp(filePathRegex.source, "g");
      while ((match = pathRe.exec(lineText)) !== null) {
        let filePath = match[1];
        const stripped = filePath.replace(/[.,;:!?)]+$/, "");
        if (stripped.length > 1) filePath = stripped;
        const start = match.index + match[0].indexOf(match[1]);
        if (col >= start && col < start + filePath.length) return filePath;
      }
      // Check multi-segment relative files
      const relFileRe = new RegExp(relativeFileRegex.source, "g");
      while ((match = relFileRe.exec(lineText)) !== null) {
        const relPath = match[1];
        const start = match.index + match[0].indexOf(relPath);
        if (col >= start && col < start + relPath.length) return relPath;
      }
      // Check multi-segment relative dirs
      const relDirRe = new RegExp(relativeDirRegex.source, "g");
      while ((match = relDirRe.exec(lineText)) !== null) {
        const relDir = match[1];
        const start = match.index + match[0].indexOf(relDir);
        if (col >= start && col < start + relDir.length) return relDir;
      }
      // Check bare filenames
      const bareRe = new RegExp(bareFileRegex.source, "g");
      while ((match = bareRe.exec(lineText)) !== null) {
        const fileName = match[1];
        const start = match.index + match[0].indexOf(fileName);
        if (col >= start && col < start + fileName.length) return fileName;
      }
      return null;
    };

    // URL detection for right-click
    const urlRegex = /https?:\/\/[^\s'"`)\]}>]+/g;
    const findUrlAtColumn = (lineText: string, col: number): string | null => {
      let match;
      const re = new RegExp(urlRegex.source, "g");
      while ((match = re.exec(lineText)) !== null) {
        let url = match[0].replace(/[.,;:!?)]+$/, "");
        if (col >= match.index && col < match.index + url.length) return url;
      }
      return null;
    };

    const termEl = term.element;
    if (termEl) {
      const handleContextMenu = (e: MouseEvent) => {
        // Get the core dimensions to compute buffer position
        const core = (term as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } } })._core;
        const cellWidth = core?._renderService?.dimensions?.css?.cell?.width;
        const cellHeight = core?._renderService?.dimensions?.css?.cell?.height;
        if (!cellWidth || !cellHeight) return;

        const rect = termEl.querySelector(".xterm-screen")?.getBoundingClientRect();
        if (!rect) return;

        const col = Math.floor((e.clientX - rect.left) / cellWidth);
        const row = Math.floor((e.clientY - rect.top) / cellHeight);
        const bufferRow = row + term.buffer.active.viewportY;

        const line = term.buffer.active.getLine(bufferRow);
        if (!line) return;
        const lineText = line.translateToString();

        // Check OSC 8 hyperlinks first — URL comes from the hover handler, not visible text.
        if (hoveredOscUrl) {
          e.preventDefault();
          e.stopPropagation();
          setUrlContextMenu({ url: hoveredOscUrl, x: e.clientX, y: e.clientY });
          return;
        }

        // Then plain-text URLs
        const url = findUrlAtColumn(lineText, col);
        if (url) {
          e.preventDefault();
          e.stopPropagation();
          setUrlContextMenu({ url, x: e.clientX, y: e.clientY });
          return;
        }

        // Then check file paths
        const filePath = findFilePathAtColumn(lineText, col);
        if (!filePath) return;

        e.preventDefault();
        e.stopPropagation();
        const showMenu = (resolvedPath: string) => {
          setFilePathContextMenu({
            path: resolvedPath,
            sessionId: id,
            x: e.clientX,
            y: e.clientY,
          });
        };
        if (filePath.startsWith("~/")) {
          void homeDir().then((home) => {
            showMenu(filePath.replace("~", home.replace(/\/$/, "")));
          });
        } else if (filePath.startsWith("/")) {
          showMenu(filePath);
        } else {
          const currentPtyId = ptyBySession()[id];
          if (currentPtyId) {
            void invoke<string>("get_pty_cwd", { id: currentPtyId }).then((cwd) => {
              if (cwd) {
                const relative = filePath.startsWith("./") ? filePath.slice(2) : filePath;
                showMenu(cwd.replace(/\/$/, "") + "/" + relative);
              }
            });
          }
        }
      };
      termEl.addEventListener("contextmenu", handleContextMenu);
    }

    // Restore scrollback from database if available
    try {
      const scrollbackData = await invoke<DbScrollback | null>("db_get_scrollback", { sessionId: id });
      if (scrollbackData && scrollbackData.content) {
        term.write(scrollbackData.content);
        term.write("\r\n\x1b[38;5;242m--- Session restored ---\x1b[0m\r\n\r\n");
        setTimeout(() => updateSessionPreview(id), 0);
      }
    } catch (err) {
      console.error("Failed to restore scrollback:", err);
    }

    term.attachCustomKeyEventHandler?.((event) => {
      // Only handle keydown, not keyup (handler fires for both)
      if (event.type !== "keydown") {
        return true;
      }

      // Cmd+Arrow Left/Right: jump to start/end of line
      if (event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        event.stopPropagation();
        // Ctrl+A = start of line, Ctrl+E = end of line (readline bindings)
        const seq = event.key === "ArrowLeft" ? "\x01" : "\x05";
        void invoke("pty_write", { id, data: seq });
        return false;
      }

      const isPaste =
        (event.key === "v" || event.key === "V") && (event.metaKey || event.ctrlKey);
      const isShiftEnter = isShiftEnterEvent(event);
      const shouldHandle = isPaste || isShiftEnter;
      if (!shouldHandle) {
        return true;
      }
      if (isShiftEnter) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void sendShiftEnterToSession(id, "term-shift-enter");
        return false;
      }
      const isCmdPaste = event.metaKey;
      const isCtrlPaste = event.ctrlKey && !event.metaKey;
      console.log("[paste] term shortcut", {
        sessionId: id,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      });
      if (shouldSuppressTerminalPaste(id)) {
        console.log("[paste] term shortcut suppressed", { sessionId: id });
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return false;
      }
      markTerminalPasteHandled(id);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void handlePasteShortcutForSession(
        id,
        isCmdPaste ? "term-shortcut-cmd" : "term-shortcut-ctrl",
        isCtrlPaste ? "long" : "short"
      );
      return false;
    });

    let ptyId = ptyBySession()[id];
    const createdPty = !ptyId;
    if (!ptyId) {
      ptyId = await invoke<string>("pty_create", {
        id,
        rows: term.rows,
        cols: term.cols,
        cwd: session?.directory || null,
        command: null,
      });
      setPtyBySession((prev) => ({ ...prev, [id]: ptyId }));
    } else {
      void updatePtySize(id);
    }

    const command = session?.command?.trim();
    if (command && createdPty && !commandRunFor.has(id)) {
      commandRunFor.add(id);
      void invoke("pty_write", { id: ptyId, data: `${command}\n` });
    }

    term.onData((data) => {
      const current = ptyBySession()[id];
      if (current) {
        void invoke("pty_write", { id: current, data });
      }
      // Schedule scrollback save after user input
      scheduleScrollbackSave(id);
    });

    const refit = () => {
      if (!canFitTerminalHost(host)) return;
      fit.fit();
      void updatePtySize(id);
    };
    requestAnimationFrame(refit);
    if (shouldAutoFocus) {
      requestAnimationFrame(() => focusTerminalInstance(term));
    }
    setTimeout(refit, 50);
    if (shouldAutoFocus) {
      setTimeout(() => focusTerminalInstance(term), 0);
    }
    setTimeout(refit, 250);
    void document.fonts?.ready.then(refit);
    setTimeout(() => {
      const textarea = (term as unknown as { textarea?: HTMLTextAreaElement }).textarea;
      console.log("[xterm] textarea status", {
        exists: Boolean(textarea),
        active: document.activeElement === textarea,
        readOnly: textarea?.readOnly,
        disabled: textarea?.disabled,
      });
    }, 50);
  }

  const maybeEnsureTerminal = (id: string) => {
    const decision = restoreDecision();
    if (decision === "pending") return;
    if (decision === "yes" || activeSessionId() === id) {
      void ensureTerminal(id);
    }
  };

  const registerTerminalHost = (id: string, el?: HTMLDivElement) => {
    if (el) {
      terminalHosts.set(id, el);
      const instance = terminalInstances.get(id);
      if (instance) {
        attachTerminalToHost(id, el, instance.term);
        requestAnimationFrame(() => fitTerminalSession(id));
      } else {
        maybeEnsureTerminal(id);
      }
    } else {
      clearTerminalHostInteractions(id);
      terminalHosts.delete(id);
    }
  };

  const registerQuickInputRef = (id: string, el?: HTMLInputElement) => {
    if (el) {
      quickInputRefs.set(id, el);
    } else {
      quickInputRefs.delete(id);
    }
  };

  const setRenameInputRef = (el?: HTMLInputElement) => {
    renameInputRef = el;
  };

  const setSearchInputRef = (el?: HTMLInputElement) => {
    searchInputRef = el;
  };

  const setCommandInputRef = (el?: HTMLInputElement) => {
    commandInputRef = el;
  };

  const setFileBrowserInputRef = (el?: HTMLInputElement) => {
    fileBrowserInputRef = el;
  };

  createEffect(() => {
    const decision = restoreDecision();
    if (decision !== "yes") return;
    const count = sessions.length;
    for (let i = 0; i < count; i += 1) {
      void ensureTerminal(sessions[i].id);
    }
  });

  createEffect(() => {
    const decision = restoreDecision();
    const active = activeSessionId();
    if (!active || decision === "pending") return;
    void ensureTerminal(active);
  });

  const resolvePasteSessionId = (target: EventTarget | null): string | null => {
    if (!(target instanceof Node)) {
      return activeWorkspaceTabKind() === "terminal" ? activeSessionId() : null;
    }
    for (const [sessionId, host] of terminalHosts) {
      if (host.contains(target)) {
        return sessionId;
      }
    }
    return activeWorkspaceTabKind() === "terminal" ? activeSessionId() : null;
  };

  const isWithinTerminalHost = (target: EventTarget | null): boolean => {
    if (!(target instanceof Node)) return false;
    for (const host of terminalHosts.values()) {
      if (host.contains(target)) {
        return true;
      }
    }
    return false;
  };

  const isTerminalActiveElement = (): boolean => {
    return isWithinTerminalHost(document.activeElement);
  };

  const isEditableTarget = (target: EventTarget | null): boolean => {
    if (isWithinTerminalHost(target)) return false;
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tagName = target.tagName;
    return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
  };

  const markTerminalPasteHandled = (sessionId: string) => {
    lastTerminalPasteAt = Date.now();
    lastTerminalPasteSessionId = sessionId;
  };

  const shouldSuppressTerminalPaste = (sessionId: string, windowMs = terminalPasteSuppressMs) => {
    return (
      lastTerminalPasteSessionId === sessionId && Date.now() - lastTerminalPasteAt < windowMs
    );
  };

  const readImageFromClipboard = async (): Promise<File | null> => {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") {
      console.log("[paste] navigator.clipboard.read not available");
      return null;
    }
    try {
      console.log("[paste] navigator.clipboard.read start");
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (!type.startsWith("image/")) continue;
          const blob = await item.getType(type);
          const extension = type.split("/")[1] || "png";
          console.log("[paste] navigator.clipboard.read found image", type, blob.size);
          return new File([blob], `pasted-image-${Date.now()}.${extension}`, { type });
        }
      }
    } catch (err) {
      console.warn("[paste] clipboard.read failed", err);
    }
    return null;
  };

  const readImageFromTauriClipboard = async (): Promise<File | null> => {
    try {
      console.log("[paste] tauri clipboard read start");
      const clipboardImage = await readClipboardImage();
      const size = await clipboardImage.size();
      const rgba = await clipboardImage.rgba();
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        console.warn("[paste] canvas context unavailable");
        return null;
      }
      const imageData = new ImageData(new Uint8ClampedArray(rgba), size.width, size.height);
      ctx.putImageData(imageData, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/png");
      });
      if (!blob) return null;
      console.log("[paste] tauri clipboard read image", blob.size);
      return new File([blob], `pasted-image-${Date.now()}.png`, { type: "image/png" });
    } catch (err) {
      console.warn("[paste] tauri clipboard read failed", err);
      return null;
    }
  };

  const readImageFromNativeCommand = async (): Promise<{ mime: string; bytes: Uint8Array } | null> => {
    try {
      console.log("[paste] native clipboard read start");
      const payload = await invoke<{ mime: string; bytes: number[] }>(
        "read_clipboard_image_native"
      );
      console.log("[paste] native clipboard read image", payload.mime, payload.bytes.length);
      return { mime: payload.mime, bytes: new Uint8Array(payload.bytes) };
    } catch (err) {
      console.warn("[paste] native clipboard read failed", err);
      return null;
    }
  };

  const readClipboardTypesNative = async (): Promise<string[] | null> => {
    try {
      console.log("[paste] native clipboard types read start");
      const types = await invoke<string[]>("read_clipboard_types_native");
      console.log("[paste] native clipboard types", types);
      lastClipboardTypes = types;
      lastClipboardTypesAt = Date.now();
      return types;
    } catch (err) {
      console.warn("[paste] native clipboard types read failed", err);
      return null;
    }
  };

  const hasImageTypes = (types: string[] | null): boolean => {
    if (!types || types.length === 0) return false;
    return types.some((entry) => {
      const type = entry.toLowerCase();
      return (
        type.includes("tiff") ||
        type.includes("png") ||
        type.includes("jpeg") ||
        type.includes("jpg") ||
        type.includes("gif") ||
        type.includes("heic") ||
        type.includes("heif") ||
        type.includes("public.image") ||
        type.includes("image/")
      );
    });
  };

  const detectClipboardImage = async (): Promise<boolean> => {
    console.log("[paste] detectClipboardImage start");
    const browserImage = await readImageFromClipboard();
    if (browserImage) return true;
    const tauriImage = await readImageFromTauriClipboard();
    if (tauriImage) return true;
    const nativeImage = await readImageFromNativeCommand();
    if (nativeImage) return true;
    const types = await readClipboardTypesNative();
    if (hasImageTypes(types)) return true;
    return false;
  };

  const hasClipboardImageTypes = async (maxAgeMs = 5000): Promise<boolean> => {
    if (lastClipboardTypes && Date.now() - lastClipboardTypesAt < maxAgeMs) {
      const cached = hasImageTypes(lastClipboardTypes);
      console.log("[paste] clipboard image types present (cached)", cached);
      return cached;
    }
    const types = await readClipboardTypesNative();
    const result = hasImageTypes(types);
    console.log("[paste] clipboard image types present", result);
    return result;
  };

  const isExpectedNoImageError = (err: unknown) => {
    const message = String((err as Error)?.message ?? err);
    return (
      message.includes("Clipboard image not available") ||
      message.includes("clipboard contents were not available") ||
      message.includes("clipboard is empty") ||
      message.includes("not available in the requested format")
    );
  };

  const warmClipboard = async (source: string) => {
    if (clipboardWarm) return;
    if (!clipboardWarmInFlight) {
      clipboardWarmInFlight = (async () => {
        console.log("[paste] warm clipboard start", source);
        try {
          await readClipboardTypesNative();
        } catch (err) {
          console.log("[paste] warm clipboard types failed", err);
        }
        try {
          await readImageFromNativeCommand();
        } catch (err) {
          if (!isExpectedNoImageError(err)) {
            console.log("[paste] warm native image failed", err);
          }
        }
        try {
          await readClipboardImage();
        } catch (err) {
          if (!isExpectedNoImageError(err)) {
            console.log("[paste] warm tauri image failed", err);
          }
        }
        try {
          await readClipboardText();
        } catch (err) {
          console.log("[paste] warm clipboard text failed", err);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        clipboardWarm = true;
        console.log("[paste] warm clipboard done");
      })().finally(() => {
        clipboardWarmInFlight = null;
      });
    }
    await clipboardWarmInFlight;
  };

  const saveClipboardImageWithRetry = async (attempts = 6, delayMs = 60): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        console.log("[paste] save_clipboard_image attempt", attempt + 1, "of", attempts);
        return await invoke<string>("save_clipboard_image");
      } catch (err) {
        lastError = err;
        if (isExpectedNoImageError(err)) {
          console.log("[paste] save_clipboard_image retryable error", err);
        } else {
          throw err;
        }
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError ?? new Error("Clipboard image not available");
  };

  async function handlePasteShortcutForSession(
    sessionId: string,
    source: string,
    retryProfile: "short" | "long" = "short"
  ) {
    const profile = retryProfile === "long" ? { attempts: 20, delay: 120 } : { attempts: 6, delay: 60 };
    console.log("[paste] shortcut session", { source, sessionId, retryProfile });
    if (!clipboardWarm) {
      await warmClipboard("first-paste");
    }
    try {
      const path = await saveClipboardImageWithRetry(profile.attempts, profile.delay);
      await writeImagePathToSession(sessionId, path, source);
      return;
    } catch (err) {
      if (isExpectedNoImageError(err)) {
        console.log("[paste] save_clipboard_image skipped", err);
        const hasImage = await hasClipboardImageTypes();
        if (hasImage) {
          console.log("[paste] image types present; retrying with longer backoff");
          try {
            const path = await saveClipboardImageWithRetry(12, 140);
            await writeImagePathToSession(sessionId, path, source);
            return;
          } catch (retryErr) {
            console.log("[paste] extended retry failed", retryErr);
            if (retryProfile === "long") {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
        } else {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      } else {
        console.warn("[paste] save_clipboard_image failed", err);
      }
    }
    try {
      const shouldFallbackToText = !(await hasClipboardImageTypes());
      console.log("[paste] reading clipboard text fallback", source, shouldFallbackToText);
      if (!shouldFallbackToText) {
        console.log("[paste] skipping text fallback; image types present");
        return;
      }
      const text = await readClipboardText();
      console.log("[paste] clipboard text fallback length", text?.length ?? 0, "preview", text?.slice(0, 20));
      let wrote = false;
      if (text) {
        const ptyId = ptyBySession()[sessionId];
        if (ptyId) {
          await invoke("pty_write", { id: ptyId, data: text });
          wrote = true;
        }
      }
      if (!wrote) {
        console.log("[paste] falling back to ctrl+v", source);
        await sendCtrlVToSession(sessionId, source);
      }
    } catch (err) {
      console.warn("[paste] tauri clipboard read text failed", err);
      console.log("[paste] falling back to ctrl+v after read error", source);
      await sendCtrlVToSession(sessionId, source);
    }
  }

  const isPreviewUrlUsable = (url: string) => url.startsWith("blob:");

  const loadPasteQueueUrl = async (path: string): Promise<string | null> => {
    try {
      const bytes = await invoke<number[]>("read_file_binary", { path });
      const mimeType = inferImageMimeType(path) ?? "image/png";
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
      return URL.createObjectURL(blob);
    } catch (err) {
      console.warn("[paste] failed to load image for preview", err);
      return null;
    }
  };

  const enqueuePastePath = (path: string) => {
    setPasteQueue((prev) => {
      const filename = path.split("/").pop() || path;
      const next = [
        { kind: "image" as const, path, url: "", filename },
        ...prev.filter((item) => item.path !== path),
      ].slice(0, pasteQueueLimit);
      const nextPaths = new Set(next.map((item) => item.path));
      for (const item of prev) {
        if (!nextPaths.has(item.path) && item.url.startsWith("blob:")) {
          URL.revokeObjectURL(item.url);
        }
      }
      return next;
    });
    void (async () => {
      const url = await loadPasteQueueUrl(path);
      if (!url) return;
      setPasteQueue((prev) =>
        prev.map((item) => (item.path === path ? { ...item, url } : item))
      );
    })();
  };

  const enqueueRecordingPath = (path: string) => {
    setPasteQueue((prev) => {
      const filename = path.split("/").pop() || path;
      return [
        { kind: "recording" as const, path, url: "", filename },
        ...prev.filter((item) => item.path !== path),
      ].slice(0, pasteQueueLimit);
    });
  };

  const setPasteHoverPosition = (
    item: PasteQueueItem,
    target: HTMLElement
  ) => {
    if (item.kind !== "image") return;
    const rect = target.getBoundingClientRect();
    setPasteHover({
      url: item.url,
      name: item.filename,
      path: item.path,
      x: rect.right + 12,
      y: 0, // Not used - positioned from bottom via CSS
    });
  };

  const showPasteHover = async (item: PasteQueueItem, target: HTMLElement) => {
    if (item.kind !== "image") return;
    if (!item.url || !isPreviewUrlUsable(item.url)) {
      const url = await loadPasteQueueUrl(item.path);
      if (url) {
        setPasteQueue((prev) =>
          prev.map((entry) => (entry.path === item.path ? { ...entry, url } : entry))
        );
        setPasteHoverPosition(
          { kind: "image", url, filename: item.filename, path: item.path },
          target
        );
        return;
      }
      console.log("[paste] no preview url for hover", item.path);
      return;
    }
    setPasteHoverPosition(item, target);
  };

  const refreshPasteQueueItem = async (path: string) => {
    const current = pasteQueue();
    const match = current.find((item) => item.path === path);
    if (!match || match.kind !== "image") return;
    if (match.url.startsWith("blob:")) {
      URL.revokeObjectURL(match.url);
    }
    setPasteQueue((prev) =>
      prev.map((item) => (item.path === path ? { ...item, url: "" } : item))
    );
    const url = await loadPasteQueueUrl(path);
    if (!url) return;
    setPasteQueue((prev) =>
      prev.map((item) => (item.path === path ? { ...item, url } : item))
    );
    const hover = pasteHover();
    if (hover && hover.path === path) {
      setPasteHover({ ...hover, url });
    }
  };

  const openImageEditor = (path: string, filename?: string) => {
    setImageEditorPath(path);
    setImageEditorName(filename ?? path.split("/").pop() ?? path);
    setImageEditorOpen(true);
    setPasteHover(null);
  };

  const closeImageEditor = () => {
    setImageEditorOpen(false);
    setImageEditorPath(null);
    setImageEditorName(null);
  };

  const copyPathToClipboard = async (path: string) => {
    await navigator.clipboard.writeText(path);
  };

  const openPathExternally = async (path: string) => {
    await Command.create("open", [path]).execute();
  };

  const sendCtrlVToSession = async (sessionId: string, source: string) => {
    const ptyId = ptyBySession()[sessionId];
    if (!ptyId) {
      console.warn("[paste] no pty for session", sessionId);
      return;
    }
    console.log("[paste] sending ctrl+v", source);
    await invoke("pty_write", { id: ptyId, data: "\x16" });
  };

  const writeImagePathToSession = async (sessionId: string, path: string, source: string) => {
    const ptyId = ptyBySession()[sessionId];
    if (!ptyId) {
      console.warn("[paste] no pty for session", sessionId);
      return;
    }
    const message = `[Read image: ${path}]`;
    console.log("[paste] sending image path", source, message);
    await invoke("pty_write", { id: ptyId, data: `${message}\n` });
    enqueuePastePath(path);
  };

  const sendShiftEnterToSession = async (sessionId: string, source: string) => {
    const ptyId = ptyBySession()[sessionId];
    if (!ptyId) return;
    console.log("[terminal] send shift+enter", source);
    await invoke("pty_write", { id: ptyId, data: "\x0A" });
  };

  const isShiftEnterEvent = (event: KeyboardEvent) => {
    const key = event.key;
    const code = event.code;
    const isEnter =
      key === "Enter" ||
      key === "Return" ||
      key === "LineFeed" ||
      code === "Enter" ||
      code === "NumpadEnter" ||
      // eslint-disable-next-line deprecation/deprecation
      event.keyCode === 13;
    return (
      isEnter &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    );
  };

  const setFooterPresetSelection = (presetId: string) => {
    setFooterPresetId(presetId);
    localStorage.setItem(FOOTER_PRESET_STORAGE_KEY, presetId);
  };

  const expandTildePath = async (path: string): Promise<string> => {
    if (path === "~" || path.startsWith("~/")) {
      const home = await homeDir();
      const trimmed = home.replace(/\/$/, "");
      return path === "~" ? trimmed : `${trimmed}${path.slice(1)}`;
    }
    return path;
  };

  const createWorktreeForPreset = async (preset: TerminalPreset) => {
    const repoDirRaw = preset.directory?.trim();
    if (!repoDirRaw) {
      throw new Error("Worktree preset requires a directory.");
    }
    const repoDir = await expandTildePath(repoDirRaw);
    const maxAttempts = 5;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const slug = generateWorktreeSlug();
      const worktreeName = `tree-${slug}`;
      const branchName = `branch-${slug}`;
      try {
        const path = await invoke<string>("git_worktree_create", {
          repoDir,
          worktreeName,
          branchName,
        });
        return { slug, worktreeName, branchName, path };
      } catch (err) {
        lastErr = err;
        const message = String(err);
        if (message.includes("not a git repository") || message.includes("Failed to resolve repo root")) {
          break;
        }
      }
    }
    const fallbackSlug = `${generateWorktreeSlug()}-${generateWorktreeSuffix()}`;
    const fallbackWorktreeName = `tree-${fallbackSlug}`;
    const fallbackBranchName = `branch-${fallbackSlug}`;
    try {
      const path = await invoke<string>("git_worktree_create", {
        repoDir,
        worktreeName: fallbackWorktreeName,
        branchName: fallbackBranchName,
      });
      return {
        slug: fallbackSlug,
        worktreeName: fallbackWorktreeName,
        branchName: fallbackBranchName,
        path,
      };
    } catch (err) {
      lastErr = err;
    }
    throw lastErr ?? new Error("Failed to create worktree");
  };

  const launchPresetSession = async (preset: TerminalPreset, commandOverride?: string) => {
    if (!preset.worktree) {
      return createSession(preset, commandOverride);
    }
    try {
      const worktree = await createWorktreeForPreset(preset);
      const title = `${preset.name} · ${worktree.worktreeName}`;
      return createSession(preset, commandOverride, worktree.path, title);
    } catch (err) {
      console.warn("[worktree] Failed to create worktree session:", err);
      return null;
    }
  };

  const waitForTerminalHost = async (id: string, timeoutMs = 2000): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (terminalHosts.get(id)) return true;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    return false;
  };

  const waitForTerminalInstance = async (
    id: string,
    timeoutMs = 2500
  ): Promise<{ term: XtermTerminal; fit: XtermFitAddon; search: XtermSearchAddon } | null> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const instance = terminalInstances.get(id);
      if (instance) return instance;
      if (terminalHosts.get(id)) {
        await ensureTerminal(id, { focus: false });
        const ensured = terminalInstances.get(id);
        if (ensured) return ensured;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  };

  const resolveForkTitle = (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return "Terminal (fork)";
    if (trimmed.endsWith(" (fork)")) return trimmed;
    return `${trimmed} (fork)`;
  };

  const getScrollbackForSession = async (sessionId: string): Promise<string> => {
    const instance = terminalInstances.get(sessionId);
    if (instance) {
      const live = captureScrollback(instance.term);
      if (live) return live;
    }
    try {
      const scrollbackData = await invoke<DbScrollback | null>("db_get_scrollback", {
        sessionId,
      });
      if (scrollbackData?.content) return scrollbackData.content;
    } catch (err) {
      console.error("Failed to fetch scrollback for fork:", err);
    }
    return "";
  };

  async function copyTerminalOutputToClipboard(sessionId: string) {
    const content = await getScrollbackForSession(sessionId);
    if (!content) return false;
    await navigator.clipboard.writeText(content);
    return true;
  }

  async function forkSession(sourceId: string) {
    const source = sessions.find((entry) => entry.id === sourceId);
    if (!source) return;

    const scrollback = await getScrollbackForSession(sourceId);

    let resolvedDirectory: string | undefined;
    const sourcePtyId = ptyBySession()[sourceId];
    if (sourcePtyId) {
      try {
        const cwd = await invoke<string>("get_pty_cwd", { id: sourcePtyId });
        if (cwd && cwd.trim()) resolvedDirectory = cwd;
      } catch (err) {
        console.warn("Failed to resolve cwd for fork:", err);
      }
    }
    if (!resolvedDirectory) {
      const fallback = source.directory?.trim();
      if (fallback) resolvedDirectory = fallback;
    }

    const newId = createSession(
      undefined,
      source.command,
      resolvedDirectory,
      resolveForkTitle(source.title)
    );

    const sourceTags = terminalTags()[sourceId] || [];
    if (sourceTags.length > 0) {
      saveTerminalTags({ ...terminalTags(), [newId]: sourceTags });
    }

    const hostReady = await waitForTerminalHost(newId);
    if (!hostReady) return;

    const instance = await waitForTerminalInstance(newId);
    if (!instance) return;

    if (scrollback) {
      const payload = scrollback.endsWith("\n") ? scrollback : `${scrollback}\n`;
      instance.term.write(payload);
      setTimeout(() => updateSessionPreview(newId), 0);
      try {
        await invoke("db_save_scrollback", { sessionId: newId, content: scrollback });
      } catch (err) {
        console.error("Failed to save forked scrollback:", err);
      }
    }
  }

  const sendFooterInput = () => {
    const raw = footerInput();
    if (!raw.trim()) return;
    const preset = resolvedFooterPreset();
    if (!preset || !preset.command || !preset.command.trim()) return;
    const command = buildFooterCommand(preset.command, raw);
    void launchPresetSession(preset, command);
    setFooterInput("");
  };

  const upsertBrowserState = (state: BrowserSessionState) => {
    setBrowserSessions((prev) => ({ ...prev, [state.sessionId]: state }));
  };

  createEffect(() => {
    const states = Object.values(browserSessions());
    for (const state of states) {
      recordBrowserUrlVisit(state.profilePath, state.url);
    }
  });

  const activeBrowserOpen = createMemo(() => {
    if (appView() !== "terminal" || quickInputActive()) return false;
    const sessionId = activeSessionId();
    if (!sessionId) return false;
    return browserSessions()[sessionId]?.open ?? false;
  });
  const activeBrowserSessionId = createMemo(() => {
    const sessionId = activeSessionId();
    return sessionId && activeBrowserOpen() ? sessionId : null;
  });

  const openBrowserForSession = async (sessionId: string, url?: string) => {
    try {
      const state = await invoke<BrowserSessionState>("browser_open", {
        sessionId,
        url: url || null,
      });
      upsertBrowserState(state);
    } catch (err) {
      console.error(`Failed to open browser for session ${sessionId}:`, err);
    }
  };

  const closeBrowserForSession = async (sessionId: string) => {
    try {
      await invoke("browser_close", { sessionId });
      setBrowserSessions((prev) => ({
        ...prev,
        [sessionId]: {
          ...(prev[sessionId] || {
            sessionId,
            open: false,
            visible: false,
            loading: false,
            url: "",
            title: "",
            canGoBack: false,
            canGoForward: false,
          }),
          open: false,
          visible: false,
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      }));
    } catch (err) {
      console.error(`Failed to close browser for session ${sessionId}:`, err);
    }
  };

  const navigateBrowser = async (sessionId: string, url: string) => {
    try {
      const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const state = await invoke<BrowserSessionState>("browser_navigate", {
        sessionId,
        url: normalized,
      });
      upsertBrowserState(state);
    } catch (err) {
      console.error(`Failed to navigate browser for session ${sessionId}:`, err);
    }
  };

  const reloadBrowser = async (sessionId: string) => {
    try {
      const state = await invoke<BrowserSessionState>("browser_reload", { sessionId });
      upsertBrowserState(state);
    } catch (err) {
      console.error(`Failed to reload browser for session ${sessionId}:`, err);
    }
  };

  const goBackBrowser = async (sessionId: string) => {
    try {
      const state = await invoke<BrowserSessionState>("browser_go_back", { sessionId });
      upsertBrowserState(state);
    } catch (err) {
      console.error(`Failed to go back in browser for session ${sessionId}:`, err);
    }
  };

  const goForwardBrowser = async (sessionId: string) => {
    try {
      const state = await invoke<BrowserSessionState>("browser_go_forward", { sessionId });
      upsertBrowserState(state);
    } catch (err) {
      console.error(`Failed to go forward in browser for session ${sessionId}:`, err);
    }
  };

  const updateBrowserPaneBounds = async (sessionId: string, bounds: BrowserBounds) => {
    try {
      const state = await invoke<BrowserSessionState>("browser_set_bounds", { sessionId, bounds });
      upsertBrowserState(state);
      const visibleState = await invoke<BrowserSessionState>("browser_set_visible", {
        sessionId,
        visible: true,
      });
      upsertBrowserState(visibleState);
    } catch (err) {
      console.error(`Failed to update browser bounds for session ${sessionId}:`, err);
    }
  };

  const setBrowserVisibility = async (sessionId: string, visible: boolean) => {
    try {
      const state = await invoke<BrowserSessionState>("browser_set_visible", { sessionId, visible });
      upsertBrowserState(state);
    } catch (err) {
      console.error(`Failed to set browser visibility for session ${sessionId}:`, err);
    }
  };

  // Native browser webviews render above DOM. Hide them whenever a DOM overlay
  // opens so modals/palettes aren't occluded by the browser; restore when the
  // overlay closes.
  const anyOverlayOpen = createMemo(
    () =>
      showCommandPalette() ||
      showClipboardDrawer() ||
      showFileBrowser() ||
      scratchpadOpen() ||
      imageEditorOpen() ||
      showPresetEditor()
  );

  let suspendedBrowserIds: string[] = [];
  createEffect(() => {
    const overlayOpen = anyOverlayOpen();
    if (overlayOpen) {
      const visibleNow = Object.values(browserSessions())
        .filter((s) => s.open && s.visible)
        .map((s) => s.sessionId);
      if (visibleNow.length === 0) return;
      suspendedBrowserIds = visibleNow;
      for (const id of visibleNow) {
        void setBrowserVisibility(id, false);
      }
    } else {
      const toRestore = suspendedBrowserIds;
      suspendedBrowserIds = [];
      for (const id of toRestore) {
        void setBrowserVisibility(id, true);
      }
    }
  });

  const openBrowserInspector = async (sessionId: string) => {
    try {
      await invoke("browser_open_devtools", { sessionId });
    } catch (err) {
      console.error(`Failed to open browser inspector for session ${sessionId}:`, err);
    }
  };

  const closeBrowserInspector = async (sessionId: string) => {
    try {
      await invoke("browser_close_devtools", { sessionId });
    } catch (err) {
      console.error(`Failed to close browser inspector for session ${sessionId}:`, err);
    }
  };

  const getBrowserUrlSuggestions = (sessionId: string, query = "") => {
    const profilePath = browserSessions()[sessionId]?.profilePath ?? null;
    return getBrowserUrlHistory(profilePath, query);
  };

  const clearBrowserProfileState = async (sessionId: string) => {
    const profilePath = browserSessions()[sessionId]?.profilePath ?? null;
    try {
      await invoke("browser_clear_profile", { sessionId });
      clearBrowserUrlHistory(profilePath);
      await openBrowserForSession(sessionId);
    } catch (err) {
      console.error(`Failed to clear browser profile for session ${sessionId}:`, err);
      throw err;
    }
  };

  function createSession(
    preset?: TerminalPreset,
    commandOverride?: string,
    directoryOverride?: string,
    titleOverride?: string
  ): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    const title = titleOverride ?? (preset?.name || `Terminal ${sessions.length + 1}`);
    const directory = directoryOverride ?? preset?.directory;
    const command = commandOverride !== undefined ? commandOverride : preset?.command;
    const newSession: WebSession = {
      id,
      title,
      createdAt: now,
      directory: directory || undefined,
      command: command || undefined,
    };
    setSessions(sessions.length, newSession);
    setSessionSeenAt((prev) => ({ ...prev, [id]: now }));
    setActiveSessionId(id);

    // Persist to database
    void dbCreateSession(newSession);

    if (preset?.tags && preset.tags.length > 0) {
      saveTerminalTags({ ...terminalTags(), [id]: preset.tags });
    }
    // Add new session to tab history
    const history = tabHistory();
    const currentIndex = tabHistoryIndex();
    const newHistory = [...history.slice(0, currentIndex + 1), id].slice(-50);
    setTabHistory(newHistory);
    setTabHistoryIndex(newHistory.length - 1);
    return id;
  }

  const confirmRestoreSessions = () => {
    setRestorePromptOpen(false);
    setRestoreDecision("yes");
    const preferred = pendingRestoreActiveId();
    const fallback = sessions.length > 0 ? sessions[0].id : null;
    const nextActive =
      preferred && sessions.some((s) => s.id === preferred) ? preferred : fallback;
    if (nextActive) {
      setActiveSessionId(nextActive);
      setTabHistory([nextActive]);
      setTabHistoryIndex(0);
    }
  };

  const declineRestoreSessions = () => {
    setRestorePromptOpen(false);
    setRestoreDecision("no");
    createSession();
  };

  onMount(async () => {
    document.documentElement.spellcheck = false;
    document.body.spellcheck = false;

    // Request notification permission for agent completion alerts
    const notifGranted = await isPermissionGranted();
    console.log("[notif] permission granted:", notifGranted);
    if (!notifGranted) {
      const result = await requestPermission();
      console.log("[notif] permission request result:", result);
    }

    // Prevent browser's native drop behavior to avoid duplicate handling with Tauri
    const preventNativeDrop = (e: DragEvent) => e.preventDefault();
    document.addEventListener("dragover", preventNativeDrop);
    document.addEventListener("drop", preventNativeDrop);

    // Sidebar resize handlers
    const handleSidebarResize = (e: MouseEvent) => {
      if (!isResizingSidebar()) return;
      e.preventDefault();
      const newWidth = Math.max(200, Math.min(500, e.clientX));
      setSidebarWidth(newWidth);
    };
    const handleSidebarResizeEnd = () => {
      if (isResizingSidebar()) {
        setIsResizingSidebar(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    document.addEventListener("mousemove", handleSidebarResize);
    document.addEventListener("mouseup", handleSidebarResizeEnd);

    window.setTimeout(() => {
      void warmClipboard("startup");
    }, 400);

    const handlePaletteShortcut = (event: KeyboardEvent) => {
      const isK = event.key === "k" || event.key === "K";
      if (!isK || !event.metaKey) return;
      const requestedMode: "commands" | "switcher" = event.shiftKey ? "commands" : "switcher";
      event.preventDefault();
      event.stopPropagation();
      const isOpen = showCommandPalette();
      const sameMode = commandPaletteMode() === requestedMode;
      if (isOpen && sameMode) {
        setShowCommandPalette(false);
        return;
      }
      setCommandPaletteMode(requestedMode);
      setShowCommandPalette(true);
      setCommandQuery("");
      setCommandIndex(0);
      setSwitcherIndex(0);
    };
    window.addEventListener("keydown", handlePaletteShortcut, true); // capture phase

    const handleClipboardHistoryShortcut = (event: KeyboardEvent) => {
      const isCmdShiftV =
        (event.key === "v" || event.key === "V") && event.metaKey && event.shiftKey;
      if (!isCmdShiftV) return;
      event.preventDefault();
      event.stopPropagation();
      void toggleClipboardDrawer();
    };
    window.addEventListener("keydown", handleClipboardHistoryShortcut, true);

    const handleClipboardDrawerKeys = (event: KeyboardEvent) => {
      if (!showClipboardDrawer()) return;
      const list = filteredClipboardHistory();
      if (event.key === "Escape") {
        event.preventDefault();
        closeClipboardDrawer();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setClipboardHistoryIndex((prev) =>
          Math.min(prev + 1, Math.max(list.length - 1, 0))
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setClipboardHistoryIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void copyFromClipboardHistory();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === "a" || event.key === "A")) {
        event.preventDefault();
        selectAllClipboardHistory();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Backspace") {
        event.preventDefault();
        const idx = Math.max(0, Math.min(clipboardHistoryIndex(), list.length - 1));
        const entry = list[idx];
        if (entry) void deleteClipboardHistoryEntry(entry.id);
        return;
      }
    };
    window.addEventListener("keydown", handleClipboardDrawerKeys, true);

    const handleFileBrowserShortcut = (event: KeyboardEvent) => {
      const isCmdShiftE =
        (event.key === "e" || event.key === "E") && event.metaKey && event.shiftKey;
      if (!isCmdShiftE) return;
      event.preventDefault();
      event.stopPropagation();
      if (showFileBrowser()) {
        setShowFileBrowser(false);
      } else {
        void openFileBrowser();
      }
    };
    window.addEventListener("keydown", handleFileBrowserShortcut, true);

    const handleCcSearchShortcut = (event: KeyboardEvent) => {
      const isCmdShiftH =
        (event.key === "h" || event.key === "H") && event.metaKey && event.shiftKey;
      if (!isCmdShiftH) return;
      event.preventDefault();
      event.stopPropagation();
      if (showCcSearch()) {
        closeCcSearch();
      } else {
        openCcSearch();
      }
    };
    window.addEventListener("keydown", handleCcSearchShortcut, true);

    const handleSearchShortcut = (event: KeyboardEvent) => {
      const isFind =
        (event.key === "f" || event.key === "F") && (event.metaKey || event.ctrlKey);
      if (!isFind) return;
      if (activeWorkspaceTabKind() === "text_file") {
        event.preventDefault();
        event.stopPropagation();
        focusActiveFileTabFind();
        return;
      }
      if (activeWorkspaceTabKind() !== "terminal") return;
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
      focusSearchInput();
    };
    window.addEventListener("keydown", handleSearchShortcut, true); // capture phase

    const handleSaveShortcut = (event: KeyboardEvent) => {
      const isSave =
        (event.key === "s" || event.key === "S") && (event.metaKey || event.ctrlKey) && !event.shiftKey;
      if (!isSave) return;
      if (activeWorkspaceTabKind() !== "text_file") return;
      event.preventDefault();
      event.stopPropagation();
      void saveActiveTextFileTab();
    };
    window.addEventListener("keydown", handleSaveShortcut, true);

    const handleNewTerminalShortcut = (event: KeyboardEvent) => {
      const isCmdN = (event.key === "n" || event.key === "N") && event.metaKey && !event.shiftKey;
      if (!isCmdN) return;
      event.preventDefault();
      createSession();
    };
    window.addEventListener("keydown", handleNewTerminalShortcut);

    const handleCloseTerminalShortcut = (event: KeyboardEvent) => {
      // Cmd+W to close current terminal
      const isCmdW = (event.key === "w" || event.key === "W") && event.metaKey && !event.shiftKey;
      if (!isCmdW) return;
      event.preventDefault();
      const active = activeSessionId();
      const activeTab = activeWorkspaceFileTab();
      if (active && activeTab) {
        closeFileWorkspaceTab(active, activeTab.id);
      } else if (active) {
        void closeSession(active);
      }
    };
    window.addEventListener("keydown", handleCloseTerminalShortcut);

    const handleReopenTerminalShortcut = (event: KeyboardEvent) => {
      const isCmdShiftT =
        (event.key === "t" || event.key === "T") && event.metaKey && event.shiftKey;
      if (!isCmdShiftT) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      void reopenLastClosedSession();
    };
    window.addEventListener("keydown", handleReopenTerminalShortcut, true);

    const handleCmdBackspace = (event: KeyboardEvent) => {
      // Cmd+Backspace to delete to beginning of line (sends Ctrl+U)
      // If pressed again quickly (already at line start), send regular backspace
      const isCmdBackspace = event.key === "Backspace" && event.metaKey;
      if (!isCmdBackspace) return;
      if (activeWorkspaceTabKind() !== "terminal") return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const sessionId = activeSessionId();
      const ptyId = sessionId ? ptyBySession()[sessionId] : null;
      if (ptyId) {
        const now = Date.now();
        const isRepeat = now - lastCmdBackspaceAt < cmdBackspaceRepeatMs;
        lastCmdBackspaceAt = now;
        if (isRepeat) {
          // Already at line start, send regular backspace
          void invoke("pty_write", { id: ptyId, data: "\x7F" }); // DEL (backspace)
        } else {
          void invoke("pty_write", { id: ptyId, data: "\x15" }); // Ctrl+U
        }
      }
    };
    window.addEventListener("keydown", handleCmdBackspace, true); // capture phase

    // Note: Cmd+K previously cleared the terminal; it is now globally bound to
    // open the switcher palette (see handlePaletteShortcut above). Use the
    // command palette ("Clear Terminal Output") or the terminal's own escape
    // sequence if you need clearing.

    const handleCanvasZoomShortcut = (event: KeyboardEvent) => {
      if (!event.metaKey || appView() !== "canvas") return;
      if (isEditableTarget(event.target)) return;
      const isZoomIn =
        event.key === "+" ||
        event.key === "=" ||
        event.code === "NumpadAdd";
      const isZoomOut =
        event.key === "-" ||
        event.code === "NumpadSubtract";
      const isReset = event.key === "0";
      if (!isZoomIn && !isZoomOut && !isReset) return;
      event.preventDefault();
      event.stopPropagation();
      if (isZoomIn) {
        zoomInCanvas();
        return;
      }
      if (isZoomOut) {
        zoomOutCanvas();
        return;
      }
      setCanvasZoom(1);
    };
    window.addEventListener("keydown", handleCanvasZoomShortcut, true);

    const handleCanvasDeleteShortcut = (event: KeyboardEvent) => {
      if (appView() !== "canvas") return;
      if (isEditableTarget(event.target)) return;
      if (isWithinTerminalHost(event.target)) return;
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      const board = canvasBoard();
      const hasSelection =
        board.selectedObjectIds.length > 0 ||
        (typeof board.selectedObjectId === "string" && board.selectedObjectId.length > 0);
      if (!hasSelection) return;
      event.preventDefault();
      event.stopPropagation();
      removeSelectedCanvasObjects();
    };
    window.addEventListener("keydown", handleCanvasDeleteShortcut, true);

    const handleWindowFocus = () => {
      if (!clipboardWarm) {
        void warmClipboard("focus");
      }
      // Pick up any external file changes while the user was away.
      reloadAllOpenTextFilesFromDisk();
    };
    window.addEventListener("focus", handleWindowFocus);

    // Use Tauri's native window focus event to handle notification clicks
    const notifWindow = getCurrentWindow();
    const unlistenNotifFocus = await notifWindow.onFocusChanged(({ payload: focused }) => {
      if (focused && lastNotifiedSessionId) {
        console.log(`[notif] window focused, switching to session ${lastNotifiedSessionId}`);
        setActiveSessionId(lastNotifiedSessionId);
        lastNotifiedSessionId = null;
        // Force window to foreground — macOS notification clicks don't always raise the window
        notifWindow.show();
        notifWindow.setFocus();
      }
    });

    const handlePaste = (event: Event) => {
      void (async () => {
        console.log("[paste] event", event.type);
        if (!(event instanceof ClipboardEvent)) return;
        console.log("[paste] clipboard types", event.clipboardData?.types);
        if (isWithinTerminalHost(event.target)) {
          const sessionId = resolvePasteSessionId(event.target);
          console.log("[paste] terminal paste event", { sessionId });
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          if (sessionId && !shouldSuppressTerminalPaste(sessionId)) {
            markTerminalPasteHandled(sessionId);
            void handlePasteShortcutForSession(sessionId, "term-paste-event");
          } else {
            console.log("[paste] terminal paste event suppressed");
          }
          return;
        }
        if (isEditableTarget(event.target)) return;
        console.log("[paste] event target", {
          tag: (event.target as HTMLElement | null)?.tagName,
          className: (event.target as HTMLElement | null)?.className,
        });
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;
        console.log("[paste] files/items", {
          files: clipboardData.files.length,
          items: clipboardData.items.length,
        });
        const types = Array.from(clipboardData.types || []);
        const hasFilesType = types.includes("Files");
        const hasImageItem = Array.from(clipboardData.items).some((item) =>
          item.type.startsWith("image/")
        );
        const image = extractImageFromClipboard(clipboardData);
        console.log("[paste] image found", Boolean(image), image?.type);

        if (appView() === "canvas") {
          if (hasFilesType || hasImageItem || image) {
            event.preventDefault();
            event.stopPropagation();
            try {
              const path = await saveClipboardImageWithRetry();
              addCanvasImageFromClipboard(path);
            } catch (err) {
              console.warn("[paste] canvas save_clipboard_image failed", err);
            }
            return;
          }
          const fallbackText = clipboardData.getData("text/plain");
          if (!fallbackText) {
            const hasImage = await detectClipboardImage();
            if (hasImage) {
              try {
                const path = await saveClipboardImageWithRetry();
                addCanvasImageFromClipboard(path);
              } catch (err) {
                console.warn("[paste] canvas save_clipboard_image failed", err);
              }
            }
          }
          return;
        }

        const sessionId = resolvePasteSessionId(event.target);
        console.log("[paste] resolved session", sessionId);
        if (!sessionId) return;
        if (hasFilesType || hasImageItem || image) {
          event.preventDefault();
          event.stopPropagation();
          try {
            console.log("[paste] paste-event attempting save_clipboard_image");
            const path = await saveClipboardImageWithRetry();
            await writeImagePathToSession(sessionId, path, "paste-event");
          } catch (err) {
            console.warn("[paste] save_clipboard_image failed", err);
            await sendCtrlVToSession(sessionId, "paste-event");
          }
          return;
        }
        const fallbackText = clipboardData.getData("text/plain");
        if (!fallbackText) {
          const hasImage = await detectClipboardImage();
          console.log("[paste] paste-event detectClipboardImage", hasImage);
          if (hasImage) {
            try {
              console.log("[paste] paste-event attempting save_clipboard_image");
              const path = await saveClipboardImageWithRetry();
              await writeImagePathToSession(sessionId, path, "paste-event");
            } catch (err) {
              console.warn("[paste] save_clipboard_image failed", err);
              await sendCtrlVToSession(sessionId, "paste-event");
            }
          }
        }
      })();
    };
    document.addEventListener("paste", handlePaste, true);
    console.log("[paste] handler attached");

    const handleCopy = (event: Event) => {
      if (!(event instanceof ClipboardEvent)) return;
      void recordClipboardCopyEvent(event);
    };
    document.addEventListener("copy", handleCopy, true);

    const handlePasteShortcut = (event: KeyboardEvent) => {
      const isPaste =
        (event.key === "v" || event.key === "V") && (event.metaKey || event.ctrlKey);
      if (!isPaste) return;
      if (isWithinTerminalHost(event.target)) return;
      if (isEditableTarget(event.target)) return;
      if (appView() === "canvas") return;
      if (activeWorkspaceTabKind() !== "terminal") return;
      if (isTerminalActiveElement()) return;
      const active = activeSessionId();
      if (active && shouldSuppressTerminalPaste(active)) {
        console.log("[paste] shortcut suppressed (recent terminal paste)");
        return;
      }
      const sessionId = resolvePasteSessionId(event.target);
      if (!sessionId) return;
      console.log("[paste] shortcut", {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
      });
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void handlePasteShortcutForSession(sessionId, "shortcut");
    };
    window.addEventListener("keydown", handlePasteShortcut, true);

    const handleShiftEnter = (event: KeyboardEvent) => {
      if (!isShiftEnterEvent(event)) return;
      if (activeWorkspaceTabKind() !== "terminal") return;
      if (isEditableTarget(event.target)) return;
      // Let terminal's own handler deal with it to avoid double newlines
      if (isWithinTerminalHost(event.target)) return;
      const sessionId = resolvePasteSessionId(event.target);
      if (!sessionId) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void sendShiftEnterToSession(sessionId, "global-shift-enter");
    };
    window.addEventListener("keydown", handleShiftEnter, true);

    const handleBeforeInput = (event: InputEvent) => {
      if (event.inputType !== "insertFromPaste") return;
      if (isWithinTerminalHost(event.target)) return;
      if (isEditableTarget(event.target)) return;
      if (appView() === "canvas") return;
      if (activeWorkspaceTabKind() !== "terminal") return;
      const sessionId = resolvePasteSessionId(event.target);
      if (!sessionId) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void (async () => {
        const hasImage = await detectClipboardImage();
        if (hasImage) {
          try {
            const path = await invoke<string>("save_clipboard_image");
            await writeImagePathToSession(sessionId, path, "beforeinput");
          } catch (err) {
            console.warn("[paste] save_clipboard_image failed", err);
            await sendCtrlVToSession(sessionId, "beforeinput");
          }
        }
      })();
    };
    document.addEventListener("beforeinput", handleBeforeInput, true);

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (searchOpen()) {
        event.preventDefault();
        closeSearch();
        return;
      }
      if (quickInputActive()) {
        event.preventDefault();
        setQuickInputActive(false);
        return;
      }

      let handled = false;
      if (contextMenuFor() || sidebarContextMenu() || folderContextMenu() || canvasContextMenu() || filePathContextMenu() || fileTabContextMenu() || urlContextMenu()) {
        setContextMenuFor(null);
        setSidebarContextMenu(null);
        setFolderContextMenu(null);
        setCanvasContextMenu(null);
        setFilePathContextMenu(null);
        setFileTabContextMenu(null);
        setUrlContextMenu(null);
        handled = true;
      }

      if (appView() === "canvas" && canvasBoard().activeTool !== "select") {
        setCanvasTool("select");
        handled = true;
      }

      const board = canvasBoard();
      const hasCanvasSelection =
        board.selectedObjectIds.length > 0 ||
        (typeof board.selectedObjectId === "string" && board.selectedObjectId.length > 0);
      if (appView() === "canvas" && hasCanvasSelection) {
        setCanvasSelectedObjects([]);
        handled = true;
      }

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", handleEscapeKey);

    // Enter key to rename selected terminal (like Finder)
    const handleEnterRename = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (appView() === "canvas") return;
      if (activeWorkspaceTabKind() !== "terminal") return;
      // Don't trigger if already renaming or in an editable field
      if (renamingSessionId()) return;
      if (isEditableTarget(event.target)) return;
      // Don't trigger if inside terminal
      if (isWithinTerminalHost(event.target)) return;
      // Don't trigger if modifiers are pressed
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Need an active session to rename
      const activeId = activeSessionId();
      if (!activeId) return;
      event.preventDefault();
      openRename(activeId);
    };
    window.addEventListener("keydown", handleEnterRename);

    const handleQuickInputShortcut = (event: KeyboardEvent) => {
      // Cmd+Shift+M or F3 to toggle Quick Input view
      const isCmdShiftM =
        (event.key === "m" || event.key === "M") && event.metaKey && event.shiftKey;
      const isF3 = event.key === "F3";
      if (!isCmdShiftM && !isF3) return;
      event.preventDefault();
      event.stopPropagation();
      toggleQuickInputView();
    };
    window.addEventListener("keydown", handleQuickInputShortcut, true); // capture phase

    // Cmd+Shift+N to toggle Scratchpad
    const handleScratchpadShortcut = (event: KeyboardEvent) => {
      const isCmdShiftN =
        (event.key === "n" || event.key === "N") && event.metaKey && event.shiftKey;
      if (!isCmdShiftN) return;
      event.preventDefault();
      event.stopPropagation();
      setScratchpadOpen((prev) => !prev);
    };
    window.addEventListener("keydown", handleScratchpadShortcut, true);

    // Tab history navigation: Cmd+[ (back) and Cmd+] (forward)
    const handleTabHistoryNavigation = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      if (event.key === "[") {
        event.preventDefault();
        event.stopPropagation();
        navigateTabBack();
      } else if (event.key === "]") {
        event.preventDefault();
        event.stopPropagation();
        navigateTabForward();
      }
    };
    window.addEventListener("keydown", handleTabHistoryNavigation, true);

    // Load config from backend
    try {
      const config = await invoke<AppConfig>("get_config");
      setAppConfig(config);

      // Load presets from config
      if (config.presets?.items && Array.isArray(config.presets.items)) {
        const loadedPresets: TerminalPreset[] = config.presets.items.map((p) => ({
          id: p.id,
          name: p.name,
          directory: p.directory,
          command: p.command,
          tags: p.tags,
          footer: p.footer,
          worktree: p.worktree,
        }));
        setPresets(loadedPresets);
      }

      // Load tags from config
      if (config.tags?.list && Array.isArray(config.tags.list) && config.tags.list.length > 0) {
        setTags(config.tags.list);
      }
    } catch (err) {
      console.error("Failed to load config:", err);
    }
    // Migration from localStorage to SQLite (one-time)
    const migrationKey = "db-migration-v1";
    const hasMigrated = localStorage.getItem(migrationKey);

    if (!hasMigrated) {
      console.log("[migration] Starting localStorage -> SQLite migration");
      const savedSessions = localStorage.getItem("terminal-sessions");
      const savedTags = localStorage.getItem("terminal-tags");

      if (savedSessions) {
        try {
          const parsed = JSON.parse(savedSessions) as WebSession[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            for (const session of parsed) {
              await invoke("db_create_session", {
                req: {
                  id: session.id,
                  title: session.title,
                  directory: session.directory || null,
                  command: session.command || null,
                },
              }).catch((err) => console.warn(`[migration] Failed to migrate session ${session.id}:`, err));
            }
            console.log(`[migration] Migrated ${parsed.length} sessions`);
          }
        } catch (err) {
          console.error("[migration] Failed to parse sessions:", err);
        }
      }

      if (savedTags) {
        try {
          const parsed = JSON.parse(savedTags) as Record<string, string[]>;
          if (parsed && typeof parsed === "object") {
            for (const [sessionId, tags] of Object.entries(parsed)) {
              await invoke("db_set_session_tags", { sessionId, tags })
                .catch((err) => console.warn(`[migration] Failed to migrate tags for ${sessionId}:`, err));
            }
            console.log(`[migration] Migrated tags for ${Object.keys(parsed).length} sessions`);
          }
        } catch (err) {
          console.error("[migration] Failed to parse tags:", err);
        }
      }

      localStorage.setItem(migrationKey, "true");
      console.log("[migration] Migration complete");
    }
    setDbMigrated(true);

    await refreshRecentlyClosedSessions();

    // Sessions are no longer auto-restored on startup
    // Use "Restore Previous Sessions" from command palette to restore manually

    // Load tags from database
    try {
      const dbTags = await invoke<Record<string, string[]>>("db_get_all_session_tags");
      if (dbTags && Object.keys(dbTags).length > 0) {
        setTerminalTags(dbTags);
        // Keep localStorage in sync for backwards compatibility
        localStorage.setItem("terminal-tags", JSON.stringify(dbTags));
        console.log(`[tags] Loaded tags for ${Object.keys(dbTags).length} sessions from database`);
      }
    } catch (err) {
      console.error("Failed to load tags from DB:", err);
      // Fall back to localStorage
      const savedTerminalTags = localStorage.getItem("terminal-tags");
      if (savedTerminalTags) {
        const parsed = JSON.parse(savedTerminalTags) as Record<string, string[]>;
        if (parsed && typeof parsed === "object") {
          setTerminalTags(parsed);
        }
      }
    }

    // Restore collapsed folders state (still localStorage only - UI preference)
    const savedCollapsed = localStorage.getItem("collapsed-folders");
    if (savedCollapsed) {
      const parsed = JSON.parse(savedCollapsed) as string[];
      if (Array.isArray(parsed)) {
        setCollapsedFolders(new Set(parsed));
      }
    }

    // Restore session seen times (still localStorage - UI state)
    const savedSeenAt = localStorage.getItem("terminal-session-seen");
    if (savedSeenAt) {
      const parsed = JSON.parse(savedSeenAt) as Record<string, number>;
      if (parsed && typeof parsed === "object") {
        setSessionSeenAt(parsed);
      }
    }

    // Prompt before restoring previous sessions
    if (sessions.length === 0) {
      setRestoreDecision("no");
      createSession();
    } else {
      const savedActiveId = localStorage.getItem("terminal-active-session");
      const preferredId =
        savedActiveId && sessions.some((s) => s.id === savedActiveId)
          ? savedActiveId
          : sessions[0].id;
      setPendingRestoreActiveId(preferredId);
      if (preferredId) {
        setActiveSessionId(preferredId);
      }
      setRestoreDecision("pending");
      setRestorePromptOpen(true);
    }

    const unlisten = await listen<{ id: string; data: string }>(
      "pty-data",
      (event) => {
        const payload = event.payload;
        const sid = sessionByPty()[payload.id];
        const instance = terminalInstances.get(payload.id);
        if (instance) {
          if (sid) {
            instance.term.write(payload.data, () => updateSessionPreview(sid));
          } else {
            instance.term.write(payload.data);
          }
        }
        // Track last output timestamp per session
        if (sid) {
          setLastOutputAt((prev) => ({ ...prev, [sid]: Date.now() }));
          // Schedule scrollback save after PTY output
          scheduleScrollbackSave(sid);
        }
      }
    );

    const unlistenBrowser = await listen<BrowserSessionState>("browser-state", (event) => {
      const payload = event.payload;
      upsertBrowserState(payload);
    });

    const unlistenClipHistory = await listen<ClipboardHistoryEntry[]>(
      "clipboard-history-changed",
      (event) => {
        setClipboardHistory(event.payload);
      }
    );

    void refreshClipboardHistory();

    // File drag-and-drop handler - writes file paths to terminal
    // Native browser drop events are prevented above, so only Tauri events are processed
    const unlistenDragDrop = await listen<{ paths: string[]; position: { x: number; y: number } }>(
      "tauri://drag-drop",
      async (event) => {
        const { paths } = event.payload;
        if (!paths || paths.length === 0) return;

        const sessionId = activeSessionId();
        if (!sessionId) return;

        const ptyId = ptyBySession()[sessionId];
        if (!ptyId) return;

        // Escape paths for shell: quote paths with spaces/special chars
        const escapedPaths = paths.map((p) => {
          // If path contains spaces or shell special characters, quote it
          if (/[\s"'`$\\!#&*?()<>|;]/.test(p)) {
            // Escape single quotes and wrap in single quotes
            return "'" + p.replace(/'/g, "'\\''") + "'";
          }
          return p;
        });

        const pathString = escapedPaths.join(" ");
        console.log("[drag-drop] writing paths to terminal:", pathString);
        await invoke("pty_write", { id: ptyId, data: pathString });
      }
    );

    // Poll agent activity every 3 seconds via DB-backed hook events
    const appWindow = getCurrentWindow();
    const activityInterval = setInterval(async () => {
      const ptys = ptyBySession();
      const ptyIds = Object.values(ptys);
      if (ptyIds.length === 0) return;
      try {
        const [claudeResults, codexResults, agentSessionResults] = await Promise.all([
          invoke<{ id: string; state: string; since: number | null }[]>("get_claude_activity", {
            ids: ptyIds,
          }),
          invoke<{ id: string; state: string; since: number | null }[]>("get_codex_activity", {
            ids: ptyIds,
          }),
          invoke<{ id: string; session_id: string | null }[]>("get_agent_session_ids", {
            ids: ptyIds,
          }),
        ]);
        const lookup = sessionByPty();
        const claudeStates: Record<string, string> = {};
        for (const r of claudeResults) {
          const sid = lookup[r.id];
          if (sid) claudeStates[sid] = r.state;
        }
        const codexStates: Record<string, string> = {};
        for (const r of codexResults) {
          const sid = lookup[r.id];
          if (sid) codexStates[sid] = r.state;
        }
        const agentSessionIds: Record<string, string> = {};
        for (const r of agentSessionResults) {
          const sid = lookup[r.id];
          if (sid && r.session_id) agentSessionIds[sid] = r.session_id;
        }

        // Detect working → idle transitions and send notifications
        const focused = await appWindow.isFocused();
        for (const sid of Object.keys(claudeStates)) {
          const prev = prevClaudeState[sid];
          const curr = claudeStates[sid];
          if (prev !== curr) {
            console.log(
              `[notif] Claude state change sid=${sid}: ${prev} → ${curr} (focused=${focused})`
            );
          }
          if (prev === "working" && curr === "idle") {
            if (focused) {
              console.log("[notif] skipping notification — window is focused");
            } else {
              const session = sessions.find((s) => s.id === sid);
              const sessionName = session?.title || "Terminal";
              console.log(`[notif] sending Claude notification for "${sessionName}" (sid=${sid})`);
              lastNotifiedSessionId = sid;
              sendNotification({
                title: "Claude Code finished",
                body: sessionName,
              });
            }
          }
        }
        for (const sid of Object.keys(codexStates)) {
          const prev = prevCodexState[sid];
          const curr = codexStates[sid];
          if (prev !== curr) {
            console.log(
              `[notif] Codex state change sid=${sid}: ${prev} → ${curr} (focused=${focused})`
            );
          }
          if (prev === "working" && curr === "idle") {
            if (focused) {
              console.log("[notif] skipping notification — window is focused");
            } else {
              const session = sessions.find((s) => s.id === sid);
              const sessionName = session?.title || "Terminal";
              console.log(`[notif] sending Codex notification for "${sessionName}" (sid=${sid})`);
              lastNotifiedSessionId = sid;
              sendNotification({
                title: "Codex finished",
                body: sessionName,
              });
            }
          }
        }

        prevClaudeState = { ...claudeStates };
        prevCodexState = { ...codexStates };

        setClaudeState(claudeStates);
        setCodexState(codexStates);
        setAgentSessionIdBySession((prev) => ({ ...prev, ...agentSessionIds }));
        maybeApplyAgentAutoTitles(agentSessionIds);
      } catch {
        // ignore polling errors
      }
    }, 3000);

    // Tick idle display every 3 seconds (matches activity poll cadence)
    const idleInterval = setInterval(() => {
      setIdleTick((n) => n + 1);
    }, 3000);

    // Poll for external file changes every 500ms. Stats are cheap; content
    // is only re-read when mtime/size changes.
    const filePollInterval = setInterval(() => {
      void pollOpenFilesForExternalChanges();
    }, 500);

    const handleResize = () => {
      if (appView() === "canvas") {
        const terminalObjects = canvasBoard().objects.filter(
          (obj): obj is Extract<CanvasObject, { type: "terminal" }> => obj.type === "terminal"
        );
        for (const item of terminalObjects) {
          fitTerminalSession(item.sessionId);
        }
        return;
      }
      const activeId = activeSessionId();
      if (activeId) {
        terminalInstances.get(activeId)?.fit.fit();
        void updatePtySize(activeId);
      }
    };
    window.addEventListener("resize", handleResize);

    // Save scrollback on visibility change (minimize/tab switch)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        console.log("[scrollback] Visibility hidden, saving all scrollback");
        void saveAllScrollback();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Listen for window close to save scrollback
    const unlistenCloseRequest = await getCurrentWindow().onCloseRequested(async (_event) => {
      console.log("[scrollback] Window close requested, saving all scrollback");
      await saveAllScrollback();
    });

    onCleanup(() => {
      recorderShuttingDown = true;
      if (recorderInstance && recorderInstance.state !== "inactive") {
        try {
          recorderInstance.stop();
        } catch {
          // Ignore recorder shutdown errors during app teardown.
        }
      }
      clearRecorderResources();
      clearInterval(activityInterval);
      clearInterval(idleInterval);
      clearInterval(filePollInterval);
      // Clear all scrollback save timers
      for (const timer of scrollbackTimers.values()) {
        clearTimeout(timer);
      }
      scrollbackTimers.clear();
      document.removeEventListener("dragover", preventNativeDrop);
      document.removeEventListener("drop", preventNativeDrop);
      document.removeEventListener("mousemove", handleSidebarResize);
      document.removeEventListener("mouseup", handleSidebarResizeEnd);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handlePaletteShortcut, true);
      window.removeEventListener("keydown", handleClipboardHistoryShortcut, true);
      window.removeEventListener("keydown", handleClipboardDrawerKeys, true);
      window.removeEventListener("keydown", handleFileBrowserShortcut, true);
      window.removeEventListener("keydown", handleCcSearchShortcut, true);
      window.removeEventListener("keydown", handleSearchShortcut, true);
      window.removeEventListener("keydown", handleSaveShortcut, true);
      window.removeEventListener("keydown", handleNewTerminalShortcut);
      window.removeEventListener("keydown", handleCloseTerminalShortcut);
      window.removeEventListener("keydown", handleReopenTerminalShortcut, true);
      window.removeEventListener("keydown", handleCmdBackspace, true);
      window.removeEventListener("keydown", handleCanvasZoomShortcut, true);
      window.removeEventListener("keydown", handleCanvasDeleteShortcut, true);
      window.removeEventListener("keydown", handlePasteShortcut, true);
      window.removeEventListener("keydown", handleShiftEnter, true);
      window.removeEventListener("keydown", handleEscapeKey);
      window.removeEventListener("keydown", handleEnterRename);
      window.removeEventListener("keydown", handleQuickInputShortcut, true);
      window.removeEventListener("keydown", handleScratchpadShortcut, true);
      window.removeEventListener("keydown", handleTabHistoryNavigation, true);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("paste", handlePaste, true);
      document.removeEventListener("copy", handleCopy, true);
      document.removeEventListener("beforeinput", handleBeforeInput, true);
      void unlisten();
      void unlistenBrowser();
      void unlistenClipHistory();
      void unlistenDragDrop();
      unlistenCloseRequest();
      unlistenNotifFocus();
      const ptys = ptyBySession();
      for (const ptyId of Object.values(ptys)) {
        void invoke("pty_close", { id: ptyId });
      }
      for (const sessionId of Object.keys(browserSessions())) {
        void invoke("browser_close", { sessionId });
      }
      terminalHostCleanup.forEach((cleanup) => cleanup());
      terminalHostCleanup.clear();
      terminalInstances.forEach(({ term, fit }) => {
        term.dispose?.();
        fit.dispose?.();
      });
    });
  });

  type ConfirmDialogState = {
    id: string;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    destructive: boolean;
    resolve: (value: boolean) => void;
  };

  const [confirmDialog, setConfirmDialog] = createSignal<ConfirmDialogState | null>(null);

  const askConfirm = (opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  }): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmDialog({
        id: crypto.randomUUID(),
        title: opts.title,
        message: opts.message,
        confirmLabel: opts.confirmLabel ?? "Confirm",
        cancelLabel: opts.cancelLabel ?? "Cancel",
        destructive: opts.destructive ?? false,
        resolve,
      });
    });
  };

  const resolveConfirmDialog = (value: boolean) => {
    const current = confirmDialog();
    if (!current) return;
    setConfirmDialog(null);
    current.resolve(value);
  };

  return {
    sessions,
    setSessions,
    recentlyClosedSessions,
    activeSessionId,
    setActiveSessionId,
    tags,
    setTags,
    pasteQueue,
    setPasteQueue,
    pasteHover,
    setPasteHover,
    safePasteHover,
    recordingState,
    recordingStartedAt,
    recordingError,
    lastRecording,
    selectedTags,
    setSelectedTags,
    showUntagged,
    setShowUntagged,
    sidebarSessionView,
    terminalTags,
    setTerminalTags,
    tagMenuOpenFor,
    setTagMenuOpenFor,
    newTagName,
    setNewTagName,
    sessionSeenAt,
    setSessionSeenAt,
    ptyBySession,
    setPtyBySession,
    browserSessions,
    fileTabsBySession,
    pinnedFileTabs,
    activeWorkspaceFileTab,
    activeWorkspaceTabKind,
    activeSessionFileTabs,
    activeBrowserOpen,
    activeBrowserSessionId,
    sessionPreview,
    setSessionPreview,
    sessionInputDraft,
    setSessionInputDraft,
    agentSessionIdBySession,
    lastAgentTurn,
    refreshLastAgentTurnsForActiveSessions,
    claudeState,
    setClaudeState,
    codexState,
    setCodexState,
    idleTick,
    setIdleTick,
    presets,
    setPresets,
    appConfig,
    setAppConfig,
    restorePromptOpen,
    setRestorePromptOpen,
    restoreDecision,
    setRestoreDecision,
    pendingRestoreActiveId,
    setPendingRestoreActiveId,
    showPresetEditor,
    setShowPresetEditor,
    editingPreset,
    setEditingPreset,
    newPresetTagName,
    setNewPresetTagName,
    showPresetMenu,
    setShowPresetMenu,
    footerPresetMenuOpen,
    setFooterPresetMenuOpen,
    footerPresetId,
    setFooterPresetId,
    footerInput,
    setFooterInput,
    showFilterMenu,
    setShowFilterMenu,
    appView,
    setAppView: setAppViewMode,
    showCommandPalette,
    setShowCommandPalette,
    commandPaletteMode,
    setCommandPaletteMode,
    switcherIndex,
    setSwitcherIndex,
    showClipboardDrawer,
    setShowClipboardDrawer,
    clipboardHistory,
    clipboardHistoryQuery,
    setClipboardHistoryQuery,
    clipboardHistoryIndex,
    setClipboardHistoryIndex,
    clipboardHistorySelected,
    filteredClipboardHistory,
    toggleClipboardHistorySelection,
    selectAllClipboardHistory,
    deleteClipboardHistoryEntry,
    clearClipboardHistory,
    copyFromClipboardHistory,
    openClipboardDrawer,
    closeClipboardDrawer,
    toggleClipboardDrawer,
    refreshClipboardHistory,
    setClipboardHistoryInputRef: (el: HTMLInputElement | undefined) => {
      clipboardHistoryInputRef = el;
    },
    canvasBoard,
    setCanvasBoard,
    scratchpadOpen,
    setScratchpadOpen,
    imageEditorOpen,
    setImageEditorOpen,
    imageEditorPath,
    setImageEditorPath,
    imageEditorName,
    setImageEditorName,
    commandQuery,
    setCommandQuery,
    commandIndex,
    setCommandIndex,
    draggingSessionId,
    setDraggingSessionId,
    dragOverSessionId,
    setDragOverSessionId,
    renamingSessionId,
    setRenamingSessionId,
    renameValue,
    setRenameValue,
    contextMenuFor,
    setContextMenuFor,
    sidebarContextMenu,
    setSidebarContextMenu,
    canvasContextMenu,
    setCanvasContextMenu,
    sidebarWidth,
    setSidebarWidth,
    sidebarHidden,
    setSidebarHidden,
    isResizingSidebar,
    setIsResizingSidebar,
    quickInputActive,
    setQuickInputActive,
    quickViewMode,
    quickViewSelectedTags,
    quickViewShowUntagged,
    quickViewIdleOnly,
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchFeedback,
    setSearchFeedback,
    collapsedFolders,
    setCollapsedFolders,
    dragOverFolder,
    setDragOverFolder,
    folderContextMenu,
    setFolderContextMenu,
    filePathContextMenu,
    setFilePathContextMenu,
    fileTabContextMenu,
    setFileTabContextMenu,
    openFileTabContextMenu,
    fileTabMenuClose,
    fileTabMenuTogglePin,
    fileTabMenuCopyPath,
    fileTabMenuCopyRelative,
    fileTabMenuOpenDefault,
    fileTabMenuOpenInVSCode,
    fileTabMenuRevealInFinder,
    fileTabMenuBrowse,
    fileTabMenuReloadFromDisk,
    urlContextMenu,
    setUrlContextMenu,
    urlMenuOpen,
    urlMenuCopy,
    filePathMenuOpenDefault,
    filePathMenuOpenInVSCode,
    filePathMenuRevealInFinder,
    filePathMenuCopyPath,
    filePathMenuCopyRelative,
    filePathMenuBrowse,
    filePathMenuOpenInButter,
    tabHistory,
    setTabHistory,
    tabHistoryIndex,
    setTabHistoryIndex,
    showFileBrowser,
    setShowFileBrowser,
    fileBrowserPath,
    setFileBrowserPath,
    fileBrowserQuery,
    setFileBrowserQuery,
    fileBrowserEntries,
    setFileBrowserEntries,
    fileBrowserSearchResults,
    setFileBrowserSearchResults,
    fileBrowserIndex,
    setFileBrowserIndex,
    fileBrowserLoading,
    setFileBrowserLoading,
    fileBrowserSearching,
    setFileBrowserSearching,
    showHiddenFiles,
    setShowHiddenFiles,
    fileBrowserActionEntry,
    setFileBrowserActionEntry,
    fileBrowserActionIndex,
    setFileBrowserActionIndex,
    fileBrowserActions,
    showCcSearch,
    setShowCcSearch,
    ccSearchQuery,
    ccSearchResults,
    ccSearchIndex,
    setCcSearchIndex,
    ccSearchLoading,
    ccSearchError,
    ccSearchMeta,
    setCcSearchInputRef,
    updateCcSearchQuery,
    openCcSearch,
    closeCcSearch,
    runCcSearch,
    resumeCcSearchResult,
    copyCcResumeCommand,
    copyCcMatch,
    copyCcThread,
    openCcSessionFile,
    activeFilterCount,
    footerPresets,
    shouldShowFooterPresetMenu,
    resolvedFooterPreset,
    footerInputEnabled,
    footerPlaceholder,
    tagQuery,
    matchingTags,
    hasExactTagMatch,
    commands,
    filteredCommands,
    filteredFileBrowserEntries,
    filteredSessionIds,
    recentSessionIds,
    inboxSessionIds,
    dismissFromInbox,
    quickViewSessionIds,
    sessionByPty,
    sessionFolders,
    registerTerminalHost,
    registerFileTabFindHandler,
    registerQuickInputRef,
    setRenameInputRef,
    setSearchInputRef,
    setCommandInputRef,
    setFileBrowserInputRef,
    focusTerminal,
    focusSearchInput,
    closeSearch,
    runSearch,
    formatSize,
    openPresetEditor,
    closePresetEditor,
    savePreset,
    deletePreset,
    toggleTagForPreset,
    createTagAndAssignToPreset,
    confirmRestoreSessions,
    declineRestoreSessions,
    selectSession,
    navigateTabBack,
    navigateTabForward,
    toggleQuickInputView,
    hideSidebar,
    showSidebar,
    toggleSidebarVisibility,
    exitQuickInputToSession,
    sendQuickInputToSession,
    updateSessionTitle,
    openRename,
    reorderSessions,
    beginPointerDrag,
    closeRename,
    clearTerminalForSession,
    closeSession,
    confirmDialog,
    askConfirm,
    resolveConfirmDialog,
    closeOtherSessions,
    closeAllSessions,
    reopenClosedSession,
    reopenLastClosedSession,
    refreshRecentlyClosedSessions,
    updatePtySize,
    ensureTerminal,
    maybeEnsureTerminal,
    openFileBrowser,
    loadDirectory,
    navigateToParent,
    debouncedSearch,
    activateFileBrowserEntry,
    openFileBrowserEntry,
    openFileInButter,
    openFileBrowserEntryInCanvas,
    copyFileBrowserEntry,
    copyFileBrowserDirectory,
    canOpenPathInButter,
    selectTerminalWorkspaceTab,
    selectFileWorkspaceTab,
    closeFileWorkspaceTab,
    pinFileTab,
    unpinFileTab,
    updateTextFileTabContent,
    saveActiveTextFileTab,
    isMarkdownTab,
    getMarkdownViewMode,
    setMarkdownViewMode,
    toggleMarkdownViewMode,
    exportActiveMarkdownAsPdf,
    setCanvasTool,
    selectCanvasObject,
    setCanvasSelectedObjects,
    updateCanvasObjectBounds,
    updateCanvasTextObject,
    removeCanvasObject,
    removeSelectedCanvasObjects,
    addCanvasTextObject,
    addCanvasStroke,
    clearCanvasStrokes,
    addCanvasImageObject,
    addCanvasImageFromClipboard,
    addCanvasFileObject,
    addCanvasTerminalObject,
    fitTerminalSession,
    openBrowserForSession,
    closeBrowserForSession,
    navigateBrowser,
    reloadBrowser,
    goBackBrowser,
    goForwardBrowser,
    updateBrowserPaneBounds,
    setBrowserVisibility,
    openBrowserInspector,
    closeBrowserInspector,
    getBrowserUrlSuggestions,
    clearBrowserProfileState,
    setCanvasZoom,
    zoomInCanvas,
    zoomOutCanvas,
    setFooterPresetSelection,
    sendFooterInput,
    launchPresetSession,
    forkSession,
    copyTerminalOutputToClipboard,
    createSession,
    toggleFolderCollapse,
    setSidebarSessionViewMode,
    toggleSidebarSessionView,
    saveTags,
    saveTerminalTags,
    toggleTagFilter,
    clearFilters,
    toggleUntaggedFilter,
    toggleQuickViewTag,
    clearQuickViewFilters,
    toggleQuickViewUntagged,
    toggleQuickViewIdleOnly,
    setQuickViewMode,
    toggleTagForTerminal,
    addTagToTerminal,
    createTagAndAssign,
    getSessionState,
    showPasteHover,
    setPasteHoverPosition,
    writeImagePathToSession,
    refreshPasteQueueItem,
    openImageEditor,
    closeImageEditor,
    copyPathToClipboard,
    openPathExternally,
    startScreenRecording,
    stopScreenRecording,
  };
}
