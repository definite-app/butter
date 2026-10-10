// Unit tests for 1thread @agent mentions. Run: npm run test:composer
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
