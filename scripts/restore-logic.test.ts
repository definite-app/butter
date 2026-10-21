// Unit tests for restoring file tabs and pinned apps after a relaunch. Run: npm run test:composer
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeTabAfterRemoval,
  appRestoreUrl,
  buildRestoreState,
  emptyRestoreState,
  MAX_SAVED_CLOSED_SESSIONS,
  parseRestoreState,
  pinnedTabsToRestore,
  planAppRestore,
  serializeRestoreState,
  sessionTabsToRestore,
  type LiveWorkspace,
  type WorkspaceRestoreState,
} from "../src/features/files/restore.ts";

const readme = { id: "t1", path: "/repo/README.md", kind: "text_file" as const, markdownView: "preview" as const };
const main = { id: "t2", path: "/repo/src/main.ts", kind: "text_file" as const };
const logo = { id: "t3", path: "/repo/logo.png", kind: "image_file" as const };
const notes = { id: "p1", path: "/notes/todo.md", kind: "text_file" as const };

const live = (overrides: Partial<LiveWorkspace> = {}): LiveWorkspace => ({
  sessionIds: [],
  sessions: {},
  pinned: [],
  apps: [],
  activeAppId: null,
  appsRestored: true,
  ...overrides,
});

test("serialize and parse round-trip", () => {
  const state = buildRestoreState(
    live({
      sessionIds: ["s1", "s2"],
      sessions: { s1: { tabs: [readme, main, logo], activeTabId: "t2" }, s2: { tabs: [], activeTabId: "p1" } },
      pinned: [notes],
      apps: [{ id: "gmail", url: "https://mail.google.com/mail/u/0/#inbox" }],
      activeAppId: "gmail",
    }),
    emptyRestoreState(),
    1000,
  );
  const parsed = parseRestoreState(serializeRestoreState(state));
  assert.deepEqual(parsed, state);
  assert.deepEqual(parsed.sessions.s1.tabs, [readme, main, logo]);
  assert.equal(parsed.sessions.s1.activeTabId, "t2");
  assert.equal(parsed.sessions.s2.activeTabId, "p1");
  assert.deepEqual(parsed.pinned, [notes]);
});

test("malformed stored state becomes empty", () => {
  assert.deepEqual(parseRestoreState(null), emptyRestoreState());
  assert.deepEqual(parseRestoreState("not json"), emptyRestoreState());
  assert.deepEqual(parseRestoreState("[]"), emptyRestoreState());
  assert.deepEqual(parseRestoreState('{"version":2,"pinned":[]}'), emptyRestoreState());
  const partial = parseRestoreState(
    JSON.stringify({
      version: 1,
      pinned: [notes, { id: "x", path: "", kind: "text_file" }, { id: "y", path: "/a", kind: "pdf" }, notes],
      sessions: { s1: "nope", s2: { tabs: [main], activeTabId: 7 } },
      apps: [{ id: "gmail", url: 3 }, { id: "gmail", url: "https://x" }, { nope: true }],
      activeAppId: 5,
    }),
  );
  assert.deepEqual(partial.pinned, [notes]);
  assert.deepEqual(Object.keys(partial.sessions), ["s2"]);
  assert.equal(partial.sessions.s2.activeTabId, null);
  assert.deepEqual(partial.apps, [{ id: "gmail", url: "" }]);
  assert.equal(partial.activeAppId, null);
});

test("closed terminals keep their tabs; open ones follow the live state", () => {
  const first = buildRestoreState(
    live({ sessionIds: ["s1", "s2"], sessions: { s1: { tabs: [main], activeTabId: null }, s2: { tabs: [logo], activeTabId: "t3" } } }),
    emptyRestoreState(),
    1000,
  );
  // s2 closed; s1 closed all its tabs.
  const second = buildRestoreState(live({ sessionIds: ["s1"], sessions: { s1: { tabs: [], activeTabId: null } } }), first, 2000);
  assert.equal(second.sessions.s1, undefined);
  assert.deepEqual(second.sessions.s2, first.sessions.s2);
});

test("savedAt only moves when an entry changes", () => {
  const entry = { tabs: [main], activeTabId: null };
  const first = buildRestoreState(live({ sessionIds: ["s1"], sessions: { s1: entry } }), emptyRestoreState(), 1000);
  const same = buildRestoreState(live({ sessionIds: ["s1"], sessions: { s1: entry } }), first, 5000);
  assert.equal(same.sessions.s1.savedAt, 1000);
  assert.equal(serializeRestoreState(same), serializeRestoreState(first));
  const changed = buildRestoreState(live({ sessionIds: ["s1"], sessions: { s1: { tabs: [main], activeTabId: "t2" } } }), same, 6000);
  assert.equal(changed.sessions.s1.savedAt, 6000);
});

test("only the newest closed terminals are kept", () => {
  const previous: WorkspaceRestoreState = emptyRestoreState();
  for (let i = 0; i < MAX_SAVED_CLOSED_SESSIONS + 5; i += 1) {
    previous.sessions[`old${i}`] = { tabs: [main], activeTabId: null, savedAt: i };
  }
  const next = buildRestoreState(live({ sessionIds: ["s1"], sessions: { s1: { tabs: [logo], activeTabId: null } } }), previous, 9999);
  assert.equal(Object.keys(next.sessions).length, MAX_SAVED_CLOSED_SESSIONS + 1);
  assert.ok(next.sessions.s1);
  assert.ok(!next.sessions.old0);
  assert.ok(next.sessions[`old${MAX_SAVED_CLOSED_SESSIONS + 4}`]);
});

test("saved apps are carried over until the app restore has run", () => {
  const previous = emptyRestoreState();
  previous.apps = [{ id: "gmail", url: "https://mail.google.com/mail/u/0/#inbox" }];
  previous.activeAppId = "gmail";
  const before = buildRestoreState(live({ appsRestored: false }), previous, 1);
  assert.deepEqual(before.apps, previous.apps);
  assert.equal(before.activeAppId, "gmail");
  const after = buildRestoreState(live({ appsRestored: true }), previous, 1);
  assert.deepEqual(after.apps, []);
  assert.equal(after.activeAppId, null);
});

test("pinned tabs keep their order and drop duplicates", () => {
  const state = emptyRestoreState();
  state.pinned = [notes, readme, { ...notes, id: "p2" }];
  assert.deepEqual(pinnedTabsToRestore(state), [notes, readme]);
});

test("a reopened terminal's tabs skip what's already open", () => {
  const state = emptyRestoreState();
  state.sessions.s1 = { tabs: [readme, main, logo], activeTabId: "t2", savedAt: 1 };
  const restored = sessionTabsToRestore(state, "s1", { ids: ["t3"], paths: ["/repo/README.md"], pinnedIds: [] });
  assert.deepEqual(restored.tabs, [main]);
  assert.equal(restored.activeTabId, "t2");
  // Active tab was the one now left out: show the terminal.
  const gone = sessionTabsToRestore(state, "s1", { ids: [], paths: ["/repo/src/main.ts"], pinnedIds: [] });
  assert.deepEqual(gone.tabs, [readme, logo]);
  assert.equal(gone.activeTabId, null);
  assert.deepEqual(sessionTabsToRestore(state, "nope", { ids: [], paths: [], pinnedIds: [] }), {
    tabs: [],
    activeTabId: null,
  });
});

test("a reopened terminal can come back on a pinned tab", () => {
  const state = emptyRestoreState();
  state.sessions.s1 = { tabs: [], activeTabId: "p1", savedAt: 1 };
  assert.equal(sessionTabsToRestore(state, "s1", { ids: ["p1"], paths: [], pinnedIds: ["p1"] }).activeTabId, "p1");
  // The pinned tab didn't come back (file gone).
  assert.equal(sessionTabsToRestore(state, "s1", { ids: [], paths: [], pinnedIds: [] }).activeTabId, null);
});

test("removing the active tab moves to the tab on its left, else the terminal", () => {
  assert.equal(activeTabAfterRemoval(["a", "b", "c"], "b", "b"), "a");
  assert.equal(activeTabAfterRemoval(["a", "b", "c"], "a", "a"), null);
  assert.equal(activeTabAfterRemoval(["a", "b", "c"], "c", "a"), "a");
  assert.equal(activeTabAfterRemoval(["a"], "a", null), null);
});

test("apps reopen at their last page only on the app's own origin", () => {
  const app = "https://mail.google.com/mail/u/0/";
  assert.equal(appRestoreUrl(app, "https://mail.google.com/mail/u/0/#inbox/abc"), "https://mail.google.com/mail/u/0/#inbox/abc");
  assert.equal(appRestoreUrl(app, "https://accounts.google.com/signin"), app);
  assert.equal(appRestoreUrl(app, "http://mail.google.com/mail"), app);
  assert.equal(appRestoreUrl(app, "javascript:alert(1)"), app);
  assert.equal(appRestoreUrl(app, "about:blank"), app);
  assert.equal(appRestoreUrl(app, ""), app);
  assert.equal(appRestoreUrl(app, null), app);
});

test("app restore skips apps removed from browser.toml", () => {
  const state = emptyRestoreState();
  state.apps = [
    { id: "gmail", url: "https://mail.google.com/mail/u/0/#inbox" },
    { id: "gone", url: "https://example.com/" },
    { id: "cal", url: "https://evil.example/" },
  ];
  state.activeAppId = "gone";
  const configured = [
    { id: "cal", url: "https://calendar.google.com/" },
    { id: "gmail", url: "https://mail.google.com/mail/u/0/" },
  ];
  const plan = planAppRestore(state, configured);
  assert.deepEqual(plan.apps, [
    { id: "gmail", url: "https://mail.google.com/mail/u/0/#inbox" },
    { id: "cal", url: "https://calendar.google.com/" },
  ]);
  assert.equal(plan.onScreenAppId, null);
  state.activeAppId = "gmail";
  assert.equal(planAppRestore(state, configured).onScreenAppId, "gmail");
});
