/**
 * What a session's agent calls cost, as its `usage` events say (spec #40):
 * list-price equivalent, tokens always alongside. Kept by quarter hour —
 * one row per session, quarter hour and charge — so a period starting at
 * any midnight a timezone has (every offset in use is a multiple of fifteen
 * minutes) takes whole rows, and a month is a few rows a session instead of
 * one an agent call.
 *
 * Each call is charged to what was running when it was made (`Charge`): a
 * session that goes on into a second workflow — a pull request's review after
 * the issue's — spends in both, and a chapter another person triggered is
 * theirs.
 */
import { advance, type Summary, workflowOf } from "./session";
import { Payload } from "./payload";
import type { StoredEvent } from "./wire";

export const BUCKET = 15 * 60_000;

/** What was spent: list-price equivalent in USD, and the tokens it bought. */
export interface Spend {
  cost: number;
  tokens: number;
}

/**
 * What an agent call is charged to: the workflow it ran in, the station that
 * ran it — whose machine and key paid — and the person who triggered the run.
 * "" for what the session's events never said.
 */
export interface Charge {
  workflow: string;
  station: string;
  stationName: string;
  person: string;
}

export interface Spent extends Spend, Charge {
  /** The quarter hour it was spent in: its start, epoch ms. */
  at: number;
}

/** What a session folded up to `summary` charges its next call to. */
export function chargeOf(summary: Summary): Charge {
  return {
    // A summary folded before it kept the workflow running now names the workflows it passed through.
    workflow: workflowOf(summary),
    station: summary.stationId,
    stationName: summary.stationName,
    person: summary.triggeredBy,
  };
}

/**
 * What `events` spent, by quarter hour and charge, earliest first: each call
 * charged to what the session — folded up to `before` when they start — was
 * running when it was made. An event whose timestamp cannot be read counts at
 * `fallback` (when the cockpit took it in), rather than not at all.
 */
export function spentIn(events: StoredEvent[], before: Summary, fallback: number): Spent[] {
  const buckets = new Map<string, Spent>();
  let summary = before;
  for (const event of events) {
    if (event.kind !== "usage" || event.v !== 1) {
      summary = advance(summary, [event]);
      continue;
    }
    const payload = Payload.parse(event.payload);
    const ts = Date.parse(event.ts);
    const at = Math.floor((Number.isNaN(ts) ? fallback : ts) / BUCKET) * BUCKET;
    const charge = chargeOf(summary);
    const key = JSON.stringify([at, charge.workflow, charge.station, charge.stationName, charge.person]);
    const bucket = buckets.get(key) ?? { at, ...charge, cost: 0, tokens: 0 };
    bucket.cost += payload.num("cost");
    bucket.tokens += payload.num("tokens");
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}
