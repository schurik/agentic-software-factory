import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { prune, weightOf } from "../convex/model/retention";
import type { Row } from "../convex/model/session";
import { cockpit, corpus, factory, ingest, recorded, type Cockpit, type WireEvent } from "./helpers";

// The invariant retention rests on (#63): no view but the Transcript tab is
// built from a transcript's bodies. So a cockpit fed the golden corpus with
// every transcript aged out shows every other view exactly as one fed the
// corpus whole — the sessions list, the session page and its story, the
// journal, each phase's tabs, the inbox, the factories list, the factory's
// page, its activity, its claims and its cost. The Events tab lists a
// transcript event as it is stored, so its raw text is the one thing on it
// that may differ: that is the Transcript tab's material, shown as it is.

const FACTORY = "acme/widgets";

/** The corpus as sessions: the recorded one, and every per-kind fixture renumbered into one more. */
const SESSIONS: Record<string, WireEvent[]> = {
  a9f259f0: recorded["issue-then-two-reviews"].events,
  "5c0075aa": Object.keys(corpus).sort().map((name, index) => ({ ...structuredClone(corpus[name]), seq: index + 1 })),
};

/** `events` as a cockpit would hold them once their transcript aged out. */
function agedOut(events: WireEvent[]): WireEvent[] {
  return events.map((event) => {
    const text = prune(event.kind, JSON.stringify(event.payload), { on: "2026-11-01T00:00:00.000Z", reason: "aged_out", by: "" });
    return weightOf(event.kind) === "transcript" && text !== null
      ? { ...event, payload: JSON.parse(text) as Record<string, unknown> } : event;
  });
}

async function fed(events: (session: string) => WireEvent[]): Promise<Cockpit> {
  const t = cockpit();
  const token = await factory(t, FACTORY);
  for (const session of Object.keys(SESSIONS)) {
    const response = await ingest(t, token, { session, events: events(session) });
    expect(response.status).toBe(200);
  }
  return t;
}

/** A row as every view but the Transcript tab may depend on it: a transcript event's raw body is its own. */
function shown(row: Row) {
  return weightOf(row.kind) === "transcript" ? { ...row, raw: "" } : row;
}

/** Every view of the cockpit, but the Transcript tab. */
async function views(t: Cockpit) {
  const sessions = {} as Record<string, unknown>;
  for (const [session, events] of Object.entries(SESSIONS)) {
    const page = (await t.query(api.sessions.get, { factory: FACTORY, session }))!;
    const phaseIds = [...new Set(events.filter((event) => event.kind === "phase_started")
      .map((event) => String(event.payload.phase_id)))];
    const phases = [];
    for (const phaseId of phaseIds) {
      const detail = await t.query(api.sessions.phase, { factory: FACTORY, session, phaseId });
      if (detail === null) continue;
      phases.push({ ...detail, transcript: null, events: detail.events.map(shown) });
    }
    const claims = await t.query(api.claims.ofSession, { factory: FACTORY, session });
    sessions[session] = { ...page, events: page.events.map(shown), phases, claims };
  }
  return {
    list: await t.query(api.sessions.list, {}),
    sessions,
    inbox: await t.query(api.inbox.list, {}),
    factories: await t.query(api.factories.list, {}),
    factory: await t.query(api.factory.page, { factory: FACTORY }),
    activity: await t.query(api.activity.page, { factory: FACTORY }),
    cost: await t.query(api.cost.rollup, { factory: FACTORY, period: { from: 0, to: Date.parse("2100-01-01") } }),
  };
}

// One clock for every cockpit here: a view that says when the cockpit last heard of something must
// say the same of both.
const NOW = Date.parse("2026-10-02T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("COCKPIT_MODE", "local");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("a corpus whose transcripts aged out", () => {
  it("has transcript events to age out at all", () => {
    for (const events of Object.values(SESSIONS)) {
      expect(events.some((event) => weightOf(event.kind) === "transcript")).toBe(true);
    }
  });

  it("rebuilds every view but the Transcript tab exactly as the whole corpus does", async () => {
    const whole = await fed((session) => SESSIONS[session]);
    const pruned = await fed((session) => agedOut(SESSIONS[session]));

    const shownWhole = await views(whole);
    // Every view is there to compare: none of them is empty for want of something to show.
    expect(Object.values(shownWhole).every((each) => each !== null)).toBe(true);
    expect(await views(pruned)).toEqual(shownWhole);
  });

  it("rebuilds them the same when the cockpit aged the transcripts out itself", async () => {
    // Each session finished, so its transcript can age out: the per-kind corpus starts a process after it ends.
    const whole = await fed((session) => {
      const events = SESSIONS[session];
      return [...events, { ...structuredClone(corpus["session_finished/v1.json"]), seq: events.length + 1 }];
    });
    const before = await views(whole);

    vi.setSystemTime(Date.parse("2100-01-01"));
    await whole.mutation(internal.retention.ageOut, {});
    await whole.finishAllScheduledFunctions(vi.runAllTimers);
    vi.setSystemTime(NOW);

    const stored = await whole.run(async (ctx) => await ctx.db.query("events").collect());
    const transcripts = stored.filter((event) => weightOf(event.kind) === "transcript");
    expect(transcripts.length).toBeGreaterThan(0);
    for (const event of transcripts) expect(JSON.parse(event.payload).pruned).toMatchObject({ reason: "aged_out" });
    expect(await views(whole)).toEqual(before);
  });

  it("still tells the journal the factory rendered, byte for byte", async () => {
    const pruned = await fed((session) => agedOut(SESSIONS[session]));

    const page = await pruned.query(api.sessions.get, { factory: FACTORY, session: "a9f259f0" });
    expect(page!.story.journal).toBe(recorded["issue-then-two-reviews"].journal);
  });
});
