/**
 * A factory's Overview (#119), over the last days the viewer picked: what it
 * spent — in all, each day, by station and by person — how its sessions
 * ended, how long people kept its gates waiting, and the same by workflow
 * (model/overview.ts says how each is counted).
 *
 * Read off the rows ingest keeps — spend, the sessions' summaries, phases —
 * and never an event. The days are the viewer's own midnights
 * (`lastDays`), which the page works out in its timezone and passes in, so
 * this query is asked again only when a day moves on.
 */
import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { type PersonCost, rolledUp, SUMMED, spentOn, type StationCost } from "./cost";
import { type Day, dailyOf, type Outcomes, outcomesOf, type PhaseFacts, type WorkflowLine, workflowsOf } from "./model/overview";
import type { Period } from "./model/period";
import { endedAt, readSummary, type Summary } from "./model/session";
import type { Spend } from "./model/spend";
import { spellingsOf } from "./spelling";
import { readable, viewing } from "./viewer";

export interface Overview {
  /** The period held more rows than the cockpit sums at once, and nothing was: a shorter one will be. */
  cut: boolean;
  spend: {
    total: Spend;
    /** How many sessions spent anything in the period: what a session's share is of. */
    sessions: number;
    days: Day[];
    /** Most spent first. */
    stations: StationCost[];
    people: PersonCost[];
  };
  outcomes: Outcomes;
  workflows: WorkflowLine[];
}

const NONE: Overview = {
  cut: false,
  spend: { total: { cost: 0, tokens: 0 }, sessions: 0, days: [], stations: [], people: [] },
  outcomes: { sessions: 0, done: 0, failed: 0, open: 0, finish: null, gates: { rounds: 0, rejected: 0, wait: null } },
  workflows: [],
};

/**
 * `factory`'s Overview over `days` — the midnights that start each day, and
 * the one after the last. Null for someone who may not read the factory, or
 * has not signed in to a team's cockpit.
 */
export const page = query({
  args: { factory: v.string(), days: v.array(v.number()), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, days, signIn }): Promise<Overview | null> => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return null;
    const factory = await readable(ctx, who, named);
    if (factory === null) return null;
    if (days.length < 2) return NONE;
    const period = { from: days[0], to: days.at(-1)! };

    const spent = await spentOn(ctx, factory, period);
    const sessions = await endedIn(ctx, factory, period);
    const phases = await phasesIn(ctx, factory, period);
    if (spent === null || sessions === null || phases === null) return { ...NONE, cut: true };

    const rollup = await rolledUp(ctx, factory, spent);
    return {
      cut: false,
      spend: {
        total: rollup.total, sessions: rollup.sessions,
        days: dailyOf(spent, days), stations: rollup.stations, people: rollup.people,
      },
      outcomes: outcomesOf(sessions, phases),
      workflows: workflowsOf(sessions, phases, rollup.workflows),
    };
  },
});

/** The summaries of `factory`'s sessions that ended in `period`, or — still going — were last heard from in it; null past `SUMMED`. */
async function endedIn(ctx: QueryCtx, factory: string, period: Period): Promise<Summary[] | null> {
  const found: Summary[] = [];
  let read = 0;
  for (const spelling of await spellingsOf(ctx, factory)) {
    // A session's activity is when the cockpit last folded anything of it in: never before it ended.
    const records = ctx.db.query("sessions").withIndex("by_factory_activity", (q) => q.eq("factory", spelling).gte("activity", period.from));
    for await (const record of records) {
      if ((read += 1) > SUMMED) return null;
      const summary = readSummary(record.summary);
      const ended = endedAt({ summary, activity: record.activity });
      if (ended >= period.from && ended < period.to) found.push(summary);
    }
  }
  return found;
}

/** The rows of `factory`'s phases that started in `period`; null past `SUMMED`. */
async function phasesIn(ctx: QueryCtx, factory: string, period: Period): Promise<PhaseFacts[] | null> {
  const found: PhaseFacts[] = [];
  for (const spelling of await spellingsOf(ctx, factory)) {
    const rows = ctx.db.query("phases").withIndex("by_factory_at", (q) => q.eq("factory", spelling).gte("at", period.from).lt("at", period.to));
    for await (const row of rows) {
      if (found.length === SUMMED) return null;
      found.push(row);
    }
  }
  return found;
}
