/**
 * What a session's agent calls cost, as its `usage` events say (spec #40):
 * list-price equivalent, tokens always alongside. Kept by quarter hour —
 * one row per session and quarter hour it spent in — so a period starting at
 * any midnight a timezone has (every offset in use is a multiple of fifteen
 * minutes) takes whole rows, and a month is a few rows a session instead of
 * one an agent call.
 */
import { Payload } from "./payload";
import type { StoredEvent } from "./wire";

export const BUCKET = 15 * 60_000;

/** What was spent: list-price equivalent in USD, and the tokens it bought. */
export interface Spend {
  cost: number;
  tokens: number;
}

export interface Spent extends Spend {
  /** The quarter hour it was spent in: its start, epoch ms. */
  at: number;
}

/**
 * What `events` spent, by quarter hour, earliest first. An event whose
 * timestamp cannot be read counts at `fallback` (when the cockpit took it in),
 * rather than not at all.
 */
export function spentIn(events: StoredEvent[], fallback: number): Spent[] {
  const buckets = new Map<number, Spent>();
  for (const event of events) {
    if (event.kind !== "usage" || event.v !== 1) continue;
    const payload = Payload.parse(event.payload);
    const ts = Date.parse(event.ts);
    const at = Math.floor((Number.isNaN(ts) ? fallback : ts) / BUCKET) * BUCKET;
    const bucket = buckets.get(at) ?? { at, cost: 0, tokens: 0 };
    bucket.cost += payload.num("cost");
    bucket.tokens += payload.num("tokens");
    buckets.set(at, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}
