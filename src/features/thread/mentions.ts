// @agent mentions in the 1thread composer. Pure so it can be unit tested
// (scripts/thread-mentions.test.ts).

const HANDLE_CHARS = /[a-z0-9._-]/i;

/** "CC Mike3" -> "cc-mike3". */
export function agentHandle(name: string): string {
  const handle = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return handle || "agent";
}

/** Gives every item a unique handle; later duplicates get -2, -3, ... */
export function assignHandles<T>(items: { name: string; value: T }[]): { handle: string; value: T }[] {
  const used = new Set<string>();
  return items.map(({ name, value }) => {
    const base = agentHandle(name);
    let handle = base;
    for (let n = 2; used.has(handle); n++) handle = `${base}-${n}`;
    used.add(handle);
    return { handle, value };
  });
}

export type MentionToken = { start: number; end: number; query: string };

/** The `@query` being typed at the caret, if any. */
export function mentionAtCaret(text: string, caret: number): MentionToken | null {
  let start = caret;
  while (start > 0 && HANDLE_CHARS.test(text[start - 1])) start--;
  if (start === 0 || text[start - 1] !== "@") return null;
  const at = start - 1;
  if (at > 0 && !/\s/.test(text[at - 1])) return null;
  return { start: at, end: caret, query: text.slice(start, caret) };
}

/** Handles matching a partial query: prefix matches first, then substring. */
export function filterHandles<T extends { handle: string }>(items: T[], query: string): T[] {
  const q = query.toLowerCase();
  const prefix = items.filter((item) => item.handle.startsWith(q));
  const rest = items.filter((item) => !item.handle.startsWith(q) && item.handle.includes(q));
  return [...prefix, ...rest];
}

/** Replaces the token with `@handle ` and returns the new text and caret. */
export function insertMention(text: string, token: MentionToken, handle: string): { text: string; caret: number } {
  const after = text.slice(token.end).replace(/^[a-z0-9._-]*/i, "");
  const inserted = `@${handle}${/^\s/.test(after) ? "" : " "}`;
  return {
    text: text.slice(0, token.start) + inserted + after,
    caret: token.start + inserted.length + (/^\s/.test(after) ? 1 : 0),
  };
}

/** The first `@handle` in the text that names a known agent. */
export function findMention(text: string, handles: string[]): { handle: string; start: number; end: number } | null {
  const known = new Set(handles.map((h) => h.toLowerCase()));
  const re = /(^|\s)@([a-z0-9._-]+)/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Trailing dots are sentence punctuation, not part of the handle.
    const word = m[2].toLowerCase().replace(/\.+$/, "");
    if (!known.has(word)) continue;
    const start = m.index + m[1].length;
    return { handle: word, start, end: start + 1 + word.length };
  }
  return null;
}

/** The message without the mention, tidied up. */
export function stripMention(text: string, mention: { start: number; end: number }): string {
  return (text.slice(0, mention.start) + text.slice(mention.end)).replace(/[ \t]{2,}/g, " ").trim();
}
