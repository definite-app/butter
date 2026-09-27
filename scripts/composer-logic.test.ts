// Unit tests for the composer's pure logic. Run: npm run test:composer
// (Node >= 22.18 / 23.6 strips the TypeScript types natively.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyExternalScores,
  currentWord,
  fuzzyScore,
  isRemoteCommand,
  matchScore,
  minScoreFor,
  matchSessions,
  planSend,
  prefixCompletion,
  rankLocal,
  poolBySection,
  recencyBoost,
  type Suggestion,
} from "../src/features/composer/logic.ts";

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const DAY = 86_400_000;

const s = (id: string, section: Suggestion["section"], matchText: string, timestamp?: number): Suggestion => ({
  id,
  section,
  label: matchText,
  hint: "",
  matchText,
  value: matchText,
  timestamp,
});

test("currentWord takes the token before the cursor", () => {
  assert.deepEqual(currentWord("fix @src/app"), { word: "@src/app", start: 4 });
  assert.deepEqual(currentWord("run /myto"), { word: "/myto", start: 4 });
  assert.deepEqual(currentWord("ends with space "), { word: "", start: 16 });
});

test("fuzzyScore prefers exact, then prefix/boundary, then subsequence", () => {
  const exact = fuzzyScore("mna", "mna");
  const prefix = fuzzyScore("mna", "mna-research");
  const inner = fuzzyScore("mna", "xxmnaxx");
  const subseq = fuzzyScore("mna", "my-new-app");
  assert.ok(exact > prefix && prefix > inner && inner > subseq && subseq > 0);
  assert.equal(fuzzyScore("zzz", "mna"), 0);
});

test("recencyBoost halves every week", () => {
  assert.equal(recencyBoost(NOW, NOW), 1);
  assert.ok(Math.abs(recencyBoost(NOW - 7 * DAY, NOW) - 0.5) < 1e-9);
  assert.equal(recencyBoost(undefined, NOW), 0);
});

test("rankLocal groups by section, drops non-matches, caps sections", () => {
  const rows = rankLocal(
    [
      s("d1", "drafts", "mna todo: update fit scores", NOW - DAY),
      s("a1", "actions", "mytodos personal todo tracker"),
      s("f1", "files", "data/mna/companies.db"),
      s("f2", "files", "data/todos/todos.db"),
      s("f3", "files", "unrelated.txt"),
      s("x1", "send", "mna"),
      s("f4", "files", "todo-1.md"),
      s("f5", "files", "todo-2.md"),
    ],
    "todo",
    NOW
  );
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes("f3"), "non-match dropped");
  assert.ok(!ids.includes("x1"), "non-match dropped");
  assert.deepEqual(
    rows.map((r) => r.section),
    [...rows.map((r) => r.section)].sort(
      (a, b) => ["send", "files", "actions", "drafts"].indexOf(a) - ["send", "files", "actions", "drafts"].indexOf(b)
    ),
    "sections in fixed order"
  );
  assert.equal(rows.filter((r) => r.section === "files").length, 3, "files capped at 3");
});

test("rankLocal uses recency to break ties", () => {
  const rows = rankLocal(
    [s("old", "drafts", "deploy the api", NOW - 60 * DAY), s("new", "drafts", "deploy the api", NOW - DAY)],
    "deploy",
    NOW
  );
  assert.deepEqual(rows.map((r) => r.id), ["new", "old"]);
});

test("applyExternalScores reorders inside sections only", () => {
  const rows = [s("f1", "files", "a"), s("f2", "files", "b"), s("a1", "actions", "c"), s("a2", "actions", "d")];
  const out = applyExternalScores(rows, new Map([["f2", 0.9], ["f1", 0.1], ["a2", 0.7]]));
  assert.deepEqual(out.map((r) => r.id), ["f2", "f1", "a2", "a1"]);
});

test("prefixCompletion completes the current line from the newest earlier draft", () => {
  const drafts = ["mna todos: list what is open this week", "mna todo: update fit scores"];
  assert.equal(prefixCompletion("mna todo", drafts), "s: list what is open this week");
  assert.equal(prefixCompletion("MNA TODO", drafts), "s: list what is open this week");
  assert.equal(prefixCompletion("mn", drafts), "", "needs 3+ chars");
  assert.equal(prefixCompletion("zzz", drafts), "");
  assert.equal(prefixCompletion("second", ["first line\nsecond line here"]), " line here");
});

test("isRemoteCommand detects ssh presets", () => {
  assert.ok(isRemoteCommand('ssh -t -o ServerAliveInterval=30 buckit@buckit-consumer-1 "tmux new"'));
  assert.ok(isRemoteCommand("/usr/bin/ssh host"));
  assert.ok(!isRemoteCommand("claude --dangerously-skip-permissions"));
  assert.ok(!isRemoteCommand(undefined));
});

test("matchSessions matches titles and tags, skips excluded", () => {
  const sessions = [
    { id: "1", title: "mna", tags: [] },
    { id: "2", title: "aws-billing", tags: ["urgent"] },
    { id: "3", title: "butter-fixes", tags: [] },
  ];
  assert.deepEqual(matchSessions(["mna", "todo"], sessions, []).map((m) => m.session.id), ["1"]);
  assert.deepEqual(matchSessions(["billing"], sessions, []).map((m) => m.session.id), ["2"]);
  assert.deepEqual(matchSessions(["urgent"], sessions, []).map((m) => m.session.id), ["2"]);
  assert.deepEqual(matchSessions(["mna"], sessions, ["1"]), []);
});

test("planSend: one paste, then a separate delayed Enter", () => {
  assert.deepEqual(planSend("hello\n\n", true, "claude"), [
    { kind: "paste", text: "hello" },
    { kind: "enter", delayMs: 90 },
  ]);
  assert.deepEqual(planSend("line1\nline2", false, "shell"), [{ kind: "paste", text: "line1\nline2" }]);
  assert.deepEqual(planSend("   \n", true, "codex"), []);
  const codex = planSend("x", true, "codex");
  assert.equal(codex[1]?.kind, "enter");
});

test("matchScore: extraText only counts as a substring, below a name match", () => {
  const byName = matchScore("todo", { matchText: "mytodos" });
  const byDescription = matchScore("todo", { matchText: "cal", extraText: "Personal todo tracker" });
  const noSubsequenceInDescription = matchScore("ptr", { matchText: "", extraText: "Personal todo tracker" });
  assert.ok(byName > byDescription && byDescription > 0);
  assert.equal(noSubsequenceInDescription, 0);
});

test("rankLocal hides weak matches for short queries", () => {
  const rows = [s("a", "actions", "mytodos"), s("b", "actions", "tell-codex-to"), s("d", "drafts", "")];
  rows[2] = { ...rows[2], extraText: "the other thing" };
  assert.deepEqual(rankLocal(rows, "to", NOW).map((r) => r.id).sort(), ["a", "b"], "2 chars: substrings only");
  assert.deepEqual(rankLocal(rows, "th", NOW).map((r) => r.id), [], "2 chars never match draft bodies");
  assert.deepEqual(rankLocal(rows, "oth", NOW).map((r) => r.id), ["d"], "3 chars: word-start substring in body");
  assert.ok(minScoreFor("ab") > minScoreFor("abc") && minScoreFor("abc") > minScoreFor("abcd"));
});

test("rankLocal boosts rows that match earlier words on the line", () => {
  const f = (path: string) => ({ id: path, section: "files" as const, label: `@${path}`, hint: "", matchText: path, value: path });
  const rows = [f("data/todos/"), f("data/todos/todos.db"), f("BUTTER_TODO.md"), f("data/mna/TODO.md")];
  assert.equal(rankLocal(rows, "todo", NOW)[0].id !== "data/mna/TODO.md", true, "without context mna/TODO.md is not first");
  assert.equal(rankLocal(rows, "todo", NOW, ["mna"])[0].id, "data/mna/TODO.md", "'mna todo' puts data/mna/TODO.md first");
});

test("poolBySection keeps more rows than the display caps", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, section: "files" as const, label: "", hint: "", matchText: "", value: "" }));
  assert.equal(poolBySection(rows).length, 8);
  assert.equal(poolBySection(rows, 20, 10).length, 10);
});
