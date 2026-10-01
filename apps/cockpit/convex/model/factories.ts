/**
 * How the Factories list ranks its rows (spec #40): those that need
 * attention first, then the most recently active, then the rest by name —
 * or by name alone, when the viewer toggles it.
 *
 * Read against the page's own clock, like the Factory page's Needs attention
 * (`model/attention.ts`), whose facts each row carries: a failure stops
 * ranking its factory first a day after it ended, with nothing new arriving.
 */
import { type Attention, type Facts, needsAttention } from "./attention";
import { liveness } from "./command";
import type { Mode } from "./mode";

export type Order = "attention" | "name";

/** What of a `factories.list` row the order goes by. */
export interface Rankable {
  repo: string;
  lastActivity: number | null;
  /** When each of its stations last polled, 0 for never. */
  seen: number[];
  facts: Facts;
}

export interface Ranked<R extends Rankable> {
  row: R;
  /** What needs attention there now: empty for a factory that needs none. */
  attention: Attention[];
  /** How many of its stations are online now. */
  online: number;
}

export function rank<R extends Rankable>(rows: R[], now: number, order: Order): Ranked<R>[] {
  const ranked = rows.map((row) => ({
    row,
    attention: needsAttention(row.facts, now),
    online: row.seen.filter((seenAt) => liveness(seenAt, null, now).online).length,
  }));
  const byName = (a: Ranked<R>, b: Ranked<R>) => {
    const [x, y] = [a.row.repo.toLowerCase(), b.row.repo.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : 0;
  };
  if (order === "name") return ranked.sort(byName);
  return ranked.sort((a, b) =>
    Number(b.attention.length > 0) - Number(a.attention.length > 0) ||
    (b.row.lastActivity ?? 0) - (a.row.lastActivity ?? 0) ||
    byName(a, b));
}

/**
 * Where the Factories entry goes instead of the list: a solo developer's one
 * factory, in a local cockpit, is not a list of one (spec #40). A second
 * factory brings the list back; a team's cockpit always shows it.
 */
export function onlyFactory(mode: Mode, factories: { repo: string }[]): string | null {
  return mode === "local" && factories.length === 1 ? factories[0].repo : null;
}
