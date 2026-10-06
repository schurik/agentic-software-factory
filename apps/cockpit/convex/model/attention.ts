/**
 * What needs a person's attention on a factory (spec #40): a gate waiting on
 * them, a session that failed in the last day, a claim whose station has been
 * away for over a day, a station whose config drifted from the default
 * branch, a failing `asf check`, and nobody watching — issues queued for a
 * route while no station online runs an issues watcher.
 *
 * Split in two, like liveness (`command.ts`): the FACTS are what the cockpit
 * was told, read in one place (`activity.attentionOf`) for Now
 * and, to rank by, the Factories list (`model/factories.ts`); whether each
 * fact is worth attention now is read here against the page's own clock. A query that read the clock would
 * keep saying a failure is news until something else re-ran it.
 *
 * Beside the rule, the other judgements a page makes by its clock: a session
 * stuck in a phase, a gate waited on long, a spend close to its ceiling.
 * Constants, not factory config: the ceiling is the factory's, how close is
 * close is ours.
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
/**
 * A session has spent this share of its factory's per-session cost ceiling:
 * its spend reads amber, and red at the ceiling itself (#104). A constant,
 * not factory config: the ceiling is the factory's, how close is close is ours.
 */
export const EXPENSIVE = 0.8;
/** A phase has been running or waiting longer than this: its session is stuck, and Now says so in amber (#104). */
export const STUCK_AFTER = 10 * 60_000;
/** A gate has waited longer than this: its wait reads amber, so the oldest is answered first (#104). */
export const LONG_WAIT = 30 * 60_000;

/** Whether a phase that began at `since` has, by `now`, run long enough to call its session stuck. */
export function stuck(since: string, now: number): boolean {
  return now - Date.parse(since) > STUCK_AFTER;
}

/** Whether a gate asked at `since` has, by `now`, waited long. */
export function waitedLong(since: string, now: number): boolean {
  return now - Date.parse(since) > LONG_WAIT;
}

/** Whether `spent` is close to `ceiling`; never, without one. */
export function expensive(spent: number, ceiling: number): boolean {
  return ceiling > 0 && spent >= ceiling * EXPENSIVE;
}

/** A session that ended in failure: which, in which workflow, on which station, and when (epoch ms). */
export interface Failed {
  session: string;
  /** What it was asked: `#42 title`, or the prompt. */
  title: string;
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
 * What of `facts` needs attention at `now`. Drift is measured against the
 * commit the last check ran on, all a query can do without the forge.
 */
export function needsAttention(facts: Facts, now: number): Attention[] {
  const items: Attention[] = [];
  if (facts.gates.mine > 0) items.push({ kind: "gates", ...facts.gates });
  const failed = facts.failed.filter((each) => now - each.endedAt < FAILED_WITHIN);
  if (failed.length) items.push({ kind: "failed", sessions: failed });
  for (const claim of facts.claims) {
    const away = now - claim.heardAt;
    if (away > AWAY_FOR) items.push({ kind: "claim", claim, away });
  }
  if (facts.drifted.length) items.push({ kind: "drift", stations: facts.drifted });
  if (facts.check === "failing") items.push({ kind: "check" });
  if (facts.queued?.length && !facts.watchers.some((each) => liveness(each.seenAt, null, now).online)) {
    items.push({ kind: "unwatched", issues: facts.queued });
  }
  return items;
}
