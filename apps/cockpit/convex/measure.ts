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
import { byTrigger, type TriggerLine } from "./model/chapters";
import { readDescription } from "./model/description";
import { type CostPerPr, costPerPrOf, type Costed, type Cycle, cycleOf, type Dear, dearestOf } from "./model/measure";
import { Payload } from "./model/payload";
import type { Period } from "./model/period";
import { type Cite, type Failing, ordered, type ScorerLine, scorerLine, STRIP, windowOf } from "./model/scorers";
import { described } from "./model/session";
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
}

const NONE: Metrics = {
  cut: false, opened: 0, merged: 0, autonomous: 0, autonomy: null, cycle: cycleOf([]), cost: costPerPrOf([]), expensive: [], chapters: byTrigger([]),
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
    if (opened === null || merged === null || chapters === null) return { ...NONE, cut: true };
    const autonomous = merged.filter((row) => row.autonomous).length;
    const costed = merged.flatMap(costedOf);
    return {
      cut: false, opened: opened.length, merged: merged.length, autonomous,
      autonomy: merged.length ? autonomous / merged.length : null,
      cycle: cycleOf(merged.map((row) => ({ ...row, kickoff: row.kickoff ?? null }))),
      cost: costPerPrOf(costed),
      expensive: dearestOf(costed),
      chapters: byTrigger(chapters),
    };
  },
});

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
 * the sessions counted toward the threshold the description resolved for it.
 * Null for someone who may not read the factory, or has not signed in to a
 * team's cockpit.
 */
export const scorers = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }): Promise<Scorers | null> => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return null;
    const factory = await readable(ctx, who, named);
    if (factory === null) return null;
    const check = await defaultCheck(ctx, factory, (await repoOf(ctx, factory))?.defaultBranch || null);
    if (check === null) return { described: false, sessions: 0, scorers: [] };
    const spellings = await spellingsOf(ctx, factory);

    const latest: Doc<"sessions">[] = [];
    for (const spelling of spellings) {
      latest.push(...await ctx.db.query("sessions").withIndex("by_factory", (q) => q.eq("factory", spelling)).order("desc").take(STRIP));
    }
    const strip = latest.sort((a, b) => a._creationTime - b._creationTime).slice(-STRIP);
    const from = strip[0]?._creationTime ?? Infinity;

    const lines = await Promise.all(readDescription(check.description).scorers.map(async (scorer) => {
      const rows = new Map<string, Doc<"scores">>();
      for (const spelling of spellings) {
        const of = () => ctx.db.query("scores").withIndex("by_factory_scorer", (q) => q.eq("factory", spelling).eq("scorer", scorer.name));
        for (const row of await of().order("desc").take(windowOf(scorer.improveAfter))) rows.set(row.session, row);
        if (from !== Infinity) {
          const inStrip = ctx.db.query("scores").withIndex("by_factory_scorer", (q) => q.eq("factory", spelling).eq("scorer", scorer.name).gte("at", from));
          for await (const row of inStrip) rows.set(row.session, row);
        }
      }
      const line = scorerLine(scorer, strip.map((record) => record.session), [...rows.values()]);
      const failing = await Promise.all(line.failing.map(async ({ seq, ...each }) =>
        ({ ...each, cite: seq === null ? null : await citeOf(ctx, rows.get(each.session)!.factory, each.session, seq) })));
      return { ...line, failing };
    }));
    return { described: true, sessions: strip.length, scorers: ordered(lines) };
  },
});

/** The event at `seq` of a session, as a score cites it; null when the cockpit holds no such event. */
async function citeOf(ctx: QueryCtx, factory: string, session: string, seq: number): Promise<Cite | null> {
  const event = await ctx.db.query("events")
    .withIndex("by_session_seq", (q) => q.eq("factory", factory).eq("session", session).eq("seq", seq)).unique();
  if (event === null) return null;
  return { seq, detail: described(event) || event.kind, phaseId: Payload.parse(event.payload).str("phase_id") };
}
