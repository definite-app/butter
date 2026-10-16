// Unit tests for browser.toml palette commands. Run: npm run test:composer
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appSessionId,
  commandMatchesUrl,
  commandNeedsQuery,
  hostOf,
  isAppSessionId,
  isGmailUrl,
  partitionCommands,
  resolveCommandUrl,
} from "../src/features/browser/logic.ts";

// The regex Rust's match_pattern_regex makes for "https://mail.google.com/*".
const GMAIL = "^https://mail\\.google\\.com(?::[0-9]+)?/.*$";
// "https://*.google.com/*"
const ANY_GOOGLE = "^https://(?:[^/:]+\\.)?google\\.com(?::[0-9]+)?/.*$";
const INBOX = "https://mail.google.com/mail/u/0/#inbox";

test("app session ids", () => {
  assert.equal(appSessionId("gmail"), "app:gmail");
  assert.ok(isAppSessionId("app:gmail"));
  assert.ok(!isAppSessionId("2b0c8c8e-1111-4c1a-9d0e-123456789abc"));
  assert.ok(!isAppSessionId(null));
});

test("{query} asks for text and is URL-encoded", () => {
  assert.ok(commandNeedsQuery("#search/{query}"));
  assert.ok(!commandNeedsQuery("#inbox"));
  assert.equal(
    resolveCommandUrl("https://www.google.com/search?q={query}", null, "a b&c"),
    "https://www.google.com/search?q=a%20b%26c",
  );
  assert.equal(
    resolveCommandUrl("#search/{query}", INBOX, "from:bob is:unread"),
    "https://mail.google.com/mail/u/0/#search/from%3Abob%20is%3Aunread",
  );
  assert.equal(resolveCommandUrl("x/{query}/{query}", "https://a.com/", " hi "), "https://a.com/x/hi/hi");
});

test("relative urls resolve against the current page", () => {
  assert.equal(
    resolveCommandUrl("#search/in:inbox is:unread", INBOX),
    "https://mail.google.com/mail/u/0/#search/in:inbox%20is:unread",
  );
  assert.equal(resolveCommandUrl("/settings", "https://a.com/x/y?z=1"), "https://a.com/settings");
  assert.equal(resolveCommandUrl("?q=2", "https://a.com/x?q=1#f"), "https://a.com/x?q=2");
  assert.equal(resolveCommandUrl("b", "https://a.com/x/y"), "https://a.com/x/b");
  // Absolute urls ignore the page.
  assert.equal(resolveCommandUrl("https://news.ycombinator.com/", INBOX), "https://news.ycombinator.com/");
  // No web page to resolve against.
  assert.equal(resolveCommandUrl("#inbox", null), null);
  assert.equal(resolveCommandUrl("#inbox", "about:blank"), null);
});

test("match filtering ignores the fragment", () => {
  assert.ok(commandMatchesUrl(GMAIL, INBOX));
  assert.ok(!commandMatchesUrl(GMAIL, "https://calendar.google.com/r"));
  assert.ok(!commandMatchesUrl(GMAIL, "https://example.com/#https://mail.google.com/"));
  assert.ok(commandMatchesUrl(ANY_GOOGLE, "https://calendar.google.com/r"));
  assert.ok(commandMatchesUrl(ANY_GOOGLE, "https://google.com/"));
  assert.ok(!commandMatchesUrl(GMAIL, null));
  assert.ok(!commandMatchesUrl(null, INBOX));
  assert.ok(!commandMatchesUrl("([", INBOX), "a bad regex never matches");
});

test("partition: matched first, global kept, others dropped", () => {
  const commands = [
    { name: "unread", url: "#search/is:unread", matchRegex: GMAIL },
    { name: "hn", url: "https://news.ycombinator.com/", matchRegex: null },
    { name: "google", url: "/", matchRegex: ANY_GOOGLE },
    { name: "docs", url: "https://docs.rs/" },
  ];
  const names = (list: { name: string }[]) => list.map((c) => c.name);

  let split = partitionCommands(commands, INBOX);
  assert.deepEqual(names(split.matched), ["unread", "google"]);
  assert.deepEqual(names(split.global), ["hn", "docs"]);

  split = partitionCommands(commands, "https://calendar.google.com/");
  assert.deepEqual(names(split.matched), ["google"]);

  split = partitionCommands(commands, null);
  assert.deepEqual(names(split.matched), []);
  assert.deepEqual(names(split.global), ["hn", "docs"]);
});

test("hosts", () => {
  assert.equal(hostOf(INBOX), "mail.google.com");
  assert.equal(hostOf("http://localhost:5173/x"), "localhost:5173");
  assert.equal(hostOf("about:blank"), "");
  assert.equal(hostOf(""), "");
  assert.ok(isGmailUrl(INBOX));
  assert.ok(!isGmailUrl("https://calendar.google.com/"));
});
