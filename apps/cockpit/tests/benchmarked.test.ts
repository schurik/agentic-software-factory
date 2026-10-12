import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { lastDays } from "../convex/model/period";
import { type Cockpit, fixture, ingest, type WireEvent } from "./helpers";
import { fakeForge, localOf, post } from "./station";

// A benchmark's sessions (#198): the station works a benchmark's tasks again
// under each variant, and each session says so on its `session_started` (v4).
// They are measurement, never the factory's work (CONTEXT.md, Benchmark): no
// metric counts them — not the Metrics view's, not the Overview's, not a
// scorer's strip or window — and what they spent is the measurement budget's,
// drawn as benchmarks beside the judges.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const at = (iso: string) => Date.parse(iso);
const WEEK = lastDays(7, at("2026-10-06T12:00:00Z"), "UTC");
const KICKOFF = "2026-10-01T09:00:00.000Z";
const sha = (letter: string) => letter.repeat(40);

/**
 * One finished session of `issue` that spent `cost` in one call, committed
 * once and was scored failing by `corrections` — a benchmark's when
 * `benchmark` says which, else the factory's own work, which opened pull
 * request #`number` and saw it merge.
 */
function session(id: string, number: number, cost: number, benchmark?: Record<string, unknown>): WireEvent[] {
  const events: WireEvent[] = [];
  const add = (event: WireEvent, ts: string, payload: Record<string, unknown> = {}) => {
    events.push({ ...event, seq: events.length + 1, ts, payload: { ...event.payload, ...payload } });
  };
  if (benchmark) add(fixture("session_started", 1, 4), KICKOFF, { adw_id: id, started_at: KICKOFF, benchmark });
  else add(fixture("session_started", 1, 3), KICKOFF, { adw_id: id, started_at: KICKOFF });
  add(fixture("workflow_started", 1, 2), KICKOFF, { workflow: "issue", chapter: 1, input: "issue" });
  add(fixture("usage", 1), KICKOFF, { cost });
  add(fixture("committed", 1), "2026-10-01T09:30:00.000Z", { sha: sha(String(number)) });
  const url = `https://github.com/acme/widgets/pull/${number}`;
  if (!benchmark) add(fixture("pull_request_opened", 1), "2026-10-01T10:00:00.000Z", { url, number });
  add(fixture("session_finished", 1), "2026-10-02T10:00:00.000Z", { status: "success", ended_at: "2026-10-02T10:00:00.000Z" });
  if (!benchmark) {
    add(fixture("pull_request_closed", 1), "2026-10-03T12:00:00Z", {
      url, number, merged: true, merged_at: "2026-10-03T12:00:00Z", first_review_at: "", head_shas: [sha(String(number))], base_merges: [],
    });
  }
  add(fixture("chapter_scored", 1), "2026-10-02T10:30:00Z", { chapter: 1, scorer: "corrections", class: "above", failing: true, evidence: [1] });
  return events;
}

const OF = (repetition: number) => ({ benchmark: "reviewer", variant: "PR #9", ref: "asf/1a2b3c4d", commit: sha("9"), task: "a1", repetition });

async function shipped(): Promise<{ t: Cockpit; token: string }> {
  const { t, ingestToken } = await localOf(fakeForge());
  for (const [id, events] of [["a1", session("a1", 1, 4)], ["b1", session("b1", 2, 2, OF(1))], ["b2", session("b2", 3, 1, OF(2))]] as const) {
    expect((await ingest(t, ingestToken, { session: id, events })).status).toBe(200);
  }
  return { t, token: ingestToken };
}

describe("a benchmark's sessions", () => {
  it("count toward no metric, and what they spent is measurement's", async () => {
    const { t } = await shipped();

    const metrics = (await t.query(api.measure.metrics, { factory: "acme/widgets", days: WEEK }))!;
    expect(metrics).toMatchObject({ opened: 1, merged: 1, autonomous: 1 });
    expect(metrics.chapters).toEqual([
      { trigger: "prompt", chapters: 0 }, { trigger: "issue", chapters: 1 }, { trigger: "pr", chapters: 0 },
    ]);
    expect(metrics.expensive.map((each) => each.session)).toEqual(["a1"]);
    expect(metrics.measurement).toMatchObject({ judges: 0, benchmarks: 3 });
  });

  it("are not in the Overview: neither what the work spent, nor how its sessions ended", async () => {
    const { t } = await shipped();

    const overview = (await t.query(api.overview.page, { factory: "acme/widgets", days: WEEK }))!;
    expect(overview.spend.total.cost).toBe(4);
    expect(overview.spend.sessions).toBe(1);
    expect(overview.outcomes.sessions).toBe(1);
  });

  it("are not in a scorer's strip, nor counted in its window", async () => {
    const { t, token } = await shipped();
    const description = JSON.parse((import.meta.glob("../../../tests/golden/self-description/v3.json",
      { eager: true, query: "?raw", import: "default" }) as Record<string, string>)["../../../tests/golden/self-description/v3.json"]);
    const station = { id: "st_ci0001", name: "runner@fv-az123:widgets", kind: "ci" };
    expect((await post(t, "/describe", token, { station, description })).status).toBe(200);

    const page = (await t.query(api.measure.scorers, { factory: "acme/widgets" }))!;
    expect(page.sessions).toBe(1);
    const corrections = page.scorers.find((each) => each.name === "corrections")!;
    expect(corrections.strip.map((each) => each.session)).toEqual(["a1"]);
    expect(corrections.counted.map((each) => each.session)).toEqual(["a1"]);
  });

  it("are never a failure that needs attention, though one stopped as not comparable", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    vi.setSystemTime(at("2026-10-02T12:00:00Z"));
    const failed = session("b1", 2, 1, OF(1)).map((event) => event.kind === "session_finished"
      ? { ...event, payload: { ...event.payload, status: "fail", reason: "not comparable: no decision" } } : event);
    expect((await ingest(t, ingestToken, { session: "b1", events: failed })).status).toBe(200);

    const row = (await t.query(api.factories.list, {}))!.factories.find((each) => each.repo === "acme/widgets")!;
    expect(row.facts.failed).toEqual([]);
  });

  it("stay out once the backfills come to a session an older cockpit stored", async () => {
    const { t } = await shipped();
    await t.run(async (ctx) => {
      for (const table of ["chapters", "scores", "phases"] as const) {
        for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
      }
      for (const record of await ctx.db.query("sessions").collect()) {
        await ctx.db.patch(record._id, { chaptered: undefined, scored: undefined, phased: undefined });
      }
    });

    await t.mutation(internal.chapters.backfill, {});
    await t.mutation(internal.scores.backfill, {});
    await t.mutation(internal.phases.backfill, {});

    const metrics = (await t.query(api.measure.metrics, { factory: "acme/widgets", days: WEEK }))!;
    expect(metrics.chapters).toContainEqual({ trigger: "issue", chapters: 1 });
    const sessions = await t.run(async (ctx) => (await ctx.db.query("scores").collect()).map((row) => row.session));
    expect(sessions).toEqual(["a1"]);
  });
});
