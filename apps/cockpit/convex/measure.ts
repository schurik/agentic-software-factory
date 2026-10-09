/**
 * A factory's Measure tab, its Metrics view (#184): over the last days the
 * viewer picked, how many pull requests the factory opened, how many merged,
 * and autonomy — the share of the merged ones that were autonomous pull
 * requests (CONTEXT.md, model/pulls.ts says how one is decided).
 *
 * Read off the rows ingest keeps of each session's pull request, never an
 * event and never the forge (ADR 0006): a merge reaches the cockpit as the
 * `pull_request_closed` a station's PR watcher sends. A pull request is the
 * period's OPENED when the session opened it in the period, and its MERGED
 * when it merged in it — the two need not be the same pull requests.
 */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { SUMMED } from "./cost";
import type { Period } from "./model/period";
import { spellingsOf } from "./spelling";
import { readable, viewing } from "./viewer";

export interface Metrics {
  /** The period held more pull requests than the cockpit counts at once, and nothing was: a shorter one will be. */
  cut: boolean;
  opened: number;
  merged: number;
  /** Of the merged ones, how many were autonomous. */
  autonomous: number;
  /** `autonomous / merged`; null when nothing merged, which is no share at all. */
  autonomy: number | null;
}

const NONE: Metrics = { cut: false, opened: 0, merged: 0, autonomous: 0, autonomy: null };

/**
 * `factory`'s Metrics over `days` — the midnights that start each day, and the
 * one after the last, as the Overview takes them. Null for someone who may not
 * read the factory, or has not signed in to a team's cockpit.
 */
export const metrics = query({
  args: { factory: v.string(), days: v.array(v.number()), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, days, signIn }): Promise<Metrics | null> => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return null;
    const factory = await readable(ctx, who, named);
    if (factory === null) return null;
    if (days.length < 2) return NONE;
    const period = { from: days[0], to: days.at(-1)! };

    const opened = await pullsIn(ctx, factory, period, "opened");
    const merged = await pullsIn(ctx, factory, period, "mergedAt");
    if (opened === null || merged === null) return { ...NONE, cut: true };
    const autonomous = merged.filter((row) => row.autonomous).length;
    return {
      cut: false, opened: opened.length, merged: merged.length, autonomous,
      autonomy: merged.length ? autonomous / merged.length : null,
    };
  },
});

/** The index each of a pull request's moments is read by. */
const BY = { opened: "by_factory_opened", mergedAt: "by_factory_merged" } as const;

/** `factory`'s pull requests whose `field` falls in `period`; null past `SUMMED`. */
async function pullsIn(ctx: QueryCtx, factory: string, period: Period,
                       field: keyof typeof BY): Promise<Doc<"pulls">[] | null> {
  const found: Doc<"pulls">[] = [];
  for (const spelling of await spellingsOf(ctx, factory)) {
    const rows = ctx.db.query("pulls").withIndex(BY[field], (q) => q.eq("factory", spelling).gte(field, period.from).lt(field, period.to));
    for await (const row of rows) {
      if (found.length === SUMMED) return null;
      found.push(row);
    }
  }
  return found;
}
