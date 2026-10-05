import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { onlyFactory, rank } from "../convex/model/factories";
import { fakeForge, type FakeForge } from "./forge";
import { catchUp, factory, fixture, ingest, signIn, type WireEvent } from "./helpers";
import { approved, localOf, poll, post, STATION, teamOf } from "./station";

// A row of the Factories list (spec #40, #117): live sessions, gates waiting
// (on the viewer / in all), stations online of all, the workflows it loads,
// spend in the period asked for, and the facts what needs attention is read
// from — the same ones the Factory page's Activity reads.

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const HOUR = 3600_000;
const OCTOBER = { from: Date.parse("2026-10-01T00:00:00.000Z"), to: Date.parse("2026-11-01T00:00:00.000Z") };

/** A session that started and is running, on alex's station. */
function started(session: string): WireEvent {
  const event = fixture("session_started", 1, 2);
  Object.assign(event.payload, { adw_id: session, station_id: STATION.id, station_name: STATION.name, station_kind: "local" });
  return event;
}

/** An agent call at `ts` that cost `cost` and took `tokens`. */
function usage(seq: number, ts: string, cost: number, tokens: number): WireEvent {
  const event = fixture("usage", seq);
  event.ts = ts;
  Object.assign(event.payload, { cost, tokens });
  return event;
}

function suspended(seq: number, trusted: string[]): WireEvent {
  const event = fixture("suspended", seq, 2);
  Object.assign(event.payload, { trusted });
  return event;
}

function failed(seq: number, endedAt: number): WireEvent {
  const event = fixture("session_finished", seq);
  Object.assign(event.payload, { status: "fail", ended_at: new Date(endedAt).toISOString() });
  return event;
}

const golden = import.meta.glob("../../../tests/golden/self-description/v1.json",
                                { eager: true, import: "default" }) as Record<string, Record<string, unknown>>;

/** The factory's CI pushing its self-description for `ref`. */
async function described(t: Awaited<ReturnType<typeof teamOf>>, token: string, ref: string): Promise<void> {
  const description = { ...structuredClone(Object.values(golden)[0]), checked: { head: "a".repeat(40), ref, config_hash: "c0ffee" } };
  const station = { id: "st_ci0001", name: "runner@fv-az123:widgets", kind: "ci" };
  expect((await post(t, "/describe", token, { station, description })).status).toBe(200);
}

let forge: FakeForge;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  forge = fakeForge();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function rowOf(t: Awaited<ReturnType<typeof teamOf>>, holding: string, period = OCTOBER) {
  const list = await t.query(api.factories.list, { signIn: holding, period });
  const row = list?.factories.find((each) => each.repo === "acme/widgets");
  expect(row).toBeDefined();
  return row!;
}

describe("a row of the Factories list", () => {
  it("sums what agent calls cost in the period, tokens alongside, wherever their sessions started", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    await ingest(t, token, { session: "s1", events: [
      started("s1"),
      usage(2, "2026-09-30T23:50:00.000+00:00", 1.0, 1000),     // September: not this period
      usage(3, "2026-10-01T00:05:00.000+00:00", 0.25, 300),
      usage(4, "2026-10-01T00:10:00.000+00:00", 0.5, 200),      // the same quarter hour as the one before
    ] });
    await ingest(t, token, { session: "s2", events: [started("s2"), usage(2, "2026-10-13T08:00:00.000+00:00", 2.0, 4000)] });
    const alex = await signIn(t, forge, "alex");

    expect((await rowOf(t, alex)).spend).toEqual({ cost: 2.75, tokens: 4500 });
    expect((await rowOf(t, alex, { from: Date.parse("2026-09-30T00:00:00.000Z"), to: OCTOBER.from })).spend)
      .toEqual({ cost: 1.0, tokens: 1000 });
  });

  it("counts a usage event once, however often its batch is sent, and only once it is contiguous", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    const late = usage(3, "2026-10-02T10:00:00.000+00:00", 0.5, 100);
    await ingest(t, token, { session: "s1", events: [late] });                      // seq 1 and 2 not yet here
    const alex = await signIn(t, forge, "alex");
    expect((await rowOf(t, alex)).spend).toEqual({ cost: 0, tokens: 0 });

    const batch = { session: "s1", events: [started("s1"), usage(2, "2026-10-02T09:00:00.000+00:00", 1.0, 1000)] };
    await ingest(t, token, batch);
    await ingest(t, token, batch);

    expect((await rowOf(t, alex)).spend).toEqual({ cost: 1.5, tokens: 1100 });
  });

  it("counts the live sessions — running, not suspended at a gate — and the gates waiting, on the viewer and in all", async () => {
    const t = await teamOf(forge, { alex: "write", sam: "write" });
    const token = await factory(t, "acme/widgets");
    await ingest(t, token, { session: "r1", events: [started("r1")] });
    await ingest(t, token, { session: "r2", events: [started("r2")] });
    await ingest(t, token, { session: "g1", events: [started("g1"), suspended(2, ["sam"])] });
    await ingest(t, token, { session: "g2", events: [started("g2"), suspended(2, [])] });

    const row = await rowOf(t, await signIn(t, forge, "alex"));

    expect(row.live).toBe(2);
    expect(row.facts.gates).toEqual({ mine: 1, total: 2 });
  });

  it("says when each of its stations last polled, and the page which are online by its clock", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const ingestToken = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    const bob = { id: "st_bob", name: "bob@desk:widgets", kind: "local" };
    await approved(t, ingestToken, alex, bob);                       // registered, never polled
    await poll(t, await approved(t, ingestToken, alex), {});

    const row = await rowOf(t, alex);
    expect(row.seen.sort()).toEqual([0, NOW]);
    expect(rank([row], NOW + 2_000)[0].online).toBe(1);
    expect(rank([row], NOW + 60_000)[0].online).toBe(0);         // its loop went quiet
  });

  it("leaves spend out when no period is asked for", async () => {
    const t = await teamOf(forge, { alex: "write" });
    await factory(t, "acme/widgets");
    const list = await t.query(api.factories.list, { signIn: await signIn(t, forge, "alex") });

    expect(list?.factories[0].spend).toBeNull();
    expect(list?.factories[0].live).toBe(0);
  });

  it("says how many workflows its default branch's self-description loads, and nothing before one is pushed", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    expect((await rowOf(t, alex)).workflows).toBeNull();

    await described(t, token, "feature");                    // a branch's check is not the factory's
    expect((await rowOf(t, alex)).workflows).toBeNull();

    await described(t, token, "main");                       // seven load; `nightly` is a problem, not a workflow
    expect((await rowOf(t, alex)).workflows).toBe(7);
  });
});

describe("the Factories list's order, over what stations shipped", () => {
  it("ranks a factory with a fresh failure first, then the most recently active, then the rest by name", async () => {
    for (const name of ["acme/gadgets", "acme/tools"]) forge.repo(name, { factory: true, roles: { alex: "write" } });
    const t = await teamOf(forge, { alex: "write" });
    const widgets = await factory(t, "acme/widgets");
    const gadgets = await factory(t, "acme/gadgets");
    vi.setSystemTime(NOW - 2 * HOUR);
    await ingest(t, widgets, { session: "w1", events: [started("w1"), failed(2, NOW - 2 * HOUR)] });
    vi.setSystemTime(NOW - HOUR);
    await ingest(t, gadgets, { session: "g1", events: [started("g1")] });
    vi.setSystemTime(NOW);

    const list = await t.query(api.factories.list, { signIn: await signIn(t, forge, "alex"), period: OCTOBER });
    const names = (now = NOW) => rank(list!.factories, now).map((each) => each.row.repo);

    expect(names()).toEqual(["acme/widgets", "acme/gadgets", "acme/tools"]);
    expect(names(NOW + 23 * HOUR)).toEqual(["acme/gadgets", "acme/widgets", "acme/tools"]);
  });
});

describe("the Factories entry", () => {
  it("goes straight to the one factory a local cockpit knows, and back to the list once there is a second", async () => {
    const { t } = await localOf(forge);
    const list = async () => (await t.query(api.factories.list, {}))!.factories;

    expect(onlyFactory("local", await list())).toBe("acme/widgets");

    forge.repo("acme/gadgets", { factory: true, roles: { alex: "write" } });
    await catchUp(t);

    expect(onlyFactory("local", await list())).toBeNull();
  });

  it("is always the list in a team's cockpit, even of one", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const list = await t.query(api.factories.list, { signIn: await signIn(t, forge, "alex") });

    expect(list!.factories.map((each) => each.repo)).toEqual(["acme/widgets"]);
    expect(onlyFactory("team", list!.factories)).toBeNull();
  });
});
