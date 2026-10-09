import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { lastDays } from "../convex/model/period";
import { type Cockpit, factory, fixture, ingest, recorded, signIn, type WireEvent } from "./helpers";
import { fakeForge, localOf, STATION, teamOf } from "./station";

// A factory's Overview (#119): what it spent, how its sessions ended and how
// long people kept its gates waiting, over the last 7 or 30 of the viewer's
// days — read off spend rows, session summaries and phase rows, never events.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const at = (iso: string) => Date.parse(iso);
const close = (value: number) => expect.closeTo(value, 6);

/** The week up to Tuesday 2026-10-06 in UTC: Wednesday 2026-09-30 through it. */
const WEEK = lastDays(7, at("2026-10-06T12:00:00Z"), "UTC");

/**
 * A ship session started on STATION by `person` at `start`: one phase, `calls`
 * agent calls of the usage fixture's ($0.0185 and 1,200 tokens each) five
 * minutes in, and — when it has `ended` — a finish with that status at it.
 */
function ship(session: string, { person, start, calls, ended }: {
  person: string; start: string; calls: number; ended?: { status: string; at: string };
}): WireEvent[] {
  const started = { ...fixture("session_started", 1, 2), ts: start };
  Object.assign(started.payload, {
    adw_id: session, workflow: "ship", triggered_by: person, station_id: STATION.id, station_name: STATION.name, started_at: start,
  });
  const phase = { ...fixture("phase_started", 2, 3), ts: start };
  Object.assign(phase.payload, { phase_id: `${session}_01_plan`, stage_index: null });
  const later = new Date(at(start) + 5 * 60_000).toISOString();
  const usage = Array.from({ length: calls }, (_, index) => {
    const event = { ...fixture("usage", index + 3), ts: later };
    Object.assign(event.payload, { phase_id: `${session}_01_plan` });
    return event;
  });
  const finished = ended ? [{ ...fixture("session_finished", calls + 3), ts: ended.at }] : [];
  for (const event of finished) Object.assign(event.payload, { status: ended!.status, ended_at: ended!.at });
  return [started, phase, ...usage, ...finished];
}

/**
 * acme/widgets, as worked by hand:
 *   a9f259f0  the recorded session, Oct 4: issue then two pr-review rounds, done in 14.96s
 *             (33.676 → 48.636), $0.383 + $0.08 = $0.463 for 27,100 tokens on schurik@mbp:widgets,
 *             started by "asf tests"; the plan gate asked twice — rejected after 0.402s, approved after 0.512s;
 *   5c0075aa  ship on alex@mbp:widgets for schurik, Oct 2: two calls, $0.037, failed after 22 minutes;
 *   77aa0011  ship on alex@mbp:widgets for sam, Oct 5: one call, $0.0185, still running;
 *   0d1d0000  ship, Sep 20: done long before the week, and none of its figures.
 */
async function seeded(t: Cockpit, token: string) {
  await ingest(t, token, { session: "a9f259f0", events: recorded["issue-then-two-reviews-in-stages"].events });
  await ingest(t, token, { session: "5c0075aa", events: ship("5c0075aa", {
    person: "schurik", start: "2026-10-02T10:00:00.000Z", calls: 2, ended: { status: "fail", at: "2026-10-02T10:22:00.000Z" },
  }) });
  await ingest(t, token, { session: "77aa0011", events: ship("77aa0011", { person: "sam", start: "2026-10-05T08:00:00.000Z", calls: 1 }) });
  await ingest(t, token, { session: "0d1d0000", events: ship("0d1d0000", {
    person: "sam", start: "2026-09-20T08:00:00.000Z", calls: 3, ended: { status: "success", at: "2026-09-20T09:00:00.000Z" },
  }) });
  await t.action(internal.stations.local, { factory: "acme/widgets", station: STATION });
}

describe("a factory's Overview, over a week", () => {
  it("spends what was spent that week: the total, each day, by station and by person", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await seeded(t, ingestToken);

    const { spend } = (await t.query(api.overview.page, { factory: "acme/widgets", days: WEEK }))!;

    expect(spend.total).toEqual({ cost: close(0.5185), tokens: 30_700 });
    expect(spend.sessions).toBe(3);
    // Sep 30, Oct 1, Oct 2, Oct 3, Oct 4, Oct 5, Oct 6.
    expect(spend.days.map((day) => day.from)).toEqual(WEEK.slice(0, -1));
    expect(spend.days.map((day) => day.cost)).toEqual([0, 0, close(0.037), 0, close(0.463), close(0.0185), 0]);
    expect(spend.stations).toEqual([
      expect.objectContaining({ name: "schurik@mbp:widgets", owner: "", cost: close(0.463), tokens: 27_100 }),
      expect.objectContaining({ name: STATION.name, owner: "alex", cost: close(0.0555), tokens: 3_600 }),
    ]);
    expect(spend.people).toEqual([
      { person: "asf tests", cost: close(0.463), tokens: 27_100 },
      { person: "schurik", cost: close(0.037), tokens: 2_400 },
      { person: "sam", cost: close(0.0185), tokens: 1_200 },
    ]);
  });

  it("says how the week's sessions ended, how long they took, and how long its gates kept them waiting", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await seeded(t, ingestToken);

    const { outcomes } = (await t.query(api.overview.page, { factory: "acme/widgets", days: WEEK }))!;

    expect(outcomes).toEqual({
      sessions: 3, done: 1, failed: 1, open: 1,
      finish: close((14.96 + 1320) / 2),
      gates: { rounds: 2, rejected: 1, wait: close((0.402 + 0.512) / 2) },
    });
  });

  it("lists each workflow the week's sessions ran: how they finished, how long, what it spent, when it last ran", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await seeded(t, ingestToken);

    const { workflows } = (await t.query(api.overview.page, { factory: "acme/widgets", days: WEEK }))!;

    expect(workflows).toEqual([
      { workflow: "ship", sessions: 2, done: 0, failed: 1, open: 1, finish: 1320, cost: close(0.0555), tokens: 3_600,
        last: at("2026-10-05T08:00:00.000Z") },
      // Its session went on into a review: it finished there, and the issue's part of it finished well.
      { workflow: "issue", sessions: 1, done: 1, failed: 0, open: 0, finish: null, cost: close(0.383), tokens: 23_100,
        last: at("2026-10-04T22:41:42.238Z") },
      { workflow: "pr-review", sessions: 1, done: 1, failed: 0, open: 0, finish: close(14.96), cost: close(0.08), tokens: 4_000,
        last: at("2026-10-04T22:41:48.498Z") },
    ]);
  });

  it("counts nothing outside the period", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await seeded(t, ingestToken);

    const before = lastDays(30, at("2026-09-27T12:00:00Z"), "UTC");    // Aug 29 through Sep 27
    const overview = (await t.query(api.overview.page, { factory: "acme/widgets", days: before }))!;

    expect(overview.spend.total).toEqual({ cost: close(0.0555), tokens: 3_600 });
    expect(overview.outcomes).toMatchObject({ sessions: 1, done: 1, failed: 0, open: 0, finish: 3600, gates: { rounds: 0, wait: null } });
    expect(overview.workflows.map((line) => line.workflow)).toEqual(["ship"]);
  });

  it("is the factory's however the page spells it, and nothing for someone who may not read it", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    forge.person("eve");
    await seeded(t, await factory(t, "acme/widgets"));

    const alex = await signIn(t, forge, "alex");
    expect((await t.query(api.overview.page, { factory: "Acme/Widgets", days: WEEK, signIn: alex }))?.spend.total)
      .toEqual({ cost: close(0.5185), tokens: 30_700 });
    expect(await t.query(api.overview.page, { factory: "acme/widgets", days: WEEK, signIn: await signIn(t, forge, "eve") })).toBeNull();
    expect(await t.query(api.overview.page, { factory: "acme/widgets", days: WEEK })).toBeNull();
  });
});
