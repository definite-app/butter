// Clickable URLs in 1thread bubbles. Pure so it can be unit tested
// (scripts/thread-logic.test.ts).

export type TextPart = { text: string; url?: string };

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/** Splits text into plain runs and http(s) URLs. Trailing punctuation stays text. */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0];
    // "(see https://x.com/a)." keeps the ")" and "." out of the link, but a
    // URL with its own "(...)" keeps its closing paren.
    while (/[.,;:!?)\]}*_]$/.test(url)) {
      if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
      url = url.slice(0, -1);
    }
    if (url.length <= "https://".length) continue;
    const start = match.index;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
