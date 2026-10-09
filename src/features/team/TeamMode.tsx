import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Command, open as openExternal } from "@tauri-apps/plugin-shell";
import { useAppContext } from "../../app/context/AppContext";
import { PaletteDialog, type PaletteItem } from "../overlays/CommandPalette";
import { extractImageFromClipboard, inferImageMimeType } from "../../utils/clipboard";
import { renderMarkdownToSafeHtml } from "../../utils/markdown";
import type {
  FileBrowserEntry,
  TeamAgentRun,
  TeamChannel,
  TeamConversation,
  TeamInboxItem,
  TeamMessage,
  TeamPin,
  TeamPinKind,
  TeamSearchResult,
  TeamUser,
} from "../../app/types";

interface PtyOutput {
  id: string;
  data: string;
}

interface RunningRun {
  run: TeamAgentRun;
  user: TeamUser;
  parentMessageId: string;
  conversationId: string;
  agentKind: TeamAgentKind | null;
  resumeAgentSessionId: string | null;
  buffer: string;
}

interface AgentSessionActivity {
  id: string;
  session_id: string | null;
}

type TeamSelection = { kind: "inbox" } | { kind: "conversation"; conversationId: string };
type MessageMenuState = { messageId: string; x: number; y: number };
type TeamAgentKind = "claude" | "codex";
type TeamCreateModal = "channel" | "agent";
type TeamInboxMode = "unread" | "recent";
type TeamComposerId = "main" | "thread";
type TeamComposerTrigger = "@" | "/";
type TeamComposerMenuMode = "mention" | "skill";
type TeamComposerMenuState = {
  composerId: TeamComposerId;
  mode: TeamComposerMenuMode;
  trigger: TeamComposerTrigger;
  query: string;
  start: number;
  end: number;
  activeIndex: number;
};
type TeamComposerSuggestion =
  | {
      kind: "user";
      id: string;
      label: string;
      detail: string;
      avatarLabel: string;
      avatarColor: string | null;
      insertText: string;
    }
  | {
      kind: "file";
      id: string;
      label: string;
      detail: string;
      insertText: string;
    }
  | {
      kind: "skill";
      id: string;
      label: string;
      detail: string;
      insertText: string;
    };
type TeamSkillSuggestion = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  path: string;
};
type TeamPinInput = {
  id: string | null;
  kind: TeamPinKind;
  title: string | null;
  file_path: string | null;
  url: string | null;
  message_id: string | null;
};
type TeamSearchItem = PaletteItem & {
  result: TeamSearchResult;
};

const DONE_MARKER_PREFIX = "__BUTTER_TEAM_RUN_DONE__:";
const TEAM_RUN_STALE_SECONDS = 60 * 60;
const TEAM_RAIL_WIDTH_STORAGE_KEY = "butter.team-rail-width";
const DEFAULT_TEAM_RAIL_WIDTH = 260;
const MIN_TEAM_RAIL_WIDTH = 220;
const MAX_TEAM_RAIL_WIDTH = 420;
const TEAM_SIDE_WIDTH_STORAGE_KEY = "butter.team-side-width";
const DEFAULT_TEAM_SIDE_WIDTH = 360;
const MIN_TEAM_SIDE_WIDTH = 300;
const MAX_TEAM_SIDE_WIDTH = 760;
const THREAD_CONTEXT_MAX_MESSAGES = 16;
const THREAD_CONTEXT_MESSAGE_MAX_CHARS = 2400;
const DEFAULT_TEAM_AGENT_CMD = 'claude -p "{user_msg}"';
const TEAM_MESSAGE_MAX_CHARS = 40_000;
const TEAM_MESSAGE_WARN_CHARS = 36_000;
const TEAM_NOTE_PASTE_THRESHOLD_CHARS = 4_000;
const TEAM_COMPOSER_MENU_LIMIT = 10;
const TEAM_COMPOSER_FILE_LIMIT = 7;
const TEAM_SKILL_SEARCH_ROOTS = ["..", "/Users/mritchie712/mike3", "~/.claude/skills", "~/.codex/skills"];
const TEAM_FILE_EXTENSIONS = new Set([
  "md",
  "mdx",
  "markdown",
  "html",
  "htm",
  "txt",
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "yaml",
  "yml",
  "toml",
  "rs",
  "py",
  "sh",
]);

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\"'\"'")}'`;

const stripAnsi = (value: string) =>
  value.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    "",
  );

const formatClock = (timestampSeconds: number) => {
  const date = new Date(timestampSeconds * 1000);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

const compactText = (value: string, max = 140) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
};

const messageCharCount = (value: string) => Array.from(value).length;

const truncatePromptText = (value: string, max = THREAD_CONTEXT_MESSAGE_MAX_CHARS) =>
  value.length > max ? `${value.slice(0, max - 3).trimEnd()}...` : value;

const looksLikeUrl = (value: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

const basename = (path: string) => path.trim().replace(/\/+$/, "").split("/").pop() || path;

const dirname = (path: string) => {
  const normalized = path.trim().replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
};

const fileExtension = (path: string) => {
  const name = basename(path);
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
  return name.slice(dotIndex + 1).toLowerCase();
};

const isTeamSuggestibleFile = (path: string) => {
  const extension = fileExtension(path);
  return !extension || TEAM_FILE_EXTENSIONS.has(extension);
};

const normalizeSuggestionText = (value: string) => value.trim().toLowerCase();

const matchesSuggestionQuery = (query: string, ...values: string[]) => {
  const normalized = normalizeSuggestionText(query).replace(/^\/+/, "");
  if (!normalized) return true;
  return values.some((value) => value.toLowerCase().includes(normalized));
};

const markdownLinkForFile = (path: string, label = basename(path)) => {
  const safeLabel = label.replace(/]/g, "\\]");
  const safeHref = /[\s()<>]/.test(path)
    ? `<${path.replace(/>/g, "%3E")}>`
    : path.replace(/\)/g, "%29");
  return `[${safeLabel}](${safeHref}) `;
};

const detectComposerTrigger = (value: string, cursor: number) => {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(^|[\s([{,;:])([/@])([^\s]*)$/);
  if (!match) return null;
  const trigger = match[2] as TeamComposerTrigger;
  const query = match[3] || "";
  const start = beforeCursor.length - trigger.length - query.length;
  return {
    trigger,
    mode: trigger === "/" ? ("skill" as const) : ("mention" as const),
    query,
    start,
    end: cursor,
  };
};

const skillNameFromPath = (path: string) => {
  const parent = basename(dirname(path));
  if (parent && parent !== "." && parent !== "..") return parent;
  return basename(path).replace(/\.[^.]+$/, "");
};

const parseSkillMarkdown = (path: string, content: string): TeamSkillSuggestion => {
  const frontMatterName = content.match(/^---[\s\S]*?\nname:\s*["']?([^"'\n]+)["']?[\s\S]*?\n---/);
  const frontMatterDescription = content.match(
    /^---[\s\S]*?\ndescription:\s*["']?([^"'\n]+)["']?[\s\S]*?\n---/,
  );
  const heading = content.match(/^#\s+(.+)$/m);
  const firstParagraph = content
    .replace(/^---[\s\S]*?\n---/, "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("#") && !part.startsWith("```"));
  const rawName = (frontMatterName?.[1] || skillNameFromPath(path)).trim();
  const displayName = (heading?.[1] || rawName).trim();
  return {
    id: path,
    name: rawName.replace(/\s+/g, "-").toLowerCase(),
    displayName,
    description: (frontMatterDescription?.[1] || firstParagraph || path).replace(/\s+/g, " ").trim(),
    path,
  };
};

const inferAgentKind = (command: string): TeamAgentKind | null => {
  if (/(^|[\s;&|()])claude(\s|$)/.test(command)) return "claude";
  if (/(^|[\s;&|()])codex(\s|$)/.test(command)) return "codex";
  return null;
};

const withClaudeResume = (command: string, sessionId: string | null) => {
  if (!sessionId || /\s--resume(?:\s|=|$)/.test(` ${command}`) || /\s-r(?:\s|=|$)/.test(` ${command}`)) {
    return command;
  }
  return command.replace(/^(\s*)claude(\s*)/, `$1claude --resume ${shellQuote(sessionId)}$2`);
};

const withCodexResume = (command: string, sessionId: string | null) => {
  if (!sessionId || /^(\s*)codex\s+(?:exec|e)\s+resume(?:\s|$)/.test(command) || /^(\s*)codex\s+resume(?:\s|$)/.test(command)) {
    return command;
  }
  const execMatch = command.match(/^(\s*)codex\s+(exec|e)(?:\s+([\s\S]*))?$/);
  if (execMatch) {
    const [, leading, subcommand, rest = ""] = execMatch;
    return `${leading}codex ${subcommand} resume ${shellQuote(sessionId)}${rest.trim() ? ` ${rest.trim()}` : ""}`;
  }
  const codexMatch = command.match(/^(\s*)codex(?:\s+([\s\S]*))?$/);
  if (codexMatch) {
    const [, leading, rest = ""] = codexMatch;
    return `${leading}codex resume ${shellQuote(sessionId)}${rest.trim() ? ` ${rest.trim()}` : ""}`;
  }
  return command;
};

const codexLastMessagePath = (runId: string) => `/tmp/butter-team-${runId}-last-message.txt`;

const codexRawOutputPath = (runId: string) => `/tmp/butter-team-${runId}-raw-output.txt`;

const withCodexLastMessageOutput = (command: string, runId: string) => {
  if (!/^(\s*)codex\s+(?:exec|e)(?:\s|$)/.test(command)) return command;
  if (/\s(?:-o|--output-last-message)(?:\s|=|$)/.test(` ${command}`)) return command;

  const lastMessagePath = codexLastMessagePath(runId);
  const rawOutputPath = codexRawOutputPath(runId);
  const commandWithOutput = command.replace(
    /^(\s*)codex\s+(exec|e)(\s*)/,
    `$1codex $2 --output-last-message ${shellQuote(lastMessagePath)}$3`,
  );

  return [
    `__butter_team_codex_raw=${shellQuote(rawOutputPath)}`,
    `${commandWithOutput} > "$__butter_team_codex_raw" 2>&1`,
    "__butter_team_codex_status=$?",
    `if [ -s ${shellQuote(lastMessagePath)} ]; then cat ${shellQuote(lastMessagePath)}; else cat "$__butter_team_codex_raw"; fi`,
    `rm -f ${shellQuote(lastMessagePath)} "$__butter_team_codex_raw"`,
    '(exit "$__butter_team_codex_status")',
  ].join("; ");
};

const withAgentResume = (
  command: string,
  agentKind: TeamAgentKind | null,
  sessionId: string | null,
) => {
  if (agentKind === "claude") return withClaudeResume(command, sessionId);
  if (agentKind === "codex") return withCodexResume(command, sessionId);
  return command;
};

export function TeamMode() {
  const app = useAppContext();
  const [users, setUsers] = createSignal<TeamUser[]>([]);
  const [channels, setChannels] = createSignal<TeamChannel[]>([]);
  const [conversations, setConversations] = createSignal<TeamConversation[]>([]);
  const [messages, setMessages] = createSignal<TeamMessage[]>([]);
  const [threadMessages, setThreadMessages] = createSignal<TeamMessage[]>([]);
  const [inbox, setInbox] = createSignal<TeamInboxItem[]>([]);
  const [runs, setRuns] = createSignal<TeamAgentRun[]>([]);
  const [pins, setPins] = createSignal<TeamPin[]>([]);
  const [skills, setSkills] = createSignal<TeamSkillSuggestion[]>([]);
  const [fileSearchResults, setFileSearchResults] = createSignal<FileBrowserEntry[]>([]);
  const [selection, setSelection] = createSignal<TeamSelection>({ kind: "inbox" });
  const [inboxMode, setInboxMode] = createSignal<TeamInboxMode>("unread");
  const [teamSearchOpen, setTeamSearchOpen] = createSignal(false);
  const [teamSearchQuery, setTeamSearchQuery] = createSignal("");
  const [teamSearchIndex, setTeamSearchIndex] = createSignal(0);
  const [teamSearchResults, setTeamSearchResults] = createSignal<TeamSearchResult[]>([]);
  const [teamSearchLoading, setTeamSearchLoading] = createSignal(false);
  const [teamSearchError, setTeamSearchError] = createSignal<string | null>(null);
  const [teamSearchAdvanced, setTeamSearchAdvanced] = createSignal(false);
  const [selectedThreadParentId, setSelectedThreadParentId] = createSignal<string | null>(null);
  const [composerText, setComposerText] = createSignal("");
  const [threadComposerText, setThreadComposerText] = createSignal("");
  const [channelName, setChannelName] = createSignal("");
  const [pinTarget, setPinTarget] = createSignal("");
  const [newAgentUsername, setNewAgentUsername] = createSignal("");
  const [newAgentDisplayName, setNewAgentDisplayName] = createSignal("");
  const [newAgentPwd, setNewAgentPwd] = createSignal("");
  const [newAgentCmd, setNewAgentCmd] = createSignal(DEFAULT_TEAM_AGENT_CMD);
  const [editingAgentId, setEditingAgentId] = createSignal<string | null>(null);
  const [messageMenu, setMessageMenu] = createSignal<MessageMenuState | null>(null);
  const [composerMenu, setComposerMenu] = createSignal<TeamComposerMenuState | null>(null);
  const [createModal, setCreateModal] = createSignal<TeamCreateModal | null>(null);
  const [teamRailWidth, setTeamRailWidth] = createSignal(DEFAULT_TEAM_RAIL_WIDTH);
  const [teamSideWidth, setTeamSideWidth] = createSignal(DEFAULT_TEAM_SIDE_WIDTH);
  const [resizingTeamRail, setResizingTeamRail] = createSignal(false);
  const [resizingTeamSide, setResizingTeamSide] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const runningRuns = new Map<string, RunningRun>();
  let stopPtyListener: (() => void) | undefined;
  let staleRunTimer: number | undefined;
  let stopTeamRailResize: (() => void) | undefined;
  let stopTeamSideResize: (() => void) | undefined;
  let fileSearchTimer: number | undefined;
  let fileSearchVersion = 0;
  let teamSearchTimer: number | undefined;
  let teamSearchVersion = 0;
  let teamSearchInputRef: HTMLInputElement | undefined;
  let lastTeamSearchRequestId = app.teamSearchRequestId();

  const selectedConversation = createMemo(() => {
    const current = selection();
    if (current.kind !== "conversation") return null;
    return conversations().find((conversation) => conversation.id === current.conversationId) || null;
  });

  const selectedChannel = createMemo(() => {
    const conversation = selectedConversation();
    if (!conversation?.channel_id) return null;
    return channels().find((channel) => channel.id === conversation.channel_id) || null;
  });

  const selectedThreadParent = createMemo(() => {
    const parentId = selectedThreadParentId();
    if (!parentId) return null;
    return messages().find((message) => message.id === parentId) || null;
  });

  const editingAgent = createMemo(() => {
    const id = editingAgentId();
    if (!id) return null;
    return users().find((user) => user.id === id) || null;
  });

  const unreadInboxItems = createMemo(() => inbox().filter((item) => item.read_at === null));

  const unreadByConversation = createMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of unreadInboxItems()) {
      counts[item.conversation.id] = (counts[item.conversation.id] || 0) + 1;
    }
    return counts;
  });

  const unreadInboxCount = createMemo(() => unreadInboxItems().length);

  const composerCharCount = createMemo(() => messageCharCount(composerText().trim()));
  const threadComposerCharCount = createMemo(() => messageCharCount(threadComposerText().trim()));

  const composerOverLimit = (parentMessageId: string | null) =>
    (parentMessageId ? threadComposerCharCount() : composerCharCount()) > TEAM_MESSAGE_MAX_CHARS;

  const composerNearLimit = (parentMessageId: string | null) =>
    (parentMessageId ? threadComposerCharCount() : composerCharCount()) >= TEAM_MESSAGE_WARN_CHARS;

  const composerLimitText = (parentMessageId: string | null) =>
    `${parentMessageId ? threadComposerCharCount() : composerCharCount()} / ${TEAM_MESSAGE_MAX_CHARS}`;

  const composerIsEmpty = (parentMessageId: string | null) =>
    !(parentMessageId ? threadComposerText() : composerText()).trim();

  const knownFileSuggestions = createMemo<FileBrowserEntry[]>(() => {
    const entries: FileBrowserEntry[] = [];
    const seen = new Set<string>();
    const addPath = (path: string, relativePath?: string) => {
      const trimmed = path.trim();
      if (!trimmed || seen.has(trimmed) || !isTeamSuggestibleFile(trimmed)) return;
      seen.add(trimmed);
      entries.push({
        name: basename(trimmed),
        path: trimmed,
        relative_path: relativePath || basename(trimmed),
        is_dir: false,
        is_hidden: basename(trimmed).startsWith("."),
        size: null,
      });
    };

    for (const pin of pins()) {
      if (pin.kind === "file" && pin.file_path) {
        addPath(pin.file_path, pin.title || undefined);
      }
    }
    for (const tab of app.pinnedFileTabs()) {
      addPath(tab.path, tab.displayName);
    }
    for (const tab of app.activeSessionFileTabs()) {
      addPath(tab.path, tab.displayName);
    }
    return entries;
  });

  const fileSearchTerm = (query: string) => {
    const trimmed = query.trim();
    const parts = trimmed.split("/");
    return (parts[parts.length - 1] || trimmed).replace(/^@/, "").trim();
  };

  const dedupeFiles = (entries: FileBrowserEntry[]) => {
    const seen = new Set<string>();
    return entries.filter((entry) => {
      if (entry.is_dir || seen.has(entry.path) || !isTeamSuggestibleFile(entry.path)) return false;
      seen.add(entry.path);
      return true;
    });
  };

  const activeFileSearchRoots = async () => {
    const roots: string[] = [];
    const addRoot = (path: string | null | undefined) => {
      const trimmed = path?.trim();
      if (!trimmed || roots.includes(trimmed)) return;
      roots.push(trimmed);
    };

    const activeId = app.activeSessionId();
    if (activeId) {
      const ptyId = app.ptyBySession()[activeId];
      if (ptyId) {
        await invoke<string>("get_pty_cwd", { id: ptyId })
          .then((cwd) => addRoot(cwd))
          .catch(() => undefined);
      }
      addRoot(app.sessions.find((session) => session.id === activeId)?.directory);
    }
    for (const user of users()) {
      addRoot(user.pwd);
      if (roots.length >= 5) break;
    }
    return roots;
  };

  const refreshFileSearchSuggestions = (query: string) => {
    if (fileSearchTimer) window.clearTimeout(fileSearchTimer);
    const searchVersion = ++fileSearchVersion;
    const term = fileSearchTerm(query);
    if (term.length < 2) {
      setFileSearchResults([]);
      return;
    }

    fileSearchTimer = window.setTimeout(() => {
      void (async () => {
        const roots = await activeFileSearchRoots();
        const batches = await Promise.all(
          roots.map((path) =>
            invoke<FileBrowserEntry[]>("search_directory", {
              path,
              query: term,
              includeHidden: false,
            }).catch(() => [] as FileBrowserEntry[]),
          ),
        );
        if (searchVersion !== fileSearchVersion) return;
        setFileSearchResults(dedupeFiles(batches.flat()).slice(0, 30));
      })();
    }, 140);
  };

  const fileSuggestionsForQuery = (query: string) =>
    dedupeFiles([...knownFileSuggestions(), ...fileSearchResults()])
      .filter((entry) => matchesSuggestionQuery(query, entry.name, entry.relative_path, entry.path))
      .slice(0, TEAM_COMPOSER_FILE_LIMIT);

  const userSuggestionsForQuery = (query: string): TeamComposerSuggestion[] =>
    users()
      .filter((user) => matchesSuggestionQuery(query, user.username, user.display_name))
      .sort((a, b) => {
        const q = normalizeSuggestionText(query);
        const aStarts = a.username.toLowerCase().startsWith(q) || a.display_name.toLowerCase().startsWith(q);
        const bStarts = b.username.toLowerCase().startsWith(q) || b.display_name.toLowerCase().startsWith(q);
        return Number(bStarts) - Number(aStarts) || a.username.localeCompare(b.username);
      })
      .map((user) => ({
        kind: "user",
        id: user.id,
        label: user.display_name,
        detail: `@${user.username}`,
        avatarLabel: user.display_name[0]?.toUpperCase() || "A",
        avatarColor: user.avatar_color,
        insertText: `@${user.username} `,
      }));

  const skillSuggestionsForQuery = (query: string): TeamComposerSuggestion[] =>
    skills()
      .filter((skill) => matchesSuggestionQuery(query, skill.name, skill.displayName, skill.description))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, TEAM_COMPOSER_MENU_LIMIT)
      .map((skill) => ({
        kind: "skill",
        id: skill.id,
        label: skill.displayName,
        detail: `/${skill.name}`,
        insertText: `/${skill.name} `,
      }));

  const composerSuggestions = createMemo<TeamComposerSuggestion[]>(() => {
    const menu = composerMenu();
    if (!menu) return [];
    if (menu.mode === "skill") return skillSuggestionsForQuery(menu.query);

    const userItems = userSuggestionsForQuery(menu.query);
    const fileItems: TeamComposerSuggestion[] = fileSuggestionsForQuery(menu.query).map((entry) => ({
      kind: "file",
      id: entry.path,
      label: entry.name,
      detail: entry.relative_path === entry.name ? entry.path : entry.relative_path,
      insertText: markdownLinkForFile(entry.path, entry.name),
    }));
    return [...userItems, ...fileItems].slice(0, TEAM_COMPOSER_MENU_LIMIT);
  });

  createEffect(() => {
    const menu = composerMenu();
    const suggestionCount = composerSuggestions().length;
    if (!menu || suggestionCount === 0 || menu.activeIndex < suggestionCount) return;
    const nextIndex = suggestionCount - 1;
    if (menu.activeIndex !== nextIndex) {
      setComposerMenu({ ...menu, activeIndex: nextIndex });
    }
  });

  const clampTeamRailWidth = (width: number) =>
    Math.max(MIN_TEAM_RAIL_WIDTH, Math.min(Math.round(width), MAX_TEAM_RAIL_WIDTH));

  const setTeamRailWidthClamped = (width: number, persist = true) => {
    const nextWidth = clampTeamRailWidth(width);
    setTeamRailWidth(nextWidth);
    if (persist) {
      window.localStorage.setItem(TEAM_RAIL_WIDTH_STORAGE_KEY, String(nextWidth));
    }
    return nextWidth;
  };

  const teamRailWidthPx = createMemo(() => clampTeamRailWidth(teamRailWidth()));

  const clampTeamSideWidth = (width: number) =>
    Math.max(MIN_TEAM_SIDE_WIDTH, Math.min(Math.round(width), MAX_TEAM_SIDE_WIDTH));

  const setTeamSideWidthClamped = (width: number, persist = true) => {
    const nextWidth = clampTeamSideWidth(width);
    setTeamSideWidth(nextWidth);
    if (persist) {
      window.localStorage.setItem(TEAM_SIDE_WIDTH_STORAGE_KEY, String(nextWidth));
    }
    return nextWidth;
  };

  const teamSideWidthPx = createMemo(() => clampTeamSideWidth(teamSideWidth()));

  const stopActiveTeamRailResize = () => {
    stopTeamRailResize?.();
    stopTeamRailResize = undefined;
  };

  const stopActiveTeamSideResize = () => {
    stopTeamSideResize?.();
    stopTeamSideResize = undefined;
  };

  const startTeamRailResize = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    stopActiveTeamRailResize();

    const startX = event.clientX;
    const startWidth = teamRailWidthPx();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    setResizingTeamRail(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      setTeamRailWidthClamped(startWidth + delta);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setResizingTeamRail(false);
      stopTeamRailResize = undefined;
    };

    stopTeamRailResize = handlePointerUp;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const startTeamSideResize = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    stopActiveTeamSideResize();

    const startX = event.clientX;
    const startWidth = teamSideWidthPx();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    setResizingTeamSide(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      setTeamSideWidthClamped(startWidth - delta);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setResizingTeamSide(false);
      stopTeamSideResize = undefined;
    };

    stopTeamSideResize = handlePointerUp;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const channelConversation = (channelId: string) =>
    conversations().find(
      (conversation) => conversation.kind === "channel" && conversation.channel_id === channelId,
    ) || null;

  const authorName = (message: TeamMessage) => {
    if (message.author_kind === "human") return "You";
    if (message.author_kind === "system") return "System";
    return users().find((user) => user.id === message.author_user_id)?.display_name || "Agent";
  };

  const avatarLabel = (message: TeamMessage) => {
    if (message.author_kind === "human") return "Y";
    const name = authorName(message).trim();
    return name ? name[0].toUpperCase() : "A";
  };

  const avatarColor = (message: TeamMessage) =>
    users().find((user) => user.id === message.author_user_id)?.avatar_color || "";

  const userForRun = (run: TeamAgentRun) => users().find((user) => user.id === run.user_id) || null;

  const runIsPending = (run: TeamAgentRun) => run.status === "queued" || run.status === "running";

  const pendingRunsForParent = (parentMessageId: string) =>
    runs().filter((run) => run.reply_parent_message_id === parentMessageId && runIsPending(run));

  const staleRunMessage = (run: TeamAgentRun) => {
    const ageMinutes = run.started_at
      ? Math.max(TEAM_RUN_STALE_SECONDS / 60, Math.round((Date.now() / 1000 - run.started_at) / 60))
      : TEAM_RUN_STALE_SECONDS / 60;
    return `No completion marker after ${ageMinutes} minutes; marked the Team Mode run as stale.`;
  };

  const isStaleRun = (run: TeamAgentRun, nowSeconds: number) => {
    if (!runIsPending(run)) return false;
    if (run.status === "queued" && !run.started_at && !runningRuns.has(run.id)) return true;
    if (!run.started_at) return false;
    return nowSeconds - run.started_at >= TEAM_RUN_STALE_SECONDS;
  };

  const latestAgentSessionIdFor = (
    userId: string,
    parentMessageId: string,
    agentKind: TeamAgentKind | null,
  ) => {
    if (!agentKind) return null;
    return (
      runs().find(
        (run) =>
          run.user_id === userId &&
          run.reply_parent_message_id === parentMessageId &&
          run.agent_kind === agentKind &&
          Boolean(run.agent_session_id),
      )?.agent_session_id || null
    );
  };

  const firstThreadAgentUserId = (parentMessageId: string) => {
    const threadRuns = runs()
      .filter((run) => run.reply_parent_message_id === parentMessageId)
      .sort((a, b) => {
        const aTime = a.started_at || a.completed_at || 0;
        const bTime = b.started_at || b.completed_at || 0;
        return aTime - bTime || a.id.localeCompare(b.id);
      });
    if (threadRuns[0]?.user_id) return threadRuns[0].user_id;

    const firstAgentMessage = threadMessages()
      .filter(
        (message) =>
          message.parent_message_id === parentMessageId &&
          message.author_kind === "agent" &&
          Boolean(message.author_user_id),
      )
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0];
    return firstAgentMessage?.author_user_id || null;
  };

  const promptAuthorName = (message: TeamMessage) => {
    if (message.author_kind === "human") return "Human";
    if (message.author_kind === "system") return "System";
    const user = users().find((entry) => entry.id === message.author_user_id);
    if (!user) return "Agent";
    return `${user.display_name}${user.username ? ` (@${user.username})` : ""}`;
  };

  const teamSearchConversationLabel = (result: TeamSearchResult) => {
    if (result.channel) return `# ${result.channel.display_name}`;
    return result.conversation.title || "Direct message";
  };

  const teamSearchAuthorLabel = (result: TeamSearchResult) => {
    if (result.message.author_kind === "human") return "You";
    if (result.message.author_kind === "system") return "System";
    return result.author?.display_name || "Agent";
  };

  const teamSearchItems = createMemo<TeamSearchItem[]>(() =>
    teamSearchResults().map((result) => ({
      id: result.message.id,
      label: compactText(result.message.content, 96) || "(empty message)",
      description: [
        teamSearchConversationLabel(result),
        result.parent_message ? "thread" : "message",
        teamSearchAuthorLabel(result),
        formatClock(result.message.created_at),
      ].join(" · "),
      result,
    })),
  );

  const threadContextMessagesForPrompt = (
    parentMessageId: string,
    triggerMessageId: string,
  ) => {
    const parent = findMessageById(parentMessageId);
    const replies = threadMessages()
      .filter((message) => message.parent_message_id === parentMessageId && message.id !== triggerMessageId)
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    const maxReplies = parent ? THREAD_CONTEXT_MAX_MESSAGES - 1 : THREAD_CONTEXT_MAX_MESSAGES;
    const recentReplies = replies.slice(Math.max(0, replies.length - maxReplies));
    return parent ? [parent, ...recentReplies] : recentReplies;
  };

  const userMessageForAgent = (
    content: string,
    triggerMessage: TeamMessage,
    parentMessageId: string,
    targetUser: TeamUser,
    resumeAgentSessionId: string | null,
  ) => {
    if (!triggerMessage.parent_message_id) return content;

    const contextMessages = threadContextMessagesForPrompt(parentMessageId, triggerMessage.id);
    if (contextMessages.length === 0) return content;

    const originalAgentUserId = firstThreadAgentUserId(parentMessageId);
    if (originalAgentUserId && originalAgentUserId === targetUser.id && resumeAgentSessionId) {
      return content;
    }

    const transcript = contextMessages
      .map((message) => {
        const time = formatClock(message.created_at);
        return `[${time}] ${promptAuthorName(message)}: ${truncatePromptText(message.content)}`;
      })
      .join("\n\n");

    return [
      `You are ${targetUser.display_name} (@${targetUser.username}).`,
      "You were mentioned in an existing Butter Team Mode thread. Use the thread context below to answer the current human message.",
      "",
      "Thread context:",
      transcript,
      "",
      "Current human message:",
      content,
    ].join("\n");
  };

  const upsertRun = (nextRun: TeamAgentRun) => {
    setRuns((current) => {
      const index = current.findIndex((run) => run.id === nextRun.id);
      if (index < 0) return [nextRun, ...current];
      const copy = [...current];
      copy[index] = nextRun;
      return copy;
    });
  };

  const failStaleRuns = async (candidateRuns = runs()) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const staleRuns = candidateRuns.filter((run) => isStaleRun(run, nowSeconds));
    for (const run of staleRuns) {
      runningRuns.delete(run.id);
      try {
        const failedRun = await invoke<TeamAgentRun>("team_update_agent_run", {
          id: run.id,
          req: {
            pty_session_id: run.pty_session_id,
            agent_kind: run.agent_kind,
            agent_session_id: run.agent_session_id,
            status: "failed",
            exit_code: null,
            error: staleRunMessage(run),
          },
        });
        upsertRun(failedRun);
      } catch (err) {
        setError(`Failed to mark stale Team Mode run ${run.id}: ${String(err)}`);
      }
      if (run.pty_session_id) {
        await invoke("pty_close", { id: run.pty_session_id }).catch(() => undefined);
      }
    }
  };

  const findMessageById = (messageId: string) =>
    messages().find((message) => message.id === messageId) ||
    threadMessages().find((message) => message.id === messageId) ||
    inbox().find((item) => item.message.id === messageId)?.message ||
    inbox().find((item) => item.parent_message?.id === messageId)?.parent_message ||
    null;

  const agentSessionIdForMessage = (message: TeamMessage) => {
    if (!message.pty_session_id) return null;
    const run = runs().find(
      (entry) => entry.id === message.pty_session_id || entry.pty_session_id === message.pty_session_id,
    );
    return run?.agent_session_id || run?.pty_session_id || message.pty_session_id;
  };

  const openMessageMenu = (
    event: MouseEvent & { currentTarget: HTMLButtonElement },
    message: TeamMessage,
  ) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 210;
    const menuHeight = agentSessionIdForMessage(message) ? 136 : 104;
    setMessageMenu({
      messageId: message.id,
      x: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menuHeight - 8)),
    });
  };

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMessageMenu(null);
    } catch (err) {
      setError(`Clipboard copy failed: ${String(err)}`);
    }
  };

  const externalHrefFromClick = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : null;
    const anchor = element?.closest("a");
    if (!anchor) return null;
    return anchor.getAttribute("href") || anchor.href || null;
  };

  const openMessageLinkExternally = async (href: string) => {
    try {
      await openExternal(href);
    } catch (err) {
      try {
        await Command.create("open", [href]).execute();
      } catch {
        setError(`Could not open link: ${String(err)}`);
      }
    }
  };

  const handleMessageLinkClick = (event: MouseEvent) => {
    const href = externalHrefFromClick(event.target);
    if (!href) return;
    event.preventDefault();
    event.stopPropagation();
    void openMessageLinkExternally(href);
  };

  const insertComposerSnippet = (
    textarea: HTMLTextAreaElement,
    currentValue: string,
    setValue: (value: string) => void,
    snippet: string,
  ) => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextValue = `${currentValue.slice(0, start)}${snippet}${currentValue.slice(end)}`;
    const nextChars = messageCharCount(nextValue.trim());
    if (nextChars > TEAM_MESSAGE_MAX_CHARS) {
      setError(`Message is ${nextChars} characters. Limit is ${TEAM_MESSAGE_MAX_CHARS}.`);
      return;
    }
    const cursor = start + snippet.length;
    setValue(nextValue);
    setComposerMenu(null);
    window.setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    }, 0);
  };

  const handleComposerPaste = async (
    event: ClipboardEvent & { currentTarget: HTMLTextAreaElement },
    setValue: (value: string) => void,
  ) => {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;
    const hasImageItem = Array.from(clipboardData.items).some((item) =>
      item.type.startsWith("image/")
    );
    const image = extractImageFromClipboard(clipboardData);
    if (hasImageItem || image) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setError(null);
      const textarea = event.currentTarget;
      try {
        const path = await invoke<string>("save_clipboard_image");
        insertComposerSnippet(
          textarea,
          textarea.value,
          setValue,
          `![${basename(path)}](${path})`,
        );
      } catch (err) {
        setError(`Image paste failed: ${String(err)}`);
      }
      return;
    }

    const pastedText = clipboardData.getData("text/plain");
    if (
      messageCharCount(pastedText) < TEAM_NOTE_PASTE_THRESHOLD_CHARS ||
      !pastedText.trim()
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    setError(null);
    const textarea = event.currentTarget;
    try {
      const noteSnippet = await saveTeamNoteMessageContent(pastedText, "Saved a note");
      insertComposerSnippet(textarea, textarea.value, setValue, noteSnippet);
    } catch (err) {
      setError(`Note paste failed: ${String(err)}`);
    }
  };

  const updateComposerMenuForTextarea = (
    composerId: TeamComposerId,
    textarea: HTMLTextAreaElement,
  ) => {
    const trigger = detectComposerTrigger(textarea.value, textarea.selectionStart);
    if (!trigger) {
      setComposerMenu((current) => (current?.composerId === composerId ? null : current));
      return;
    }
    let shouldRefreshFileSearch = false;
    setComposerMenu((current) => {
      const activeIndex =
        current?.composerId === composerId &&
        current.mode === trigger.mode &&
        current.query === trigger.query
          ? current.activeIndex
          : 0;
      const next: TeamComposerMenuState = {
        composerId,
        mode: trigger.mode,
        trigger: trigger.trigger,
        query: trigger.query,
        start: trigger.start,
        end: trigger.end,
        activeIndex,
      };
      if (
        current &&
        current.composerId === next.composerId &&
        current.mode === next.mode &&
        current.trigger === next.trigger &&
        current.query === next.query &&
        current.start === next.start &&
        current.end === next.end &&
        current.activeIndex === next.activeIndex
      ) {
        return current;
      }
      shouldRefreshFileSearch = next.mode === "mention";
      return next;
    });
    if (shouldRefreshFileSearch) {
      refreshFileSearchSuggestions(trigger.query);
    }
  };

  const insertComposerSuggestion = (
    composerId: TeamComposerId,
    textarea: HTMLTextAreaElement,
    setValue: (value: string) => void,
    suggestion: TeamComposerSuggestion,
  ) => {
    const menu = composerMenu();
    if (!menu || menu.composerId !== composerId) return;
    const value = textarea.value;
    const nextValue = `${value.slice(0, menu.start)}${suggestion.insertText}${value.slice(menu.end)}`;
    const nextChars = messageCharCount(nextValue.trim());
    if (nextChars > TEAM_MESSAGE_MAX_CHARS) {
      setError(`Message is ${nextChars} characters. Limit is ${TEAM_MESSAGE_MAX_CHARS}.`);
      return;
    }
    const cursor = menu.start + suggestion.insertText.length;
    setValue(nextValue);
    setComposerMenu(null);
    window.setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    }, 0);
  };

  const TeamComposer = (props: {
    id: TeamComposerId;
    parentMessageId: () => string | null;
    value: () => string;
    setValue: (value: string) => void;
    placeholder: string;
  }) => {
    let textareaRef: HTMLTextAreaElement | undefined;
    const menuOpen = createMemo(() => composerMenu()?.composerId === props.id);
    const activeSuggestion = createMemo(() => {
      const menu = composerMenu();
      if (!menu || menu.composerId !== props.id) return null;
      return composerSuggestions()[menu.activeIndex] || null;
    });
    const submit = () => {
      const parentMessageId = props.parentMessageId();
      void (composerOverLimit(parentMessageId)
        ? createNoteFromComposer(parentMessageId)
        : sendMessage(parentMessageId));
    };
    const chooseSuggestion = (suggestion: TeamComposerSuggestion) => {
      if (!textareaRef) return;
      insertComposerSuggestion(props.id, textareaRef, props.setValue, suggestion);
    };
    const moveActiveSuggestion = (delta: number) => {
      const suggestions = composerSuggestions();
      if (suggestions.length === 0) return;
      setComposerMenu((current) => {
        if (!current || current.composerId !== props.id) return current;
        const nextIndex = (current.activeIndex + delta + suggestions.length) % suggestions.length;
        return { ...current, activeIndex: nextIndex };
      });
    };
    const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
      if (menuOpen()) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveActiveSuggestion(1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          moveActiveSuggestion(-1);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setComposerMenu(null);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          const suggestion = activeSuggestion();
          if (suggestion) {
            event.preventDefault();
            chooseSuggestion(suggestion);
            return;
          }
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    };

    return (
      <div class={`team-composer ${props.id === "thread" ? "thread" : ""}`}>
        <div class="team-composer-input">
          <textarea
            ref={(element) => {
              textareaRef = element;
            }}
            value={props.value()}
            onInput={(event) => {
              props.setValue(event.currentTarget.value);
              updateComposerMenuForTextarea(props.id, event.currentTarget);
            }}
            onPaste={(event) => void handleComposerPaste(event, props.setValue)}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => {
              if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
              updateComposerMenuForTextarea(props.id, event.currentTarget);
            }}
            onClick={(event) => updateComposerMenuForTextarea(props.id, event.currentTarget)}
            onSelect={(event) => updateComposerMenuForTextarea(props.id, event.currentTarget)}
            placeholder={props.placeholder}
            spellcheck={false}
          />
          <Show when={menuOpen()}>
            <div class="team-composer-menu">
              <div class="team-composer-menu-heading">
                <Show when={composerMenu()?.mode === "skill"} fallback="@ users and files">
                  / skills
                </Show>
              </div>
              <Show
                when={composerSuggestions().length > 0}
                fallback={<div class="team-composer-menu-empty">No matches</div>}
              >
                <For each={composerSuggestions()}>
                  {(suggestion, index) => (
                    <button
                      type="button"
                      class={`team-composer-menu-item ${index() === composerMenu()?.activeIndex ? "active" : ""}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        chooseSuggestion(suggestion);
                      }}
                    >
                      <Show
                        when={suggestion.kind === "user"}
                        fallback={<span class={`team-composer-menu-icon ${suggestion.kind}`}>{suggestion.kind[0].toUpperCase()}</span>}
                      >
                        <span
                          class="team-avatar mini"
                          style={{
                            "--team-avatar-color":
                              suggestion.kind === "user" ? suggestion.avatarColor || "" : "",
                          }}
                        >
                          {suggestion.kind === "user" ? suggestion.avatarLabel : "A"}
                        </span>
                      </Show>
                      <span class="team-composer-menu-text">
                        <span class="team-composer-menu-label">{suggestion.label}</span>
                        <span class="team-composer-menu-detail">{suggestion.detail}</span>
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </Show>
          <Show when={composerNearLimit(props.parentMessageId())}>
            <div class={`team-composer-limit ${composerOverLimit(props.parentMessageId()) ? "over" : ""}`}>
              {composerLimitText(props.parentMessageId())}
            </div>
          </Show>
        </div>
        <button disabled={composerIsEmpty(props.parentMessageId())} onClick={submit}>
          <Show when={composerOverLimit(props.parentMessageId())} fallback={props.id === "thread" ? "Reply" : "Send"}>
            Create note
          </Show>
        </button>
      </div>
    );
  };

  const MessageContent = (props: { content: string }) => {
    let contentRef: HTMLDivElement | undefined;
    let loadVersion = 0;
    let objectUrls: string[] = [];

    const revokeObjectUrls = () => {
      for (const url of objectUrls) {
        URL.revokeObjectURL(url);
      }
      objectUrls = [];
    };

    createEffect(() => {
      props.content;
      loadVersion += 1;
      const currentVersion = loadVersion;
      revokeObjectUrls();
      const root = contentRef;
      if (!root) return;

      const images = Array.from(
        root.querySelectorAll<HTMLImageElement>("img[data-butter-local-image-path]"),
      );
      for (const image of images) {
        const path = image.dataset.butterLocalImagePath;
        if (!path) continue;
        image.dataset.butterImageLoading = "true";
        void (async () => {
          try {
            const bytes = await invoke<number[]>("read_file_binary", { path });
            if (currentVersion !== loadVersion) return;
            const mimeType = inferImageMimeType(path) || "application/octet-stream";
            const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
            objectUrls.push(url);
            image.src = url;
            delete image.dataset.butterImageLoading;
          } catch (err) {
            if (currentVersion !== loadVersion) return;
            delete image.dataset.butterImageLoading;
            image.alt = `${image.alt || basename(path)} (failed to load)`;
            console.warn("[team-message-image] failed to load local image", err);
          }
        })();
      }
    });

    onCleanup(() => {
      loadVersion += 1;
      revokeObjectUrls();
    });

    return (
      <div
        ref={contentRef}
        class="team-message-content markdown"
        onClick={handleMessageLinkClick}
        onAuxClick={handleMessageLinkClick}
        innerHTML={renderMarkdownToSafeHtml(props.content)}
      />
    );
  };

  const MessageArticle = (props: { message: TeamMessage; compact?: boolean }) => (
    <article class={`team-message ${props.compact ? "compact" : ""}`}>
      <div
        class={`team-avatar ${props.compact ? "mini" : ""}`}
        style={{ "--team-avatar-color": avatarColor(props.message) }}
      >
        {avatarLabel(props.message)}
      </div>
      <div class="team-message-body">
        <div class="team-message-meta">
          <span class="team-message-author">{authorName(props.message)}</span>
          <span>{formatClock(props.message.created_at)}</span>
          <button
            class="team-message-menu-button"
            onClick={(event) => openMessageMenu(event, props.message)}
            title="Message actions"
            aria-label="Message actions"
          >
            ...
          </button>
        </div>
        <MessageContent content={props.message.content} />
        <Show
          when={props.compact}
          fallback={
            <div class="team-message-actions">
              <Show
                when={props.message.thread_reply_count > 0}
                fallback={
                  <button class="team-reply-action" onClick={() => void openThread(props.message)}>
                    Reply in thread
                  </button>
                }
              >
                <button class="team-reply-count" onClick={() => void openThread(props.message)}>
                  {props.message.thread_reply_count} repl{props.message.thread_reply_count === 1 ? "y" : "ies"}
                </button>
              </Show>
            </div>
          }
        >
          <></>
        </Show>
      </div>
    </article>
  );

  const AgentAcknowledgement = (props: { run: TeamAgentRun; compact?: boolean }) => {
    const user = () => userForRun(props.run);
    const displayName = () => user()?.display_name || "Agent";
    const statusText = () =>
      props.run.status === "queued"
        ? `${displayName()} is starting...`
        : `${displayName()} is thinking...`;
    return (
      <div class={`team-agent-ack ${props.compact ? "compact" : ""} ${props.run.status}`}>
        <span
          class="team-avatar mini"
          style={{ "--team-avatar-color": user()?.avatar_color || "" }}
        >
          {displayName()[0]?.toUpperCase() || "A"}
        </span>
        <span class="team-agent-ack-text">{statusText()}</span>
        <span class="team-agent-ack-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
    );
  };

  const refreshInbox = async (mode = inboxMode()) => {
    const nextInbox = await invoke<TeamInboxItem[]>("team_get_inbox", {
      includeRead: mode === "recent",
      limit: mode === "recent" ? 100 : 200,
    });
    setInbox(nextInbox);
  };

  const refreshRuns = async () => {
    const nextRuns = await invoke<TeamAgentRun[]>("team_list_agent_runs");
    setRuns(nextRuns);
    void failStaleRuns(nextRuns);
  };

  const refreshPins = async () => {
    const nextPins = await invoke<TeamPin[]>("team_list_pins");
    setPins(nextPins);
  };

  const refreshMessages = async (conversationId = selectedConversation()?.id || null) => {
    if (!conversationId) return;
    const nextMessages = await invoke<TeamMessage[]>("team_list_messages", {
      conversationId,
      parentMessageId: null,
    });
    setMessages(nextMessages);
  };

  const refreshThread = async (parentMessageId = selectedThreadParentId()) => {
    const conversation = selectedConversation();
    if (!conversation || !parentMessageId) {
      setThreadMessages([]);
      return;
    }
    const replies = await invoke<TeamMessage[]>("team_list_messages", {
      conversationId: conversation.id,
      parentMessageId,
    });
    setThreadMessages(replies);
  };

  const loadBase = async () => {
    setLoading(true);
    setError(null);
    try {
      const currentInboxMode = inboxMode();
      const [nextUsers, nextChannels, nextConversations, nextInbox, nextRuns, nextPins] = await Promise.all([
        invoke<TeamUser[]>("team_list_users"),
        invoke<TeamChannel[]>("team_list_channels"),
        invoke<TeamConversation[]>("team_list_conversations"),
        invoke<TeamInboxItem[]>("team_get_inbox", {
          includeRead: currentInboxMode === "recent",
          limit: currentInboxMode === "recent" ? 100 : 200,
        }),
        invoke<TeamAgentRun[]>("team_list_agent_runs"),
        invoke<TeamPin[]>("team_list_pins"),
      ]);
      setUsers(nextUsers);
      setChannels(nextChannels);
      setConversations(nextConversations);
      setInbox(nextInbox);
      setRuns(nextRuns);
      setPins(nextPins);
      void failStaleRuns(nextRuns);

      const current = selection();
      if (current.kind === "conversation") {
        await refreshMessages(current.conversationId);
        return;
      }

      const general = nextChannels.find((channel) => channel.name === "general");
      const generalConversation = general
        ? nextConversations.find((conversation) => conversation.channel_id === general.id)
        : null;
      if (generalConversation) {
        setSelection({ kind: "conversation", conversationId: generalConversation.id });
        await refreshMessages(generalConversation.id);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const selectConversation = async (conversationId: string) => {
    setSelection({ kind: "conversation", conversationId });
    setSelectedThreadParentId(null);
    setThreadMessages([]);
    await refreshMessages(conversationId);
    await invoke("team_mark_conversation_read", { conversationId });
    await refreshInbox();
  };

  const selectChannel = async (channel: TeamChannel) => {
    const conversation =
      channelConversation(channel.id) ||
      (await invoke<TeamConversation | null>("team_get_channel_conversation", {
        channelId: channel.id,
      }));
    if (conversation) {
      await selectConversation(conversation.id);
    }
  };

  const selectDm = async (user: TeamUser) => {
    const conversation = await invoke<TeamConversation>("team_get_or_create_dm", { userId: user.id });
    setConversations((current) => {
      if (current.some((entry) => entry.id === conversation.id)) return current;
      return [...current, conversation];
    });
    await selectConversation(conversation.id);
  };

  const editAgent = (user: TeamUser) => {
    setError(null);
    setEditingAgentId(user.id);
    setNewAgentUsername(user.username);
    setNewAgentDisplayName(user.display_name);
    setNewAgentPwd(user.pwd);
    setNewAgentCmd(user.cmd);
    setCreateModal("agent");
  };

  const openInbox = async () => {
    setSelection({ kind: "inbox" });
    setSelectedThreadParentId(null);
    setMessages([]);
    setThreadMessages([]);
    await refreshInbox();
  };

  const selectInboxMode = async (mode: TeamInboxMode) => {
    setInboxMode(mode);
    if (selection().kind === "inbox") {
      await refreshInbox(mode);
    }
  };

  const clearTeamSearchTimer = () => {
    if (teamSearchTimer) {
      window.clearTimeout(teamSearchTimer);
      teamSearchTimer = undefined;
    }
  };

  const runTeamSearch = async (
    rawQuery = teamSearchQuery(),
    version = ++teamSearchVersion,
    advanced = teamSearchAdvanced(),
  ) => {
    const query = rawQuery.trim();
    if (!query) {
      setTeamSearchResults([]);
      setTeamSearchError(null);
      setTeamSearchLoading(false);
      return;
    }
    setTeamSearchLoading(true);
    setTeamSearchError(null);
    try {
      const results = await invoke<TeamSearchResult[]>("team_search_messages", {
        q: query,
        limit: 50,
        advanced,
      });
      if (version !== teamSearchVersion) return;
      setTeamSearchResults(results);
      setTeamSearchIndex(0);
      setTeamSearchAdvanced(advanced);
    } catch (err) {
      if (version !== teamSearchVersion) return;
      setTeamSearchError(String(err));
      setTeamSearchResults([]);
    } finally {
      if (version === teamSearchVersion) {
        setTeamSearchLoading(false);
      }
    }
  };

  const updateTeamSearchQuery = (value: string) => {
    setTeamSearchQuery(value);
    setTeamSearchIndex(0);
    setTeamSearchAdvanced(false);
    clearTeamSearchTimer();
    const version = ++teamSearchVersion;
    if (!value.trim()) {
      setTeamSearchResults([]);
      setTeamSearchError(null);
      setTeamSearchLoading(false);
      return;
    }
    setTeamSearchLoading(true);
    teamSearchTimer = window.setTimeout(() => {
      void runTeamSearch(value, version);
    }, 220);
  };

  const runAdvancedTeamSearch = () => {
    const query = teamSearchQuery().trim();
    if (!query) return;
    clearTeamSearchTimer();
    const version = ++teamSearchVersion;
    setTeamSearchAdvanced(true);
    void runTeamSearch(query, version, true);
  };

  const openTeamSearch = () => {
    clearTeamSearchTimer();
    app.setShowCommandPalette(false);
    setTeamSearchOpen(true);
    setTeamSearchIndex(0);
    setTeamSearchError(null);
    if (teamSearchQuery().trim()) {
      void runTeamSearch();
    }
  };

  const closeTeamSearch = () => {
    clearTeamSearchTimer();
    teamSearchVersion += 1;
    setTeamSearchOpen(false);
    setTeamSearchLoading(false);
  };

  const teamSearchEmptyContent = () => {
    if (!teamSearchQuery().trim()) return "Search messages across Team Mode";
    if (teamSearchAdvanced()) return "No advanced matches";
    return (
      <>
        No matches.{" "}
        <button
          type="button"
          class="command-palette-inline-action"
          onClick={(event) => {
            event.stopPropagation();
            runAdvancedTeamSearch();
          }}
        >
          Run advanced search
        </button>
      </>
    );
  };

  const openThread = async (message: TeamMessage) => {
    const parentId = message.parent_message_id || message.id;
    setSelectedThreadParentId(parentId);
    await refreshThread(parentId);
    await invoke("team_mark_thread_read", { parentMessageId: parentId });
    await refreshInbox();
  };

  const openInboxItem = async (item: TeamInboxItem) => {
    setSelection({ kind: "conversation", conversationId: item.conversation.id });
    await refreshMessages(item.conversation.id);
    if (item.parent_message) {
      setSelectedThreadParentId(item.parent_message.id);
      await refreshThread(item.parent_message.id);
      await invoke("team_mark_thread_read", { parentMessageId: item.parent_message.id });
    } else {
      setSelectedThreadParentId(null);
      setThreadMessages([]);
      await invoke("team_mark_message_read", { messageId: item.message.id });
    }
    await refreshInbox();
  };

  const openTeamSearchResult = async (item: TeamSearchItem) => {
    const { result } = item;
    closeTeamSearch();
    setSelection({ kind: "conversation", conversationId: result.conversation.id });
    await refreshMessages(result.conversation.id);
    if (result.parent_message) {
      setSelectedThreadParentId(result.parent_message.id);
      await refreshThread(result.parent_message.id);
      await invoke("team_mark_thread_read", { parentMessageId: result.parent_message.id });
    } else {
      setSelectedThreadParentId(null);
      setThreadMessages([]);
      await invoke("team_mark_message_read", { messageId: result.message.id });
    }
    await refreshInbox();
  };

  const openCreateChannelModal = () => {
    setError(null);
    setEditingAgentId(null);
    setChannelName("");
    setCreateModal("channel");
  };

  const openCreateAgentModal = () => {
    setError(null);
    setEditingAgentId(null);
    setNewAgentUsername("");
    setNewAgentDisplayName("");
    setNewAgentPwd("");
    setNewAgentCmd(DEFAULT_TEAM_AGENT_CMD);
    setCreateModal("agent");
  };

  const closeCreateModal = () => {
    setCreateModal(null);
    setEditingAgentId(null);
  };

  const refreshSkills = async () => {
    const entries: FileBrowserEntry[] = [];
    const seenPaths = new Set<string>();
    for (const root of TEAM_SKILL_SEARCH_ROOTS) {
      const rootEntries = await invoke<FileBrowserEntry[]>("search_directory", {
        path: root,
        query: "SKILL.md",
        includeHidden: true,
      }).catch(() => [] as FileBrowserEntry[]);
      for (const entry of rootEntries) {
        if (entry.is_dir || !entry.path.endsWith("/SKILL.md")) continue;
        if (entry.path.includes("/.claude/worktrees/")) continue;
        if (seenPaths.has(entry.path)) continue;
        seenPaths.add(entry.path);
        entries.push(entry);
      }
    }

    const parsedSkills = await Promise.all(
      entries.slice(0, 80).map(async (entry) => {
        const content = await invoke<string>("read_file_text", {
          path: entry.path,
          maxBytes: 6000,
        }).catch(() => "");
        return parseSkillMarkdown(entry.path, content);
      }),
    );

    const seenNames = new Set<string>();
    setSkills(
      parsedSkills.filter((skill) => {
        if (seenNames.has(skill.name)) return false;
        seenNames.add(skill.name);
        return true;
      }),
    );
  };

  const mentionedAgentHandles = (content: string) =>
    Array.from(
      new Set([...content.matchAll(/@([A-Za-z0-9_-]+)/g)].map((match) => match[1].toLowerCase())),
    );

  const sendSystemThreadMessage = async (
    conversationId: string,
    parentMessageId: string,
    content: string,
  ) => {
    await invoke<TeamMessage>("team_send_message", {
      req: {
        id: null,
        conversation_id: conversationId,
        author_kind: "system",
        author_user_id: null,
        content,
        parent_message_id: parentMessageId,
        pty_session_id: null,
      },
    });
  };

  const buildRunCommand = (
    run: TeamAgentRun,
    user: TeamUser,
    parentMessageId: string,
    conversationId: string,
    agentKind: TeamAgentKind | null,
    resumeAgentSessionId: string | null,
  ) => {
    const marker = `${DONE_MARKER_PREFIX}${run.id}:`;
    const exports = [
      `export BUTTER_TEAM_USER_ID=${shellQuote(user.id)}`,
      `export BUTTER_TEAM_PARENT_MESSAGE_ID=${shellQuote(parentMessageId)}`,
      `export BUTTER_TEAM_CONVERSATION_ID=${shellQuote(conversationId)}`,
      `export BUTTER_TEAM_RUN_ID=${shellQuote(run.id)}`,
      `export BUTTER_TEAM_AGENT_KIND=${shellQuote(agentKind || "")}`,
      `export BUTTER_TEAM_AGENT_SESSION_ID=${shellQuote(resumeAgentSessionId || "")}`,
    ].join("; ");
    const resumedCommand = withAgentResume(run.rendered_command, agentKind, resumeAgentSessionId);
    const command =
      agentKind === "codex" ? withCodexLastMessageOutput(resumedCommand, run.id) : resumedCommand;
    return `${exports}; ${command}\nprintf '\\n${marker}%s\\n' "$?"`;
  };

  const resolveRunAgentSessionId = async (runId: string, running: RunningRun) => {
    if (running.agentKind === "claude") {
      const results = await invoke<AgentSessionActivity[]>("get_agent_session_ids", {
        ids: [runId],
      });
      return results[0]?.session_id || running.resumeAgentSessionId;
    }
    if (running.agentKind === "codex") {
      const sessionId = await invoke<string | null>("codex_latest_session_id", {
        cwd: running.run.cwd,
      });
      return sessionId || running.resumeAgentSessionId;
    }
    return null;
  };

  const finishRun = async (runId: string, exitCode: number, rawOutput: string) => {
    const running = runningRuns.get(runId);
    if (!running) return;
    runningRuns.delete(runId);
    const cleaned = stripAnsi(rawOutput)
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
    const status = exitCode === 0 ? "succeeded" : "failed";
    const agentSessionId = await resolveRunAgentSessionId(runId, running).catch(
      () => running.resumeAgentSessionId,
    );
    const savedRun = await invoke<TeamAgentRun>("team_update_agent_run", {
      id: runId,
      req: {
        pty_session_id: runId,
        agent_kind: running.agentKind,
        agent_session_id: agentSessionId,
        status,
        exit_code: exitCode,
        error: exitCode === 0 ? null : `Exited with ${exitCode}`,
      },
    });
    upsertRun(savedRun);
    await invoke("pty_close", { id: runId }).catch(() => undefined);
    await invoke<TeamMessage>("team_send_message", {
      req: {
        id: null,
        conversation_id: running.conversationId,
        author_kind: "agent",
        author_user_id: running.user.id,
        content: cleaned || "(no output)",
        parent_message_id: running.parentMessageId,
        pty_session_id: runId,
      },
    });
    await Promise.all([refreshRuns(), refreshInbox(), refreshMessages(running.conversationId)]);
    if (selectedThreadParentId() === running.parentMessageId) {
      await refreshThread(running.parentMessageId);
    }
  };

  const handlePtyData = (payload: PtyOutput) => {
    const running = runningRuns.get(payload.id);
    if (!running) return;
    running.buffer += payload.data;
    const marker = `${DONE_MARKER_PREFIX}${payload.id}:`;
    const markerIndex = running.buffer.indexOf(marker);
    if (markerIndex < 0) return;
    const output = running.buffer.slice(0, markerIndex);
    const afterMarker = running.buffer.slice(markerIndex + marker.length);
    const exitMatch = afterMarker.match(/(-?\d+)/);
    const exitCode = exitMatch ? Number(exitMatch[1]) : 0;
    void finishRun(payload.id, Number.isFinite(exitCode) ? exitCode : 0, output).catch((err) => {
      setError(String(err));
    });
  };

  const launchMentionedAgents = async (
    triggerMessage: TeamMessage,
    content: string,
    parentMessageId: string,
  ) => {
    const handles = mentionedAgentHandles(content);
    if (handles.length === 0) return;
    for (const handle of handles) {
      const user = users().find((entry) => entry.username.toLowerCase() === handle);
      if (!user) {
        await sendSystemThreadMessage(
          triggerMessage.conversation_id,
          parentMessageId,
          `Could not start @${handle}: no Team Mode agent is configured with that username.`,
        );
        continue;
      }
      if (!user.enabled) {
        await sendSystemThreadMessage(
          triggerMessage.conversation_id,
          parentMessageId,
          `Could not start @${user.username}: this agent is disabled.`,
        );
        continue;
      }

      const agentKind = inferAgentKind(user.cmd);
      const resumeAgentSessionId = latestAgentSessionIdFor(user.id, parentMessageId, agentKind);
      const userMsg = userMessageForAgent(
        content,
        triggerMessage,
        parentMessageId,
        user,
        resumeAgentSessionId,
      );
      let run: TeamAgentRun;
      try {
        run = await invoke<TeamAgentRun>("team_create_agent_run", {
          req: {
            trigger_message_id: triggerMessage.id,
            reply_parent_message_id: parentMessageId,
            user_id: user.id,
            user_msg: userMsg,
          },
        });
      } catch (err) {
        await sendSystemThreadMessage(
          triggerMessage.conversation_id,
          parentMessageId,
          `Could not queue @${user.username}: ${String(err)}`,
        );
        continue;
      }
      upsertRun(run);
      const command = buildRunCommand(
        run,
        user,
        parentMessageId,
        triggerMessage.conversation_id,
        agentKind,
        resumeAgentSessionId,
      );
      runningRuns.set(run.id, {
        run,
        user,
        parentMessageId,
        conversationId: triggerMessage.conversation_id,
        agentKind,
        resumeAgentSessionId,
        buffer: "",
      });
      try {
        await invoke<string>("pty_create", {
          id: run.id,
          rows: 24,
          cols: 100,
          cwd: run.cwd,
          command,
        });
      } catch (err) {
        runningRuns.delete(run.id);
        const message = `Could not start @${user.username}: ${String(err)}`;
        try {
          const failedRun = await invoke<TeamAgentRun>("team_update_agent_run", {
            id: run.id,
            req: {
              pty_session_id: null,
              agent_kind: agentKind,
              agent_session_id: resumeAgentSessionId,
              status: "failed",
              exit_code: null,
              error: message,
            },
          });
          upsertRun(failedRun);
        } catch (updateErr) {
          const fallbackRun: TeamAgentRun = {
            ...run,
            agent_kind: agentKind,
            agent_session_id: resumeAgentSessionId,
            status: "failed",
            completed_at: Math.floor(Date.now() / 1000),
            error: `${message}; failed to record status: ${String(updateErr)}`,
          };
          upsertRun(fallbackRun);
        }
        await sendSystemThreadMessage(triggerMessage.conversation_id, parentMessageId, message);
        continue;
      }

      const localRunningRun: TeamAgentRun = {
        ...run,
        pty_session_id: run.id,
        agent_kind: agentKind,
        agent_session_id: resumeAgentSessionId,
        status: "running",
        started_at: run.started_at || Math.floor(Date.now() / 1000),
        exit_code: null,
        error: null,
      };
      upsertRun(localRunningRun);
      try {
        const savedRun = await invoke<TeamAgentRun>("team_update_agent_run", {
          id: run.id,
          req: {
            pty_session_id: run.id,
            agent_kind: agentKind,
            agent_session_id: resumeAgentSessionId,
            status: "running",
            exit_code: null,
            error: null,
          },
        });
        upsertRun(savedRun);
      } catch (err) {
        setError(`Started @${user.username}, but failed to record run status: ${String(err)}`);
      }
    }
    await Promise.all([refreshRuns(), refreshInbox(), refreshMessages(triggerMessage.conversation_id)]);
    if (selectedThreadParentId() === parentMessageId) {
      await refreshThread(parentMessageId);
    }
  };

  const sendMessage = async (parentMessageId: string | null) => {
    const conversation = selectedConversation();
    const content = parentMessageId ? threadComposerText().trim() : composerText().trim();
    if (!conversation || !content) return;
    const contentChars = messageCharCount(content);
    if (contentChars > TEAM_MESSAGE_MAX_CHARS) {
      setError(`Message is ${contentChars} characters. Limit is ${TEAM_MESSAGE_MAX_CHARS}.`);
      return;
    }
    const mentionedHandles = mentionedAgentHandles(content);
    setError(null);
    try {
      const message = await invoke<TeamMessage>("team_send_message", {
        req: {
          id: null,
          conversation_id: conversation.id,
          author_kind: "human",
          author_user_id: null,
          content,
          parent_message_id: parentMessageId,
          pty_session_id: null,
        },
      });
      if (parentMessageId) {
        setThreadComposerText("");
        await refreshThread(parentMessageId);
      } else {
        setComposerText("");
      }
      await refreshMessages(conversation.id);
      if (mentionedHandles.length > 0) {
        const threadParentId = parentMessageId || message.id;
        setSelectedThreadParentId(threadParentId);
        await refreshThread(threadParentId);
      }
      await launchMentionedAgents(message, content, parentMessageId || message.id);
    } catch (err) {
      setError(String(err));
    }
  };

  const saveTeamNoteMessageContent = async (content: string, label: string) => {
    const path = await invoke<string>("save_team_note_file", { content });
    const mentions = mentionedAgentHandles(content)
      .slice(0, 20)
      .map((handle) => `@${handle}`)
      .join(" ");
    return `${mentions ? `${mentions} ` : ""}${label}: ${markdownLinkForFile(path).trim()}`;
  };

  const createNoteFromComposer = async (parentMessageId: string | null) => {
    const conversation = selectedConversation();
    const content = parentMessageId ? threadComposerText().trim() : composerText().trim();
    if (!conversation || !content) return;
    setError(null);
    try {
      const noteMessageContent = await saveTeamNoteMessageContent(content, "Saved a long note");
      const message = await invoke<TeamMessage>("team_send_message", {
        req: {
          id: null,
          conversation_id: conversation.id,
          author_kind: "human",
          author_user_id: null,
          content: noteMessageContent,
          parent_message_id: parentMessageId,
          pty_session_id: null,
        },
      });
      if (parentMessageId) {
        setThreadComposerText("");
        await refreshThread(parentMessageId);
      } else {
        setComposerText("");
      }
      await refreshMessages(conversation.id);
      if (mentionedAgentHandles(noteMessageContent).length > 0) {
        const threadParentId = parentMessageId || message.id;
        setSelectedThreadParentId(threadParentId);
        await refreshThread(threadParentId);
      }
      await launchMentionedAgents(message, noteMessageContent, parentMessageId || message.id);
    } catch (err) {
      setError(String(err));
    }
  };

  const saveChannel = async () => {
    const name = channelName().trim();
    if (!name) return;
    setError(null);
    try {
      const channel = await invoke<TeamChannel>("team_save_channel", {
        req: {
          id: null,
          name,
          display_name: name.replace(/^#/, ""),
          description: null,
        },
      });
      setChannelName("");
      setCreateModal(null);
      await loadBase();
      await selectChannel(channel);
    } catch (err) {
      setError(String(err));
    }
  };

  const saveAgentFromModal = async () => {
    const username = newAgentUsername().trim();
    const displayName = newAgentDisplayName().trim() || username;
    const pwd = newAgentPwd().trim();
    const cmd = newAgentCmd().trim();
    if (!username || !pwd || !cmd) return;
    const existingAgentId = editingAgentId();
    setError(null);
    try {
      const saved = await invoke<TeamUser>("team_save_user", {
        req: {
          id: existingAgentId,
          username,
          display_name: displayName,
          avatar_color: null,
          pwd,
          cmd,
          description: null,
          enabled: true,
        },
      });
      setNewAgentUsername("");
      setNewAgentDisplayName("");
      setNewAgentPwd("");
      setNewAgentCmd(DEFAULT_TEAM_AGENT_CMD);
      setCreateModal(null);
      setEditingAgentId(null);
      await loadBase();
      if (!existingAgentId) {
        await selectDm(saved);
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const savePin = async (req: TeamPinInput) => {
    const saved = await invoke<TeamPin>("team_save_pin", { req });
    await refreshPins();
    return saved;
  };

  const savePinnedTarget = async () => {
    const target = pinTarget().trim();
    if (!target) return;
    setError(null);
    try {
      await savePin({
        id: null,
        kind: looksLikeUrl(target) ? "link" : "file",
        title: looksLikeUrl(target) ? target : basename(target),
        file_path: looksLikeUrl(target) ? null : target,
        url: looksLikeUrl(target) ? target : null,
        message_id: null,
      });
      setPinTarget("");
    } catch (err) {
      setError(String(err));
    }
  };

  const pinMessage = async (message: TeamMessage) => {
    setError(null);
    try {
      await savePin({
        id: null,
        kind: "message",
        title: compactText(message.content, 80),
        file_path: null,
        url: null,
        message_id: message.id,
      });
      setMessageMenu(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const deletePin = async (pin: TeamPin) => {
    setError(null);
    try {
      await invoke("team_delete_pin", { id: pin.id });
      await refreshPins();
    } catch (err) {
      setError(String(err));
    }
  };

  const openPin = async (pin: TeamPin) => {
    setError(null);
    try {
      if (pin.kind === "file" && pin.file_path) {
        if (app.canOpenPathInButter(pin.file_path)) {
          await app.openFileInButter(pin.file_path);
          app.setAppView("terminal");
          return;
        }
        await Command.create("open", [pin.file_path]).execute();
        return;
      }
      if (pin.kind === "link" && pin.url) {
        await Command.create("open", [pin.url]).execute();
        return;
      }
      if (pin.kind === "message" && pin.message_conversation_id && pin.message_id) {
        setSelection({ kind: "conversation", conversationId: pin.message_conversation_id });
        await refreshMessages(pin.message_conversation_id);
        if (pin.message_parent_message_id) {
          setSelectedThreadParentId(pin.message_parent_message_id);
          await refreshThread(pin.message_parent_message_id);
          await invoke("team_mark_thread_read", { parentMessageId: pin.message_parent_message_id });
        } else {
          setSelectedThreadParentId(null);
          setThreadMessages([]);
          await invoke("team_mark_message_read", { messageId: pin.message_id });
        }
        await refreshInbox();
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const pinSubtitle = (pin: TeamPin) => {
    if (pin.kind === "file") return pin.file_path || "";
    if (pin.kind === "link") return pin.url || "";
    return pin.message_preview ? compactText(pin.message_preview, 110) : "Pinned message";
  };

  const pinIcon = (pin: TeamPin) => {
    if (pin.kind === "file") return "F";
    if (pin.kind === "link") return "L";
    return "M";
  };

  const markInboxRead = async (messageId: string) => {
    await invoke("team_mark_message_read", { messageId });
    await refreshInbox();
  };

  const markInboxUnread = async (messageId: string) => {
    await invoke("team_mark_message_unread", { messageId });
    await refreshInbox();
  };

  const closeMessageMenuFromEvent = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(".team-message-menu") || target?.closest(".team-message-menu-button")) {
      return;
    }
    setMessageMenu(null);
  };

  const closeMessageMenuOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (createModal()) {
        closeCreateModal();
        return;
      }
      setComposerMenu(null);
      setMessageMenu(null);
    }
  };

  createEffect(() => {
    const requestId = app.teamSearchRequestId();
    if (requestId === lastTeamSearchRequestId) return;
    lastTeamSearchRequestId = requestId;
    openTeamSearch();
  });

  createEffect(() => {
    if (!teamSearchOpen()) return;
    requestAnimationFrame(() => {
      teamSearchInputRef?.focus();
      teamSearchInputRef?.select();
    });
  });

  createEffect(() => {
    const count = teamSearchItems().length;
    const index = teamSearchIndex();
    if (count === 0) {
      if (index !== 0) setTeamSearchIndex(0);
      return;
    }
    if (index >= count) {
      setTeamSearchIndex(count - 1);
    }
  });

  onMount(() => {
    const storedTeamRailWidth = Number(window.localStorage.getItem(TEAM_RAIL_WIDTH_STORAGE_KEY));
    if (Number.isFinite(storedTeamRailWidth) && storedTeamRailWidth > 0) {
      setTeamRailWidthClamped(storedTeamRailWidth, false);
    }
    const storedTeamSideWidth = Number(window.localStorage.getItem(TEAM_SIDE_WIDTH_STORAGE_KEY));
    if (Number.isFinite(storedTeamSideWidth) && storedTeamSideWidth > 0) {
      setTeamSideWidthClamped(storedTeamSideWidth, false);
    }
    void loadBase();
    void refreshSkills();
    void listen<PtyOutput>("pty-data", (event) => handlePtyData(event.payload)).then((unlisten) => {
      stopPtyListener = unlisten;
    });
    staleRunTimer = window.setInterval(() => {
      void failStaleRuns();
    }, 60_000);
    window.addEventListener("pointerdown", closeMessageMenuFromEvent);
    window.addEventListener("keydown", closeMessageMenuOnEscape);
  });

  onCleanup(() => {
    stopPtyListener?.();
    stopActiveTeamRailResize();
    stopActiveTeamSideResize();
    if (staleRunTimer) window.clearInterval(staleRunTimer);
    if (fileSearchTimer) window.clearTimeout(fileSearchTimer);
    clearTeamSearchTimer();
    window.removeEventListener("pointerdown", closeMessageMenuFromEvent);
    window.removeEventListener("keydown", closeMessageMenuOnEscape);
  });

  return (
    <main
      class={`team-mode ${selectedThreadParent() ? "has-team-side" : ""} ${resizingTeamRail() ? "resizing-team-rail" : ""} ${resizingTeamSide() ? "resizing-team-side" : ""}`}
      style={{
        "--team-rail-width": `${teamRailWidthPx()}px`,
        "--team-side-width": `${teamSideWidthPx()}px`,
      } as JSX.CSSProperties}
    >
      <aside class="team-rail">
        <div class="team-rail-header">
          <div class="team-product">Team Mode</div>
          <button
            class="team-icon-button team-search-button"
            onClick={openTeamSearch}
            title="Search Team Mode"
            aria-label="Search Team Mode"
          >
            Search
          </button>
        </div>

        <button
          class={`team-nav-item inbox ${selection().kind === "inbox" ? "active" : ""}`}
          onClick={() => void openInbox()}
        >
          <span>Inbox</span>
          <Show when={unreadInboxCount() > 0}>
            <span class="team-badge">{unreadInboxCount()}</span>
          </Show>
        </button>

        <div class="team-section-header">
          <div class="team-section-label">Channels</div>
          <button
            class="team-section-add"
            onClick={openCreateChannelModal}
            title="Create channel"
            aria-label="Create channel"
          >
            +
          </button>
        </div>
        <For each={channels()}>
          {(channel) => {
            const conversation = () => channelConversation(channel.id);
            const unread = () => (conversation() ? unreadByConversation()[conversation()!.id] || 0 : 0);
            const active = () =>
              selection().kind === "conversation" &&
              conversation()?.id === (selection() as { kind: "conversation"; conversationId: string }).conversationId;
            return (
              <button
                class={`team-nav-item ${active() ? "active" : ""}`}
                onClick={() => void selectChannel(channel)}
              >
                <span class="team-channel-name"># {channel.display_name}</span>
                <Show when={unread() > 0}>
                  <span class="team-badge">{unread()}</span>
                </Show>
              </button>
            );
          }}
        </For>

        <div class="team-section-header">
          <div class="team-section-label">DIRECT MESSAGE</div>
          <button
            class="team-section-add"
            onClick={openCreateAgentModal}
            title="Create agent"
            aria-label="Create agent"
          >
            +
          </button>
        </div>
        <For each={users()}>
          {(user) => (
            <button class="team-nav-item" onClick={() => void selectDm(user)}>
              <span class="team-avatar mini" style={{ "--team-avatar-color": user.avatar_color || "" }}>
                {user.display_name[0]?.toUpperCase() || "A"}
              </span>
              <span>{user.display_name}</span>
            </button>
          )}
        </For>

        <div class="team-section-label directory">Directory</div>
        <Show when={users().length > 0} fallback={<div class="team-directory-empty">No users yet.</div>}>
          <For each={users()}>
            {(user) => (
              <div class={`team-directory-row ${editingAgentId() === user.id ? "active" : ""}`}>
                <button class="team-directory-main" onClick={() => editAgent(user)}>
                  <span class="team-avatar mini" style={{ "--team-avatar-color": user.avatar_color || "" }}>
                    {user.display_name[0]?.toUpperCase() || "A"}
                  </span>
                  <span class="team-directory-text">
                    <span class="team-directory-name">{user.display_name}</span>
                    <span class="team-directory-handle">@{user.username}</span>
                  </span>
                </button>
                <button class="team-directory-edit" onClick={() => editAgent(user)}>
                  Edit
                </button>
              </div>
            )}
          </For>
        </Show>

        <div class="team-section-label pinned">Pinned</div>
        <Show when={pins().length > 0} fallback={<div class="team-pins-empty">No pinned objects.</div>}>
          <For each={pins()}>
            {(pin) => (
              <div class="team-pin-row">
                <button class="team-pin-main" onClick={() => void openPin(pin)}>
                  <span class={`team-pin-icon ${pin.kind}`}>{pinIcon(pin)}</span>
                  <span class="team-pin-text">
                    <span class="team-pin-title">{pin.title}</span>
                    <span class="team-pin-subtitle">{pinSubtitle(pin)}</span>
                  </span>
                </button>
                <button class="team-pin-remove" onClick={() => void deletePin(pin)} title="Remove pin">
                  x
                </button>
              </div>
            )}
          </For>
        </Show>
        <div class="team-inline-form team-pin-form">
          <input
            value={pinTarget()}
            onInput={(event) => setPinTarget(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void savePinnedTarget();
            }}
            placeholder="/path/to/file or https://"
            spellcheck={false}
          />
          <button onClick={() => void savePinnedTarget()} title="Pin file or link">+</button>
        </div>
      </aside>

      <div
        class="team-rail-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize left sidebar"
        title="Resize left sidebar"
        onPointerDown={startTeamRailResize}
      />

      <section class="team-main">
        <header class="team-main-header">
          <div>
            <div class="team-title">
              <Show when={selection().kind === "inbox"} fallback={selectedChannel() ? `# ${selectedChannel()!.display_name}` : selectedConversation()?.title || "DIRECT MESSAGE"}>
                Inbox
              </Show>
            </div>
            <div class="team-subtitle">
              <Show
                when={selection().kind === "inbox"}
                fallback="Mention an agent to start a threaded run."
              >
                {inboxMode() === "recent"
                  ? "Recent direct messages, mentions, and thread replies across Team Mode."
                  : "Unread direct messages, mentions, and thread replies across Team Mode."}
              </Show>
            </div>
          </div>
          <Show when={selection().kind === "inbox"}>
            <div class="team-inbox-mode" role="tablist" aria-label="Inbox view">
              <button
                class={inboxMode() === "unread" ? "active" : ""}
                onClick={() => void selectInboxMode("unread")}
                aria-selected={inboxMode() === "unread"}
              >
                Unread
              </button>
              <button
                class={inboxMode() === "recent" ? "active" : ""}
                onClick={() => void selectInboxMode("recent")}
                aria-selected={inboxMode() === "recent"}
              >
                Recent
              </button>
            </div>
          </Show>
          <Show when={loading()}>
            <span class="team-status">Loading</span>
          </Show>
        </header>

        <Show when={error()}>
          {(message) => <div class="team-error">{message()}</div>}
        </Show>

        <Show
          when={selection().kind !== "inbox"}
          fallback={
            <div class="team-inbox-list">
              <Show when={inbox().length === 0}>
                <div class="team-empty">
                  {inboxMode() === "recent" ? "No recent inbox items." : "Inbox is clear."}
                </div>
              </Show>
              <For each={inbox()}>
                {(item) => (
                  <div
                    class={`team-inbox-row ${item.read_at === null ? "unread" : "read"}`}
                    onClick={() => void openInboxItem(item)}
                  >
                    <div class="team-inbox-source">
                      {item.channel ? `# ${item.channel.display_name}` : item.conversation.title || "DIRECT MESSAGE"}
                      <Show when={item.parent_message}> · thread</Show>
                    </div>
                    <div class="team-inbox-title-row">
                      <div class="team-inbox-title">{item.author?.display_name || "Agent"}</div>
                      <span class={`team-inbox-state ${item.read_at === null ? "unread" : "read"}`}>
                        {item.read_at === null ? "Unread" : "Read"}
                      </span>
                    </div>
                    <div class="team-inbox-preview">{compactText(item.message.content)}</div>
                    <div class="team-inbox-actions">
                      <button
                        class="team-message-menu-button inbox"
                        onClick={(event) => openMessageMenu(event, item.message)}
                        title="Message actions"
                        aria-label="Message actions"
                      >
                        ...
                      </button>
                      <Show
                        when={item.read_at === null}
                        fallback={
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              void markInboxUnread(item.message.id);
                            }}
                          >
                            Mark unread
                          </button>
                        }
                      >
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            void markInboxRead(item.message.id);
                          }}
                        >
                          Mark read
                        </button>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          }
        >
          <div class="team-message-list">
            <Show when={messages().length === 0}>
              <div class="team-empty">No messages yet.</div>
            </Show>
            <For each={messages()}>
              {(message) => (
                <>
                  <MessageArticle message={message} />
                  <For each={pendingRunsForParent(message.id)}>
                    {(run) => <AgentAcknowledgement run={run} />}
                  </For>
                </>
              )}
            </For>
          </div>
          <TeamComposer
            id="main"
            parentMessageId={() => null}
            value={composerText}
            setValue={setComposerText}
            placeholder="Message #general, type @ for users/files or / for skills"
          />
        </Show>
      </section>

      <Show when={selectedThreadParent()}>
        {(parent) => (
          <aside class="team-side">
            <div
              class="team-side-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize thread sidebar"
              title="Resize thread sidebar"
              onPointerDown={startTeamSideResize}
            />
            <div class="team-thread">
              <div class="team-thread-header">
                <div>
                  <div class="team-panel-title">Thread</div>
                  <div class="team-thread-parent">{compactText(parent().content, 90)}</div>
                </div>
                <button class="team-icon-button" onClick={() => setSelectedThreadParentId(null)} title="Close thread">
                  x
                </button>
              </div>
              <div class="team-thread-list">
                <For each={threadMessages()}>
                  {(message) => <MessageArticle message={message} compact />}
                </For>
                <For each={pendingRunsForParent(parent().id)}>
                  {(run) => <AgentAcknowledgement run={run} compact />}
                </For>
              </div>
              <TeamComposer
                id="thread"
                parentMessageId={() => parent().id}
                value={threadComposerText}
                setValue={setThreadComposerText}
                placeholder="Reply in thread, type @ for users/files or / for skills"
              />
            </div>
          </aside>
        )}
      </Show>

      <Show when={createModal()}>
        {(modal) => (
          <div class="modal-overlay team-create-overlay" onClick={closeCreateModal}>
            <div
              class="team-create-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="team-create-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div class="team-create-header">
                <div>
                  <div id="team-create-title" class="team-create-title">
                    {modal() === "channel" ? "New channel" : editingAgentId() ? "Edit agent" : "New agent"}
                  </div>
                  <div class="team-create-subtitle">
                    {modal() === "channel" ? "Channels" : editingAgent() ? `@${editingAgent()!.username}` : "DIRECT MESSAGE"}
                  </div>
                </div>
                <button
                  class="team-create-close"
                  onClick={closeCreateModal}
                  type="button"
                  title="Close"
                  aria-label="Close"
                >
                  x
                </button>
              </div>

              <Show
                when={modal() === "channel"}
                fallback={
                  <form
                    class="team-create-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveAgentFromModal();
                    }}
                  >
                    <label>
                      <span>Username</span>
                      <input
                        value={newAgentUsername()}
                        onInput={(event) => setNewAgentUsername(event.currentTarget.value)}
                        placeholder="molly"
                        spellcheck={false}
                        autofocus
                      />
                    </label>
                    <label>
                      <span>Display name</span>
                      <input
                        value={newAgentDisplayName()}
                        onInput={(event) => setNewAgentDisplayName(event.currentTarget.value)}
                        placeholder="molly"
                        spellcheck={false}
                      />
                    </label>
                    <label>
                      <span>Start path</span>
                      <input
                        value={newAgentPwd()}
                        onInput={(event) => setNewAgentPwd(event.currentTarget.value)}
                        placeholder="/path/to/start"
                        spellcheck={false}
                      />
                    </label>
                    <label>
                      <span>Command</span>
                      <input
                        value={newAgentCmd()}
                        onInput={(event) => setNewAgentCmd(event.currentTarget.value)}
                        placeholder={DEFAULT_TEAM_AGENT_CMD}
                        spellcheck={false}
                      />
                    </label>
                    <div class="team-create-actions">
                      <button type="button" onClick={closeCreateModal}>
                        Cancel
                      </button>
                      <button
                        class="primary"
                        type="submit"
                        disabled={!newAgentUsername().trim() || !newAgentPwd().trim() || !newAgentCmd().trim()}
                      >
                        {editingAgentId() ? "Save" : "Create"}
                      </button>
                    </div>
                  </form>
                }
              >
                <form
                  class="team-create-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveChannel();
                  }}
                >
                  <label>
                    <span>Name</span>
                    <input
                      value={channelName()}
                      onInput={(event) => setChannelName(event.currentTarget.value)}
                      placeholder="new-channel"
                      spellcheck={false}
                      autofocus
                    />
                  </label>
                  <div class="team-create-actions">
                    <button type="button" onClick={closeCreateModal}>
                      Cancel
                    </button>
                    <button class="primary" type="submit" disabled={!channelName().trim()}>
                      Create
                    </button>
                  </div>
                </form>
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show when={teamSearchOpen()}>
        <PaletteDialog
          placeholder="Search Team Mode messages..."
          value={teamSearchQuery()}
          items={teamSearchItems()}
          activeIndex={teamSearchIndex()}
          emptyText={teamSearchEmptyContent()}
          loadingText={teamSearchLoading() ? "Searching..." : undefined}
          errorText={teamSearchError()}
          setInputRef={(el) => {
            teamSearchInputRef = el;
          }}
          onInput={updateTeamSearchQuery}
          onActiveIndexChange={setTeamSearchIndex}
          onSelect={(item) => void openTeamSearchResult(item)}
          onClose={closeTeamSearch}
        />
      </Show>

      <Show when={messageMenu()}>
        {(menu) => {
          const message = () => findMessageById(menu().messageId);
          const sessionId = () => {
            const current = message();
            return current ? agentSessionIdForMessage(current) : null;
          };
          return (
            <div
              class="team-message-menu"
              style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
            >
              <button
                onClick={() => {
                  const current = message();
                  if (current) void copyToClipboard(current.content);
                }}
              >
                Copy full message
              </button>
              <button
                onClick={() => {
                  const current = message();
                  if (current) void pinMessage(current);
                }}
              >
                Pin message
              </button>
              <button
                onClick={() => {
                  const current = message();
                  if (current) {
                    void markInboxUnread(current.id).finally(() => setMessageMenu(null));
                  }
                }}
              >
                Mark unread
              </button>
              <Show when={sessionId()}>
                {(value) => (
                  <button onClick={() => void copyToClipboard(value())}>
                    Copy agent session id
                  </button>
                )}
              </Show>
            </div>
          );
        }}
      </Show>
    </main>
  );
}
