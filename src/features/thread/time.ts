// Message times for the 1thread ⋯ menu. Pure so it can be unit tested
// (scripts/thread-logic.test.ts).

const UNITS: [limit: number, ms: number, unit: string][] = [
  [60_000, 1_000, "second"],
  [3_600_000, 60_000, "minute"],
  [86_400_000, 3_600_000, "hour"],
  [7 * 86_400_000, 86_400_000, "day"],
];

/** "just now", "42 seconds ago", "1 minute ago", ... "6 days ago", then the date. */
export function timeAgo(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < 5_000) return "just now";
  for (const [limit, ms, unit] of UNITS) {
    if (elapsed < limit) {
      const n = Math.floor(elapsed / ms);
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

/** "Thursday, October 16, 2026 at 3:14:05 PM" */
export function fullTimestamp(at: number): string {
  return new Date(at).toLocaleString("en-US", { dateStyle: "full", timeStyle: "medium" });
}
