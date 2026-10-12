/**
 * A factory's Measure tab, its Metrics view (#184): over the last days the
 * viewer picked, how many pull requests the factory opened, how many merged,
 * and autonomy — the share of the merged ones that were autonomous pull
 * requests (CONTEXT.md, model/pulls.ts says how one is decided).
 *
 * Read off the rows ingest keeps of each session's pull request, never an
 * event and never the forge (ADR 0006): a merge reaches the cockpit as the
 * `pull_request_closed` a station sends — its PR watcher's, or the same event
 * backfilled by `asf score`, counted alike. A pull request is the
 * period's OPENED when the session opened it in the period, and its MERGED
 * when it merged in it — the two need not be the same pull requests.
 */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { SUMMED } from "./cost";
import { defaultCheck, repoOf } from "./factory";
import { type BenchmarkedRow, type BenchmarkLine, compare, newestFirst } from "./model/benchmarks";
import { byTrigger, type TriggerLine } from "./model/chapters";
import { readDescription } from "./model/description";
import { type CostPerPr, costPerPrOf, type Costed, type Cycle, cycleOf, type Dear, dearestOf } from "./model/measure";
import { type MeasuredKind, overrunOf } from "./model/measured";
import { Payload } from "./model/payload";
import type { Period } from "./model/period";
import { type ImprovingPull, type Improvements, improvementsOf } from "./model/improvements";
import { type Cite, type Failing, ordered, type ScorerLine, scorerLine, STRIP, windowOf } from "./model/scorers";
import { described, isBenchmark, readSummary } from "./model/session";
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
  /** PR cycle time of the merged ones, by stage. */
  cycle: Cycle;
  /** Cost per PR of the merged ones whose cost the cockpit kept. */
  cost: CostPerPr;
  /** The merged ones that cost the most, dearest first. */
  expensive: Dear[];
  /** The chapters that started in the period, by trigger. The split by workflow is the Overview's. */
  chapters: TriggerLine[];
  /** What measuring cost in the period — never in any of the above. */
  measurement: Measurement;
}

/**
 * What measuring the factory's own work cost in the period (#193), by what was
 * paid for, USD list-price equivalent, against the budget the factory's
 * default branch described (`measurement: {usd_per_day}`, format 4) for each
 * of its days. Null where the factory never said its budget.
 */
export interface Measurement {
  judges: number;
  benchmarks: number;
  usdPerDay: number | null;
  /** How many days the period holds. */
  days: number;
  /** `usdPerDay` × `days`. */
  budget: number | null;
  /**
   * What the days of the period spent past their own budget, summed (model/measured.ts):
   * a judge that started under the budget may overrun it. 0 when none did, or no budget is known.
   */
  over: number;
}

const NONE: Metrics = {
  cut: false, opened: 0, merged: 0, autonomous: 0, autonomy: null, cycle: cycleOf([]), cost: costPerPrOf([]), expensive: [], chapters: byTrigger([]),
  measurement: { judges: 0, benchmarks: 0, usdPerDay: null, days: 0, budget: null, over: 0 },
};

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
    const chapters = await chaptersStartedIn(ctx, factory, period);
    const measured = await measuredRowsIn(ctx, factory, period);
    if (opened === null || merged === null || chapters === null || measured === null) return { ...NONE, cut: true };
    const autonomous = merged.filter((row) => row.autonomous).length;
    const costed = merged.flatMap(costedOf);
    return {
      cut: false, opened: opened.length, merged: merged.length, autonomous,
      autonomy: merged.length ? autonomous / merged.length : null,
      cycle: cycleOf(merged.map((row) => ({ ...row, kickoff: row.kickoff ?? null }))),
      cost: costPerPrOf(costed),
      expensive: dearestOf(costed),
      chapters: byTrigger(chapters),
      // `days` are the midnights that start each day and the one after the last: one more than the days.
      measurement: measurementOf(measured, await usdPerDayOf(ctx, factory), days.length - 1),
    };
  },
});

/** What `measured` cost by kind, against `usdPerDay` for each of `days` days. */
function measurementOf(measured: Doc<"measured">[], usdPerDay: number | null, days: number): Measurement {
  const spent = (kind: MeasuredKind) => measured.filter((row) => row.kind === kind).reduce((total, row) => total + row.cost, 0);
  return {
    judges: spent("judge"), benchmarks: spent("benchmark"), usdPerDay, days,
    budget: usdPerDay === null ? null : usdPerDay * days,
    over: usdPerDay === null ? 0 : overrunOf(measured, usdPerDay),
  };
}

/** The measurement budget `factory`'s default branch described (format 4); null when it described none. */
async function usdPerDayOf(ctx: QueryCtx, factory: string): Promise<number | null> {
  const described = await describedOf(ctx, factory);
  return described?.settings?.measure?.usdPerDay ?? null;
}

/** The self-description `factory`'s CI pushed for its default branch, read; null before one was. */
async function describedOf(ctx: QueryCtx, factory: string) {
  const check = await defaultCheck(ctx, factory, (await repoOf(ctx, factory))?.defaultBranch || null);
  return check === null ? null : readDescription(check.description);
}

/** What measuring `factory`'s work cost in `period`, row by row; null past `SUMMED`. */
async function measuredRowsIn(ctx: QueryCtx, factory: string, period: Period): Promise<Doc<"measured">[] | null> {
  const found: Doc<"measured">[] = [];
  for (const spelling of await spellingsOf(ctx, factory)) {
    const rows = ctx.db.query("measured").withIndex("by_factory_at", (q) => q.eq("factory", spelling).gte("at", period.from).lt("at", period.to));
    for await (const row of rows) {
      if (found.length === SUMMED) return null;
      found.push(row);
    }
  }
  return found;
}

/** A row with its cost, or none for one an older cockpit wrote before it kept what a pull request cost. */
function costedOf(row: Doc<"pulls">): Costed[] {
  const { spent } = row;
  return spent === undefined ? [] : [{ ...row, prs: row.prs ?? 1, lines: row.lines ?? null, spent }];
}

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

/** `factory`'s chapters that started in `period`; null past `SUMMED`. */
async function chaptersStartedIn(ctx: QueryCtx, factory: string, period: Period): Promise<Doc<"chapters">[] | null> {
  const found: Doc<"chapters">[] = [];
  for (const spelling of await spellingsOf(ctx, factory)) {
    const rows = ctx.db.query("chapters").withIndex("by_factory_at", (q) => q.eq("factory", spelling).gte("at", period.from).lt("at", period.to));
    for await (const row of rows) {
      if (found.length === SUMMED) return null;
      found.push(row);
    }
  }
  return found;
}

// ── the Scorers view ────────────────────────────────────────────────────────

/** A scorer's line as the view shows it: each failing counted session with the first event it cites. */
export type ScorerView = Omit<ScorerLine, "failing"> & { failing: Failing[] };

export interface Scorers {
  /** Whether the factory has described itself on its default branch: what names its scorers. */
  described: boolean;
  /** How many sessions the strip spans: the factory's last `STRIP`, or all it has. */
  sessions: number;
  /** Nearest its threshold first, the inactive last. */
  scorers: ScorerView[];
}

/**
 * `factory`'s Scorers view (#190): every scorer its default branch's
 * self-description names, over the factory's last `STRIP` sessions, with
 * the sessions counted toward the threshold the description resolved for it
 * — since its last self-improvement merge — and its self-improvement issues
 * (#196). Null for someone who may not read the factory, or has not signed
 * in to a team's cockpit.
 */
export const scorers = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }): Promise<Scorers | null> => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return null;
    const factory = await readable(ctx, who, named);
    if (factory === null) return null;
    const described = await describedOf(ctx, factory);
    if (described === null) return { described: false, sessions: 0, scorers: [] };
    const spellings = await spellingsOf(ctx, factory);

    // The factory's own work: a benchmark's session is measurement, in no scorer's strip or window.
    const latest: Doc<"sessions">[] = [];
    for (const spelling of spellings) {
      let taken = 0;
      for await (const record of ctx.db.query("sessions").withIndex("by_factory", (q) => q.eq("factory", spelling)).order("desc")) {
        if (isBenchmark(readSummary(record.summary))) continue;
        latest.push(record);
        if ((taken += 1) === STRIP) break;
      }
    }
    const strip = latest.sort((a, b) => a._creationTime - b._creationTime).slice(-STRIP);
    const from = strip[0]?._creationTime ?? Infinity;

    const lines = await Promise.all(described.scorers.map(async (scorer) => {
      const rows = new Map<string, Doc<"scores">>();
      for (const spelling of spellings) {
        const of = () => ctx.db.query("scores").withIndex("by_factory_scorer", (q) => q.eq("factory", spelling).eq("scorer", scorer.name));
        for (const row of await of().order("desc").take(windowOf(scorer.improveAfter))) rows.set(row.session, row);
        if (from !== Infinity) {
          const inStrip = ctx.db.query("scores").withIndex("by_factory_scorer", (q) => q.eq("factory", spelling).eq("scorer", scorer.name).gte("at", from));
          for await (const row of inStrip) rows.set(row.session, row);
        }
      }
      const line = scorerLine(scorer, strip.map((record) => ({ session: record.session, at: record._creationTime })),
                              [...rows.values()], await improvementsFor(ctx, spellings, scorer.name));
      const failing = await Promise.all(line.failing.map(async ({ seq, ...each }) =>
        ({ ...each, cite: seq === null ? null : await citeOf(ctx, rows.get(each.session)!.factory, each.session, seq) })));
      return { ...line, failing };
    }));
    return { described: true, sessions: strip.length, scorers: ordered(lines) };
  },
});

/** `scorer`'s self-improvement: the issues filed for it, and the pull requests of the sessions that worked them. */
async function improvementsFor(ctx: QueryCtx, spellings: string[], scorer: string): Promise<Improvements> {
  const issues: Doc<"improvements">[] = [];
  const pulls: ImprovingPull[] = [];
  for (const spelling of spellings) {
    issues.push(...await ctx.db.query("improvements").withIndex("by_factory_scorer", (q) => q.eq("factory", spelling).eq("scorer", scorer)).collect());
    for (const row of await ctx.db.query("pulls").withIndex("by_factory_improves", (q) => q.eq("factory", spelling).eq("improves", scorer)).collect()) {
      pulls.push({ session: row.session, issue: row.issue ?? 0, url: row.url, opened: row.opened, closed: row.closed, merged: row.merged, mergedAt: row.mergedAt });
    }
  }
  return improvementsOf(issues.map(({ number, url, title, cause, surface, notDiagnosed, at }) => ({ number, url, title, cause, surface, notDiagnosed, at })), pulls);
}

/** The event at `seq` of a session, as a score cites it; null when the cockpit holds no such event. */
async function citeOf(ctx: QueryCtx, factory: string, session: string, seq: number): Promise<Cite | null> {
  const event = await ctx.db.query("events")
    .withIndex("by_session_seq", (q) => q.eq("factory", factory).eq("session", session).eq("seq", seq)).unique();
  if (event === null) return null;
  return { seq, detail: described(event) || event.kind, phaseId: Payload.parse(event.payload).str("phase_id") };
}

// ── the Benchmarks view ─────────────────────────────────────────────────────

export interface Benchmarks {
  /** Whether the factory has described itself on its default branch: what names its benchmarks. */
  described: boolean;
  /** Newest first, the never worked last. */
  benchmarks: BenchmarkLine[];
}

/**
 * `factory`'s Benchmarks view (#199): every benchmark its default branch's
 * self-description names (format 5), compared over the benchmark sessions the
 * cockpit holds of it — mean ± run-to-run noise per variant and metric, with
 * readings in words (model/benchmarks.ts). Null for someone who may not read
 * the factory, or has not signed in to a team's cockpit.
 */
export const benchmarks = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }): Promise<Benchmarks | null> => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return null;
    const factory = await readable(ctx, who, named);
    if (factory === null) return null;
    const described = await describedOf(ctx, factory);
    if (described === null) return { described: false, benchmarks: [] };
    const spellings = await spellingsOf(ctx, factory);
    const lines = await Promise.all(described.benchmarks.map(async (benchmark) => {
      const rows: BenchmarkedRow[] = [];
      for (const spelling of spellings) {
        rows.push(...await ctx.db.query("benchmarked")
          .withIndex("by_factory_benchmark", (q) => q.eq("factory", spelling).eq("benchmark", benchmark.name)).collect());
      }
      return compare(benchmark, rows);
    }));
    return { described: true, benchmarks: newestFirst(lines) };
  },
});
