// 1thread search: query parsing and snippet highlighting. Pure so it can be
// unit tested (scripts/thread-logic.test.ts).

export type SearchFrom = "me" | "agent" | null;

export type SearchQuery = {
  /** Lowercased words that must all appear (in the message or thread name). */
  terms: string[];
  /** An @handle naming the agent the thread was started with. */
  agent: string | null;
  from: SearchFrom;
  pinned: boolean;
};

/**
 * Plain words are search terms. `@handle` (a known agent) filters by agent,
 * `from:me` / `from:agent` by sender, and `is:pinned` to pinned threads.
 */
export function parseSearchQuery(query: string, agentHandles: string[]): SearchQuery {
  const known = new Set(agentHandles.map((h) => h.toLowerCase()));
  const out: SearchQuery = { terms: [], agent: null, from: null, pinned: false };
  for (const raw of query.trim().split(/\s+/)) {
    const word = raw.toLowerCase();
    if (!word) continue;
    if (word.startsWith("@") && known.has(word.slice(1))) out.agent = word.slice(1);
    else if (word === "from:me" || word === "from:you") out.from = "me";
    else if (word === "from:agent" || word === "from:agents") out.from = "agent";
    else if (word === "is:pinned" || word === "pinned:true") out.pinned = true;
    else out.terms.push(word);
  }
  return out;
}

export const matchesTerms = (text: string, terms: string[]): boolean => {
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term));
};

export type SnippetPart = { text: string; hit: boolean };

/**
 * A one-line excerpt around the first matching term, split into parts so the
 * matched words can be highlighted. Text without a match is truncated from
 * the start.
 */
export function searchSnippet(text: string, terms: string[], radius = 70): SnippetPart[] {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const first = terms
    .map((term) => lower.indexOf(term))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  let start = first === undefined ? 0 : Math.max(0, first - radius);
  // Start on a word boundary so the excerpt doesn't open mid-word.
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space !== -1 && space < (first ?? 0)) start = space + 1;
  }
  const end = Math.min(flat.length, start + radius * 2 + 40);
  const window = flat.slice(start, end);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";

  // Mark every occurrence of every term, merging overlaps.
  const lowerWindow = window.toLowerCase();
  const ranges: [number, number][] = [];
  for (const term of terms) {
    if (!term) continue;
    for (let i = lowerWindow.indexOf(term); i !== -1; i = lowerWindow.indexOf(term, i + term.length)) {
      ranges.push([i, i + term.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }

  const parts: SnippetPart[] = [];
  let at = 0;
  for (const [from, to] of merged) {
    if (from > at) parts.push({ text: window.slice(at, from), hit: false });
    parts.push({ text: window.slice(from, to), hit: true });
    at = to;
  }
  if (at < window.length) parts.push({ text: window.slice(at), hit: false });
  if (prefix) parts.unshift({ text: prefix, hit: false });
  if (suffix) parts.push({ text: suffix, hit: false });
  return parts;
}
