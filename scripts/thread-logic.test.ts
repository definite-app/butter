// Unit tests for 1thread @agent mentions and search. Run: npm run test:composer
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentHandle,
  assignHandles,
  filterHandles,
  findMention,
  insertMention,
  mentionAtCaret,
  stripMention,
} from "../src/features/thread/mentions.ts";
import { matchesTerms, parseSearchQuery, searchSnippet } from "../src/features/thread/search.ts";

test("agentHandle slugs preset names", () => {
  assert.equal(agentHandle("CC Mike3"), "cc-mike3");
  assert.equal(agentHandle("  Codex (yolo)! "), "codex-yolo");
  assert.equal(agentHandle("🦀"), "agent");
});

test("assignHandles keeps handles unique", () => {
  const handles = assignHandles([
    { name: "Claude", value: 0 },
    { name: "claude", value: 1 },
    { name: "Claude!", value: 2 },
  ]).map((h) => h.handle);
  assert.deepEqual(handles, ["claude", "claude-2", "claude-3"]);
});

test("mentionAtCaret finds the token being typed", () => {
  assert.deepEqual(mentionAtCaret("@cc", 3), { start: 0, end: 3, query: "cc" });
  assert.deepEqual(mentionAtCaret("hi @", 4), { start: 3, end: 4, query: "" });
  assert.equal(mentionAtCaret("mike@cc", 7), null);
  assert.equal(mentionAtCaret("hi cc", 5), null);
});

test("filterHandles ranks prefix matches first", () => {
  const items = [{ handle: "codex-mike3" }, { handle: "cc-mike3" }, { handle: "mike" }];
  assert.deepEqual(
    filterHandles(items, "mi").map((i) => i.handle),
    ["mike", "codex-mike3", "cc-mike3"]
  );
});

test("insertMention completes the handle and adds a space", () => {
  assert.deepEqual(insertMention("@cc", { start: 0, end: 3, query: "cc" }, "cc-mike3"), {
    text: "@cc-mike3 ",
    caret: 10,
  });
  assert.deepEqual(insertMention("@cc fix it", { start: 0, end: 3, query: "cc" }, "cc-mike3"), {
    text: "@cc-mike3 fix it",
    caret: 10,
  });
});

test("findMention and stripMention pull the agent out of the message", () => {
  const handles = ["claude", "cc-mike3"];
  const text = "check the weather @cc-mike3. thanks";
  const mention = findMention(text, handles);
  assert.deepEqual(mention, { handle: "cc-mike3", start: 18, end: 27 });
  assert.equal(stripMention(text, mention!), "check the weather . thanks");
  assert.equal(findMention("email mike@cc-mike3", handles), null);
  assert.equal(findMention("@nobody hi", handles), null);
  const lead = findMention("@CC-Mike3 fix the build", handles)!;
  assert.equal(stripMention("@CC-Mike3 fix the build", lead), "fix the build");
});

// ----- search -----

test("parseSearchQuery pulls out filters", () => {
  assert.deepEqual(parseSearchQuery("Eagles @CC-Mike3 from:me is:pinned odds", ["claude", "cc-mike3"]), {
    terms: ["eagles", "odds"],
    agent: "cc-mike3",
    from: "me",
    pinned: true,
  });
  // An unknown @word is just a search term.
  assert.deepEqual(parseSearchQuery("@nobody", ["claude"]).terms, ["@nobody"]);
});

test("matchesTerms needs every term", () => {
  assert.equal(matchesTerms("The Eagles play Sunday", ["eagles", "sunday"]), true);
  assert.equal(matchesTerms("The Eagles play Sunday", ["eagles", "monday"]), false);
});

test("searchSnippet highlights matches and trims long text", () => {
  assert.deepEqual(searchSnippet("Barkley is out", ["barkley"]), [
    { text: "Barkley", hit: true },
    { text: " is out", hit: false },
  ]);
  const long = `${"word ".repeat(40)}Barkley is out ${"tail ".repeat(60)}`;
  const parts = searchSnippet(long, ["barkley"], 20);
  assert.equal(parts[0].text, "…");
  assert.equal(parts.at(-1)?.text, "…");
  assert.ok(parts.some((p) => p.hit && p.text === "Barkley"));
});
