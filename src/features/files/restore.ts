// Pure logic for bringing file tabs and pinned web apps back after a relaunch.
// The state is one JSON value in the DB's app_state table (per flavor:
// ~/.butter/agent.db, ~/.butter-dev/agent.db), written as it changes.
// Tests: scripts/restore-logic.test.ts (npm run test:composer).

/** app_state key holding the serialized WorkspaceRestoreState. */
export const WORKSPACE_RESTORE_STATE_KEY = "workspace_restore_v1";

/** Closed terminals whose tabs are kept for a later reopen (Recently Closed). */
export const MAX_SAVED_CLOSED_SESSIONS = 50;

export type SavedFileTabKind = "text_file" | "image_file";

export interface SavedFileTab {
  id: string;
  path: string;
  kind: SavedFileTabKind;
  /** Markdown tabs only; missing means source view. */
  markdownView?: "preview";
}

export interface SavedSessionTabs {
  tabs: SavedFileTab[];
  /** Id of the tab on screen in that terminal: one of its tabs, a pinned tab, or null for the terminal. */
  activeTabId: string | null;
  /** When this entry last changed (ms); orders closed terminals for pruning. */
  savedAt: number;
}

export interface SavedApp {
  id: string;
  /** Last URL the app's webview was on. */
  url: string;
}

export interface WorkspaceRestoreState {
  version: 1;
  pinned: SavedFileTab[];
  sessions: Record<string, SavedSessionTabs>;
  /** Pinned web apps whose webview was open. */
  apps: SavedApp[];
  /** The app on screen at quit; null when a terminal (or another view) was. */
  activeAppId: string | null;
}

export const emptyRestoreState = (): WorkspaceRestoreState => ({
  version: 1,
  pinned: [],
  sessions: {},
  apps: [],
  activeAppId: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseTab = (value: unknown): SavedFileTab | null => {
  if (!isRecord(value)) return null;
  const { id, path, kind, markdownView } = value;
  if (typeof id !== "string" || !id || typeof path !== "string" || !path) return null;
  if (kind !== "text_file" && kind !== "image_file") return null;
  const tab: SavedFileTab = { id, path, kind };
  if (markdownView === "preview") tab.markdownView = "preview";
  return tab;
};

/** Drops repeated ids and paths, keeping the first. */
const uniqueTabs = (tabs: SavedFileTab[], taken?: { ids: Set<string>; paths: Set<string> }) => {
  const ids = new Set(taken?.ids);
  const paths = new Set(taken?.paths);
  const out: SavedFileTab[] = [];
  for (const tab of tabs) {
    if (ids.has(tab.id) || paths.has(tab.path)) continue;
    ids.add(tab.id);
    paths.add(tab.path);
    out.push(tab);
  }
  return out;
};

const parseTabs = (value: unknown): SavedFileTab[] =>
  Array.isArray(value)
    ? uniqueTabs(value.map(parseTab).filter((tab): tab is SavedFileTab => tab !== null))
    : [];

/** Reads the stored JSON. Anything malformed becomes empty instead of throwing. */
export const parseRestoreState = (raw: string | null | undefined): WorkspaceRestoreState => {
  const state = emptyRestoreState();
  if (!raw) return state;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return state;
  state.pinned = parseTabs(parsed.pinned);
  if (isRecord(parsed.sessions)) {
    for (const [sessionId, entry] of Object.entries(parsed.sessions)) {
      if (!isRecord(entry)) continue;
      const tabs = parseTabs(entry.tabs);
      const activeTabId = typeof entry.activeTabId === "string" ? entry.activeTabId : null;
      if (tabs.length === 0 && activeTabId === null) continue;
      const savedAt = typeof entry.savedAt === "number" && Number.isFinite(entry.savedAt) ? entry.savedAt : 0;
      state.sessions[sessionId] = { tabs, activeTabId, savedAt };
    }
  }
  if (Array.isArray(parsed.apps)) {
    const seen = new Set<string>();
    for (const app of parsed.apps) {
      if (!isRecord(app) || typeof app.id !== "string" || !app.id || seen.has(app.id)) continue;
      seen.add(app.id);
      state.apps.push({ id: app.id, url: typeof app.url === "string" ? app.url : "" });
    }
  }
  state.activeAppId = typeof parsed.activeAppId === "string" ? parsed.activeAppId : null;
  return state;
};

export const serializeRestoreState = (state: WorkspaceRestoreState): string => JSON.stringify(state);

export interface LiveSessionTabs {
  tabs: SavedFileTab[];
  /** Null when the terminal itself is on screen. */
  activeTabId: string | null;
}

export interface LiveWorkspace {
  /** Every open terminal, with or without file tabs. */
  sessionIds: string[];
  /** File tabs and active tab of open terminals (missing: none). */
  sessions: Record<string, LiveSessionTabs>;
  pinned: SavedFileTab[];
  /** Open app webviews, plus apps waiting to be reopened lazily. */
  apps: SavedApp[];
  activeAppId: string | null;
  /** False until the saved apps have been handed to the app restore; until then they're carried over. */
  appsRestored: boolean;
}

const sameEntry = (a: SavedSessionTabs, b: LiveSessionTabs) =>
  a.activeTabId === b.activeTabId && JSON.stringify(a.tabs) === JSON.stringify(b.tabs);

/**
 * The state to store now. Open terminals are written from the live state.
 * Terminals not open now keep their earlier entry, so a terminal closed this
 * run (or not reopened yet) still has its tabs when it's reopened; only the
 * newest MAX_SAVED_CLOSED_SESSIONS of those are kept.
 */
export const buildRestoreState = (
  live: LiveWorkspace,
  previous: WorkspaceRestoreState,
  now: number,
): WorkspaceRestoreState => {
  const liveIds = new Set(live.sessionIds);
  const sessions: Record<string, SavedSessionTabs> = {};
  for (const sessionId of live.sessionIds) {
    const entry = live.sessions[sessionId];
    if (!entry || (entry.tabs.length === 0 && entry.activeTabId === null)) continue;
    const before = previous.sessions[sessionId];
    sessions[sessionId] = {
      tabs: entry.tabs,
      activeTabId: entry.activeTabId,
      savedAt: before && sameEntry(before, entry) ? before.savedAt : now,
    };
  }
  const closed = Object.entries(previous.sessions)
    .filter(([sessionId]) => !liveIds.has(sessionId))
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, MAX_SAVED_CLOSED_SESSIONS);
  for (const [sessionId, entry] of closed) sessions[sessionId] = entry;
  return {
    version: 1,
    pinned: uniqueTabs(live.pinned),
    sessions,
    apps: live.appsRestored ? live.apps : previous.apps,
    activeAppId: live.appsRestored ? live.activeAppId : previous.activeAppId,
  };
};

/** Pinned tabs to reopen at launch, in order. */
export const pinnedTabsToRestore = (state: WorkspaceRestoreState): SavedFileTab[] => uniqueTabs(state.pinned);

/**
 * A reopened terminal's tabs. Tabs already open elsewhere (a pinned tab, or
 * the same id/path) are left out. The active tab stays if it's one of these
 * tabs or a pinned tab; otherwise the terminal is shown.
 */
export const sessionTabsToRestore = (
  state: WorkspaceRestoreState,
  sessionId: string,
  open: { ids: Iterable<string>; paths: Iterable<string>; pinnedIds: Iterable<string> },
): LiveSessionTabs => {
  const entry = state.sessions[sessionId];
  if (!entry) return { tabs: [], activeTabId: null };
  const tabs = uniqueTabs(entry.tabs, { ids: new Set(open.ids), paths: new Set(open.paths) });
  const pinnedIds = new Set(open.pinnedIds);
  const active = entry.activeTabId;
  const activeTabId =
    active !== null && (tabs.some((tab) => tab.id === active) || pinnedIds.has(active)) ? active : null;
  return { tabs, activeTabId };
};

/**
 * Where a terminal's view goes when one of its tabs is removed: the tab to its
 * left, else the terminal (null). Matches closing a tab by hand.
 */
export const activeTabAfterRemoval = (
  tabIds: string[],
  removedId: string,
  activeTabId: string | null,
): string | null => {
  if (activeTabId !== removedId) return activeTabId;
  const index = tabIds.indexOf(removedId);
  return index > 0 ? tabIds[index - 1] : null;
};

const httpOrigin = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
};

/** The app's last URL when it's on the app's own origin, else the app's url. */
export const appRestoreUrl = (appUrl: string, lastUrl: string | null | undefined): string => {
  if (!lastUrl) return appUrl;
  const origin = httpOrigin(appUrl);
  return origin !== null && httpOrigin(lastUrl) === origin ? lastUrl : appUrl;
};

export interface AppRestorePlan {
  /** Apps to reopen, with the URL to open each at. */
  apps: SavedApp[];
  /** The app to show (it was on screen at quit), or null. */
  onScreenAppId: string | null;
}

/** Saved apps still in browser.toml, each at its restore URL. */
export const planAppRestore = (
  state: WorkspaceRestoreState,
  configured: { id: string; url: string }[],
): AppRestorePlan => {
  const byId = new Map(configured.map((app) => [app.id, app]));
  const apps: SavedApp[] = [];
  for (const saved of state.apps) {
    const app = byId.get(saved.id);
    if (!app) continue;
    apps.push({ id: app.id, url: appRestoreUrl(app.url, saved.url) });
  }
  const onScreen = state.activeAppId;
  return {
    apps,
    onScreenAppId: onScreen !== null && apps.some((app) => app.id === onScreen) ? onScreen : null,
  };
};
