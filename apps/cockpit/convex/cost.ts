/**
 * What the factories' agent calls cost in a period, rolled up (spec #40):
 * by session, workflow, factory, station — whose machine and key paid, and so
 * whose it is — and person, who triggered the run. "Who spent" and "who
 * asked" differ whenever a teammate's label is picked up by your watcher.
 *
 * Read off the `spend` table (model/spend.ts), which ingest charges as each
 * `usage` event arrives, and summed for whichever period the page asks for:
 * a calendar day, week or month of the viewer's own timezone, or a range of
 * days (model/period.ts). Every amount is list-price equivalent, with the
 * tokens it bought alongside, and nothing here is a budget: the only ceiling
 * there is is the factory's per session.
 */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { readSummary, type Summary } from "./model/session";
import { type Charge, chargeOf, type Spend } from "./model/spend";
import { spellingsOf, storedAs } from "./spelling";
import { canRead, readable, viewing } from "./viewer";

/**
 * The most `spend` rows one roll-up sums: a quarter hour a session and
 * charge, so a busy team's month is well under it, and a range of days long
 * enough to pass it is refused (`cut`) rather than summed in part.
 */
export const SUMMED = 10_000;

export interface SessionCost extends Spend {
  factory: string;
  session: string;
  /** What it was asked to do, and the workflows it passed through: what names it on the page. */
  request: string;
  workflows: string[];
}

export interface WorkflowCost extends Spend {
  /** A workflow is its factory's: two factories' `ship` are two workflows. */
  factory: string;
  workflow: string;
}

export interface FactoryCost extends Spend {
  factory: string;
}

export interface StationCost extends Spend {
  factory: string;
  station: string;
  name: string;
  /** The forge login of whoever registered it, "" for a station nobody did: whose machine and key paid. */
  owner: string;
}

export interface PersonCost extends Spend {
  /** The forge login of whoever triggered the runs, "" for runs the factory named nobody for. */
  person: string;
}

export interface Rollup {
  /** The period held more than `SUMMED` rows, and nothing was summed: a shorter one will be. */
  cut: boolean;
  total: Spend;
  /** Each dimension, most spent first. */
  sessions: SessionCost[];
  workflows: WorkflowCost[];
  factories: FactoryCost[];
  stations: StationCost[];
  people: PersonCost[];
}

/**
 * What was spent in `period` — in `factory` alone on its Factory page, in
 * every factory the viewer can read on the Cost page. Null for someone who
 * may not read the factory, or has not signed in to a team's cockpit. A
 * factory is summed under every spelling its rows were stored under, and
 * named by the one it is stored under now (`spelling.ts`), as the Factories
 * list sums it.
 */
export const rollup = query({
  args: {
    factory: v.optional(v.string()),
    period: v.object({ from: v.number(), to: v.number() }),
    signIn: v.optional(v.string()),
  },
  handler: async (ctx, { factory: named, period: { from, to }, signIn }): Promise<Rollup | null> => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return null;
    const rows: Stored[] = [];
    let scanned = 0;
    if (named !== undefined) {
      const factory = await readable(ctx, who, named);
      if (factory === null) return null;
      for (const spelling of await spellingsOf(ctx, factory)) {
        const found = ctx.db.query("spend").withIndex("by_factory_at", (q) => q.eq("factory", spelling).gte("at", from).lt("at", to));
        for await (const row of found) {
          if ((scanned += 1) > SUMMED) return { ...NOTHING, cut: true };
          rows.push({ row, factory });
        }
      }
    } else {
      const storedHere = new Map<string, string | null>();
      for await (const row of ctx.db.query("spend").withIndex("by_at", (q) => q.gte("at", from).lt("at", to))) {
        if ((scanned += 1) > SUMMED) return { ...NOTHING, cut: true };
        if (!storedHere.has(row.factory)) {
          storedHere.set(row.factory, (await canRead(ctx, who, row.factory)) ? await storedAs(ctx, row.factory) : null);
        }
        const factory = storedHere.get(row.factory)!;
        if (factory !== null) rows.push({ row, factory });
      }
    }
    return await rolledUp(ctx, rows);
  },
});

const NOTHING: Rollup = {
  cut: false, total: { cost: 0, tokens: 0 }, sessions: [], workflows: [], factories: [], stations: [], people: [],
};

/** A row as it was stored, and the factory it is summed under: the spelling its factory is stored under now. */
interface Stored {
  row: Doc<"spend">;
  factory: string;
}

async function rolledUp(ctx: QueryCtx, rows: Stored[]): Promise<Rollup> {
  const summaries = new Map<string, Summary>();
  const sessions = new Map<string, SessionCost>();
  const workflows = new Map<string, WorkflowCost>();
  const factories = new Map<string, FactoryCost>();
  const stations = new Map<string, StationCost>();
  const people = new Map<string, PersonCost>();
  const total: Spend = { cost: 0, tokens: 0 };

  for (const { row, factory } of rows) {
    const key = JSON.stringify([row.factory, row.session]);
    if (!summaries.has(key)) summaries.set(key, await summaryOf(ctx, row.factory, row.session));
    const summary = summaries.get(key)!;
    const charge = chargeIn(row, summary);
    add(total, row);
    add(entry(sessions, key, () => ({
      factory, session: row.session, request: summary.request, workflows: summary.workflows,
    })), row);
    add(entry(workflows, JSON.stringify([factory, charge.workflow]), () => ({ factory, workflow: charge.workflow })), row);
    add(entry(factories, factory, () => ({ factory })), row);
    add(entry(stations, JSON.stringify([factory, charge.station]), () => ({
      factory, station: charge.station, name: charge.stationName, owner: "",
    })), row);
    add(entry(people, charge.person, () => ({ person: charge.person })), row);
  }

  // A registered station is its owner's, under the name it registered with.
  for (const station of stations.values()) {
    const registered = await ctx.db.query("stations")
      .withIndex("by_station", (q) => q.eq("factory", station.factory).eq("station", station.station)).unique();
    if (registered !== null) Object.assign(station, { name: registered.name, owner: registered.ownerLogin });
  }

  return {
    cut: false, total, sessions: ranked(sessions), workflows: ranked(workflows), factories: ranked(factories),
    stations: ranked(stations), people: ranked(people),
  };
}

/** What a row is charged to: what ingest charged it, or — stored before it charged anything — its session's summary. */
function chargeIn(row: Doc<"spend">, summary: Summary): Charge {
  if (row.workflow === undefined) return chargeOf(summary);
  return { workflow: row.workflow, station: row.station ?? "", stationName: row.stationName ?? "", person: row.person ?? "" };
}

async function summaryOf(ctx: QueryCtx, factory: string, session: string): Promise<Summary> {
  const record = await ctx.db.query("sessions")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session)).unique();
  return readSummary(record?.summary);
}

function entry<T extends Spend>(lines: Map<string, T>, key: string, made: () => Omit<T, keyof Spend>): T {
  let line = lines.get(key);
  if (line === undefined) {
    line = { ...made(), cost: 0, tokens: 0 } as T;
    lines.set(key, line);
  }
  return line;
}

function add(into: Spend, spent: Spend): void {
  into.cost += spent.cost;
  into.tokens += spent.tokens;
}

/** Most spent first; what spent alike, in the order it was first spent. */
function ranked<T extends Spend>(lines: Map<string, T>): T[] {
  return [...lines.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}
