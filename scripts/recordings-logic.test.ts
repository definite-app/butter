// Unit tests for the Recordings palette's pure logic. Run: npm run test:composer
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  askAgentCommand,
  askAgentPrompt,
  expandHome,
  filterDictations,
  filterMeetings,
  formatDuration,
  meetingDate,
  meetingReady,
  meetingStatusLabel,
  oneLine,
  timeAgo,
  type MeetingSummary,
} from "../src/features/recordings/logic.ts";

// Local time, so the day boundaries hold in any time zone.
const NOW = new Date(2026, 9, 15, 16, 0, 0).getTime();
const local = (month: number, day: number, h: number, m: number, year = 2026) =>
  new Date(year, month, day, h, m).toISOString();

const meeting = (overrides: Partial<MeetingSummary> = {}): MeetingSummary => ({
  id: "2026-10-15_1510_acme-sync",
  title: "Acme sync",
  started_at: local(9, 15, 15, 10),
  ended_at: null,
  duration: 1830,
  status: "done",
  error: null,
  in_progress: false,
  has_transcript: true,
  has_summary: false,
  dir: "/Users/me/.butter/recordings/2026-10-15_1510_acme-sync",
  transcript_path: "/Users/me/.butter/recordings/2026-10-15_1510_acme-sync/transcript.md",
  summary_path: null,
  ...overrides,
});

test("meetingDate is relative to today in local time", () => {
  assert.equal(meetingDate(local(9, 15, 15, 10), NOW), "Today 3:10 PM");
  assert.equal(meetingDate(local(9, 15, 0, 5), NOW), "Today 12:05 AM");
  assert.equal(meetingDate(local(9, 14, 9, 0), NOW), "Yesterday 9:00 AM");
  assert.equal(meetingDate(local(9, 12, 12, 30), NOW), "Mon 12:30 PM");
  assert.equal(meetingDate(local(9, 3, 11, 0), NOW), "Oct 3");
  assert.equal(meetingDate(local(11, 30, 11, 0, 2025), NOW), "Dec 30, 2025");
  assert.equal(meetingDate(null, NOW), "");
  assert.equal(meetingDate("not a date", NOW), "");
});

test("timeAgo", () => {
  assert.equal(timeAgo(new Date(NOW - 20_000).toISOString(), NOW), "just now");
  assert.equal(timeAgo(new Date(NOW - 4 * 60_000).toISOString(), NOW), "4m ago");
  assert.equal(timeAgo(new Date(NOW - 3 * 3_600_000).toISOString(), NOW), "3h ago");
  assert.equal(timeAgo(new Date(NOW - 2 * 86_400_000).toISOString(), NOW), "2d ago");
  assert.equal(timeAgo(new Date(NOW - 35 * 86_400_000).toISOString(), NOW), "5w ago");
  assert.equal(timeAgo(new Date(NOW + 60_000).toISOString(), NOW), "just now");
});

test("formatDuration", () => {
  assert.equal(formatDuration(null), "");
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(44.6), "45s");
  assert.equal(formatDuration(1830), "31m");
  assert.equal(formatDuration(3900), "1h 05m");
});

test("oneLine flattens and truncates", () => {
  assert.equal(oneLine("  hello\n  world  "), "hello world");
  assert.equal(oneLine("abcdefghij", 6), "abcde…");
});

test("only finished meetings with a transcript are ready", () => {
  assert.equal(meetingReady(meeting()), true);
  assert.equal(meetingReady(meeting({ status: "transcribing", in_progress: true, has_transcript: false })), false);
  assert.equal(meetingReady(meeting({ status: "summarizing", in_progress: true })), false);
  assert.equal(meetingReady(meeting({ status: "error", error: "summarizer failed" })), true);
  assert.equal(meetingReady(meeting({ status: "error", has_transcript: false })), false);
  assert.equal(meetingStatusLabel(meeting()), "");
  assert.equal(meetingStatusLabel(meeting({ status: "queued" })), "queued");
  assert.equal(meetingStatusLabel(meeting({ has_transcript: false })), "no transcript");
});

test("filterMeetings matches title, id, status and date terms", () => {
  const list = [
    meeting(),
    meeting({ id: "2026-10-14_0900_standup", title: "Standup", started_at: local(9, 14, 9, 0), status: "queued" }),
  ];
  assert.deepEqual(filterMeetings(list, "", NOW).length, 2);
  assert.deepEqual(filterMeetings(list, "ACME", NOW).map((m) => m.title), ["Acme sync"]);
  assert.deepEqual(filterMeetings(list, "yesterday", NOW).map((m) => m.title), ["Standup"]);
  assert.deepEqual(filterMeetings(list, "queued stand", NOW).map((m) => m.title), ["Standup"]);
  assert.deepEqual(filterMeetings(list, "2026-10-15", NOW).map((m) => m.title), ["Acme sync"]);
  assert.deepEqual(filterMeetings(list, "acme standup", NOW), []);
});

test("filterDictations requires every term", () => {
  const list = [
    { at: "2026-10-15T10:00:00Z", text: "Send the pricing deck to Acme" },
    { at: "2026-10-15T09:00:00Z", text: "Pricing for the enterprise tier" },
  ];
  assert.equal(filterDictations(list, "").length, 2);
  assert.deepEqual(filterDictations(list, "pricing acme").map((d) => d.at), ["2026-10-15T10:00:00Z"]);
  assert.deepEqual(filterDictations(list, "PRICING").length, 2);
});

test("askAgent prompt mentions the summary only when there is one", () => {
  assert.equal(
    askAgentPrompt(meeting()),
    "Read the meeting transcript at /Users/me/.butter/recordings/2026-10-15_1510_acme-sync/transcript.md. Then wait for my questions about it."
  );
  const withSummary = meeting({ has_summary: true, summary_path: "/r/x/summary.md" });
  assert.match(askAgentPrompt(withSummary), /transcript\.md and summary at \/r\/x\/summary\.md\. Then wait/);
});

test("askAgentCommand passes the prompt as one literal argument", () => {
  const tricky = meeting({
    dir: "/tmp/it's $(here)",
    transcript_path: "/tmp/it's $(here)/transcript.md",
  });
  const command = askAgentCommand(tricky);
  const script = `claude() { printf '%s\\0' "$@"; }; ${command}`;
  const args = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" }).split("\0").slice(0, -1);
  assert.deepEqual(args, ["--add-dir", "/tmp/it's $(here)", "--", askAgentPrompt(tricky)]);
});

test("expandHome", () => {
  assert.equal(expandHome("~", "/Users/me/"), "/Users/me");
  assert.equal(expandHome("~/code", "/Users/me"), "/Users/me/code");
  assert.equal(expandHome("/srv", "/Users/me"), "/srv");
});
