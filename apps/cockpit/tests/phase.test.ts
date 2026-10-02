import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { detailedVersions } from "../convex/model/phase";
import { cockpit, corpus, factory, fixture, ingest, recorded, type Cockpit, type WireEvent } from "./helpers";

// A phase opened into its tabs, read off the golden corpus's recorded session
// (issue #42, the plan gate asked twice, then two review rounds on pull request
// #9). Every expectation is read off that recording by hand.

const SESSION = "a9f259f0";
const { events: RECORDED } = recorded["issue-then-two-reviews"];

async function told(events: WireEvent[] = RECORDED): Promise<Cockpit> {
  const t = cockpit();
  const response = await ingest(t, await factory(t), { session: SESSION, events });
  expect(response.status).toBe(200);
  return t;
}

async function phase(t: Cockpit, phaseId: string) {
  return (await t.query(api.sessions.phase, { factory: "acme/widgets", session: SESSION, phaseId }))!;
}

beforeEach(() => {
  vi.stubEnv("COCKPIT_MODE", "local");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the session page", () => {
  it("names the forge its links go to", async () => {
    const t = await told();

    expect((await t.query(api.sessions.get, { factory: "acme/widgets", session: SESSION }))!.forge).toBe("https://github.com");
  });
});

describe("the Artifacts tab", () => {
  it("shows a handoff file inline, as the station shipped it", async () => {
    const t = await told();

    const { artifacts } = await phase(t, "a9f259f0_02_scout");

    expect(artifacts).toMatchObject([{
      path: "context_handoff/scout_findings.md", location: "handoff", role: "output", size: 112, truncated: false,
    }]);
    expect(artifacts[0].content).toContain("# Findings");
  });

  it("pins a repo file to the commit after it was written, and says nothing changed it since", async () => {
    const t = await told();

    const [revised] = (await phase(t, "a9f259f0_05_plan_revise_1")).artifacts;
    const [doc] = (await phase(t, "a9f259f0_13_document")).artifacts;

    expect(revised).toMatchObject({
      path: "docs/asf/spec/plan.md", location: "repo", content: "",
      committed: { sha: "2512a3cb0fcacfd5d9e68b9105d01f667430f9ce", phase: "commit_plan" },
      rewritten: null, changedLater: null,
    });
    expect(doc).toMatchObject({
      path: "docs/asf/meeting-date.md",
      committed: { sha: "fba4ec9550c663aa73205c0440dce10a37edd47c", phase: "commit_document" },
      changedLater: null,
    });
  });

  it("says when a repo file was rewritten before anything committed it: that version never reached the forge", async () => {
    const t = await told();

    const [first] = (await phase(t, "a9f259f0_03_plan")).artifacts;

    expect(first).toMatchObject({
      path: "docs/asf/spec/plan.md", size: 77, committed: null, rewritten: { phase: "plan_revise_1" },
    });
  });

  it("says when a later commit changed a repo file, and which", async () => {
    const written = fixture("artifact_written", 3);
    Object.assign(written.payload, { location: "repo", path: "docs/spec.md", content: "", phase_id: "5c0075aa_03_plan" });
    const later = fixture("committed", 5);
    Object.assign(later.payload, { sha: "9".repeat(40), files: ["docs/spec.md"], files_total: 1,
                                   phase_id: "5c0075aa_09_commit_fix" });
    const t = await told([
      fixture("session_started", 1), fixture("phase_started", 2, 2), written,
      { ...fixture("committed", 4), payload: { ...fixture("committed", 4).payload, files: ["docs/spec.md"] } },
      later,
    ]);

    const [artifact] = (await phase(t, "5c0075aa_03_plan")).artifacts;

    expect(artifact.committed).toMatchObject({ sha: "3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f" });
    expect(artifact.changedLater).toEqual({ sha: "9".repeat(40), phase: "" });
  });
});

describe("the Checks tab", () => {
  it("lists each gate's result with its checks, and each envelope refused and re-prompted", async () => {
    const t = await told();

    const { checks, rejections } = await phase(t, "a9f259f0_05_plan_revise_1");

    expect(rejections).toEqual([{
      seq: 69, at: expect.any(String), attempt: 1, outputType: "PlanOutput",
      error: "no JSON object found in the response", raw: "I revised the plan.",
    }]);
    // Its own run, then the same results answered from the record by the resume that replayed it.
    expect(checks.map(({ gate, attempt, passed, replayed }) => ({ gate, attempt, passed, replayed }))).toEqual([
      { gate: "artifacts_exist", attempt: 1, passed: true, replayed: false },
      { gate: "files_non_empty", attempt: 1, passed: true, replayed: false },
      { gate: "artifacts_exist", attempt: 0, passed: true, replayed: true },
      { gate: "files_non_empty", attempt: 0, passed: true, replayed: true },
    ]);
    expect(checks[0].checks).toEqual([{ item: "docs/asf/spec/plan.md", ok: true, note: "exists, 122B" }]);
  });

  it("lists what a code step ran, with the tail of its output", async () => {
    const t = await told();

    const { commands } = await phase(t, "a9f259f0_09_verify_1");

    expect(commands).toMatchObject([{ name: "test", exitCode: 0 }]);
  });
});

describe("the Tools tab", () => {
  it("lists every tool call with whether it worked and how long it took, never what it was given", async () => {
    const t = await told();

    const { tools } = await phase(t, "a9f259f0_02_scout");

    expect(tools).toEqual([
      { seq: 11, at: "2026-09-30T17:22:35.686+00:00", agent: "scout", tool: "grep", ok: true, durationMs: 0 },
      { seq: 12, at: "2026-09-30T17:22:35.689+00:00", agent: "scout", tool: "read", ok: true, durationMs: 0 },
      { seq: 13, at: "2026-09-30T17:22:35.692+00:00", agent: "scout", tool: "read", ok: false, durationMs: 0 },
    ]);
  });
});

describe("the Cost tab", () => {
  it("lists each turn's spend, and how full the agent's context window was after it", async () => {
    const t = await told();

    const { usage } = await phase(t, "a9f259f0_03_plan");

    expect(usage).toEqual([{
      seq: 26, at: "2026-09-30T17:22:35.810+00:00", agent: "planner", model: "opus", tokens: 6100, cost: 0.102,
      breakdown: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      contextTokens: 121000, contextWindow: 200000,
    }]);
  });

  it("counts only the turns an agent ran: a phase answered from the record cost nothing", async () => {
    const t = await told();

    // plan_revise_1 ran once (two turns: the refused envelope and the correction); its replays add nothing.
    expect((await phase(t, "a9f259f0_05_plan_revise_1")).usage.map(({ seq }) => seq)).toEqual([68, 72]);
  });
});

describe("the Overview tab", () => {
  it("says what the phase is for, what it was given, and the envelope it reported", async () => {
    const t = await told();

    const plan = await phase(t, "a9f259f0_03_plan");

    expect(plan).toMatchObject({
      name: "plan", kind: "agent", owner: "planner", status: "success", error: "",
      description: "Turn the request into an implementable plan, before any code exists to blur what was asked",
      task: "asf/stages/plan/task.md",
      promptDigest: "470f91b8a520e1ddc64e2f8ec67e0fa9b9abf0991315f755c92274f3722581c8",
    });
    expect(plan.envelope).toMatchObject({ seq: 29, outputType: "PlanOutput", attempt: 1, agent: "planner" });
    expect(JSON.parse(plan.envelope!.json)).toMatchObject({ summary: "a required meeting date, and a test for its format" });
  });

  it("names the commits a code step made", async () => {
    const t = await told();

    const { commits } = await phase(t, "a9f259f0_07_commit_plan");

    expect(commits).toEqual([{ seq: 123, sha: "2512a3cb0fcacfd5d9e68b9105d01f667430f9ce",
                               message: "docs: plan the meeting date", files: ["docs/asf/spec/plan.md"], filesTotal: 1 }]);
  });
});

describe("the Transcript tab", () => {
  it("holds the prompts sent and the harness's raw output, run by run, when the factory opted in", async () => {
    const t = await told();

    const { transcript } = await phase(t, "a9f259f0_05_plan_revise_1");

    expect(transcript.on).toBe(true);
    // One run sent anything; the resume that replayed the phase sent nothing, and is not a run here.
    expect(transcript.runs).toHaveLength(1);
    const [run] = transcript.runs;
    expect(run.sends.map(({ send, truncated }) => ({ send, truncated }))).toEqual([
      { send: 1, truncated: false }, { send: 2, truncated: false },
    ]);
    expect(run.sends[0].system).toContain("# Planner");
    expect(run.sends[1].prompt).toContain("Your response was not valid JSON");
    expect(run.output).toContain('"I revised the plan."');
  });

  it("says transcripts are off when the session shipped none at all", async () => {
    const t = await told(RECORDED.filter((event) => !["prompt_rendered", "harness_output"].includes(event.kind))
      .map((event, index) => ({ ...event, seq: index + 1 })));

    const { transcript } = await phase(t, "a9f259f0_05_plan_revise_1");

    expect(transcript).toEqual({ on: false, runs: [], pruned: null });
  });
});

describe("the Events tab", () => {
  it("lists every event that names the phase, the ones this cockpit cannot read among them", async () => {
    const unknown = { seq: 4, ts: "2026-09-29T12:00:00.000+00:00", kind: "phase_paused", v: 1,
                      payload: { phase_id: "5c0075aa_03_plan" } };
    const t = await told([fixture("session_started", 1), fixture("phase_started", 2, 2), fixture("tool_called", 3), unknown,
                          fixture("usage", 5)]);

    const { events } = await phase(t, "5c0075aa_03_plan");

    expect(events.map(({ seq, kind, unreadBecause }) => ({ seq, kind, unreadBecause }))).toEqual([
      { seq: 2, kind: "phase_started", unreadBecause: null },
      { seq: 3, kind: "tool_called", unreadBecause: null },
      { seq: 4, kind: "phase_paused", unreadBecause: "unknown kind" },
      { seq: 5, kind: "usage", unreadBecause: null },
    ]);
    expect(events[1].detail).toBe("planner called bash: failed after 1840ms");
  });

  it("includes the suspend that asked a gate phase's question", async () => {
    const t = await told();

    const { events } = await phase(t, "a9f259f0_04_approve_plan");

    expect(events.map(({ kind }) => kind)).toContain("suspended");
  });
});

describe("the tabs' readers", () => {
  it.each(Object.keys(corpus))("read %s if they read its kind at all", (name) => {
    const { kind, v: version } = corpus[name];
    const read = detailedVersions(kind);
    if (read.length) expect(read, `${kind} v${version} has a reader but no detailer in phase.ts`).toContain(version);
  });
});
