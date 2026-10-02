/**
 * What needs a person's attention on a factory (spec #40): a gate waiting on
 * them, a session that failed in the last day, a claim whose station has been
 * away for over a day, a station whose config drifted from the default
 * branch, a failing `asf check`, and nobody watching — issues queued for a
 * route while no station online runs an issues watcher.
 *
 * Split in two, like liveness (`command.ts`): the FACTS are what the cockpit
 * was told, read in one place (`activity.attentionOf`) for the Factory page
 * and, to rank by, the Factories list (`model/factories.ts`); whether each
 * fact is worth attention now is read here against the page's own clock. A query that read the clock would
 * keep saying a failure is news until something else re-ran it.
 */

import type { ClaimView } from "./claim";
import { liveness } from "./command";

/** A session failed this recently: it is news. */
export const FAILED_WITHIN = 24 * 3600_000;
/**
 * A claim's station has been away this long: lifted into Needs attention, for
 * a writer to release if the station is truly gone. Never released by the
 * clock, and never called orphaned — a laptop shut over a weekend is not dead.
 */
export const AWAY_FOR = 24 * 3600_000;

/** A session that ended in failure: which, in which workflow, on which station, and when (epoch ms). */
export interface Failed {
  session: string;
  workflow: string;
  station: string;
  endedAt: number;
}

export interface Facts {
  /** Gates waiting at sessions of the factory: those the viewer may answer, and all of them. */
  gates: { mine: number; total: number };
  /** The factory's latest failures, newest first, however old: the clock decides which are news. */
  failed: Failed[];
  /** Every claim the factory's stations hold now, and when each station was last heard of. */
  claims: ClaimView[];
  /** What the default branch's `asf check` last said; unchecked is no CI workflow, never broken. */
  check: "passing" | "failing" | "unchecked";
  /** The stations whose config is not the default branch's, as the last check there measured it. */
  drifted: Drifted[];
  /** Open issues queued for a route, waiting for a watcher; null until the forge said. */
  queued: number[] | null;
  /** The stations whose loop runs an issues watcher, and when each loop last polled. */
  watchers: { station: string; name: string; seenAt: number }[];
}

export interface Drifted {
  station: string;
  name: string;
  badges: string[];
}

export type Attention =
  | { kind: "gates"; mine: number; total: number }
  | { kind: "failed"; sessions: Failed[] }
  /** One per claim, `away` being how long (ms) its station has not been heard of. */
  | { kind: "claim"; claim: ClaimView; away: number }
  | { kind: "drift"; stations: Drifted[] }
  | { kind: "check" }
  /** Issues queued for a route, and no station online running an issues watcher to start them. */
  | { kind: "unwatched"; issues: number[] };

/**
 * What of `facts` needs attention at `now`. `drifted` is drift a page measured
 * against the forge's tip of the default branch (`factory.look`), which it
 * goes by over the facts' own — measured against the commit the last check
 * ran on, all a query can do — so the page never says two things of one
 * station, and a factory no CI checks still shows its drift.
 */
export function needsAttention(facts: Facts, now: number, drifted: Drifted[] = facts.drifted): Attention[] {
  const items: Attention[] = [];
  if (facts.gates.mine > 0) items.push({ kind: "gates", ...facts.gates });
  const failed = facts.failed.filter((each) => now - each.endedAt < FAILED_WITHIN);
  if (failed.length) items.push({ kind: "failed", sessions: failed });
  for (const claim of facts.claims) {
    const away = now - claim.heardAt;
    if (away > AWAY_FOR) items.push({ kind: "claim", claim, away });
  }
  if (drifted.length) items.push({ kind: "drift", stations: drifted });
  if (facts.check === "failing") items.push({ kind: "check" });
  if (facts.queued?.length && !facts.watchers.some((each) => liveness(each.seenAt, null, now).online)) {
    items.push({ kind: "unwatched", issues: facts.queued });
  }
  return items;
}
