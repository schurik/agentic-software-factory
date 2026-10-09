import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { cockpit, type Cockpit, factory, ingest, recorded, type WireEvent } from "./helpers";

function line(seq: number, kind = "journal_noted"): WireEvent {
  return { seq, ts: "2026-09-29T12:00:00.000+00:00", kind, v: 1, payload: { n: seq } };
}

// A local cockpit, where every session is its one viewer's to see. Who may see
// which session in a team's cockpit is team.test.ts.
beforeEach(() => {
  vi.stubEnv("COCKPIT_MODE", "local");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ingest", () => {
  it("rejects a batch with no token", async () => {
    const t = cockpit();
    await factory(t);
    const response = await ingest(t, null, { session: "5c0075aa", events: [line(1)] });
    expect(response.status).toBe(401);
  });

  it("rejects a batch with a token it never issued", async () => {
    const t = cockpit();
    await factory(t);
    const response = await ingest(t, "asf_ingest_nope", { session: "5c0075aa", events: [line(1)] });
    expect(response.status).toBe(401);
  });

  it("rejects a body that is not a batch", async () => {
    const t = cockpit();
    const token = await factory(t);
    for (const body of [[], { events: [line(1)] }, { session: "s", events: [{ ...line(1), seq: 0 }] },
                        { session: "s", events: [{ ...line(1), payload: "x" }] }]) {
      expect((await ingest(t, token, body)).status).toBe(400);
    }
  });

  it("acknowledges the highest seq it stored", async () => {
    const t = cockpit();
    const token = await factory(t);
    const response = await ingest(t, token, { session: "5c0075aa", events: [line(1), line(2)] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acked: 2 });
  });

  it("acknowledges only what has no gap below it, until the gap is filled", async () => {
    const t = cockpit();
    const token = await factory(t);
    const first = await ingest(t, token, { session: "5c0075aa", events: [line(1), line(3)] });
    expect(await first.json()).toEqual({ acked: 1 });
    const second = await ingest(t, token, { session: "5c0075aa", events: [line(2)] });
    expect(await second.json()).toEqual({ acked: 3 });
  });

  it("stores a resent batch once, and keeps the first copy of a seq", async () => {
    const t = cockpit();
    const token = await factory(t);
    const batch = { session: "5c0075aa", events: [line(1), line(2)] };
    await ingest(t, token, batch);
    const again = await ingest(t, token, {
      session: "5c0075aa", events: [line(1), { ...line(2), payload: { n: "changed" } }],
    });
    expect(await again.json()).toEqual({ acked: 2 });

    const view = await t.query(api.sessions.get, { factory: "acme/widgets", session: "5c0075aa" });
    expect(view?.events.map((row) => [row.seq, JSON.parse(row.raw)])).toEqual([[1, { n: 1 }], [2, { n: 2 }]]);
  });

  it("stores a payload exactly as sent, whatever its keys", async () => {
    const t = cockpit();
    const token = await factory(t);
    const payload = { $schema: "x", "größe": 1, _private: { $ref: "#/a" } };
    await ingest(t, token, { session: "5c0075aa", events: [{ ...line(1, "artifact_written"), payload }] });

    const view = await t.query(api.sessions.get, { factory: "acme/widgets", session: "5c0075aa" });
    expect(JSON.parse(view!.events[0].raw)).toEqual(payload);
  });

  it("refuses a batch too big to store in one go, so the station sends it in smaller ones", async () => {
    const t = cockpit();
    const token = await factory(t);
    const events = Array.from({ length: 501 }, (_, index) => line(index + 1));
    const response = await ingest(t, token, { session: "5c0075aa", events });
    expect(response.status).toBe(413);
    expect((await t.query(api.sessions.list, {}))?.sessions).toEqual([]);
  });

  it("keeps each factory's sessions apart, by the token that sent them", async () => {
    const t = cockpit();
    const widgets = await factory(t, "acme/widgets");
    const gadgets = await factory(t, "acme/gadgets");
    await ingest(t, widgets, { session: "5c0075aa", events: [line(1), line(2)] });
    const other = await ingest(t, gadgets, { session: "5c0075aa", events: [line(1)] });
    expect(await other.json()).toEqual({ acked: 1 });
  });
});

// A phase's row (#119): written as its events become contiguous, the way spend
// is, so a factory's pages count phases without reading an event.

describe("a phase's rows, written at ingest", () => {
  const SESSION = "a9f259f0";
  const { events: STAGED } = recorded["issue-then-two-reviews-in-stages"];

  async function rows(t: Cockpit) {
    return (await t.run((ctx) => ctx.db.query("phases")
      .withIndex("by_session", (q) => q.eq("factory", "acme/widgets").eq("session", SESSION)).collect()))
      .sort((a, b) => a.at - b.at);
  }

  it("is one row a phase of a recorded session, with its stage when its events carry one", async () => {
    const t = cockpit();
    await ingest(t, await factory(t), { session: SESSION, events: STAGED });

    const written = await rows(t);
    expect(written).toHaveLength(26);
    expect(written.slice(0, 4).map((row) => [row.name, row.stage])).toEqual([
      ["issue", null], ["scout", "scout"], ["plan", "plan"], ["approve_plan", "plan"],
    ]);
    expect(written.find((row) => row.name === "approve_plan")).toMatchObject({ kind: "gate", verdict: "reject" });
  });

  it("folds each batch onto the rows before it, and nothing past a gap until it is filled", async () => {
    const t = cockpit();
    const token = await factory(t);
    const batch = (from: number, to: number) => STAGED.filter(({ seq }) => seq > from && seq <= to);

    await ingest(t, token, { session: SESSION, events: batch(0, 37) });
    await ingest(t, token, { session: SESSION, events: batch(80, 245) });        // 38–80 not here yet
    expect((await rows(t)).map((row) => row.name)).toEqual(["issue", "scout", "plan", "approve_plan"]);
    expect((await rows(t))[3]).toMatchObject({ status: "waiting", verdict: "" });

    await ingest(t, token, { session: SESSION, events: batch(37, 80) });
    const once = cockpit();
    await ingest(once, await factory(once), { session: SESSION, events: STAGED });
    const plain = (written: Awaited<ReturnType<typeof rows>>) => written.map((row) => ({ ...row, _id: undefined, _creationTime: undefined }));
    expect(plain(await rows(t))).toEqual(plain(await rows(once)));
  });

  it("writes a session an older cockpit stored whole, from its first event, when the backfill comes to it", async () => {
    const t = cockpit();
    const token = await factory(t);
    await ingest(t, token, { session: SESSION, events: STAGED.filter(({ seq }) => seq <= 190) });
    // As an older cockpit left it: the session, and no row of its phases.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("phases").collect()) await ctx.db.delete(row._id);
      const record = (await ctx.db.query("sessions").first())!;
      await ctx.db.patch(record._id, { phased: undefined });
    });

    await t.mutation(internal.phases.backfill, {});
    expect(await rows(t)).toHaveLength(17);

    await ingest(t, token, { session: SESSION, events: STAGED.filter(({ seq }) => seq > 190) });
    expect(await rows(t)).toHaveLength(26);
  });

  it("writes a session an older cockpit stored whole when its next batch comes before the backfill does", async () => {
    const t = cockpit();
    const token = await factory(t);
    await ingest(t, token, { session: SESSION, events: STAGED.filter(({ seq }) => seq <= 190) });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("phases").collect()) await ctx.db.delete(row._id);
      const record = (await ctx.db.query("sessions").first())!;
      await ctx.db.patch(record._id, { phased: undefined });
    });

    await ingest(t, token, { session: SESSION, events: STAGED.filter(({ seq }) => seq > 190) });
    expect(await rows(t)).toHaveLength(26);
    expect((await rows(t)).find((row) => row.name === "approve_plan_2")).toMatchObject({ verdict: "approve" });
  });
});
