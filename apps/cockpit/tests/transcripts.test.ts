import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { isTranscript } from "../convex/model/retention";
import { view } from "../convex/model/session";
import { cockpit, factory, ingest, recorded, type Cockpit, type WireEvent } from "./helpers";

// A session's transcript is the heaviest thing it holds, and only a phase's
// Agent prompt and Harness output tabs read it (#275). So it is stored apart
// (`transcripts`), and the session page — its own query, its row on Now, a
// phase's other tabs — never reads one: a long session with transcripts on
// loads as fast as one without.

const SESSION = "a9f259f0";
const WHERE = { factory: "acme/widgets", session: SESSION };
const { events: RECORDED } = recorded["issue-then-two-reviews"];
const PHASE = { ...WHERE, phaseId: "a9f259f0_05_plan_revise_1" };

/** The recorded session with every harness output blown up far past the rest of it, as a long agent's would be. */
function heavy(): WireEvent[] {
  return RECORDED.map((event) => event.kind === "harness_output"
    ? { ...event, payload: { ...event.payload, text: `${String(event.payload.text)}${"x".repeat(400_000)}` } }
    : event);
}

/** Ship `events` in batches a station would send: a batch holds at most 4 MB. */
async function ship(t: Cockpit, events: WireEvent[]) {
  const token = await factory(t);
  for (let at = 0; at < events.length; at += 8) {
    const response = await ingest(t, token, { session: SESSION, events: events.slice(at, at + 8) });
    expect(response.status).toBe(200);
  }
}

/** What every query but the transcript tabs' answers: the page, its row on Now, and a phase's other tabs. */
async function everythingButTheTranscript(t: Cockpit) {
  return {
    page: await t.query(api.sessions.get, WHERE),
    progress: await t.query(api.sessions.progress, WHERE),
    phase: await t.query(api.sessions.phase, PHASE),
    tools: await t.query(api.sessions.phaseTools, PHASE),
    rows: await t.query(api.sessions.events, PHASE),
  };
}

beforeEach(() => {
  vi.stubEnv("COCKPIT_MODE", "local");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("a session whose transcript dwarfs the rest of it", () => {
  it("stores its transcript apart from its other events", async () => {
    const t = cockpit();
    await ship(t, heavy());

    const stored = await t.run(async (ctx) => ({
      events: await ctx.db.query("events").collect(),
      transcripts: await ctx.db.query("transcripts").collect(),
    }));
    expect(stored.events.filter((event) => isTranscript(event.kind))).toEqual([]);
    expect(stored.transcripts.map((event) => event.seq))
      .toEqual(RECORDED.filter((event) => isTranscript(event.kind)).map((event) => event.seq));
    // ...each under the phase it is of, which is what a tab reads it by.
    for (const event of stored.transcripts) expect(event.phase).toBe(JSON.parse(event.payload).phase_id);
  });

  it("shows the page, its row and a phase's other tabs without reading a transcript", async () => {
    const t = cockpit();
    await ship(t, heavy());
    const before = await everythingButTheTranscript(t);

    // Were any of them to read a transcript document, taking every one away would change what it says.
    await t.run(async (ctx) => {
      for (const event of await ctx.db.query("transcripts").collect()) await ctx.db.delete(event._id);
    });

    expect(await everythingButTheTranscript(t)).toEqual(before);
    expect(before.page!.transcripts).toBe(true);
    expect(before.phase!.transcripts).toBe(true);
  });

  it("still says when it was last heard from by its harness's output, which the page does not read", async () => {
    const t = cockpit();
    await ship(t, heavy());

    const page = (await t.query(api.sessions.get, WHERE))!;
    const [listed] = (await t.query(api.sessions.list, {}))!.sessions;
    expect(page.summary).toEqual(listed.summary);
    expect(page.summary.lastEventAt).toBe(RECORDED.at(-1)!.ts);
  });

  it("tells the same story, row for row, as one that kept its transcript among its events", async () => {
    const t = cockpit();
    await ship(t, RECORDED);
    const page = (await t.query(api.sessions.get, WHERE))!;

    const whole = view(RECORDED.map((event) => ({ ...event, payload: JSON.stringify(event.payload) })), RECORDED.at(-1)!.seq);
    expect(page.story).toEqual(whole.story);
    expect(page.summary).toEqual(whole.summary);
    expect(page.unread).toEqual(whole.unread);
  });
});

describe("the move", () => {
  /** A cockpit as an older one left it: every transcript among the events, and no session marked as having one. */
  async function older(): Promise<Cockpit> {
    const t = cockpit();
    await ship(t, RECORDED);
    await t.run(async (ctx) => {
      for (const { _id, _creationTime, phase, ...event } of await ctx.db.query("transcripts").collect()) {
        void _creationTime;
        void phase;
        await ctx.db.insert("events", event);
        await ctx.db.delete(_id);
      }
      const record = (await ctx.db.query("sessions").first())!;
      await ctx.db.patch(record._id, { transcribed: undefined, transcripts: undefined, transcriptsDue: undefined });
    });
    return t;
  }

  it("moves an older cockpit's transcripts to their own table, and marks the session as having one", async () => {
    const t = await older();
    expect((await t.query(api.sessions.phase, PHASE))!.transcripts).toBe(false);

    await t.mutation(internal.transcripts.move, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const stored = await t.run(async (ctx) => ({
      events: await ctx.db.query("events").collect(),
      transcripts: await ctx.db.query("transcripts").collect(),
      session: (await ctx.db.query("sessions").first())!,
    }));
    expect(stored.events.filter((event) => isTranscript(event.kind))).toEqual([]);
    expect(stored.transcripts).toHaveLength(RECORDED.filter((event) => isTranscript(event.kind)).length);
    expect(stored.session.transcribed).toBe(true);
    // ...and then the retention backfill found it there, so it ages out like any other.
    expect(stored.session.transcripts).toBe(true);
    expect((await t.query(api.sessions.phase, PHASE))!.transcripts).toBe(true);
    const prompts = (await t.query(api.sessions.prompts, PHASE))!;
    expect(prompts.items.length).toBeGreaterThan(0);
  });

  it("moves a session whose next batch came before the move did", async () => {
    const t = await older();
    const finished = { seq: RECORDED.length + 1, ts: "2026-10-01T00:00:00.000+00:00", kind: "session_finished", v: 1,
                       payload: { status: "success", ended_at: "2026-10-01T00:00:00.000+00:00" } };
    const response = await ingest(t, await factory(t), { session: SESSION, events: [finished] });
    expect(response.status).toBe(200);
    // Not yet looked at: its transcript is still among its events, so it is not marked either way.
    expect((await t.run(async (ctx) => (await ctx.db.query("sessions").first())!)).transcribed).toBeUndefined();

    await t.mutation(internal.transcripts.move, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await t.query(api.sessions.phase, PHASE))!.transcripts).toBe(true);
    expect((await t.run(async (ctx) => await ctx.db.query("events").collect())).filter((event) => isTranscript(event.kind)))
      .toEqual([]);
  });

  it("marks a session an older cockpit stored without a transcript as having none, so it is looked at once", async () => {
    const t = cockpit();
    await ship(t, RECORDED.filter((event) => !isTranscript(event.kind)).map((event, index) => ({ ...event, seq: index + 1 })));
    await t.run(async (ctx) => {
      const record = (await ctx.db.query("sessions").first())!;
      await ctx.db.patch(record._id, { transcribed: undefined });
    });

    await t.mutation(internal.transcripts.move, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await t.run(async (ctx) => (await ctx.db.query("sessions").first())!)).transcribed).toBe(false);
  });

  it("has nothing to do the second time", async () => {
    const t = await older();
    await t.mutation(internal.transcripts.move, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const once = await t.run(async (ctx) => await ctx.db.query("transcripts").collect());

    await t.mutation(internal.transcripts.move, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.run(async (ctx) => await ctx.db.query("transcripts").collect())).toEqual(once);
  });
});
