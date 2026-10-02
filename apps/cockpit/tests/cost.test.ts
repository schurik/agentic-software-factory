import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { periodOf } from "../convex/model/period";
import { catchUp, type Cockpit, factory, fixture, ingest, recorded, signIn, type WireEvent } from "./helpers";
import { approved, fakeForge, localOf, STATION, teamOf } from "./station";

// Cost is rolled up from `usage` events by session, workflow, factory, station
// (whose machine and key paid, and so its owner) and person (who triggered
// the run), over a period of the viewer's own calendar (spec #40, #62).

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
    forge.repo("acme/gadgets", { factory: true, roles: { alex: "admin" } });
    await catchUp(t);
    await corpusOf(t);

    const cost = await t.query(api.cost.rollup, { period: SEPTEMBER });

    expect(cost?.total).toEqual({ cost: close(0.5185), tokens: 30_700 });
    expect(cost?.sessions).toEqual([
      expect.objectContaining({ factory: "acme/widgets", session: "a9f259f0", cost: close(0.463), tokens: 27_100 }),
      expect.objectContaining({ factory: "acme/widgets", session: "5c0075aa", cost: close(0.037), tokens: 2_400 }),
      expect.objectContaining({ factory: "acme/gadgets", session: "77aa0011", cost: close(0.0185), tokens: 1_200 }),
    ]);
    expect(cost?.workflows).toEqual([
      { factory: "acme/widgets", workflow: "issue", cost: close(0.383), tokens: 23_100 },
      { factory: "acme/widgets", workflow: "pr-review", cost: close(0.08), tokens: 4_000 },
      { factory: "acme/widgets", workflow: "ship", cost: close(0.037), tokens: 2_400 },
      { factory: "acme/gadgets", workflow: "ship", cost: close(0.0185), tokens: 1_200 },
    ]);
    expect(cost?.factories).toEqual([
      { factory: "acme/widgets", cost: close(0.5), tokens: 29_500 },
      { factory: "acme/gadgets", cost: close(0.0185), tokens: 1_200 },
    ]);
    expect(cost?.stations).toEqual([
      { factory: "acme/widgets", station: "st_93db23f2e84f", name: "schurik@mbp:widgets", owner: "", cost: close(0.463), tokens: 27_100 },
      { factory: "acme/widgets", station: STATION.id, name: STATION.name, owner: "alex", cost: close(0.037), tokens: 2_400 },
      { factory: "acme/gadgets", station: "st_gadgets", name: "alex@mbp:gadgets", owner: "", cost: close(0.0185), tokens: 1_200 },
    ]);
    expect(cost?.people).toEqual([
      { person: "", cost: close(0.463), tokens: 27_100 },
      { person: "schurik", cost: close(0.037), tokens: 2_400 },
      { person: "sam", cost: close(0.0185), tokens: 1_200 },
    ]);
  });

  it("is one factory's alone on its Factory page, however the page spells it", async () => {
    const forge = fakeForge();
    const { t } = await localOf(forge);
    await corpusOf(t);

    const cost = await t.query(api.cost.rollup, { factory: "Acme/Widgets", period: SEPTEMBER });

    expect(cost?.total).toEqual({ cost: close(0.5), tokens: 29_500 });
    expect(cost?.factories).toEqual([{ factory: "acme/widgets", cost: close(0.5), tokens: 29_500 }]);
  });

  it("is nothing outside the period", async () => {
    const forge = fakeForge();
    const { t } = await localOf(forge);
    await corpusOf(t);

    const cost = await t.query(api.cost.rollup, { period: { from: SEPTEMBER.to, to: at("2026-11-01T00:00:00Z") } });

    expect(cost).toMatchObject({ total: { cost: 0, tokens: 0 }, sessions: [], workflows: [], factories: [], stations: [], people: [] });
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

    const cost = await t.query(api.cost.rollup, { period: SEPTEMBER, signIn: await signIn(t, forge, "sam") });

    expect(cost?.stations).toEqual([
      { factory: "acme/widgets", station: STATION.id, name: STATION.name, owner: "alex", cost: 0.0185, tokens: 1_200 },
    ]);
    expect(cost?.people).toEqual([{ person: "sam", cost: 0.0185, tokens: 1_200 }]);
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

    expect(await t.query(api.cost.rollup, { period: SEPTEMBER })).toBeNull();
    const eve = await signIn(t, forge, "eve");
    expect(await t.query(api.cost.rollup, { period: SEPTEMBER, signIn: eve })).toMatchObject({ total: { cost: 0, tokens: 0 } });
    expect(await t.query(api.cost.rollup, { factory: "acme/widgets", period: SEPTEMBER, signIn: eve })).toBeNull();
    expect((await t.query(api.cost.rollup, { period: SEPTEMBER, signIn: await signIn(t, forge, "alex") }))?.total)
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
    const spent = async (period: { from: number; to: number }) =>
      (await t.query(api.cost.rollup, { period }))?.total.cost;

    expect(await spent(periodOf("month", at("2026-10-15T12:00:00Z"), "UTC"))).toBe(0.0185);
    expect(await spent(periodOf("month", at("2026-10-15T12:00:00Z"), "Europe/Berlin"))).toBe(0);
    expect(await spent(periodOf("month", at("2026-11-15T12:00:00Z"), "Europe/Berlin"))).toBe(0.0185);
    expect(await spent(periodOf("day", at("2026-11-01T08:00:00Z"), "Europe/Berlin"))).toBe(0.0185);
  });
});
