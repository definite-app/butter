// Routines: scheduled check-ins that start an agent in a 1thread conversation
// (backend: src-tauri/src/routine.rs). Pure so it can be unit tested
// (scripts/thread-logic.test.ts).

export type RoutineStatus = "pending" | "firing" | "fired" | "cancelled" | "failed";

export interface RoutineRecord {
  id: string;
  title: string;
  prompt: string;
  due_at: number;
  /** The due time in local time, preformatted by the backend. */
  due: string;
  status: RoutineStatus;
  created_at: number;
  /** The conversation it fires into; null starts a new thread. */
  thread_id: string | null;
  source_session_id: string;
  preset_id: string | null;
  preset_name: string | null;
  directory: string | null;
  agent_command: string | null;
  agent_kind: string | null;
  agent_session_id: string | null;
  fired_at: number | null;
  fired_session_id: string | null;
  error: string | null;
}

export const ROUTINE_INSTRUCTIONS =
  "To check back on something later (a blocker, a date, a follow-up the user asks for), schedule a routine: butter-cli routine create --in <30m|4h|3d|2w> \"<prompt>\" (or --at <YYYY-MM-DD> or --at \"<YYYY-MM-DD HH:MM>\"). When it's due, Butter starts a new agent in this conversation with the conversation so far and your prompt, so write the prompt for that agent: the task, what's blocking it, and what to check or do next. Then tell the user when you'll check back.";

/** "Thu, Oct 29" */
export function routineDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "Thu, Oct 29, 9:00 AM" */
export function routineWhen(ms: number): string {
  const time = new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${routineDay(ms)}, ${time}`;
}

/**
 * What the woken agent reads before the routine's prompt: why it was started,
 * where the earlier agent's transcript is, and how to reschedule.
 */
export function routinePreamble(routine: RoutineRecord): string {
  const lines = [
    `A Butter routine started you. It was scheduled on ${routineDay(routine.created_at)} to check back on ${routineDay(routine.due_at)}. The task is in the <butter_message> below; the conversation so far, if there is one, is above it.`,
  ];
  if (routine.agent_session_id) {
    const codex = routine.agent_kind === "codex";
    const where = codex ? "~/.codex/sessions/" : "~/.claude/projects/";
    const folder = routine.directory ? ` in ${routine.directory}` : "";
    lines.push(
      `The earlier agent was ${codex ? "Codex" : "Claude Code"} session ${routine.agent_session_id}${folder}. For more detail than the conversation gives, read its transcript: the file ending in ${routine.agent_session_id}.jsonl under ${where}.`
    );
  }
  lines.push(
    `If it's still blocked, reschedule this routine with: butter-cli routine snooze ${routine.id} --in <duration> (or --at <YYYY-MM-DD>), and tell the user when you'll check again.`
  );
  return lines.join("\n");
}
