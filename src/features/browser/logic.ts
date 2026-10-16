// Pure logic for browser.toml palette commands and pinned apps.
// Tests: scripts/browser-logic.test.ts (npm run test:composer).

/** Browser session id of a pinned web app. Terminal sessions are UUIDs. */
export const APP_SESSION_PREFIX = "app:";

export const appSessionId = (appId: string) => `${APP_SESSION_PREFIX}${appId}`;

export const isAppSessionId = (sessionId: string | null | undefined) =>
  !!sessionId && sessionId.startsWith(APP_SESSION_PREFIX);

export const QUERY_PLACEHOLDER = "{query}";

/** A command whose url has `{query}` asks for text before it runs. */
export const commandNeedsQuery = (url: string) => url.includes(QUERY_PLACEHOLDER);

const hasScheme = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url);

/**
 * The URL a command opens. `{query}` becomes the URL-encoded `query`. An
 * absolute url is used as is; a relative one (`#search/...`, `/path`,
 * `?q=...`) resolves against `currentUrl`. Returns null when a relative url
 * has no web page to resolve against.
 */
export const resolveCommandUrl = (
  template: string,
  currentUrl: string | null | undefined,
  query = "",
): string | null => {
  const filled = template.split(QUERY_PLACEHOLDER).join(encodeURIComponent(query.trim()));
  if (hasScheme(filled)) return filled;
  const base = (currentUrl || "").trim();
  if (!/^(https?|file):/i.test(base)) return null;
  try {
    return new URL(filled, base).href;
  } catch {
    return null;
  }
};

/** Does a command's `matchRegex` cover the page? The fragment is ignored. */
export const commandMatchesUrl = (
  matchRegex: string | null | undefined,
  url: string | null | undefined,
): boolean => {
  if (!matchRegex || !url) return false;
  const page = url.split("#")[0];
  try {
    return new RegExp(matchRegex).test(page);
  } catch {
    return false;
  }
};

export interface MatchableCommand {
  url: string;
  matchRegex?: string | null;
}

/**
 * Splits commands for the palette: `matched` have a `match` that covers the
 * active page (listed first, under the page's host), `global` have no
 * `match` (bookmarks). Commands whose `match` doesn't cover the page are
 * dropped.
 */
export const partitionCommands = <T extends MatchableCommand>(
  commands: readonly T[],
  activeUrl: string | null | undefined,
): { matched: T[]; global: T[] } => {
  const matched: T[] = [];
  const global: T[] = [];
  for (const command of commands) {
    if (!command.matchRegex) global.push(command);
    else if (commandMatchesUrl(command.matchRegex, activeUrl)) matched.push(command);
  }
  return { matched, global };
};

/** "mail.google.com" for the palette header; "" for non-web pages. */
export const hostOf = (url: string | null | undefined) => {
  try {
    const parsed = new URL(url || "");
    return /^https?:$/.test(parsed.protocol) ? parsed.host : "";
  } catch {
    return "";
  }
};

/** Is this a Gmail page, where the bundled Inbox Keys runs? */
export const isGmailUrl = (url: string | null | undefined) => hostOf(url) === "mail.google.com";
