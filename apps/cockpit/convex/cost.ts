/**
 * What a factory's agent calls cost in a period, rolled up (spec #40): by
 * workflow, station — whose machine and key paid, and so whose it is — and
 * person, who triggered the run. "Who spent" and "who asked" differ whenever
 * a teammate's label is picked up by your watcher. A factory's Overview
 * reads it (overview.ts).
 *
 * Read off the `spend` table (model/spend.ts), which ingest charges as each
 * `usage` event arrives, and summed for the days the page asks for, by the
 * viewer's own midnights (model/period.ts). Every amount is list-price
 * equivalent, with the tokens it bought alongside, and nothing here is a
 * budget: the only ceiling there is is the factory's per session.
 */
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import type { Period } from "./model/period";
import { readSummary, type Summary } from "./model/session";
import { type Charge, chargeOf, type Spend } from "./model/spend";
import { spellingsOf } from "./spelling";

/**
 * The most `spend` rows one roll-up sums: a quarter hour a session and
 * charge, so a busy team's month is well under it, and a period long enough
 * to pass it is refused rather than summed in part.
 */
export const SUMMED = 10_000;

export interface WorkflowCost extends Spend {
  workflow: string;
}

export interface StationCost extends Spend {
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
  total: Spend;
  /** How many sessions spent anything. */
  sessions: number;
  /** Each dimension, most spent first. */
  workflows: WorkflowCost[];
  stations: StationCost[];
  people: PersonCost[];
}

/**
 * The rows `factory` — as it is stored now — spent in `period`, under every
 * spelling its rows were stored under (`spelling.ts`), as the Factories list
 * sums it; null when there are more than `SUMMED`.
 */
export async function spentOn(ctx: QueryCtx, factory: string, { from, to }: Period): Promise<Doc<"spend">[] | null> {
  const rows: Doc<"spend">[] = [];
  for (const spelling of await spellingsOf(ctx, factory)) {
    const found = ctx.db.query("spend").withIndex("by_factory_at", (q) => q.eq("factory", spelling).gte("at", from).lt("at", to));
    for await (const row of found) {
      if (rows.length === SUMMED) return null;
      rows.push(row);
    }
  }
  return rows;
}

/** `rows` of `factory` — as it is stored now — rolled up. */
export async function rolledUp(ctx: QueryCtx, factory: string, rows: Doc<"spend">[]): Promise<Rollup> {
  const summaries = new Map<string, Summary>();
  const workflows = new Map<string, WorkflowCost>();
  const stations = new Map<string, StationCost>();
  const people = new Map<string, PersonCost>();
  const total: Spend = { cost: 0, tokens: 0 };

  for (const row of rows) {
    const key = JSON.stringify([row.factory, row.session]);
    if (!summaries.has(key)) summaries.set(key, await summaryOf(ctx, row.factory, row.session));
    const charge = chargeIn(row, summaries.get(key)!);
    add(total, row);
    add(entry(workflows, charge.workflow, () => ({ workflow: charge.workflow })), row);
    add(entry(stations, charge.station, () => ({ station: charge.station, name: charge.stationName, owner: "" })), row);
    add(entry(people, charge.person, () => ({ person: charge.person })), row);
  }

  // A registered station is its owner's, under the name it registered with.
  for (const station of stations.values()) {
    const registered = await ctx.db.query("stations")
      .withIndex("by_station", (q) => q.eq("factory", factory).eq("station", station.station)).unique();
    if (registered !== null) Object.assign(station, { name: registered.name, owner: registered.ownerLogin });
  }

  return { total, sessions: summaries.size, workflows: ranked(workflows), stations: ranked(stations), people: ranked(people) };
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
