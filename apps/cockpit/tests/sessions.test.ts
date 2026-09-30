import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { cockpit, corpus, factory, fixture, ingest, type Cockpit, type WireEvent } from "./helpers";

const WHERE = { factory: "acme/widgets", session: "5c0075aa" };

async function ship(t: Cockpit, token: string, events: WireEvent[]) {
  const response = await ingest(t, token, { session: WHERE.session, events });
  expect(response.status).toBe(200);
  return (await response.json()) as { acked: number };
}

// What each fixture reads as on the session page, written out by hand from the
// fixture itself. A fixture the factory adds has no line here until the cockpit
// says how it reads it, which is the point: the reader ships in the same PR.
const DESCRIBED: Record<string, string> = {
  "artifact_written/v1.json": "output context_handoff/scout_findings.md written: 59 bytes, inline",
  "command_finished/v1.json": "test exited 1 after 4.25s",
  "command_result/v1.json": "command kill by schurik: done — stopped 2 processes",
  "committed/v1.json": "committed 3e1f0a9: docs: plan the health check (1 file)",
  "decision_recorded/v1.json": "decision on plan round 1: reject by alex",
  "envelope_accepted/v1.json": "planner's PlanOutput accepted: planned the health check",
  "envelope_rejected/v1.json":
    "planner's PlanOutput rejected (attempt 1): no JSON object found in the response",
  "gate_opened/v1.json": "plan round 2 opened on the issue channel",
  "gate_result/v1.json": "gate artifacts_exist failed (attempt 1)",
  "harness_output/v1.json": "planner's harness output, chunk 2",
  "journal_noted/v1.json": "journal: deviation — used httpx",
  "phase_ended/v1.json": "approve_plan ended: waiting at plan round 2",
  "phase_replayed/v1.json": "plan replayed from the record, planner not called",
  "phase_started/v1.json": "plan started · agent planner",
  "phase_started/v2.json": "plan started · agent planner · asf/stages/plan/task.md",
  "process_ended/v1.json": "process 4250 ended",
  "process_started/v1.json": "process 4250 started: claude_code planner sonnet",
  "prompt_rendered/v1.json": "prompt 1 sent to planner",
  "provenance_recorded/v1.json": "provenance: #42 health check broken",
  "session_finished/v1.json": "session finished: fail — the run's acceptance criterion was not met",
  "session_resumed/v1.json": "resumed chapter 1: ship",
  "session_started/v1.json": "session started: ship on alex@mbp:widgets",
  "suspended/v1.json": "suspended at plan round 2",
  "tool_called/v1.json": "planner called bash: failed after 1840ms",
  "usage/v1.json": "planner · sonnet: 1200 tokens, $0.0185",
  "workflow_finished/v1.json":
    "chapter 1: ship finished: fail — the run's acceptance criterion was not met",
  "workflow_started/v1.json": "chapter 1: ship started, answering an issue",
};

// A local cockpit, where every session is its one viewer's to see. Who may see
// which session in a team's cockpit is team.test.ts.
beforeEach(() => {
  vi.stubEnv("COCKPIT_MODE", "local");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    expect(row.unreadBecause).toBeNull();
    expect(row.detail, `how does the cockpit read ${name}? add it to DESCRIBED`).toBe(DESCRIBED[name]);
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

  it("tells what it can of a phase whose start it never received", async () => {
    const t = cockpit();
    await ship(t, await factory(t), upToTheGate);

    // The fixtures are one line per kind, not one session: the gate phase that
    // ended here never started, so there is no card to put its end on.
    const view = await t.query(api.sessions.get, WHERE);
    expect(view!.story.chapters).toMatchObject([
      { number: 0, workflow: "ship", items: [
        { type: "agent", phaseId: "5c0075aa_03_plan", name: "plan", owner: "planner", status: "running",
          description: "Write the plan the builder will follow", cost: 0.0185, tokens: 1200 },
      ] },
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

    const page = await t.query(api.sessions.get, WHERE);
    expect(page!.summary.status).toBe("running");
    expect(page!.events.map((row) => row.seq)).toEqual([1, 3]);

    await ship(t, token, [fixture("phase_started", 2)]);
    expect((await t.query(api.sessions.list, {}))[0].summary.status).toBe("fail");
    expect((await t.query(api.sessions.get, WHERE))!.summary.status).toBe("fail");
  });

  it("is unknown to the session page when nothing of it was shipped", async () => {
    const t = cockpit();
    await factory(t);
    expect(await t.query(api.sessions.get, WHERE)).toBeNull();
  });
});

describe("an artifact", () => {
  it("says how it travelled: inline, cut, not sent at all, or as a path in the repository", async () => {
    const t = cockpit();
    const token = await factory(t);
    const written = (seq: number, payload: Record<string, unknown>) => ({
      ...fixture("artifact_written", seq),
      payload: { ...fixture("artifact_written", seq).payload, ...payload },
    });
    await ship(t, token, [
      fixture("session_started", 1),
      written(2, { path: "context_handoff/scout_findings.md", size: 300001, truncated: true }),
      written(3, { path: "context_handoff/core.dump", size: 4008, content: "", truncated: true }),
      written(4, { location: "repo", path: "docs/asf/spec/plan.md", size: 38, content: "" }),
    ]);

    const view = await t.query(api.sessions.get, WHERE);
    expect(view!.events.slice(1).map((row) => row.detail)).toEqual([
      "output context_handoff/scout_findings.md written: 300001 bytes, inline, cut at the cap",
      "output context_handoff/core.dump written: 4008 bytes, not text, not sent",
      "output docs/asf/spec/plan.md written: 38 bytes, in the repository",
    ]);
  });
});

describe("an event this cockpit cannot read", () => {
  it("is stored and shown as a generic row, and changes nothing it cannot vouch for", async () => {
    const t = cockpit();
    const token = await factory(t);
    const unknownKind = { seq: 2, ts: "2026-09-29T12:01:00.000+00:00", kind: "claim_granted",
                          v: 1, payload: { station: "st_7f3a9c", issue: 42 } };
    const newerVersion = { ...fixture("session_finished", 3), v: 2,
                           payload: { status: "success", ended_at: "later", verdict: "new" } };
    expect(await ship(t, token, [fixture("session_started", 1), unknownKind, newerVersion]))
      .toEqual({ acked: 3 });

    const view = await t.query(api.sessions.get, WHERE);
    expect(view!.events.slice(1)).toEqual([
      { seq: 2, ts: "2026-09-29T12:01:00.000+00:00", kind: "claim_granted", v: 1,
        unreadBecause: "unknown kind", detail: "", raw: JSON.stringify(unknownKind.payload) },
      { seq: 3, ts: "2026-09-29T12:00:00.000+00:00", kind: "session_finished", v: 2,
        unreadBecause: "newer version", detail: "", raw: JSON.stringify(newerVersion.payload) },
    ]);
    expect(view!.summary).toMatchObject({ status: "running", unread: 2 });
    expect((await t.query(api.sessions.list, {}))[0].summary).toEqual(view!.summary);
  });
});
