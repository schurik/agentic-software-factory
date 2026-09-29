import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { cockpit, corpus, factory, fixture, ingest, type Cockpit, type WireEvent } from "./helpers";

const WHERE = { factory: "acme/widgets", session: "5c0075aa" };

async function ship(t: Cockpit, token: string, events: WireEvent[]) {
  const response = await ingest(t, token, { session: WHERE.session, events });
  expect(response.status).toBe(200);
  return (await response.json()) as { acked: number };
}

describe("the golden corpus", () => {
  it("is where the cockpit expects it", () => {
    expect(Object.keys(corpus)).toContain("session_started/v1.json");
  });

  it.each(Object.keys(corpus))("reads %s as its own kind, never as a generic row", async (name) => {
    const t = cockpit();
    const token = await factory(t);
    const event = corpus[name];
    const rest = event.kind === "session_started" ? [] : [{ ...event, seq: 2 }];
    expect(await ship(t, token, [fixture("session_started", 1), ...rest])).toEqual({
      acked: 1 + rest.length,
    });

    const view = await t.query(api.sessions.get, WHERE);
    const row = view!.events.at(-1)!;
    expect(row.kind).toBe(event.kind);
    expect(row.v).toBe(event.v);
    expect(row.unread).toBeNull();
    expect(row.detail).not.toBe("");
    expect(view!.summary.unread).toBe(0);
  });
});

describe("a session told by its events", () => {
  const upToTheGate = [
    fixture("session_started", 1),
    fixture("provenance_recorded", 2),
    fixture("phase_started", 3),
    fixture("usage", 4),
    fixture("envelope_accepted", 5),
    fixture("gate_opened", 6),
    fixture("phase_ended", 7),
    fixture("suspended", 8),
  ];

  it("lists a suspended session as waiting at its gate", async () => {
    const t = cockpit();
    await ship(t, await factory(t), upToTheGate);

    expect(await t.query(api.sessions.list, {})).toEqual([
      {
        factory: "acme/widgets",
        session: "5c0075aa",
        acked: 8,
        summary: {
          status: "waiting",
          workflows: ["ship"],
          request: "add a health check",
          branch: "asf/5c0075aa",
          baseRef: "main",
          trigger: "issue",
          triggeredBy: "schurik",
          issueUrl: "https://github.com/acme/widgets/issues/42",
          prUrl: "https://github.com/acme/widgets/pull/9",
          stationName: "alex@mbp:widgets",
          skillVersion: "1.1.0",
          startedAt: "2026-09-29T11:58:00.000+00:00",
          endedAt: "",
          lastEventAt: "2026-09-29T12:00:00.000+00:00",
          waitingFor: { gate: "plan", round: 2, kind: "gate", channel: "issue",
                        since: "2026-09-29T11:59:00.000+00:00" },
          totalTokens: 5400,
          totalCost: 0.0742,
          unread: 0,
        },
      },
    ]);
  });

  it("renders its phases in the order they started, with where each one stands", async () => {
    const t = cockpit();
    await ship(t, await factory(t), upToTheGate);

    const view = await t.query(api.sessions.get, WHERE);
    expect(view!.phases).toEqual([
      { phaseId: "5c0075aa_03_plan", name: "plan", kind: "agent", owner: "planner",
        description: "Write the plan the builder will follow", status: "running",
        error: "", gate: "", round: 0 },
      { phaseId: "5c0075aa_05_approve_plan", name: "approve_plan", kind: "", owner: "",
        description: "", status: "waiting", error: "", gate: "plan", round: 2 },
    ]);
    expect(view!.events.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("stops waiting once a decision is consumed, and ends how session_finished says", async () => {
    const t = cockpit();
    const token = await factory(t);
    await ship(t, token, upToTheGate);
    await ship(t, token, [fixture("decision_recorded", 9), fixture("session_finished", 10)]);

    const [listed] = await t.query(api.sessions.list, {});
    expect(listed.summary).toMatchObject({
      status: "fail",
      waitingFor: null,
      endedAt: "2026-09-29T12:00:00.000+00:00",
    });
    expect((await t.query(api.sessions.get, WHERE))!.summary).toEqual(listed.summary);
  });

  it("does not list what lies beyond a gap until the gap is filled", async () => {
    const t = cockpit();
    const token = await factory(t);
    await ship(t, token, [fixture("session_started", 1), fixture("session_finished", 3)]);
    expect((await t.query(api.sessions.list, {}))[0].summary.status).toBe("running");

    await ship(t, token, [fixture("phase_started", 2)]);
    expect((await t.query(api.sessions.list, {}))[0].summary.status).toBe("fail");
  });

  it("is unknown to the session page when nothing of it was shipped", async () => {
    const t = cockpit();
    await factory(t);
    expect(await t.query(api.sessions.get, WHERE)).toBeNull();
  });
});

describe("an event this cockpit cannot read", () => {
  it("is stored and shown as a generic row, and changes nothing it cannot vouch for", async () => {
    const t = cockpit();
    const token = await factory(t);
    const unknownKind = { seq: 2, ts: "2026-09-29T12:01:00.000+00:00", kind: "artifact_written",
                          v: 1, payload: { path: "plan.md", role: "output" } };
    const newerVersion = { ...fixture("session_finished", 3), v: 2,
                           payload: { status: "success", ended_at: "later", verdict: "new" } };
    expect(await ship(t, token, [fixture("session_started", 1), unknownKind, newerVersion]))
      .toEqual({ acked: 3 });

    const view = await t.query(api.sessions.get, WHERE);
    expect(view!.events.slice(1)).toEqual([
      { seq: 2, ts: "2026-09-29T12:01:00.000+00:00", kind: "artifact_written", v: 1,
        unread: "unknown kind", detail: "", payload: unknownKind.payload },
      { seq: 3, ts: "2026-09-29T12:00:00.000+00:00", kind: "session_finished", v: 2,
        unread: "newer version", detail: "", payload: newerVersion.payload },
    ]);
    expect(view!.summary).toMatchObject({ status: "running", unread: 2 });
    expect((await t.query(api.sessions.list, {}))[0].summary).toEqual(view!.summary);
  });
});
