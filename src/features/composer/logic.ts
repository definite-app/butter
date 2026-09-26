// Pure composer logic: fuzzy matching, local ranking, prefix completion and
// send sequencing. No imports, so it runs under `node --test` as-is
// (see scripts/composer-logic.test.ts).

export type SuggestionSection = "send" | "files" | "actions" | "drafts";

export const SECTION_ORDER: readonly SuggestionSection[] = ["send", "files", "actions", "drafts"];

export const SECTION_LABEL: Record<SuggestionSection, string> = {
  send: "Send to",
  files: "Files",
  actions: "Actions",
  drafts: "From earlier drafts",
};

/** Max rows shown per section, and overall. */
export const SECTION_CAP: Record<SuggestionSection, number> = {
  send: 2,
  files: 3,
  actions: 3,
  drafts: 2,
};
export const TOTAL_CAP = 9;

export interface Suggestion {
  id: string;
  section: SuggestionSection;
  /** Main row text. */
  label: string;
  /** Right-aligned hint. */
  hint: string;
  /** Text the fuzzy (subsequence) matcher scores against. */
  matchText: string;
  /** Longer text that only counts on a plain substring match (descriptions, draft bodies). */
  extraText?: string;
  /** Small badge, e.g. the harness of a skill ("Claude" / "Codex"). */
  badge?: string;
  /** Unix ms of the underlying item, when known (recency boost). */
  timestamp?: number;
  /** Local rank score (higher is better), filled by `rankLocal`. */
  score?: number;
  /** Section-specific payload. */
  value: string;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** The word right before the cursor (letters, digits and `@/._-:~`). */
export function currentWord(textBeforeCursor: string): { word: string; start: number } {
  const match = /[^\s"'`()[\]{}<>,;]*$/.exec(textBeforeCursor);
  const word = match ? match[0] : "";
  return { word, start: textBeforeCursor.length - word.length };
}

/** Lowercase words of 2+ chars, without leading `@` or `/`. */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map((w) => w.replace(/^[.\-_]+|[.\-_]+$/g, ""))
    .filter((w) => w.length >= 2);
}

export function stripSigil(word: string): string {
  return word.replace(/^[@/]+/, "");
}

/**
 * Fuzzy subsequence score of `query` in `text`, 0 when not a subsequence.
 * Rewards contiguous runs, matches at word starts and a match at the start.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  const idx = t.indexOf(q);
  if (idx >= 0) {
    const atBoundary = idx === 0 || /[\s/_.:@-]/.test(t[idx - 1] ?? "");
    return 500 + (atBoundary ? 200 : 0) + (idx === 0 ? 100 : 0) - Math.min(idx, 50) - t.length * 0.1;
  }
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (; ti < t.length; ti++) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
    }
    if (found < 0) return 0;
    const boundary = found === 0 || /[\s/_.:@-]/.test(t[found - 1] ?? "");
    run = found > 0 && qi > 0 && t[found - 1] === q[qi - 1] ? run + 1 : 0;
    score += 10 + run * 8 + (boundary ? 12 : 0);
    ti = found + 1;
  }
  return score - t.length * 0.1;
}

/** Fuzzy score on `matchText`, or a weaker substring score on `extraText`. */
export function matchScore(query: string, c: Pick<Suggestion, "matchText" | "extraText">): number {
  const primary = c.matchText ? fuzzyScore(query, c.matchText) : 0;
  let extra = 0;
  if (c.extraText && query.length >= 2) {
    const text = c.extraText.toLowerCase();
    const q = query.toLowerCase();
    const idx = text.indexOf(q);
    if (idx >= 0) {
      const atWordStart = idx === 0 || /[^\p{L}\p{N}]/u.test(text[idx - 1] ?? "");
      extra = (atWordStart ? 260 : 120) - Math.min(idx, 200) * 0.2;
    }
  }
  return Math.max(primary, extra);
}

/** 0..1 boost that halves every `halfLifeDays`. */
export function recencyBoost(timestamp: number | undefined, now: number, halfLifeDays = 7): number {
  if (!timestamp || timestamp > now) return timestamp ? 1 : 0;
  const days = (now - timestamp) / 86_400_000;
  return Math.pow(0.5, days / halfLifeDays);
}

/**
 * Fast local ranker: fuzzy score of the query against each candidate plus a
 * recency boost; returns candidates grouped in SECTION_ORDER, best first
 * inside each section, capped per section and overall. Candidates that do
 * not match the query at all are dropped.
 */
export function rankLocal(
  candidates: readonly Suggestion[],
  query: string,
  now: number
): Suggestion[] {
  const q = stripSigil(query);
  const scored: Suggestion[] = [];
  for (const c of candidates) {
    const fuzzy = q ? matchScore(q, c) : 0;
    if (q && fuzzy < minScoreFor(q)) continue;
    const score = fuzzy + recencyBoost(c.timestamp, now) * 40;
    scored.push({ ...c, score });
  }
  return capBySection(scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)));
}

/**
 * Minimum match score so the list does not pop up for weak matches:
 * 1-2 chars need a name substring, 3 chars a word-start substring or a
 * strong subsequence, longer queries any subsequence with some structure.
 */
export function minScoreFor(query: string): number {
  if (query.length <= 2) return 450;
  if (query.length === 3) return 100;
  return 40;
}

/** Stable section grouping + caps; keeps the incoming order inside a section. */
export function capBySection(sorted: readonly Suggestion[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const section of SECTION_ORDER) {
    const rows = sorted.filter((s) => s.section === section).slice(0, SECTION_CAP[section]);
    out.push(...rows);
  }
  return out.slice(0, TOTAL_CAP);
}

/**
 * Reorder rows inside each section by an external relevance probability
 * (e.g. Jev Noul values). Rows with no probability keep their local order
 * after the ones that have one.
 */
export function applyExternalScores(
  rows: readonly Suggestion[],
  probs: ReadonlyMap<string, number>
): Suggestion[] {
  const out: Suggestion[] = [];
  for (const section of SECTION_ORDER) {
    const inSection = rows.filter((r) => r.section === section);
    const indexed = inSection.map((row, index) => ({ row, index, p: probs.get(row.id) }));
    indexed.sort((a, b) => {
      const pa = a.p ?? -1;
      const pb = b.p ?? -1;
      if (pa !== pb) return pb - pa;
      return a.index - b.index;
    });
    out.push(...indexed.map((x) => x.row));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ghost-text prefix completion
// ---------------------------------------------------------------------------

export const MIN_GHOST_PREFIX = 3;

/**
 * Completion for the current line from earlier drafts (newest first).
 * Returns the remainder of the first earlier line that starts with
 * `linePrefix` (case-insensitive) and is longer than it, or "".
 */
export function prefixCompletion(linePrefix: string, earlierDrafts: readonly string[]): string {
  if (linePrefix.trim().length < MIN_GHOST_PREFIX) return "";
  const lower = linePrefix.toLowerCase();
  for (const draft of earlierDrafts) {
    for (const line of draft.split(/\r?\n/)) {
      if (line.length > linePrefix.length && line.toLowerCase().startsWith(lower)) {
        return line.slice(linePrefix.length);
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Sessions started through ssh/mosh run on another machine. */
export function isRemoteCommand(command: string | undefined | null): boolean {
  if (!command) return false;
  return /^\s*(?:\S*\/)?(ssh|mosh|et|autossh)\s/.test(command);
}

export interface SessionLike {
  id: string;
  title: string;
  tags: readonly string[];
}

/** Sessions whose title or a tag matches one of `words` (prefix or fuzzy). */
export function matchSessions(
  words: readonly string[],
  sessions: readonly SessionLike[],
  excludeIds: readonly string[]
): { session: SessionLike; word: string; score: number }[] {
  const out: { session: SessionLike; word: string; score: number }[] = [];
  for (const session of sessions) {
    if (excludeIds.includes(session.id)) continue;
    let best = 0;
    let bestWord = "";
    const haystacks = [session.title, ...session.tags];
    for (const word of words) {
      if (word.length < 2) continue;
      for (const hay of haystacks) {
        const h = hay.toLowerCase();
        if (!h) continue;
        let s = 0;
        if (h === word) s = 1000;
        else if (h.split(/[\s_.:/-]+/).some((part) => part === word)) s = 700;
        else if (h.startsWith(word) && word.length >= 3) s = 500;
        if (s > best) {
          best = s;
          bestWord = word;
        }
      }
    }
    if (best > 0) out.push({ session, word: bestWord, score: best });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type AgentKindName = "claude" | "codex" | "shell";

/**
 * Delay between the bracketed paste and the separate Enter. TUIs such as
 * Claude Code treat a CR that arrives inside (or glued to) the paste as a
 * newline, so the Enter must be its own write after the paste has ended.
 * Codex also suppresses Enter shortly after fast input, so it gets more.
 */
export const ENTER_DELAY_MS: Record<AgentKindName, number> = {
  claude: 90,
  codex: 160,
  shell: 40,
};

export type SendStep = { kind: "paste"; text: string } | { kind: "enter"; delayMs: number };

/** The PTY writes for one send: one paste, then (optionally) one delayed CR. */
export function planSend(text: string, pressEnter: boolean, agent: AgentKindName): SendStep[] {
  const body = text.replace(/\s+$/u, "");
  if (!body.trim()) return [];
  const steps: SendStep[] = [{ kind: "paste", text: body }];
  if (pressEnter) steps.push({ kind: "enter", delayMs: ENTER_DELAY_MS[agent] });
  return steps;
}

/** Rough "3h ago" style label. */
export function relativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(timestamp);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
