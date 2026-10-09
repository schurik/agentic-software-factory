import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { lastDays } from "../convex/model/period";
import { type Cockpit, fixture, ingest, type WireEvent } from "./helpers";
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
}

/**
 * One session's events, in order: it starts on Oct 1, commits `commits` in
 * its first chapter, opens pull request #`number` (unless `opened` is false:
 * it found one open), commits `reviewed` in a review chapter driven by a
 * person's comments, finishes, and — later — hears how the pull request closed.
 */
function session(id: string, number: number, { commits, reviewed = [], opened = true, openedAt = "2026-10-01T10:00:00.000Z", closed }: {
  commits: string[]; reviewed?: string[]; opened?: boolean; openedAt?: string; closed?: Closed;
}): WireEvent[] {
  const url = `https://github.com/acme/widgets/pull/${number}`;
  const events: WireEvent[] = [];
  const add = (event: WireEvent, ts: string, payload: Record<string, unknown> = {}) => {
    events.push({ ...event, seq: events.length + 1, ts, payload: { ...event.payload, ...payload } });
  };
  add(fixture("session_started", 1, 3), "2026-10-01T09:00:00.000Z", { adw_id: id, started_at: "2026-10-01T09:00:00.000Z" });
  add(fixture("workflow_started", 1, 2), "2026-10-01T09:00:01.000Z", { workflow: "issue", chapter: 1, input: "issue" });
  for (const each of commits) add(fixture("committed", 1), "2026-10-01T09:30:00.000Z", { sha: each });
  if (opened) add(fixture("pull_request_opened", 1), openedAt, { url, number });
  else add(fixture("provenance_recorded", 1, 2), openedAt, { pr_url: url });
  if (reviewed.length) {
    add(fixture("workflow_started", 1, 2), "2026-10-02T09:00:00.000Z", { workflow: "pr-review", chapter: 2, input: "pr" });
    for (const each of reviewed) add(fixture("committed", 1), "2026-10-02T09:30:00.000Z", { sha: each });
  }
  add(fixture("session_finished", 1), "2026-10-02T10:00:00.000Z", { status: "success", ended_at: "2026-10-02T10:00:00.000Z" });
  if (closed) {
    add(fixture("pull_request_closed", 1), closed.at, {
      url, number, merged: closed.merged, merged_at: closed.merged ? closed.at : "",
      head_shas: closed.head, base_merges: closed.baseMerges ?? [],
    });
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

    expect(await metrics(t)).toEqual({ cut: false, opened: 1, merged: 1, autonomous: 1, autonomy: 1 });
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

    expect(await metrics(t)).toEqual({ cut: false, opened: 0, merged: 1, autonomous: 0, autonomy: 0 });
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

    expect(await metrics(t)).toEqual({ cut: false, opened: 4, merged: 2, autonomous: 1, autonomy: 0.5 });
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

    expect(await metrics(t)).toEqual({ cut: false, opened: 1, merged: 1, autonomous: 1, autonomy: 1 });
  });

  it("has nothing to say of a period with no pull requests", async () => {
    const { t } = await localOf(fakeForge());
    expect(await metrics(t)).toEqual({ cut: false, opened: 0, merged: 0, autonomous: 0, autonomy: null });
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
