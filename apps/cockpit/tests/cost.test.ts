import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { SUMMED } from "../convex/cost";
import { lastDays, type Period, periodOf } from "../convex/model/period";
import { catchUp, type Cockpit, factory, fixture, ingest, recorded, signIn, type WireEvent } from "./helpers";
import { approved, fakeForge, localOf, STATION, teamOf } from "./station";

// Cost is rolled up from `usage` events by workflow, station (whose machine and
// key paid, and so its owner) and person (who triggered the run), over a
// period of the viewer's own calendar (spec #40, #62) — as a factory's
// Overview reads it (#119).

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const at = (iso: string) => Date.parse(iso);
const SEPTEMBER = { from: at("2026-09-01T00:00:00Z"), to: at("2026-10-01T00:00:00Z") };

/** A session started on `station` by `person` in `workflow`, then `calls` agent calls of the usage fixture's. */
function spending(session: string, { workflow, person, station, calls, ts }: {
  workflow: string; person: string; station: { id: string; name: string }; calls: number; ts?: string;
}): WireEvent[] {
  const started = fixture("session_started", 1, 2);
  Object.assign(started.payload, {
    adw_id: session, workflow, triggered_by: person, station_id: station.id, station_name: station.name,
  });
  const usage = Array.from({ length: calls }, (_, index) => {
    const event = fixture("usage", index + 2);
    return ts ? { ...event, ts } : event;
  });
  return [started, ...usage];
}

const close = (cost: number) => expect.closeTo(cost, 9);

/** What `factory`'s Overview spends over `period`, taken as one day, for the viewer `signIn` holds. */
async function spendOf(t: Cockpit, factory: string, { from, to }: Period, signIn?: string) {
  return (await t.query(api.overview.page, { factory, days: [from, to], signIn }))?.spend;
}

/** What each workflow of `factory` spent over `period`, most sessions first, then most spent. */
async function workflowsOf(t: Cockpit, factory: string, { from, to }: Period) {
  return (await t.query(api.overview.page, { factory, days: [from, to] }))?.workflows
    .map(({ workflow, cost, tokens }) => ({ workflow, cost, tokens }));
}

describe("cost rolled up over the corpus", () => {
  // acme/widgets: the recorded session — its issue workflow spent $0.383 for
  // 23,100 tokens, then two pr-review chapters $0.04 and 2,000 tokens each, all
  // on schurik@mbp:widgets, triggered by nobody the factory named — and a
  // ship session of two usage fixtures ($0.0185, 1,200 tokens each) on alex's
  // registered station, triggered by schurik. acme/gadgets: one more call, by sam.
  async function corpusOf(t: Cockpit) {
    const widgets = await factory(t, "acme/widgets");
    await ingest(t, widgets, { session: "a9f259f0", events: recorded["issue-then-two-reviews"].events });
    await ingest(t, widgets, { session: "5c0075aa", events: spending("5c0075aa", {
      workflow: "ship", person: "schurik", station: STATION, calls: 2,
    }) });
    await t.action(internal.stations.local, { factory: "acme/widgets", station: STATION });
    const gadgets = await factory(t, "acme/gadgets");
    await ingest(t, gadgets, { session: "77aa0011", events: spending("77aa0011", {
      workflow: "ship", person: "sam", station: { id: "st_gadgets", name: "alex@mbp:gadgets" }, calls: 1,
    }) });
  }

  it("matches the sums worked by hand, for every dimension", async () => {
    const forge = fakeForge();
    const { t } = await localOf(forge);
    await corpusOf(t);

    const spend = await spendOf(t, "acme/widgets", SEPTEMBER);

    expect(spend?.total).toEqual({ cost: close(0.5), tokens: 29_500 });
    expect(spend?.sessions).toBe(2);
    expect(spend?.stations).toEqual([
      { station: "st_93db23f2e84f", name: "schurik@mbp:widgets", owner: "", cost: close(0.463), tokens: 27_100 },
      { station: STATION.id, name: STATION.name, owner: "alex", cost: close(0.037), tokens: 2_400 },
    ]);
    expect(spend?.people).toEqual([
      { person: "", cost: close(0.463), tokens: 27_100 },
      { person: "schurik", cost: close(0.037), tokens: 2_400 },
    ]);
    expect(await workflowsOf(t, "acme/widgets", SEPTEMBER)).toEqual([
      { workflow: "issue", cost: close(0.383), tokens: 23_100 },
      { workflow: "pr-review", cost: close(0.08), tokens: 4_000 },
      { workflow: "ship", cost: close(0.037), tokens: 2_400 },
    ]);
  });

  it("is one factory's alone, however the page spells it", async () => {
    const forge = fakeForge();
    const { t } = await localOf(forge);
    forge.repo("acme/gadgets", { factory: true, roles: { alex: "admin" } });
    await catchUp(t);
    await corpusOf(t);

    expect((await spendOf(t, "Acme/Widgets", SEPTEMBER))?.total).toEqual({ cost: close(0.5), tokens: 29_500 });
    expect((await spendOf(t, "acme/gadgets", SEPTEMBER))?.total).toEqual({ cost: 0.0185, tokens: 1_200 });
  });

  it("is nothing outside the period", async () => {
    const forge = fakeForge();
    const { t } = await localOf(forge);
    await corpusOf(t);

    const spend = await spendOf(t, "acme/widgets", { from: SEPTEMBER.to, to: at("2026-11-01T00:00:00Z") });

    expect(spend).toMatchObject({ total: { cost: 0, tokens: 0 }, sessions: 0, stations: [], people: [] });
  });
});

describe("who spent and who asked", () => {
  it("are told apart when a teammate's label is picked up by your watcher", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write", sam: "triage" });
    const ingestToken = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    await approved(t, ingestToken, alex);
    // sam labelled the issue; alex's station's issues watcher started the run.
    await ingest(t, ingestToken, { session: "5c0075aa", events: spending("5c0075aa", {
      workflow: "ship", person: "sam", station: STATION, calls: 1,
    }) });

    const spend = await spendOf(t, "acme/widgets", SEPTEMBER, await signIn(t, forge, "sam"));

    expect(spend?.stations).toEqual([
      { station: STATION.id, name: STATION.name, owner: "alex", cost: 0.0185, tokens: 1_200 },
    ]);
    expect(spend?.people).toEqual([{ person: "sam", cost: 0.0185, tokens: 1_200 }]);
  });
});

describe("who may see cost", () => {
  it("is whoever the forge lets read the factory, and nobody signed out", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    forge.person("eve");
    const ingestToken = await factory(t, "acme/widgets");
    await ingest(t, ingestToken, { session: "5c0075aa", events: spending("5c0075aa", {
      workflow: "ship", person: "alex", station: STATION, calls: 1,
    }) });

    expect(await spendOf(t, "acme/widgets", SEPTEMBER)).toBeUndefined();
    expect(await spendOf(t, "acme/widgets", SEPTEMBER, await signIn(t, forge, "eve"))).toBeUndefined();
    expect((await spendOf(t, "acme/widgets", SEPTEMBER, await signIn(t, forge, "alex")))?.total)
      .toEqual({ cost: 0.0185, tokens: 1_200 });
  });
});

describe("a period's edges", () => {
  it("are the viewer's own midnights, not UTC's", async () => {
    const forge = fakeForge();
    const { t, ingestToken } = await localOf(forge);
    // 23:30 UTC on 31 October is already half past midnight on 1 November in Berlin.
    await ingest(t, ingestToken, { session: "5c0075aa", events: spending("5c0075aa", {
      workflow: "ship", person: "alex", station: STATION, calls: 1, ts: "2026-10-31T23:30:00.000+00:00",
    }) });
    const spent = async (period: Period) => (await spendOf(t, "acme/widgets", period))?.total.cost;

    expect(await spent(periodOf("month", at("2026-10-15T12:00:00Z"), "UTC"))).toBe(0.0185);
    expect(await spent(periodOf("month", at("2026-10-15T12:00:00Z"), "Europe/Berlin"))).toBe(0);
    expect(await spent(periodOf("month", at("2026-11-15T12:00:00Z"), "Europe/Berlin"))).toBe(0.0185);
    expect(await spent(periodOf("day", at("2026-11-01T08:00:00Z"), "Europe/Berlin"))).toBe(0.0185);
  });

  it("put a day's spend on the day it was spent there, in the Overview's columns", async () => {
    const forge = fakeForge();
    const { t, ingestToken } = await localOf(forge);
    await ingest(t, ingestToken, { session: "5c0075aa", events: spending("5c0075aa", {
      workflow: "ship", person: "alex", station: STATION, calls: 1, ts: "2026-10-31T23:30:00.000+00:00",
    }) });
    const columns = async (timeZone: string) =>
      (await t.query(api.overview.page, { factory: "acme/widgets", days: lastDays(7, at("2026-11-02T12:00:00Z"), timeZone) }))
        ?.spend.days.map((day) => day.cost);

    expect(await columns("UTC")).toEqual([0, 0, 0, 0, 0.0185, 0, 0]);             // Oct 31
    expect(await columns("Europe/Berlin")).toEqual([0, 0, 0, 0, 0, 0.0185, 0]);   // Nov 1
  });
});

describe("a factory a cockpit stored under two spellings, before it kept to one", () => {
  it("is one factory, its spend read under both, as the Factories list reads it", async () => {
    const forge = fakeForge();
    const { t, ingestToken } = await localOf(forge);
    await ingest(t, ingestToken, { session: "5c0075aa", events: spending("5c0075aa", {
      workflow: "ship", person: "alex", station: STATION, calls: 1,
    }) });
    await t.run(async (ctx) => {
      await ctx.db.insert("ingestTokens", { factory: "Acme/Widgets", digest: "an older token" });
      await ctx.db.insert("spend", { factory: "Acme/Widgets", session: "0ld0ld00", at: at("2026-09-02T10:00:00Z"),
                                     cost: 1, tokens: 1_000, workflow: "ship", station: STATION.id,
                                     stationName: STATION.name, person: "alex" });
    });

    for (const factory of ["acme/widgets", "Acme/Widgets"]) {
      expect((await spendOf(t, factory, SEPTEMBER))?.total).toEqual({ cost: 1.0185, tokens: 2_200 });
      expect(await workflowsOf(t, factory, SEPTEMBER)).toEqual([{ workflow: "ship", cost: 1.0185, tokens: 2_200 }]);
    }
  });
});

describe("a period too long to sum at once", () => {
  // Heavy by nature — it stores one row past the cap — so it is given longer than the default.
  it("is said to be, rather than summed in part, and summed whole up to the cap", { timeout: 30_000 }, async () => {
    const forge = fakeForge();
    const { t } = await localOf(forge);
    const QUARTER = 15 * 60_000;
    await t.run(async (ctx) => {
      for (let row = 0; row <= SUMMED; row += 1) {
        await ctx.db.insert("spend", { factory: "acme/widgets", session: "5c0075aa", at: SEPTEMBER.from + row * QUARTER,
                                       cost: 0.01, tokens: 1, workflow: "ship", station: "", stationName: "", person: "" });
      }
    });
    const overview = ({ from, to }: Period) => t.query(api.overview.page, { factory: "acme/widgets", days: [from, to] });

    expect(await overview({ from: SEPTEMBER.from, to: SEPTEMBER.from + (SUMMED + 1) * QUARTER }))
      .toMatchObject({ cut: true, spend: { total: { cost: 0, tokens: 0 } } });
    expect(await overview({ from: SEPTEMBER.from, to: SEPTEMBER.from + SUMMED * QUARTER }))
      .toMatchObject({ cut: false, spend: { total: { tokens: SUMMED } } });
  });
});
