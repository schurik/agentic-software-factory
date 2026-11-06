import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { LIVE_FOR, NUDGE_FOR } from "../convex/model/webhook";
import { type FakeForge, fakeForge } from "./forge";
import { type Cockpit, factory, signIn } from "./helpers";
import { approved, json, nudged, poll, REPORT, teamOf } from "./station";

// A nudge (ADR 0008): a webhook delivery about a work item, kept as one row
// per item for about ten minutes and handed to every online station that runs
// the watcher it concerns, in the answer to its command poll. A hint, never
// the record — the factory's end is tests/test_asf_nudges.py.

const EVERY = { ...REPORT, watchers: ["issues", "answers", "prs"] };
const OTHER = { id: "st_0b1e55", name: "sam@desk:widgets", kind: "local" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function watched(forge: FakeForge) {
  const t = await teamOf(forge, { alex: "write" });
  const ingestToken = await factory(t, "acme/widgets");
  const alex = await signIn(t, forge, "alex");
  return { t, ingestToken, alex, token: await approved(t, ingestToken, alex) };
}

async function labelled(t: Cockpit, forge: FakeForge, number: number, action = "labeled", event = "issues") {
  const delivery = await forge.delivery(event, {
    action, issue: { number }, repository: { full_name: "acme/widgets" },
  });
  const response = await t.fetch("/forge/webhook", { method: "POST", headers: delivery.headers, body: delivery.body });
  expect(response.status).toBe(202);
}

async function rows(t: Cockpit) {
  return await t.run(async (ctx) => await ctx.db.query("nudges").collect());
}

describe("a nudge", () => {
  it("is one row per item, however many deliveries were about it", async () => {
    const forge = fakeForge();
    const { t, token } = await watched(forge);

    for (let at = 0; at < 30; at++) {
      await labelled(t, forge, 42, "created", "issue_comment");
      vi.advanceTimersByTime(1_000);
    }
    await labelled(t, forge, 43);

    expect((await rows(t)).map(({ kind, number }) => [kind, number]).sort()).toEqual([["answers", 42], ["issues", 43]]);
    expect((await nudged(t, token, 0, EVERY))!.items).toHaveLength(2);
  });

  it("is handed only once to a station that keeps its cursor, and again when the item moves again", async () => {
    const forge = fakeForge();
    const { t, token } = await watched(forge);
    await labelled(t, forge, 42);

    const first = (await nudged(t, token, 0, EVERY))!;
    const again = (await nudged(t, token, first.after, EVERY))!;
    vi.advanceTimersByTime(5_000);
    await labelled(t, forge, 42);
    const moved = (await nudged(t, token, again.after, EVERY))!;

    expect(first.items).toEqual([{ kind: "issues", number: 42 }]);
    expect(again.items).toEqual([]);
    expect(again.after).toBe(first.after);
    expect(moved.items).toEqual([{ kind: "issues", number: 42 }]);
    expect(moved.after).toBeGreaterThan(first.after);
  });

  it("goes only to a station that runs the watcher it concerns", async () => {
    const forge = fakeForge();
    const { t, token } = await watched(forge);
    await labelled(t, forge, 42);

    expect((await nudged(t, token, 0, { ...REPORT, watchers: ["answers", "prs"] }))!.items).toEqual([]);
    expect((await nudged(t, token, 0, { ...REPORT, watchers: ["issues"] }))!.items).toEqual([{ kind: "issues", number: 42 }]);
  });

  it("goes to every station of the factory that runs that watcher: the claim picks one, not the cockpit", async () => {
    const forge = fakeForge();
    const { t, ingestToken, alex, token } = await watched(forge);
    const other = await approved(t, ingestToken, alex, OTHER);
    await labelled(t, forge, 42);

    const mine = (await nudged(t, token, 0, EVERY))!.items;
    const theirs = (await json(await poll(t, other, { report: EVERY, nudged_after: 0 }, OTHER))).nudges as { items: unknown[] };

    expect(mine).toEqual([{ kind: "issues", number: 42 }]);
    expect(theirs.items).toEqual(mine);
  });

  it("is not a command, and never rides a run's own poll or a station from before nudges", async () => {
    const forge = fakeForge();
    const { t, token } = await watched(forge);
    await labelled(t, forge, 42);

    const older = await json(await poll(t, token, { report: EVERY }));
    const run = await json(await poll(t, token, { report: EVERY, session: "5c0075aa", nudged_after: 0 }));

    expect(older).toEqual({ commands: [] });
    expect(run).toEqual({ commands: [] });
  });

  it("expires after about ten minutes, by the cron, whether or not anyone collected it", async () => {
    const forge = fakeForge();
    const { t, token } = await watched(forge);
    await labelled(t, forge, 42);
    vi.advanceTimersByTime(NUDGE_FOR - 1_000);
    await labelled(t, forge, 43);

    vi.advanceTimersByTime(2_000);
    await t.mutation(internal.nudges.expire, {});

    expect((await rows(t)).map(({ number }) => number)).toEqual([43]);
    expect((await nudged(t, token, 0, EVERY))!.items).toEqual([{ kind: "issues", number: 43 }]);
  });
});

describe("whether nudges are live", () => {
  it("is so while the App has a webhook secret and a delivery arrived lately, and not after", async () => {
    const forge = fakeForge();
    const { t, token } = await watched(forge);

    expect((await nudged(t, token, 0, EVERY))!.live).toBe(false);       // nothing delivered yet
    await labelled(t, forge, 42, "opened");                                // any signed delivery counts
    expect((await nudged(t, token, 0, EVERY))!.live).toBe(true);
    vi.advanceTimersByTime(LIVE_FOR + 1_000);
    expect((await nudged(t, token, 0, EVERY))!.live).toBe(false);
  });

  it("is never so for a delivery the App did not sign", async () => {
    const forge = fakeForge();
    const { t, token } = await watched(forge);

    const forged = await forge.delivery("issues", { action: "labeled", issue: { number: 42 }, repository: { full_name: "acme/widgets" } },
      "not-the-secret");
    await t.fetch("/forge/webhook", { method: "POST", headers: forged.headers, body: forged.body });

    expect(await nudged(t, token, 0, EVERY)).toEqual({ live: false, after: 0, items: [] });
    expect(await rows(t)).toEqual([]);
  });
});
