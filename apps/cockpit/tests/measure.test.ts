import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { lastDays } from "../convex/model/period";
import { foldedVersions as chapterVersions } from "../convex/model/chapters";
import { foldedVersions as pullVersions } from "../convex/model/pulls";
import { foldedVersions as scoreVersions } from "../convex/model/scores";
import { type Cockpit, corpus, fixture, ingest, type WireEvent } from "./helpers";
import { fakeForge, localOf } from "./station";

// The Measure tab's Metrics (#184): how many pull requests the factory opened
// in a period, how many merged, and autonomy — the share of the merged ones
// that were autonomous pull requests (CONTEXT.md). Built from domain events
// alone: `pull_request_opened`, `committed`, and the `pull_request_closed` a
// station's PR watcher sends after the session finished.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const at = (iso: string) => Date.parse(iso);

/** The week up to Tuesday 2026-10-06 in UTC: Wednesday 2026-09-30 through it. */
const WEEK = lastDays(7, at("2026-10-06T12:00:00Z"), "UTC");

const sha = (letter: string) => letter.repeat(40);

interface Closed {
  at: string;
  merged: boolean;
  head: string[];
  baseMerges?: string[];
  /** When its first review came; none when nobody reviewed it. */
  review?: string;
  /** Its changed lines: a v2 close says them, and none is a v1 close, which never said. */
  lines?: { additions: number; deletions: number };
}

/** What one agent call cost, by component — the four a `usage` event's breakdown prices, and what it left unpriced. */
interface Call {
  at?: string;
  cost: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * One session's events, in order: it starts at `kickoff` (Oct 1, 09:00) on
 * an issue, makes `calls`, commits `commits` in its first chapter, opens pull
 * request #`number` (unless `opened` is false: it found one open), commits
 * `reviewed` in a review chapter driven by a person's comments, finishes,
 * and — later — hears how the pull request closed.
 */
function session(id: string, number: number, {
  commits, reviewed = [], opened = true, openedAt = "2026-10-01T10:00:00.000Z", kickoff = "2026-10-01T09:00:00.000Z",
  calls = [], closed, input = "issue", before, scored = 0,
}: {
  commits: string[]; reviewed?: string[]; opened?: boolean; openedAt?: string; kickoff?: string; calls?: Call[];
  closed?: Closed; input?: string;
  /** Another pull request the session opened first, by number. */
  before?: number;
  /** What a scorer's judge spent on its first chapter, once the pull request closed: measurement, not work. */
  scored?: number;
}): WireEvent[] {
  const url = `https://github.com/acme/widgets/pull/${number}`;
  const events: WireEvent[] = [];
  const add = (event: WireEvent, ts: string, payload: Record<string, unknown> = {}) => {
    events.push({ ...event, seq: events.length + 1, ts, payload: { ...event.payload, ...payload } });
  };
  add(fixture("session_started", 1, 3), kickoff, { adw_id: id, started_at: kickoff });
  add(fixture("workflow_started", 1, 2), kickoff, { workflow: "issue", chapter: 1, input });
  for (const call of calls) {
    const usage = { ...fixture("usage", 1).payload.usage as Record<string, unknown>,
                    input_cost: call.input ?? 0, output_cost: call.output ?? 0,
                    cache_read_cost: call.cacheRead ?? 0, cache_write_cost: call.cacheWrite ?? 0, total_cost: call.cost };
    add(fixture("usage", 1), call.at ?? kickoff, { cost: call.cost, usage });
  }
  for (const each of commits) add(fixture("committed", 1), "2026-10-01T09:30:00.000Z", { sha: each });
  if (before !== undefined) add(fixture("pull_request_opened", 1), openedAt, { url: `https://github.com/acme/widgets/pull/${before}`, number: before });
  if (opened) add(fixture("pull_request_opened", 1), openedAt, { url, number });
  else add(fixture("provenance_recorded", 1, 2), openedAt, { pr_url: url });
  if (reviewed.length) {
    add(fixture("workflow_started", 1, 2), "2026-10-02T09:00:00.000Z", { workflow: "pr-review", chapter: 2, input: "pr" });
    for (const each of reviewed) add(fixture("committed", 1), "2026-10-02T09:30:00.000Z", { sha: each });
  }
  add(fixture("session_finished", 1), "2026-10-02T10:00:00.000Z", { status: "success", ended_at: "2026-10-02T10:00:00.000Z" });
  if (closed) {
    const said = {
      url, number, merged: closed.merged, merged_at: closed.merged ? closed.at : "", first_review_at: closed.review ?? "",
      head_shas: closed.head, base_merges: closed.baseMerges ?? [],
    };
    if (closed.lines) add(fixture("pull_request_closed", 1, 2), closed.at, { ...said, ...closed.lines });
    else add(fixture("pull_request_closed", 1), closed.at, said);
  }
  if (scored) {
    const usage = { ...fixture("chapter_scored", 1).payload.usage as Record<string, unknown>, output_cost: scored, total_cost: scored };
    add(fixture("chapter_scored", 1), "2026-10-04T09:00:00Z", { chapter: 1, kind: "judge", evidence: [1], usage });
  }
  return events;
}

async function ship(t: Cockpit, token: string, id: string, events: WireEvent[]) {
  const response = await ingest(t, token, { session: id, events });
  expect(response.status).toBe(200);
}

async function metrics(t: Cockpit, days = WEEK) {
  return (await t.query(api.measure.metrics, { factory: "acme/widgets", days }))!;
}

describe("autonomy", () => {
  it("counts a merged pull request whose every commit the session made", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1"), sha("2")], closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [sha("1"), sha("2")] },
    }));

    expect(await metrics(t)).toMatchObject({ cut: false, opened: 1, merged: 1, autonomous: 1, autonomy: 1 });
  });

  it("is lost to a single human push", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")], closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [sha("1"), sha("f")] },
    }));

    expect(await metrics(t)).toMatchObject({ merged: 1, autonomous: 0, autonomy: 0 });
  });

  it("is not lost to a merge from the base branch", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")],
      closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [sha("1"), sha("b")], baseMerges: [sha("b")] },
    }));

    expect(await metrics(t)).toMatchObject({ merged: 1, autonomous: 1, autonomy: 1 });
  });

  it("is kept through review chapters that people's comments drove", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")], reviewed: [sha("2"), sha("3")],
      closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [sha("1"), sha("2"), sha("3")] },
    }));

    expect(await metrics(t)).toMatchObject({ merged: 1, autonomous: 1, autonomy: 1 });
  });

  it("is never a pull request the factory did not open itself", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    // A person opened it from the session's branch; the session pushed onto it, every commit its own.
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")], opened: false, closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [sha("1")] },
    }));

    expect(await metrics(t)).toMatchObject({ cut: false, opened: 0, merged: 1, autonomous: 0, autonomy: 0 });
  });

  it("is never a merged pull request whose commits were never read", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")], closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [] },
    }));

    expect(await metrics(t)).toMatchObject({ merged: 1, autonomous: 0, autonomy: 0 });
  });

  it("is a share of the merged ones only: one closed unmerged counts against nothing", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")], closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [sha("1")] },
    }));
    await ship(t, ingestToken, "a2", session("a2", 2, {
      commits: [sha("2")], closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [sha("2"), sha("f")] },
    }));
    await ship(t, ingestToken, "a3", session("a3", 3, {
      commits: [sha("3")], closed: { at: "2026-10-03T12:00:00Z", merged: false, head: [sha("3")] },
    }));
    await ship(t, ingestToken, "a4", session("a4", 4, { commits: [sha("4")] }));    // still open

    expect(await metrics(t)).toMatchObject({ cut: false, opened: 4, merged: 2, autonomous: 1, autonomy: 0.5 });
  });
});

describe("the period", () => {
  it("counts a pull request opened when it was opened, and merged when it merged", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    // Opened before the week, merged in it.
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")], openedAt: "2026-09-25T10:00:00.000Z",
      closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [sha("1")] },
    }));
    // Opened in the week, merged after it.
    await ship(t, ingestToken, "a2", session("a2", 2, {
      commits: [sha("2")], closed: { at: "2026-10-09T12:00:00Z", merged: true, head: [sha("2")] },
    }));

    expect(await metrics(t)).toMatchObject({ cut: false, opened: 1, merged: 1, autonomous: 1, autonomy: 1 });
  });

  it("has nothing to say of a period with no pull requests", async () => {
    const { t } = await localOf(fakeForge());
    expect(await metrics(t)).toMatchObject({ cut: false, opened: 0, merged: 0, autonomous: 0, autonomy: null });
  });

  it("hears the close of a pull request that arrives in a batch of its own, after the session finished", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    const events = session("a1", 1, {
      commits: [sha("1")], closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [sha("1")] },
    });
    await ship(t, ingestToken, "a1", events.slice(0, -1));
    expect(await metrics(t)).toMatchObject({ opened: 1, merged: 0, autonomy: null });

    await ship(t, ingestToken, "a1", events.slice(-1));
    expect(await metrics(t)).toMatchObject({ opened: 1, merged: 1, autonomous: 1 });
  });
});

const HOUR = 3600;

describe("PR cycle time", () => {
  it("is the median of each leg — kickoff to PR, PR to first review, first review to merge — and of the whole", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    // Kicked off at 09:00 each; opened after 1h, 2h and 3h; reviewed after 2h, 4h and never; merged 4h, 18h and — unreviewed — 45h on.
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")], openedAt: "2026-10-01T10:00:00.000Z",
      closed: { at: "2026-10-01T16:00:00Z", review: "2026-10-01T12:00:00Z", merged: true, head: [sha("1")] },
    }));
    await ship(t, ingestToken, "a2", session("a2", 2, {
      commits: [sha("2")], openedAt: "2026-10-01T11:00:00.000Z",
      closed: { at: "2026-10-02T09:00:00Z", review: "2026-10-01T15:00:00Z", merged: true, head: [sha("2")] },
    }));
    await ship(t, ingestToken, "a3", session("a3", 3, {
      commits: [sha("3")], openedAt: "2026-10-01T12:00:00.000Z",
      closed: { at: "2026-10-03T09:00:00Z", merged: true, head: [sha("3")] },
    }));
    // Closed unmerged: no cycle to time.
    await ship(t, ingestToken, "a4", session("a4", 4, {
      commits: [sha("4")], closed: { at: "2026-10-03T09:00:00Z", review: "2026-10-01T12:00:00Z", merged: false, head: [sha("4")] },
    }));

    expect((await metrics(t)).cycle).toEqual({
      toPr: { median: 2 * HOUR, prs: 3 },
      toReview: { median: 3 * HOUR, prs: 2 },
      toMerge: { median: 11 * HOUR, prs: 2 },
      total: { median: 24 * HOUR, prs: 3 },
    });
  });

  it("times a pull request the factory did not open only from its first review, and from its kickoff to its merge", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")], opened: false,
      closed: { at: "2026-10-01T16:00:00Z", review: "2026-10-01T12:00:00Z", merged: true, head: [sha("1")] },
    }));

    expect((await metrics(t)).cycle).toEqual({
      toPr: { median: null, prs: 0 },
      toReview: { median: null, prs: 0 },
      toMerge: { median: 4 * HOUR, prs: 1 },
      total: { median: 7 * HOUR, prs: 1 },
    });
  });
});

describe("cost per PR", () => {
  const merged = (number: number, lines?: Closed["lines"]): Closed =>
    ({ at: "2026-10-03T12:00:00Z", merged: true, head: [sha(String(number))], lines });

  it("is the median of what each merged pull request's session spent, by component, a session's spend split evenly between the pull requests it opened", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    // $1.50 over two calls.
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")], closed: merged(1),
      calls: [{ cost: 1, input: 0.25, output: 0.5, cacheRead: 0.25 }, { cost: 0.5, output: 0.25, cacheWrite: 0.25 }],
    }));
    // $3.
    await ship(t, ingestToken, "a2", session("a2", 2, {
      commits: [sha("2")], closed: merged(2), calls: [{ cost: 3, input: 0.5, output: 1.5, cacheRead: 1 }],
    }));
    // $4 for two pull requests — #30 first, then #3 — of which a quarter dollar its breakdown never priced: $2 each.
    await ship(t, ingestToken, "a3", session("a3", 3, {
      commits: [sha("3")], before: 30, closed: merged(3), calls: [{ cost: 4, input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 }],
    }));

    expect((await metrics(t)).cost).toMatchObject({
      prs: 3, median: 2,
      components: { input: 0.5, output: 1, cacheRead: 0.25, cacheWrite: 0.125, other: 0 },
    });
  });

  it("never holds what measuring the session cost", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")], closed: merged(1), calls: [{ cost: 1, output: 1 }], scored: 9,
    }));

    expect((await metrics(t)).cost).toMatchObject({ prs: 1, median: 1, components: { output: 1, other: 0 } });
  });

  it("is by size, at 100, 500 and 1,000 changed lines — and a close that never said its size is no size at all", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    const sized: [string, number, Closed["lines"], number][] = [
      ["s1", 1, { additions: 30, deletions: 10 }, 1],
      ["s2", 2, { additions: 99, deletions: 0 }, 3],
      ["m1", 3, { additions: 60, deletions: 40 }, 5],
      ["l1", 4, { additions: 500, deletions: 0 }, 8],
      ["x1", 5, { additions: 900, deletions: 100 }, 20],
      ["u1", 6, undefined, 7],
    ];
    for (const [id, number, lines, cost] of sized) {
      await ship(t, ingestToken, id, session(id, number, { commits: [sha(String(number))], closed: merged(number, lines), calls: [{ cost }] }));
    }

    expect((await metrics(t)).cost).toMatchObject({
      prs: 6,
      sizes: [
        { size: "S", prs: 2, median: 2 },
        { size: "M", prs: 1, median: 5 },
        { size: "L", prs: 1, median: 8 },
        { size: "XL", prs: 1, median: 20 },
      ],
      unsized: 1,
    });
  });

  it("has no median when nothing merged", async () => {
    const { t } = await localOf(fakeForge());
    expect((await metrics(t)).cost).toMatchObject({
      prs: 0, median: null, components: { input: null, output: null, cacheRead: null, cacheWrite: null, other: null },
      sizes: [
        { size: "S", prs: 0, median: null }, { size: "M", prs: 0, median: null },
        { size: "L", prs: 0, median: null }, { size: "XL", prs: 0, median: null },
      ],
      unsized: 0,
    });
  });
});

describe("the most expensive pull requests", () => {
  it("are the five merged ones that cost the most, dearest first, each with the session behind it", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    const costs = [3, 9, 1, 12, 5, 7, 2];
    for (const [index, cost] of costs.entries()) {
      const number = index + 1;
      await ship(t, ingestToken, `a${number}`, session(`a${number}`, number, {
        commits: [sha(String(number))], calls: [{ cost }],
        closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [sha(String(number))], lines: { additions: 100 * number, deletions: 0 } },
      }));
    }
    // Closed unmerged, and dearer than any: not among them.
    await ship(t, ingestToken, "b1", session("b1", 20, {
      commits: [sha("b")], calls: [{ cost: 50 }], closed: { at: "2026-10-03T12:00:00Z", merged: false, head: [sha("b")] },
    }));

    const { expensive } = await metrics(t);
    expect(expensive.map(({ session, cost }) => [session, cost])).toEqual([["a4", 12], ["a2", 9], ["a6", 7], ["a5", 5], ["a1", 3]]);
    expect(expensive[0]).toEqual({
      session: "a4", url: "https://github.com/acme/widgets/pull/4", cost: 12, lines: 400, size: "M", autonomous: true,
    });
  });

  it("are a session's share when it opened more than one", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ship(t, ingestToken, "a1", session("a1", 1, {
      commits: [sha("1")], before: 9, calls: [{ cost: 6 }], closed: { at: "2026-10-03T12:00:00Z", merged: true, head: [sha("1")] },
    }));

    expect((await metrics(t)).expensive).toEqual([
      { session: "a1", url: "https://github.com/acme/widgets/pull/1", cost: 3, lines: null, size: null, autonomous: true },
    ]);
  });
});

describe("chapters by trigger", () => {
  it("counts the chapters that started in the period by what started them: a prompt, an issue, a pull request's review", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    // An issue's chapter on Oct 1, then a review round on Oct 2.
    await ship(t, ingestToken, "a1", session("a1", 1, { commits: [sha("1")], reviewed: [sha("2")] }));
    await ship(t, ingestToken, "a2", session("a2", 2, { commits: [sha("3")], input: "prompt" }));
    // Kicked off before the week: its issue's chapter is not the week's, though the session ended in it.
    await ship(t, ingestToken, "a3", session("a3", 3, { commits: [sha("4")], kickoff: "2026-09-20T09:00:00.000Z" }));

    expect((await metrics(t)).chapters).toEqual([
      { trigger: "prompt", chapters: 1 }, { trigger: "issue", chapters: 1 }, { trigger: "pr", chapters: 1 },
    ]);
  });

  it("has every trigger to count, at none, in a period no chapter started in", async () => {
    const { t } = await localOf(fakeForge());
    expect((await metrics(t)).chapters).toEqual([
      { trigger: "prompt", chapters: 0 }, { trigger: "issue", chapters: 0 }, { trigger: "pr", chapters: 0 },
    ]);
  });

  /** `t` as a cockpit before chapters were kept left it: the sessions, and no chapter of any. */
  async function older(t: Cockpit) {
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("chapters").collect()) await ctx.db.delete(row._id);
      for (const record of await ctx.db.query("sessions").collect()) await ctx.db.patch(record._id, { chaptered: undefined });
    });
  }

  it("counts a session an older cockpit stored once the backfill comes to it", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ship(t, ingestToken, "a1", session("a1", 1, { commits: [sha("1")], reviewed: [sha("2")] }));
    await older(t);
    expect((await metrics(t)).chapters).toContainEqual({ trigger: "issue", chapters: 0 });

    await t.mutation(internal.chapters.backfill, {});
    expect((await metrics(t)).chapters).toEqual([
      { trigger: "prompt", chapters: 0 }, { trigger: "issue", chapters: 1 }, { trigger: "pr", chapters: 1 },
    ]);
  });

  it("counts a session an older cockpit stored when its next batch comes before the backfill does", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    const events = session("a1", 1, { commits: [sha("1")], reviewed: [sha("2")] });
    await ship(t, ingestToken, "a1", events.slice(0, 3));
    await older(t);

    await ship(t, ingestToken, "a1", events.slice(3));
    expect((await metrics(t)).chapters).toEqual([
      { trigger: "prompt", chapters: 0 }, { trigger: "issue", chapters: 1 }, { trigger: "pr", chapters: 1 },
    ]);
  });
});

describe("the rows' readers", () => {
  it.each(Object.keys(corpus))("fold %s if they fold its kind at all", (name) => {
    const { kind, v: version } = corpus[name];
    for (const [where, folded] of [["model/pulls.ts", pullVersions(kind)], ["model/chapters.ts", chapterVersions(kind)],
                                ["model/scores.ts", scoreVersions(kind)]] as const) {
      if (folded.length) expect(folded, `${kind} v${version} has a reader but no fold in ${where}`).toContain(version);
    }
  });
});
