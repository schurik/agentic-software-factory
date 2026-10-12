import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { type Cockpit, fixture, ingest, type WireEvent } from "./helpers";
import { fakeForge, localOf, post } from "./station";

// The Measure tab's Benchmarks view (#199): each benchmark the factory's
// default branch describes, its variants compared metric by metric as the
// mean over repetitions ± the run-to-run noise — one standard deviation of
// what each repetition came to — with a reading in words that never says
// which is better (CONTEXT.md, Benchmark; ADR 0006). Built from the benchmark
// sessions' own events: a scorer's score of one arrives after it ended.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const MAIN = { variant: "main", ref: "main", commit: "a".repeat(40) };
const PR = { variant: "PR #9", ref: "asf/1a2b3c4d", commit: "9".repeat(40) };
const TASKS = ["5c0be7ed", "7e1a2b3c"];

type Outcome = "accepted" | "not accepted" | "not comparable" | "running";

interface Worked {
  id: string;
  of: typeof MAIN;
  task: string;
  repetition: number;
  benchmark?: string;
  /** When it started, minutes after the first. */
  start: number;
  minutes?: number;
  cost: number;
  outcome?: Outcome;
  /** Envelopes refused, and the failed gate results of one round. */
  rejected?: number;
  failedGates?: number;
  /** How the `corrections` scorer scored it, once it ended; unscored when absent. */
  failing?: boolean;
}

const FIRST = Date.parse("2026-10-10T09:00:00.000Z");
const iso = (minutes: number) => new Date(FIRST + minutes * 60_000).toISOString();

/** A benchmark session's events, as its station ships them: all it did, then — later — its score. */
function batches(worked: Worked): [WireEvent[], WireEvent[]] {
  const { start, minutes = 10, outcome = "accepted" } = worked;
  const events: WireEvent[] = [];
  const add = (event: WireEvent, at: number, payload: Record<string, unknown> = {}) => {
    events.push({ ...event, seq: events.length + 1, ts: iso(at), payload: { ...event.payload, ...payload } });
  };
  add(fixture("session_started", 1, 4), start, {
    adw_id: worked.id, started_at: iso(start), trigger: "benchmark",
    benchmark: { benchmark: worked.benchmark ?? "reviewer-scope", ...worked.of, task: worked.task, repetition: worked.repetition },
  });
  add(fixture("workflow_started", 1, 2), start, { workflow: "issue", chapter: 1, input: "issue" });
  add(fixture("usage", 1), start, { cost: worked.cost, session_cost: worked.cost });
  for (let each = 0; each < (worked.rejected ?? 0); each++) add(fixture("envelope_rejected", 1), start, { attempt: each + 1 });
  for (let each = 0; each < (worked.failedGates ?? 0); each++) {
    add(fixture("gate_result", 1), start, { phase_id: `${worked.id}_03_build`, gate: `gate${each}`, attempt: 1, passed: false });
  }
  if (outcome === "running") return [events, []];
  add(fixture("workflow_finished", 1, 2), start + minutes, {
    workflow: "issue", chapter: 1, status: outcome === "accepted" ? "success" : "fail", accepted: outcome !== "not accepted",
    reason: outcome === "not comparable" ? "not comparable: no decision at gate plan, round 1" : outcome === "accepted" ? "" : "refused",
  });
  add(fixture("session_finished", 1), start + minutes, { status: outcome === "accepted" ? "success" : "fail", ended_at: iso(start + minutes) });
  const ended = events.length;
  if (worked.failing !== undefined) {
    add(fixture("chapter_scored", 1), start + minutes + 5, {
      chapter: 1, scorer: "corrections", class: worked.failing ? "above" : "within", failing: worked.failing, evidence: [1],
    });
  }
  return [events.slice(0, ended), events.slice(ended)];
}

/**
 * Two variants, two tasks, two repetitions. `main` was refused once and
 * corrected twice in the first; `PR #9` was accepted every time, cheaper.
 */
const COMPARED: Worked[] = [
  { id: "m11", of: MAIN, task: TASKS[0], repetition: 1, start: 0, cost: 1, rejected: 1, failedGates: 2, failing: true },
  { id: "p11", of: PR, task: TASKS[0], repetition: 1, start: 10, cost: 0.5, failing: false },
  { id: "m12", of: MAIN, task: TASKS[1], repetition: 1, start: 20, cost: 3, outcome: "not accepted", failing: true },
  { id: "p12", of: PR, task: TASKS[1], repetition: 1, start: 30, cost: 0.5, failing: false },
  { id: "m21", of: MAIN, task: TASKS[0], repetition: 2, start: 40, cost: 2, failing: true },
  { id: "p21", of: PR, task: TASKS[0], repetition: 2, start: 50, cost: 1, failing: false },
  { id: "m22", of: MAIN, task: TASKS[1], repetition: 2, start: 60, cost: 4, failing: false },
  { id: "p22", of: PR, task: TASKS[1], repetition: 2, start: 70, cost: 1, failing: false },
];

const description = (): Record<string, unknown> => JSON.parse((import.meta.glob("../../../tests/golden/self-description/v5.json",
  { eager: true, query: "?raw", import: "default" }) as Record<string, string>)["../../../tests/golden/self-description/v5.json"]);

/** A factory whose default branch describes `reviewer-scope` at two repetitions, then `fresh` and `older`, of one task each. */
async function described(): Promise<{ t: Cockpit; token: string }> {
  const { t, ingestToken } = await localOf(fakeForge());
  const said = description();
  const [scope] = said.benchmarks as Record<string, unknown>[];
  said.benchmarks = [
    { ...scope, repetitions: 2 },
    { ...scope, name: "fresh", tasks: [(scope.tasks as unknown[])[0]] },
    { ...scope, name: "older", tasks: [(scope.tasks as unknown[])[0]] },
  ];
  const station = { id: "st_ci0001", name: "runner@fv-az123:widgets", kind: "ci" };
  expect((await post(t, "/describe", ingestToken, { station, description: said })).status).toBe(200);
  return { t, token: ingestToken };
}

async function worked(t: Cockpit, token: string, sessions: Worked[]): Promise<void> {
  for (const each of sessions) {
    for (const events of batches(each)) {
      if (events.length) expect((await ingest(t, token, { session: each.id, events })).status).toBe(200);
    }
  }
}

async function benchmarks(t: Cockpit) {
  return (await t.query(api.measure.benchmarks, { factory: "acme/widgets" }))!;
}

describe("the Benchmarks view", () => {
  it("compares each metric per variant as the mean over repetitions ± one standard deviation, with a reading in words", async () => {
    const { t, token } = await described();
    await worked(t, token, COMPARED);

    const [scope] = (await benchmarks(t)).benchmarks;
    expect(scope.name).toBe("reviewer-scope");
    expect(scope.variants.map((each) => [each.label, each.ref, each.commit])).toEqual([
      ["main", "main", MAIN.commit], ["PR #9", "asf/1a2b3c4d", PR.commit],
    ]);
    const metric = (key: string) => scope.metrics.find((each) => each.key === key)!;
    const values = (key: string) => metric(key).values.map((each) => each && [each.mean, each.noise]);
    const reading = (key: string) => metric(key).readings.map((each) => each && `${each.words} · ${each.noise}`);

    // The order the view draws: each scorer's failing share, then accepted, corrections, cost, duration.
    expect(scope.metrics.map((each) => each.key)).toEqual(["scorer:corrections", "accepted", "corrections", "cost", "duration"]);

    // main failed 2 of 2, then 1 of 2: 100% and 50%.
    expect(values("scorer:corrections")[0]![0]).toBeCloseTo(0.75);
    expect(values("scorer:corrections")[0]![1]).toBeCloseTo(0.3536, 3);
    expect(values("scorer:corrections")[1]).toEqual([0, 0]);
    expect(reading("scorer:corrections")).toEqual([null, "75 pts lower · more than the noise"]);

    // main accepted 1 of 2, then 2 of 2.
    expect(values("accepted")[0]![0]).toBeCloseTo(0.75);
    expect(values("accepted")[1]).toEqual([1, 0]);
    expect(reading("accepted")).toEqual([null, "25 pts higher · within the noise"]);

    // A refused envelope and one round of two failed gates: two corrections, in main's first repetition alone.
    expect(values("corrections")[0]![0]).toBeCloseTo(0.5);
    expect(values("corrections")[0]![1]).toBeCloseTo(0.7071, 3);
    expect(reading("corrections")).toEqual([null, "0.5 fewer · within the noise"]);

    // main spent $1 and $3, then $2 and $4: $2 and $3 a session; PR #9 $0.50, then $1.
    expect(values("cost")[0]![0]).toBeCloseTo(2.5);
    expect(values("cost")[0]![1]).toBeCloseTo(0.7071, 3);
    expect(values("cost")[1]![0]).toBeCloseTo(0.75);
    expect(reading("cost")).toEqual([null, "$1.75 less · more than the noise"]);

    expect(values("duration")).toEqual([[600, 0], [600, 0]]);
    expect(reading("duration")).toEqual([null, "the same · within the noise"]);
  });

  it("says how far a benchmark got while its sessions are still being worked, and compares only what ended", async () => {
    const { t, token } = await described();
    const running = COMPARED.map((each) => (each.id === "p22" ? { ...each, outcome: "running" as const, cost: 50 } : each));
    await worked(t, token, running);

    const [scope] = (await benchmarks(t)).benchmarks;
    expect(scope.progress).toMatchObject({ planned: 8, worked: 7, running: 1, notComparable: 0 });
    expect(scope.state).toBe("working");
    const cost = scope.metrics.find((each) => each.key === "cost")!;
    expect(cost.values[1]!.mean).toBeCloseTo(0.75);
  });

  it("counts a session that could not be compared as worked, and compares the rest", async () => {
    const { t, token } = await described();
    const refused = COMPARED.map((each) => (each.id === "p22" ? { ...each, outcome: "not comparable" as const } : each));
    await worked(t, token, refused);

    const [scope] = (await benchmarks(t)).benchmarks;
    expect(scope.progress).toMatchObject({ planned: 8, worked: 8, running: 0, notComparable: 1 });
    expect(scope.state).toBe("finished");
    expect(scope.progress.finishedAt).toBe(FIRST + 80 * 60_000);
    expect(scope.metrics.find((each) => each.key === "accepted")!.values[1]).toEqual({ mean: 1, noise: 0, repetitions: 2 });
  });

  it("compares a variant at the commit it was last worked at, once its ref moved", async () => {
    const { t, token } = await described();
    const before = { ...PR, commit: "8".repeat(40) };
    await worked(t, token, [{ id: "old", of: before, task: TASKS[0], repetition: 1, start: -60, cost: 100 }, ...COMPARED]);

    const [scope] = (await benchmarks(t)).benchmarks;
    expect(scope.variants[1].commit).toBe(PR.commit);
    expect(scope.progress.worked).toBe(8);
    expect(scope.metrics.find((each) => each.key === "cost")!.values[1]!.mean).toBeCloseTo(0.75);
  });

  it("says no noise is known from one repetition", async () => {
    const { t, token } = await described();
    await worked(t, token, COMPARED.filter((each) => each.repetition === 1));

    const [scope] = (await benchmarks(t)).benchmarks;
    const cost = scope.metrics.find((each) => each.key === "cost")!;
    expect(cost.values.map((each) => each && [each.mean, each.noise])).toEqual([[2, null], [0.5, null]]);
    expect(cost.readings[1]).toMatchObject({ words: "$1.50 less", noise: "noise not known: one repetition" });
  });

  it("lists every described benchmark newest first, the never worked last, and none for a factory that described none", async () => {
    const { t, token } = await described();
    await worked(t, token, COMPARED.slice(0, 2));
    await worked(t, token, [{ id: "o1", of: MAIN, task: TASKS[0], repetition: 1, start: -600, cost: 1, benchmark: "older" }]);

    const page = await benchmarks(t);
    expect(page.described).toBe(true);
    expect(page.benchmarks.map((each) => [each.name, each.state, each.progress.worked, each.progress.planned])).toEqual([
      ["reviewer-scope", "partway", 2, 8], ["older", "partway", 1, 6], ["fresh", "not worked", 0, 6],
    ]);

    const { t: bare } = await localOf(fakeForge());
    expect(await bare.query(api.measure.benchmarks, { factory: "acme/widgets" })).toEqual({ described: false, benchmarks: [] });
  });
});
