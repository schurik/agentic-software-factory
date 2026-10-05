import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { CI, type SessionFilter } from "../convex/model/filter";
import { cockpit, type Cockpit, factory, fixture, ingest, type WireEvent } from "./helpers";

// The Sessions pages (spec #40): a factory's Sessions tab and the page across
// factories read one query, `sessions.list`, which narrows by workflow,
// station, person — who triggered the run — status and period, and offers
// each filter's choices from the sessions it looked at. Who may see which
// factory's sessions in a team's cockpit is team.test.ts.

const HOUR = 3600_000;
const OCT_1 = Date.parse("2026-10-01T00:00:00.000Z");

interface Shipped {
  session: string;
  workflows?: string[];
  triggeredBy?: string;
  station?: { id: string; name: string; kind?: string };
  status?: "running" | "success" | "fail";
  startedAt?: number;
  endedAt?: number;
}

const ALEX = { id: "st_alex", name: "alex@mbp:widgets" };

/** A session as its station ships it: started, through each workflow, and ended where `given` says. */
function shipped(given: Shipped): WireEvent[] {
  const [first, ...later] = given.workflows ?? ["issue"];
  const station: { id: string; name: string; kind?: string } = given.station ?? ALEX;
  const startedAt = given.startedAt ?? OCT_1 + 10 * HOUR;
  const started = fixture("session_started", 1, 2);
  Object.assign(started.payload, {
    adw_id: given.session, workflow: first, triggered_by: given.triggeredBy ?? "alex", station_id: station.id,
    station_name: station.name, station_kind: station.kind ?? "local", started_at: new Date(startedAt).toISOString(),
  });
  started.ts = new Date(startedAt).toISOString();
  // Each later workflow is a process joining the session, as a review round's watcher starts one.
  const events = [started, ...later.flatMap((workflow, at) => {
    const joined = structuredClone(started);
    Object.assign(joined, { seq: 2 * at + 2 });
    Object.assign(joined.payload, { workflow });
    const chapter = fixture("workflow_started", 2 * at + 3);
    Object.assign(chapter.payload, { workflow, chapter: at + 2 });
    return [joined, chapter];
  })];
  const status = given.status ?? "success";
  if (status === "running") return events;
  const finished = fixture("session_finished", events.length + 1);
  const endedAt = new Date(given.endedAt ?? startedAt + HOUR).toISOString();
  Object.assign(finished.payload, { status, ended_at: endedAt });
  finished.ts = endedAt;
  return [...events, finished];
}

async function ship(t: Cockpit, token: string, ...sessions: Shipped[]): Promise<void> {
  for (const given of sessions) {
    expect((await ingest(t, token, { session: given.session, events: shipped(given) })).status).toBe(200);
  }
}

beforeEach(() => {
  vi.stubEnv("COCKPIT_MODE", "local");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function found(t: Cockpit, args: { factory?: string; filter?: SessionFilter } = {}) {
  const list = await t.query(api.sessions.list, args);
  return list && list.sessions.map(({ factory: from, session }) => `${from} ${session}`).sort();
}

describe("the sessions list", () => {
  it("across factories lists every factory's sessions; a factory's tab, only its own", async () => {
    const t = cockpit();
    await ship(t, await factory(t, "acme/widgets"), { session: "w1" }, { session: "w2" });
    await ship(t, await factory(t, "acme/gadgets"), { session: "g1" });

    expect(await found(t)).toEqual(["acme/gadgets g1", "acme/widgets w1", "acme/widgets w2"]);
    expect(await found(t, { factory: "acme/widgets" })).toEqual(["acme/widgets w1", "acme/widgets w2"]);
    // Named by a page in whatever case: the forge's names are case-insensitive.
    expect(await found(t, { factory: "Acme/Gadgets" })).toEqual(["acme/gadgets g1"]);
  });

  it("narrows by each filter, and by all of them at once", async () => {
    const t = cockpit();
    const ci = { id: "st_ci0001", name: "runner@fv-az1:widgets", kind: "ci" };
    await ship(t, await factory(t),
      { session: "issue-alex", triggeredBy: "alex" },
      { session: "reviewed-sam", workflows: ["issue", "pr-review"], triggeredBy: "sam", status: "fail" },
      { session: "prompt-sam", workflows: ["prompt"], triggeredBy: "Sam", status: "running", startedAt: OCT_1 - 30 * 24 * HOUR },
      { session: "ci-alex", triggeredBy: "alex", station: ci, startedAt: OCT_1 + 30 * HOUR },
    );

    expect(await found(t, { filter: { workflow: "pr-review" } })).toEqual(["acme/widgets reviewed-sam"]);
    expect(await found(t, { filter: { workflow: "issue" } }))
      .toEqual(["acme/widgets ci-alex", "acme/widgets issue-alex", "acme/widgets reviewed-sam"]);
    expect(await found(t, { filter: { person: "sam" } })).toEqual(["acme/widgets prompt-sam", "acme/widgets reviewed-sam"]);
    expect(await found(t, { filter: { station: CI } })).toEqual(["acme/widgets ci-alex"]);
    expect(await found(t, { filter: { station: ALEX.id } }))
      .toEqual(["acme/widgets issue-alex", "acme/widgets prompt-sam", "acme/widgets reviewed-sam"]);
    expect(await found(t, { filter: { status: "running" } })).toEqual(["acme/widgets prompt-sam"]);
    // 1 October: what ran that day, and what was still running.
    expect(await found(t, { filter: { period: { from: OCT_1, to: OCT_1 + 24 * HOUR } } }))
      .toEqual(["acme/widgets issue-alex", "acme/widgets prompt-sam", "acme/widgets reviewed-sam"]);
    expect(await found(t, { filter: { person: "alex", workflow: "issue", station: ALEX.id, status: "success" } }))
      .toEqual(["acme/widgets issue-alex"]);
  });

  it("finds sessions by what a person searched for, past the newest it would show", async () => {
    const t = cockpit();
    await ship(t, await factory(t), { session: "5c0075aa" }, { session: "a9f259f0" }, { session: "a9f2ffff" });

    expect(await found(t, { filter: { search: "a9f2" } })).toEqual(["acme/widgets a9f259f0", "acme/widgets a9f2ffff"]);
    expect(await found(t, { filter: { search: "nothing like it" } })).toEqual([]);
  });

  it("names every factory the viewer can read, for the page to narrow to", async () => {
    const t = cockpit();
    await ship(t, await factory(t, "acme/widgets"), { session: "w1" });
    await ship(t, await factory(t, "acme/gadgets"), { session: "g1" });

    expect((await t.query(api.sessions.list, {}))?.factories).toEqual(["acme/gadgets", "acme/widgets"]);
    // Narrowed to one, the others are still there to pick.
    expect((await t.query(api.sessions.list, { factory: "acme/widgets" }))?.factories).toEqual(["acme/gadgets", "acme/widgets"]);
  });

  it("offers each filter's choices from every session it looked at, not only those the filter kept", async () => {
    const t = cockpit();
    await ship(t, await factory(t), { session: "a", triggeredBy: "alex" }, { session: "b", workflows: ["prompt"], triggeredBy: "sam" });

    const list = await t.query(api.sessions.list, { filter: { person: "alex" } });

    expect(list?.sessions.map((row) => row.session)).toEqual(["a"]);
    expect(list?.facets).toEqual({
      workflows: ["issue", "prompt"], people: ["alex", "sam"], stations: [{ key: ALEX.id, name: ALEX.name }],
    });
    expect(list?.looked).toBe(2);
    expect(list?.cut).toBe(false);
  });

  it("says each session's factory, its summary and how far it was acknowledged", async () => {
    const t = cockpit();
    await ship(t, await factory(t), { session: "a", triggeredBy: "alex" });

    const [row] = (await t.query(api.sessions.list, {}))!.sessions;

    expect(row).toMatchObject({ factory: "acme/widgets", session: "a", acked: 2 });
    expect(row.summary).toMatchObject({ status: "success", triggeredBy: "alex", workflows: ["issue"] });
  });

  it("is empty for a factory nothing was shipped of", async () => {
    const t = cockpit();
    expect(await t.query(api.sessions.list, { factory: "acme/nowhere" })).toEqual({
      sessions: [], facets: { workflows: [], people: [], stations: [] }, looked: 0, cut: false, factories: [],
    });
  });
});
