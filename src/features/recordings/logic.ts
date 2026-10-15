// Pure logic for the Recordings palette (butter-rec meetings and dictations).
// Tests: scripts/recordings-logic.test.ts (npm run test:composer).
import { shellEscape } from "../../utils/shell.ts";

/** One meeting folder, as `recordings_list_meetings` returns it. */
export interface MeetingSummary {
  id: string;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  duration: number | null;
  status: string;
  error: string | null;
  in_progress: boolean;
  has_transcript: boolean;
  has_summary: boolean;
  dir: string;
  transcript_path: string;
  summary_path: string | null;
}

/** One line of ~/.butter/dictation/history.jsonl. */
export interface Dictation {
  at: string;
  text: string;
  engine?: string | null;
  model?: string | null;
  seconds?: number | null;
  elapsed?: number | null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

function clockTime(date: Date): string {
  const h = date.getHours();
  const m = date.getMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today 3:10 PM", "Yesterday 9:00 AM", "Mon 9:00 AM" (this week), "Oct 3", "Oct 3, 2025". Local time. */
export function meetingDate(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const date = new Date(ms);
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return `Today ${clockTime(date)}`;
  if (days === 1) return `Yesterday ${clockTime(date)}`;
  if (days < 7) return `${WEEKDAYS[date.getDay()]} ${clockTime(date)}`;
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}

/** "just now", "4m ago", "3h ago", "2d ago", "5w ago". */
export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

/** "45s", "12m", "1h 05m". Empty for a missing or zero duration. */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** One line of dictation text, cut at `max` characters with an ellipsis. */
export function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * A transcript can be opened once butter-rec is done with the meeting. A
 * meeting that failed later (e.g. while summarizing) still has its transcript.
 */
export function meetingReady(meeting: MeetingSummary): boolean {
  return meeting.has_transcript && !meeting.in_progress;
}

/** Status shown next to a meeting; nothing when it's done. */
export function meetingStatusLabel(meeting: MeetingSummary): string {
  if (meeting.status === "done") return meeting.has_transcript ? "" : "no transcript";
  return meeting.status;
}

function queryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every whitespace-separated term must appear in the title, id, status or date. */
export function filterMeetings(meetings: readonly MeetingSummary[], query: string, now = Date.now()): MeetingSummary[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [...meetings];
  return meetings.filter((meeting) => {
    const haystack = [meeting.title, meeting.id, meeting.status, meetingDate(meeting.started_at, now)]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Every whitespace-separated term must appear in the dictation text. */
export function filterDictations(dictations: readonly Dictation[], query: string): Dictation[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [...dictations];
  return dictations.filter((dictation) => {
    const text = dictation.text.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** The first message for an agent asked about a meeting. */
export function askAgentPrompt(meeting: MeetingSummary): string {
  const summary = meeting.summary_path ? ` and summary at ${meeting.summary_path}` : "";
  return `Read the meeting transcript at ${meeting.transcript_path}${summary}. Then wait for my questions about it.`;
}

/**
 * `claude --add-dir <meeting folder> -- '<prompt>'`, like
 * `butter-cli session create --agent claude --prompt`. --add-dir lets Claude
 * read the transcript without a permission prompt from another folder.
 */
export function askAgentCommand(meeting: MeetingSummary): string {
  return `claude --add-dir ${shellEscape(meeting.dir)} -- ${shellEscape(askAgentPrompt(meeting))}`;
}

/** `~` or `~/x` against the home folder; other paths unchanged. */
export function expandHome(path: string, home: string): string {
  const base = home.replace(/\/+$/, "");
  if (path === "~") return base;
  if (path.startsWith("~/")) return `${base}/${path.slice(2)}`;
  return path;
}
