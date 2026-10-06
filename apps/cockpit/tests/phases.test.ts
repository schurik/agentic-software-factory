import { describe, expect, it } from "vitest";
import { foldedVersions, type PhaseRow, phasedIn } from "../convex/model/phases";
import { advance, EMPTY_SUMMARY } from "../convex/model/session";
import { corpus, fixture, recorded, type WireEvent } from "./helpers";

// A session's phases as rows, one a phase, folded as ingest folds them: batch
// by batch, each batch onto the rows the ones before it left. Every
// expectation is read off the recordings by hand: the issue chapter asks the
// plan gate twice (rejected, then approved), the integrate gate passes by
// policy, then two review rounds each run implement, verify and commit.

const STAGED = recorded["issue-then-two-reviews-in-stages"].events;
const BEFORE = recorded["issue-then-two-reviews"].events;

const stored = (events: WireEvent[]) => events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));

/** `events` folded in batches that end at each of `cuts`' seqs, as a station shipping them would. */
function folded(events: WireEvent[], cuts: number[] = []): PhaseRow[] {
  const rows = new Map<string, PhaseRow>();
  let summary = EMPTY_SUMMARY;
  let from = 0;
  for (const cut of [...cuts, Infinity]) {
    const batch = stored(events.filter(({ seq }) => seq > from && seq <= cut));
    for (const row of phasedIn([...rows.values()], batch, summary, 0)) rows.set(row.phase, row);
    summary = advance(summary, batch);
    from = cut;
  }
  return [...rows.values()];
}

const named = (rows: PhaseRow[], phase: string) => rows.find((row) => row.phase === `a9f259f0_${phase}`)!;
const close = (value: number) => expect.closeTo(value, 6);

describe("a phase's row, from a factory that records its stages", () => {
  it("is one row a phase, however often a resume walked it, each with its chapter, workflow and stage", () => {
    expect(folded(STAGED).map((row) => `${row.chapter} ${row.workflow} ${row.name} ${row.kind} ${row.stage ?? "—"}`)).toEqual([
      "1 issue issue code —",
      "1 issue scout agent scout",
      "1 issue plan agent plan",
      "1 issue approve_plan gate plan",
      "1 issue plan_revise_1 agent plan",
      "1 issue approve_plan_2 gate plan",
      "1 issue commit_plan code commit",
      "1 issue implement agent implement",
      "1 issue verify_1 code verify",
      "1 issue review_1 agent review",
      "1 issue commit_implement code commit",
      "1 issue changes code document",
      "1 issue document agent document",
      "1 issue commit_document code commit",
      "1 issue integrate code integrate",
      "1 issue report code —",
      "2 pr-review pr code —",
      "2 pr-review implement agent implement",
      "2 pr-review verify_1 code verify",
      "2 pr-review commit_implement code commit",
      "2 pr-review report code —",
      "3 pr-review pr code —",
      "3 pr-review implement agent implement",
      "3 pr-review verify_1 code verify",
      "3 pr-review commit_implement code commit",
      "3 pr-review report code —",
    ]);
  });

  it("tells the three commit stages of a workflow apart by where they stand in it", () => {
    const rows = folded(STAGED);

    expect(["07_commit_plan", "11_commit_implement", "14_commit_document"].map((phase) => named(rows, phase).stageIndex))
      .toEqual([2, 6, 8]);
    expect(named(rows, "01_issue").stageIndex).toBeNull();
  });

  it("counts the time each live run worked and none of a replay's, with what its agent calls cost", () => {
    const rows = folded(STAGED);

    // Worked once (33.846 → 34.336), then replayed twice.
    expect(named(rows, "02_scout")).toMatchObject({ status: "success", duration: close(0.49), cost: close(0.021), tokens: 1900 });
    // Read the issue three times, each time live: .074 + .059 + .057.
    expect(named(rows, "01_issue")).toMatchObject({ duration: close(0.19), cost: 0, tokens: 0 });
    // Two calls, the first of them free.
    expect(named(rows, "05_plan_revise_1")).toMatchObject({ duration: close(0.257), cost: close(0.041), tokens: 2400 });
    expect(rows.every((row) => row.since === null)).toBe(true);
  });

  it("holds each round a person was asked at a gate: its verdict, and how long it waited for it", () => {
    const rows = folded(STAGED);

    // Asked since 34.629, decided 35.031 — and the same decision read back on each resume.
    expect(named(rows, "04_approve_plan")).toMatchObject({ gate: "plan", round: 1, verdict: "reject", wait: close(0.402) });
    // Asked since 36.515, decided 37.027.
    expect(named(rows, "06_approve_plan_2")).toMatchObject({ gate: "plan", round: 2, verdict: "approve", wait: close(0.512) });
    // Nobody was asked at integrate: the policy passed it, and only phases are rows.
    expect(rows.filter((row) => row.kind === "gate")).toHaveLength(2);
    expect(named(rows, "15_integrate")).toMatchObject({ kind: "code", gate: "", verdict: "", wait: null });
  });

  it("comes out the same however the events were cut into batches", () => {
    expect(folded(STAGED, [35, 37, 38, 61, 82, 126, 184, 190, 216])).toEqual(folded(STAGED));
    expect(folded(STAGED, Array.from({ length: 245 }, (_, seq) => seq + 1))).toEqual(folded(STAGED));
  });
});

describe("a phase's row while it goes on, and when it stops short", () => {
  const working = STAGED.filter(({ seq }) => seq <= 126);            // the builder has just started

  it("is running, counting nothing yet, from when its run started", () => {
    expect(named(folded(working), "08_implement")).toMatchObject({
      status: "running", duration: 0, since: Date.parse("2026-10-04T22:41:38.775Z"), stage: "implement",
    });
  });

  it("waits at a gate until a person answers it, with no verdict and no wait yet", () => {
    expect(named(folded(STAGED.filter(({ seq }) => seq <= 37)), "04_approve_plan"))
      .toMatchObject({ status: "waiting", gate: "plan", round: 1, verdict: "", wait: null,
                       askedAt: Date.parse("2026-10-04T22:41:34.629Z") });
  });

  it("failed where a killed session stopped, counting the time up to its end", () => {
    const killed = [...working, { ...fixture("session_finished", 127), ts: "2026-10-04T22:41:39.775+00:00" }];

    expect(named(folded(killed), "08_implement")).toMatchObject({ status: "fail", duration: close(1), since: null });
  });
});

describe("a phase's row, from a factory before stages", () => {
  it("is the same rows with no stage, which count toward the session alone", () => {
    const rows = folded(BEFORE);

    expect(rows).toHaveLength(26);
    expect(rows.every((row) => row.stage === null && row.stageIndex === null)).toBe(true);
    expect(rows.map((row) => `${row.chapter} ${row.name}`)).toEqual(folded(STAGED).map((row) => `${row.chapter} ${row.name}`));
    expect(named(rows, "04_approve_plan")).toMatchObject({ kind: "gate", verdict: "reject", wait: close(0.269) });
  });
});

describe("the rows' readers", () => {
  it.each(Object.keys(corpus))("fold %s if they fold its kind at all", (name) => {
    const { kind, v: version } = corpus[name];
    const folded = foldedVersions(kind);
    if (folded.length) expect(folded, `${kind} v${version} has a reader but no fold in model/phases.ts`).toContain(version);
  });
});
