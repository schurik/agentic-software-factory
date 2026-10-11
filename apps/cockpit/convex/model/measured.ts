/**
 * What measuring a factory's own work cost (#193): one row for each judgement
 * a scorer's judge was paid for — what the Metrics view's Measurement cost
 * draws against the factory's `measurement:` budget, without reading an event.
 *
 * Measurement is never work. A judge's spend is the `usage` of the
 * `chapter_scored` it became, never a `usage` event of the session, so it is in
 * no session's spend and in no cost per PR (model/pulls.ts); it is here, on the
 * day it was judged — its event's own time, usually long after the session
 * ended. A code predicate costs nothing and leaves no row. A benchmark's
 * sessions will be paid from the same budget, and add rows of their own kind.
 */
import { Payload } from "./payload";
import type { StoredEvent } from "./wire";

/** What was paid for: a scorer's judge, or (to come) a benchmark's session. */
export type MeasuredKind = "judge" | "benchmark";

export interface MeasuredRow {
  /** The seq of the event that said it: one row an event, however often a batch is sent. */
  seq: number;
  kind: MeasuredKind;
  /** When it was paid for, epoch ms: what a period takes it by. */
  at: number;
  /** List-price equivalent, USD. */
  cost: number;
}

/** The versions of each kind the rows fold. */
const FOLDED: Record<string, number[]> = { chapter_scored: [1, 2] };

/** The versions of `kind` the rows fold, or [] for a kind they take nothing from (tests/measure.test.ts holds the corpus to it). */
export function foldedVersions(kind: string): number[] {
  return FOLDED[kind] ?? [];
}

const DAY = 86_400_000;

/**
 * What `rows` spent past `usdPerDay`, day by day: each UTC day's spend over its
 * own budget, summed. The budget is a day's, and the station stops judges on a
 * UTC day (`engine/measurement.py`), so a day that overran is over though the
 * days around it left budget unspent — what a period's total would hide.
 */
export function overrunOf(rows: Pick<MeasuredRow, "at" | "cost">[], usdPerDay: number): number {
  const byDay = new Map<number, number>();
  for (const row of rows) byDay.set(Math.floor(row.at / DAY), (byDay.get(Math.floor(row.at / DAY)) ?? 0) + row.cost);
  return [...byDay.values()].reduce((over, spent) => over + Math.max(0, spent - usdPerDay), 0);
}

/** The rows `events` add. An event whose timestamp cannot be read counts at `fallback` (when the cockpit took it in). */
export function measuredIn(events: StoredEvent[], fallback: number): MeasuredRow[] {
  const rows: MeasuredRow[] = [];
  for (const event of events) {
    if (!foldedVersions(event.kind).includes(event.v)) continue;
    const p = Payload.parse(event.payload);
    const cost = p.obj("usage")?.num("total_cost") ?? 0;
    if (p.str("kind") !== "judge" || cost <= 0) continue;
    const ts = Date.parse(event.ts);
    rows.push({ seq: event.seq, kind: "judge", at: Number.isNaN(ts) ? fallback : ts, cost });
  }
  return rows;
}
