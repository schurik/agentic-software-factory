/**
 * The Metrics view's work numbers (#188), worked out from the rows ingest
 * keeps of each session's pull request (model/pulls.ts) — never from an
 * event, never from the forge (ADR 0006). Each is over the pull requests
 * that merged in the period: the ones whose cycle is over, and whose cost
 * is all spent.
 */
import { median } from "./overview";
import { COMPONENTS, type Components, costOf, type PullRow } from "./pulls";

/** One stretch of a pull request's cycle: its median, seconds, and how many pull requests it is the median of. */
export interface Stretch {
  median: number | null;
  prs: number;
}

/**
 * PR cycle time, leg by leg: kickoff (the session started) → PR (its own
 * integration opened it) → first review → merge, and the whole. Each leg is
 * timed only where both its ends are known — a pull request nobody reviewed
 * has no leg to or from its review, one the session did not open no leg up to
 * its opening — so the medians need not add up to the whole's.
 */
export interface Cycle {
  toPr: Stretch;
  toReview: Stretch;
  toMerge: Stretch;
  total: Stretch;
}

/** What a leg's seconds are, from `from` to `to` (epoch ms); null when either end is unknown. */
function between(from: number | null | undefined, to: number | null | undefined): number | null {
  return from == null || to == null ? null : Math.max(0, (to - from) / 1000);
}

function stretch(seconds: (number | null)[]): Stretch {
  const known = seconds.filter((each): each is number => each !== null);
  return { median: median(known), prs: known.length };
}

/** The cycle time of `merged`, pull requests that merged. */
export function cycleOf(merged: Pick<PullRow, "kickoff" | "opened" | "firstReviewAt" | "mergedAt">[]): Cycle {
  return {
    toPr: stretch(merged.map((row) => between(row.kickoff, row.opened))),
    toReview: stretch(merged.map((row) => (row.opened === null ? null : between(row.opened, row.firstReviewAt)))),
    toMerge: stretch(merged.map((row) => between(row.firstReviewAt, row.mergedAt))),
    total: stretch(merged.map((row) => between(row.kickoff, row.mergedAt))),
  };
}

/** A merged pull request's cost, as Metrics reads it off its row. */
export type Priced = Pick<PullRow, "prs" | "spent" | "lines">;

/** A merged pull request whose cost is known, and whose it is. */
export type Costed = Priced & Pick<PullRow, "url" | "autonomous"> & { session: string };

/**
 * Cost per PR: the median of what each merged pull request's session spent on
 * agent calls — list-price equivalent, and work only (model/pulls.ts keeps
 * measurement out) — split evenly between the pull requests that session
 * opened, and the same by component. Medians each: the components' need not
 * add up to the whole's.
 */
export interface CostPerPr {
  /** How many merged pull requests it is the median of. */
  prs: number;
  median: number | null;
  components: Record<keyof Components, number | null>;
  /** The same by size, every size in order, each the median of its own. */
  sizes: SizeLine[];
  /** Of `prs`, those whose close never said how many lines they changed: in no size. */
  unsized: number;
}

/** A pull request's size by its changed lines: S under 100, M under 500, L under 1,000, XL from there. */
export type Size = "S" | "M" | "L" | "XL";

export interface SizeLine {
  size: Size;
  prs: number;
  median: number | null;
}

/** Each size and the fewest changed lines it starts at, smallest first. */
export const SIZES: [Size, number][] = [["S", 0], ["M", 100], ["L", 500], ["XL", 1000]];

/** The size of a pull request that changed `lines`. */
export function sizeOf(lines: number): Size {
  return SIZES.findLast(([, from]) => lines >= from)![0];
}

/** `row`'s share of its session's spend, by component. */
export function shareOf(row: Priced): Components {
  const split = Math.max(1, row.prs);
  return Object.fromEntries(COMPONENTS.map((each) => [each, row.spent[each] / split])) as unknown as Components;
}

/** The cost per PR of `merged`, pull requests that merged. */
export function costPerPrOf(merged: Priced[]): CostPerPr {
  const shares = merged.map(shareOf);
  const sized = merged.map((row, index) => ({ size: row.lines === null ? null : sizeOf(row.lines), cost: costOf(shares[index]) }));
  return {
    prs: shares.length,
    median: median(shares.map(costOf)),
    components: Object.fromEntries(COMPONENTS.map((each) => [each, median(shares.map((share) => share[each]))])) as CostPerPr["components"],
    sizes: SIZES.map(([size]) => {
      const costs = sized.filter((each) => each.size === size).map((each) => each.cost);
      return { size, prs: costs.length, median: median(costs) };
    }),
    unsized: sized.filter((each) => each.size === null).length,
  };
}

/** How many of the dearest merged pull requests Metrics lists. */
export const DEAREST = 5;

/** A merged pull request among the dearest: its session, to read what it took, and its share of that session's spend. */
export interface Dear {
  session: string;
  url: string;
  cost: number;
  lines: number | null;
  size: Size | null;
  autonomous: boolean;
}

/** The `DEAREST` of `merged` that cost the most, dearest first. */
export function dearestOf(merged: Costed[]): Dear[] {
  return merged
    .map((row): Dear => ({
      session: row.session, url: row.url, cost: costOf(shareOf(row)), lines: row.lines,
      size: row.lines === null ? null : sizeOf(row.lines), autonomous: row.autonomous,
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, DEAREST);
}
