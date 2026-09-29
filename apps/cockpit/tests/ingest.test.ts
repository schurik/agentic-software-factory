import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { cockpit, factory, ingest, type WireEvent } from "./helpers";

function line(seq: number, kind = "journal_noted"): WireEvent {
  return { seq, ts: "2026-09-29T12:00:00.000+00:00", kind, v: 1, payload: { n: seq } };
}

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
    expect(view?.events.map((row) => [row.seq, row.payload])).toEqual([[1, { n: 1 }], [2, { n: 2 }]]);
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
