// Skill autocomplete in the 1thread composer, and getting a typed skill to
// the agent. Claude runs `/name`, Codex runs `$name`. Pure so it can be unit
// tested (scripts/thread-logic.test.ts).

/** A skill or command from `composer_list_actions`. */
export interface SkillAction {
  name: string;
  /** What to type: `/name`, `/plugin:name`, `$name` or `/prompts:name`. */
  invoke: string;
  description: string;
  /** "skill" | "command" | "prompt" */
  kind: string;
  harness: string;
}

const SKILL_CHARS = /[a-z0-9._:-]/i;

export type SkillToken = { start: number; end: number; query: string };

/** The `/query` or `$query` being typed at the caret, if any. */
export function skillAtCaret(text: string, caret: number): SkillToken | null {
  let start = caret;
  while (start > 0 && SKILL_CHARS.test(text[start - 1])) start--;
  if (start === 0 || !"/$".includes(text[start - 1])) return null;
  const sigil = start - 1;
  if (sigil > 0 && !/\s/.test(text[sigil - 1])) return null;
  return { start: sigil, end: caret, query: text.slice(start, caret) };
}

const MAX_MATCHES = 50;

/** Skills matching a partial query: name prefix first, then substring. */
export function filterSkills<T extends SkillAction>(actions: T[], query: string): T[] {
  const q = query.toLowerCase();
  const key = (a: T) => a.invoke.replace(/^[/$]/, "").toLowerCase();
  const prefix = actions.filter((a) => a.name.toLowerCase().startsWith(q) || key(a).startsWith(q));
  const rest = actions.filter((a) => !prefix.includes(a) && key(a).includes(q));
  return [...prefix, ...rest].slice(0, MAX_MATCHES);
}

/** Replaces the token with `invoke ` and returns the new text and caret. */
export function insertSkill(text: string, token: SkillToken, invoke: string): { text: string; caret: number } {
  const after = text.slice(token.end).replace(/^[a-z0-9._:-]*/i, "");
  const inserted = `${invoke}${/^\s/.test(after) ? "" : " "}`;
  return {
    text: text.slice(0, token.start) + inserted + after,
    caret: token.start + inserted.length + (/^\s/.test(after) ? 1 : 0),
  };
}

/**
 * Splits a message that starts with one of the agent's skills (`known`, as
 * the agent types them) into the invocation and the rest. A plain `/name`
 * sent to Codex becomes `$name` and the other way round, so a message picks
 * up the right spelling wherever it lands.
 */
export function leadingSkill(text: string, known: ReadonlySet<string>): { skill: string; rest: string } | null {
  const trimmed = text.trimStart();
  const token = /^[/$][a-z0-9._:-]+(?=\s|$)/i.exec(trimmed)?.[0];
  if (!token) return null;
  const name = token.slice(1);
  const spellings = name.includes(":") ? [token] : [token, `/${name}`, `$${name}`];
  const skill = spellings.find((s) => known.has(s));
  return skill ? { skill, rest: trimmed.slice(token.length).trim() } : null;
}

/**
 * The agent's prompt for `body`. `build` turns the message into the prompt
 * (wrapping it, adding context) and returns "" when there's nothing to send.
 * A skill at the start of the body goes in front of all that, outside any
 * tags, so the agent runs it.
 */
export function withLeadingSkill(
  body: string,
  known: ReadonlySet<string>,
  build: (message: string) => string
): string {
  const found = leadingSkill(body, known);
  if (!found) return build(body);
  const rest = build(found.rest);
  return rest ? `${found.skill} ${rest}` : found.skill;
}
