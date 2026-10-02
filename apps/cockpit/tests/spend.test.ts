import { describe, expect, it } from "vitest";
import { advance, EMPTY_SUMMARY } from "../convex/model/session";
import { spentIn } from "../convex/model/spend";
import { corpus, recorded } from "./helpers";

// Spend is read from `usage` events by its own reader (`model/spend.ts`), apart
// from the session fold's — so every `usage` version ever written must be read
// by it too, or a new one would ship spending nothing.

describe("spend, over the golden corpus", () => {
  const versions = Object.entries(corpus).filter(([path]) => path.startsWith("usage/"));

  it.each(versions)("reads what %s cost, and the tokens it took", (_, event) => {
    const payload = event.payload as { cost: number; tokens: number };
    const stored = { ...event, payload: JSON.stringify(event.payload) };

    expect(spentIn([stored], EMPTY_SUMMARY, 0)).toEqual([
      { at: Date.parse("2026-09-29T12:00:00.000Z"), workflow: "", station: "", stationName: "", person: "",
        cost: payload.cost, tokens: payload.tokens },
    ]);
  });

  it("has a usage version to read", () => {
    expect(versions.length).toBeGreaterThan(0);
  });
});

// Each agent call is charged to what was running when it was made: the
// workflow of its chapter, the station that ran it, the person who triggered
// it — so a session that went on into a second workflow is spent in both.

describe("spend, charged to what made each call", () => {
  const { events } = recorded["issue-then-two-reviews"];
  const stored = events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));
  const quarter = Date.parse("2026-09-30T17:15:00.000Z");
  const station = { station: "st_93db23f2e84f", stationName: "schurik@mbp:widgets", person: "" };

  it("charges each chapter's calls to its own workflow", () => {
    const spent = spentIn(stored, EMPTY_SUMMARY, 0);

    // issue: scout .021 + planner .102, 0, .041 + builder .135 + reviewer .066 + documenter .018;
    // pr-review: a builder .04 in each of its two chapters.
    expect(spent).toEqual([
      { at: quarter, workflow: "issue", ...station, cost: expect.closeTo(0.383, 9), tokens: 23_100 },
      { at: quarter, workflow: "pr-review", ...station, cost: expect.closeTo(0.08, 9), tokens: 4_000 },
    ]);
  });

  it("charges a batch's calls to what the session was running before it, when nothing in it starts anything", () => {
    const split = stored.findIndex((event) => event.seq > 190);
    const before = advance(EMPTY_SUMMARY, stored.slice(0, split));

    expect(spentIn(stored.slice(split), before, 0)).toEqual([
      { at: quarter, workflow: "pr-review", ...station, cost: expect.closeTo(0.08, 9), tokens: 4_000 },
    ]);
  });

  it("charges a call to whoever triggered the run, apart from the station that ran it", () => {
    const started = { ...corpus["session_started/v2.json"], seq: 1 };
    started.payload = { ...started.payload, triggered_by: "sam", station_id: "st_alex", station_name: "alex@mbp:widgets" };
    const usage = { ...corpus["usage/v1.json"], seq: 2 };

    expect(spentIn([started, usage].map((event) => ({ ...event, payload: JSON.stringify(event.payload) })), EMPTY_SUMMARY, 0))
      .toEqual([{ at: Date.parse("2026-09-29T12:00:00.000Z"), workflow: "ship", station: "st_alex",
                  stationName: "alex@mbp:widgets", person: "sam", cost: 0.0185, tokens: 1200 }]);
  });
});
