import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { phasedIn } from "../convex/model/phases";
import { lastDays } from "../convex/model/period";
import { EMPTY_SUMMARY } from "../convex/model/session";
import { recordOf, type StageFigures, stagesOf } from "../convex/model/workflows";
import { fixture, ingest, recorded, type WireEvent } from "./helpers";
import { fakeForge, localOf, STATION } from "./station";

// A workflow's last 30 days, stage by stage (#120): what the Workflows tab
// writes on each card of a workflow's graph — the median time a stage's
// phases worked in a chapter and what they cost, how many chapters failed there, and
// what people did at its gate — read off the per-phase rows, never events.
// Every figure is read off the recording by hand: the issue chapter asks the
// plan gate twice (rejected after 0.402s, approved after 0.512s), then two
// review rounds each run implement, verify and commit.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const at = (iso: string) => Date.parse(iso);
const close = (value: number) => expect.closeTo(value, 6);
const STAGED = recorded["issue-then-two-reviews-in-stages"].events;
const stored = (events: WireEvent[]) => events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));
const rows = (events: WireEvent[]) => phasedIn([], stored(events), EMPTY_SUMMARY, 0).map((row) => ({ ...row, session: "a9f259f0" }));
const figure = (figures: StageFigures[], workflow: string, index: number) =>
  figures.find((each) => each.workflow === workflow && each.index === index);

describe("a workflow's stages, from its phases' rows", () => {
  it("are what each stage's phases worked and cost in a chapter, the gate's rounds aside", () => {
    const figures = stagesOf(rows(STAGED));

    // plan: the plan and its revision worked 0.252s + 0.257s for $0.102 + $0.041; the gate's two rounds are its own.
    expect(figure(figures, "issue", 1)).toEqual({
      workflow: "issue", index: 1, stage: "plan", chapters: 1, time: close(0.509), cost: close(0.143), failures: 0,
      gate: { rounds: 2, rejected: 1, wait: close((0.402 + 0.512) / 2) },
    });
    // document: collecting the diff, then the documenter.
    expect(figure(figures, "issue", 7)).toMatchObject({ stage: "document", time: close(0.715), cost: close(0.018) });
    // pr-review's implement ran once in each of two review rounds: the median of 0.460s and 0.487s.
    expect(figure(figures, "pr-review", 0)).toMatchObject({ stage: "implement", chapters: 2, time: close(0.4735), cost: close(0.04) });
    expect(figure(figures, "pr-review", 2)).toMatchObject({ stage: "commit", chapters: 2, time: close(0.672), gate: { rounds: 0, rejected: 0, wait: null } });
  });

  it("are none for the work item, the report, or a factory before stages", () => {
    expect(stagesOf(rows(STAGED)).map((each) => `${each.workflow} ${each.index} ${each.stage}`)).toEqual([
      "issue 0 scout", "issue 1 plan", "issue 2 commit", "issue 3 implement", "issue 4 verify", "issue 5 review",
      "issue 6 commit", "issue 7 document", "issue 8 commit", "issue 9 integrate",
      "pr-review 0 implement", "pr-review 1 verify", "pr-review 2 commit",
    ]);
    expect(stagesOf(rows(recorded["issue-then-two-reviews"].events))).toEqual([]);
  });

  it("count a chapter that ended failing there, and time only the chapters whose phases ended", () => {
    const base = { session: "s1", chapter: 1, workflow: "ship", stage: "verify", stageIndex: 4, kind: "code",
                   at: 0, duration: 10, cost: 0, verdict: "", wait: null };
    const figures = stagesOf([
      // s1: verify failed, the fix ran, verify passed — the stage did not fail.
      { ...base, status: "fail" }, { ...base, kind: "agent", at: 1, status: "success" }, { ...base, at: 2, status: "success" },
      // s2: the session ended in verify.
      { ...base, session: "s2", status: "fail", duration: 4 },
      // s3: still verifying — no time yet, and no failure.
      { ...base, session: "s3", status: "running", duration: 1 },
    ]);
    expect(figures).toEqual([expect.objectContaining({ chapters: 2, time: 17, failures: 1 })]);
  });

  it("count a session a person aborted at the stage's gate as failing there, though the round never ended", () => {
    const base = { session: "s1", chapter: 1, workflow: "ship", stage: "plan", stageIndex: 1, at: 0, cost: 0.1, wait: null };
    const figures = stagesOf([
      { ...base, kind: "agent", status: "success", duration: 30, verdict: "" },
      // Suspended for a person, who aborted the session: the round's row stays as it was left.
      { ...base, kind: "gate", at: 1, status: "waiting", duration: 0, verdict: "abort", wait: 600 },
    ]);
    expect(figures).toEqual([expect.objectContaining({ chapters: 1, time: 30, failures: 1, gate: { rounds: 1, rejected: 0, wait: 600 } })]);
  });
});

describe("a workflow's record, as its graph is annotated", () => {
  const figures = stagesOf(rows(STAGED));

  it("puts each stage's figures on the stage the description names at that place, and marks the slowest", () => {
    const record = recordOf("pr-review", ["implement", "verify", "commit"], figures);
    expect(record.map((each) => each?.stage)).toEqual(["implement", "verify", "commit"]);
    expect(record.map((each) => each?.slowest)).toEqual([false, false, true]);
  });

  it("puts nothing on a stage whose place another stage held when it ran, and marks no slowest of one", () => {
    // The workflow changed since: its first stage is now a scout, and only `verify` is where it was.
    expect(recordOf("pr-review", ["scout", "verify"], figures)).toEqual([null, expect.objectContaining({ stage: "verify", slowest: false })]);
    expect(recordOf("nightly", ["implement"], figures)).toEqual([null]);
  });
});

/**
 * A ship session on STATION that failed in its verify stage on `day`: its
 * workflow names its stages, the phase says where it is, and the session ends
 * there.
 */
function failedInVerify(session: string, day: string): WireEvent[] {
  const ts = `${day}T10:00:00.000Z`;
  const started = { ...fixture("session_started", 1, 2), ts };
  Object.assign(started.payload, { adw_id: session, workflow: "ship", station_id: STATION.id, station_name: STATION.name, started_at: ts });
  const workflow = { ...fixture("workflow_started", 2, 2), ts };
  const phase = { ...fixture("phase_started", 3, 3), ts };
  Object.assign(phase.payload, { phase_id: `${session}_06_verify_1`, name: "verify_1", kind: "code", stage_index: 4 });
  const later = `${day}T10:02:00.000Z`;
  const ended = { ...fixture("phase_ended", 4), ts: later };
  Object.assign(ended.payload, { phase_id: `${session}_06_verify_1`, name: "verify_1", status: "fail", gate: "", round: 0 });
  const finished = { ...fixture("session_finished", 5), ts: later };
  Object.assign(finished.payload, { status: "fail", ended_at: later });
  return [started, workflow, phase, ended, finished];
}

describe("the Workflows tab's figures, from the factory's rows", () => {
  it("are each stage's over the last 30 days, beside the Overview's by-workflow lines", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ingest(t, ingestToken, { session: "a9f259f0", events: STAGED });
    await ingest(t, ingestToken, { session: "5c0075aa", events: failedInVerify("5c0075aa", "2026-10-02") });
    await ingest(t, ingestToken, { session: "0d1d0000", events: failedInVerify("0d1d0000", "2026-08-20") });   // before the 30 days

    const days = lastDays(30, at("2026-10-06T12:00:00Z"), "UTC");
    const { stages, workflows } = (await t.query(api.overview.page, { factory: "acme/widgets", days }))!;

    expect(figure(stages, "issue", 1)).toMatchObject({ stage: "plan", time: close(0.509), gate: { rounds: 2, rejected: 1 } });
    expect(figure(stages, "ship", 4)).toEqual({
      workflow: "ship", index: 4, stage: "verify", chapters: 1, time: 120, cost: 0, failures: 1, gate: { rounds: 0, rejected: 0, wait: null },
    });
    expect(workflows.map((line) => `${line.workflow} ${line.sessions} ${line.failed}`)).toEqual(["issue 1 0", "pr-review 1 0", "ship 1 1"]);
  });
});
