import { invoke } from "@tauri-apps/api/core";
import { applyExternalScores, rankLocal, type Suggestion } from "./logic";

export type RankerName = "local" | "jev";

export interface RankContext {
  draft: string;
  query: string;
  workspace: string;
}

export interface RankResult {
  rows: Suggestion[];
  rankedBy: RankerName;
}

/** A ranker reorders the locally ranked rows. Must never throw. */
export interface Ranker {
  name: RankerName;
  rank(rows: Suggestion[], ctx: RankContext): Promise<RankResult>;
}

/** Always-on local ranking: fuzzy score + recency (see logic.ts `rankLocal`). */
export const rankCandidatesLocally = (candidates: readonly Suggestion[], query: string): Suggestion[] =>
  rankLocal(candidates, query, Date.now());

/** The local ranker keeps the order `rankCandidatesLocally` produced. */
export const localRanker: Ranker = {
  name: "local",
  rank: async (rows) => ({ rows, rankedBy: "local" }),
};

interface JevStatus {
  configured: boolean;
  model: string;
  timeout_ms: number;
  key_source: string;
}

let jevStatusPromise: Promise<JevStatus | null> | null = null;

export const jevStatus = (): Promise<JevStatus | null> => {
  if (!jevStatusPromise) {
    jevStatusPromise = invoke<JevStatus>("composer_jev_status").catch(() => null);
  }
  return jevStatusPromise;
};

const SECTION_KIND: Record<Suggestion["section"], string> = {
  send: "route to terminal session",
  files: "file path",
  actions: "agent skill or slash command",
  drafts: "earlier message",
};

const cache = new Map<string, Map<string, number>>();
// After an auth/billing error (HTTP 4xx) stop asking Jev for a while.
const BACKOFF_MS = 5 * 60_000;
let jevBackoffUntil = 0;
const CACHE_LIMIT = 200;

/**
 * TypeSafe Jev reranker. Asks one Noul per row ("does this fit what the
 * user is typing") through the Rust backend, which holds the API key. The
 * request has a hard budget (config `timeout_ms`, default 300 ms); on any
 * error or timeout the local order is returned unchanged.
 */
export const jevRanker: Ranker = {
  name: "jev",
  async rank(rows, ctx) {
    const fallback: RankResult = { rows, rankedBy: "local" };
    if (rows.length < 2) return fallback;
    const status = await jevStatus();
    if (!status?.configured) return fallback;
    const key = `${ctx.query}\u0000${ctx.workspace}\u0000${rows.map((r) => r.id).join("|")}`;
    let probs = cache.get(key);
    if (!probs) {
      if (Date.now() < jevBackoffUntil) return fallback;
      const budget = (status.timeout_ms || 300) + 150;
      const request = invoke<(number | null)[]>("composer_jev_rank", {
        draft: ctx.draft,
        query: ctx.query,
        workspace: ctx.workspace,
        candidates: rows.map((r) => ({
          kind: r.badge ? `${SECTION_KIND[r.section]} (${r.badge})` : SECTION_KIND[r.section],
          text: r.section === "actions" ? r.hint : r.label,
          detail: r.section === "actions" ? r.label : r.hint,
        })),
      });
      const settled = request.catch((err: unknown) => {
        if (/jev http 4\d\d/.test(String(err))) jevBackoffUntil = Date.now() + BACKOFF_MS;
        return null;
      });
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), budget));
      const values = await Promise.race([settled, timeout]);
      if (!values) return fallback;
      probs = new Map();
      values.forEach((v, i) => {
        const row = rows[i];
        if (row && typeof v === "number" && Number.isFinite(v)) probs?.set(row.id, v);
      });
      if (probs.size === 0) return fallback;
      if (cache.size > CACHE_LIMIT) cache.clear();
      cache.set(key, probs);
    }
    return { rows: applyExternalScores(rows, probs), rankedBy: "jev" };
  },
};
