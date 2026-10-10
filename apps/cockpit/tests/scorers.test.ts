import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { type Cockpit, factory, fixture, ingest, signIn, type WireEvent } from "./helpers";
import { fakeForge, localOf, post, teamOf } from "./station";

// The Measure tab's Scorers view (#190): each scorer the factory's own
// self-description names, over the factory's last 30 sessions — the same
// sessions for every scorer — with the sessions counted toward its threshold
// (the last `of_last` it judged, its own `improve_after:` where it has one)
// and the failing ones among them, each with its first cited event. Built from
// the `chapter_scored` a station appends, never from the forge (ADR 0006).

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const DESCRIPTION = JSON.parse((import.meta.glob("../../../tests/golden/self-description/v3.json",
  { eager: true, query: "?raw", import: "default" }) as Record<string, string>)["../../../tests/golden/self-description/v3.json"]) as
  { scorers: { name: string; sample_rate: number }[] };
const CI = { id: "st_ci0001", name: "runner@fv-az123:widgets", kind: "ci" };

/**
 * The golden format-3 description: `corrections` (code, every chapter of
 * `issue`, 3 failing of the last 10) and `reviewer-scope` (a judge of 20%,
 * its own 2 of the last 5) — with `edit` applied to it first.
 */
async function describedAs(t: Cockpit, token: string, edit: (description: typeof DESCRIPTION) => void = () => {}) {
  const description = structuredClone(DESCRIPTION);
  edit(description);
  expect((await post(t, "/describe", token, { station: CI, description })).status).toBe(200);
}

/** A class each scorer gave the session's chapter; a scorer absent did not judge it. */
type Scored = Partial<Record<"corrections" | "reviewer-scope", string>>;
const FAILING: Record<string, boolean> = { above: true, within: false, plan_only: true, checked_both: false };

/**
 * One finished session of `issue`: a gate failed at seq 3 in its plan phase,
 * and then each scorer in `scored` scored its chapter — the late events a
 * station appends after `session_finished`.
 */
function session(id: string, scored: Scored = {}, { chapter = 1 }: { chapter?: number } = {}): WireEvent[] {
  const events: WireEvent[] = [];
  const add = (event: WireEvent, payload: Record<string, unknown> = {}) => {
    events.push({ ...event, seq: events.length + 1, payload: { ...event.payload, ...payload } });
  };
  add(fixture("session_started", 1, 3), { adw_id: id });
  add(fixture("workflow_started", 1, 2), { workflow: "issue", chapter: 1, input: "issue" });
  add(fixture("gate_result", 1), { phase_id: `${id}_03_plan` });
  add(fixture("session_finished", 1), { status: "success" });
  for (const [scorer, klass] of Object.entries(scored)) {
    add(fixture("chapter_scored", 1), { chapter, scorer, class: klass, failing: FAILING[klass], evidence: [3, 1] });
  }
  return events;
}

async function ship(t: Cockpit, token: string, id: string, events: WireEvent[]) {
  expect((await ingest(t, token, { session: id, events })).status).toBe(200);
}

async function scorers(t: Cockpit) {
  return (await t.query(api.measure.scorers, { factory: "acme/widgets" }))!;
}

async function scorer(t: Cockpit, name: string) {
  return (await scorers(t)).scorers.find((each) => each.name === name)!;
}

describe("the scorers", () => {
  it("are none to show before the factory described itself", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await ship(t, ingestToken, "a1", session("a1", { corrections: "above" }));

    expect(await scorers(t)).toEqual({ described: false, sessions: 0, scorers: [] });
  });

  it("are the self-description's, with the threshold it resolved for each — a scorer's own override included", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await describedAs(t, ingestToken);

    const page = await scorers(t);
    expect(page).toMatchObject({ described: true, sessions: 0 });
    expect(page.scorers.map(({ name, kind, workflow, focus, sampleRate, threshold }) => ({ name, kind, workflow, focus, sampleRate, threshold })))
      .toEqual(expect.arrayContaining([
        { name: "corrections", kind: "code", workflow: "issue", focus: "builder", sampleRate: 1, threshold: { failures: 3, ofLast: 10 } },
        { name: "reviewer-scope", kind: "judge", workflow: "issue", focus: "reviewer", sampleRate: 0.2, threshold: { failures: 2, ofLast: 5 } },
      ]));
    expect(page.scorers[0]).toMatchObject({ strip: [], counted: [], failing: [] });
  });

  it("are the factory's however the page spells it, and nothing for someone who may not read it", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    forge.person("eve");
    await describedAs(t, await factory(t, "acme/widgets"));

    const alex = await signIn(t, forge, "alex");
    expect(await t.query(api.measure.scorers, { factory: "Acme/Widgets", signIn: alex })).toMatchObject({ described: true });
    expect(await t.query(api.measure.scorers, { factory: "acme/widgets", signIn: await signIn(t, forge, "eve") })).toBeNull();
    expect(await t.query(api.measure.scorers, { factory: "acme/widgets" })).toBeNull();
  });
});

describe("the session strip", () => {
  it("is the factory's last sessions, oldest first, the same for every scorer — a low mark where one did not judge", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await describedAs(t, ingestToken);
    await ship(t, ingestToken, "a1", session("a1", { corrections: "above" }));
    await ship(t, ingestToken, "a2", session("a2"));
    await ship(t, ingestToken, "a3", session("a3", { corrections: "within", "reviewer-scope": "plan_only" }));

    expect((await scorers(t)).sessions).toBe(3);
    expect((await scorer(t, "corrections")).strip).toEqual([
      { session: "a1", judged: true, failing: true, counted: true },
      { session: "a2", judged: false, failing: false, counted: false },
      { session: "a3", judged: true, failing: false, counted: true },
    ]);
    expect((await scorer(t, "reviewer-scope")).strip.map((mark) => [mark.session, mark.judged])).toEqual([["a1", false], ["a2", false], ["a3", true]]);
  });

  it("spans the last 30 sessions, while the counted window reaches as far back as the last ones judged", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await describedAs(t, ingestToken);
    await ship(t, ingestToken, "old1", session("old1", { corrections: "above" }));
    await ship(t, ingestToken, "old2", session("old2", { corrections: "above" }));
    for (let n = 1; n <= 30; n += 1) await ship(t, ingestToken, `s${n}`, session(`s${n}`, n > 25 ? { corrections: "within" } : {}));

    const corrections = await scorer(t, "corrections");
    expect(corrections.strip).toHaveLength(30);
    expect(corrections.strip[0].session).toBe("s1");
    expect(corrections.counted).toEqual([
      { session: "old1", failing: true }, { session: "old2", failing: true },
      ...["s26", "s27", "s28", "s29", "s30"].map((each) => ({ session: each, failing: false })),
    ]);
    expect(corrections.failures).toBe(2);
  });
});

describe("the counted window", () => {
  it("is the last of_last sessions a scorer judged, by its own improve_after: when it has one", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await describedAs(t, ingestToken);
    const ids = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    for (const id of ids) await ship(t, ingestToken, id, session(id, { corrections: "within", "reviewer-scope": id === "a1" ? "plan_only" : "checked_both" }));

    // reviewer-scope counts its last 5 — a1, failing, is older than that; corrections counts its last 10.
    const reviewer = await scorer(t, "reviewer-scope");
    expect(reviewer.counted.map((each) => each.session)).toEqual(["a3", "a4", "a5", "a6", "a7"]);
    expect(reviewer.strip.slice(0, 2)).toEqual([
      { session: "a1", judged: true, failing: true, counted: false }, { session: "a2", judged: true, failing: false, counted: false },
    ]);
    expect(reviewer).toMatchObject({ failures: 0, shares: { before: 0.5, counted: 0 } });
    expect((await scorer(t, "corrections")).counted.map((each) => each.session)).toEqual(ids);
  });

  it("is whatever threshold the self-description resolved for the scorer", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await describedAs(t, ingestToken, (description) => {
      const raw = description as unknown as { scorers: { improve_after: unknown }[] };
      raw.scorers[0].improve_after = { failures: 1, of_last: 2 };
    });
    for (const id of ["a1", "a2", "a3"]) await ship(t, ingestToken, id, session(id, { corrections: "above" }));

    expect(await scorer(t, "corrections")).toMatchObject({ threshold: { failures: 1, ofLast: 2 }, failures: 2 });
    expect((await scorer(t, "corrections")).counted.map((each) => each.session)).toEqual(["a2", "a3"]);
  });

  it("counts a session failing when any chapter it scored failed, the latest score of each chapter standing", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await describedAs(t, ingestToken);
    // Scored failing, then scored again — `asf score` after a fix to the scorer — not failing.
    const events = session("a1", { corrections: "above" });
    events.push({ ...fixture("chapter_scored", events.length + 1), payload: { ...fixture("chapter_scored", 0).payload, chapter: 1, scorer: "corrections", class: "within", failing: false, evidence: [] } });
    await ship(t, ingestToken, "a1", events);
    // A second chapter of a2's, failing, beside a first one passing.
    const two = session("a2", { corrections: "within" });
    two.push({ ...fixture("chapter_scored", two.length + 1), payload: { ...fixture("chapter_scored", 0).payload, chapter: 2, scorer: "corrections", class: "above", failing: true, evidence: [3] } });
    await ship(t, ingestToken, "a2", two);

    expect((await scorer(t, "corrections")).counted).toEqual([{ session: "a1", failing: false }, { session: "a2", failing: true }]);
  });
});

describe("the failing counted sessions", () => {
  it("are listed newest first, each with its class, its chapter, and the first event it cites", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await describedAs(t, ingestToken);
    await ship(t, ingestToken, "a1", session("a1", { corrections: "above" }));
    await ship(t, ingestToken, "a2", session("a2", { corrections: "within" }));
    await ship(t, ingestToken, "a3", session("a3", { corrections: "above" }));

    expect((await scorer(t, "corrections")).failing).toEqual([
      { session: "a3", chapter: 1, class: "above", cite: { seq: 3, detail: expect.stringMatching(/^gate artifacts_exist failed/), phaseId: "a3_03_plan" } },
      { session: "a1", chapter: 1, class: "above", cite: { seq: 3, detail: expect.stringMatching(/^gate artifacts_exist failed/), phaseId: "a1_03_plan" } },
    ]);
  });

  it("cite nothing when the score cited nothing", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await describedAs(t, ingestToken);
    const events = session("a1");
    events.push({ ...fixture("chapter_scored", events.length + 1), payload: { ...fixture("chapter_scored", 0).payload, chapter: 1, scorer: "corrections", class: "above", failing: true, evidence: [] } });
    await ship(t, ingestToken, "a1", events);

    expect((await scorer(t, "corrections")).failing).toEqual([{ session: "a1", chapter: 1, class: "above", cite: null }]);
  });
});

describe("the order", () => {
  it("puts the scorer nearest its threshold first, and an inactive one last", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await describedAs(t, ingestToken);
    // One failing each: reviewer-scope is one short of its 2, corrections two short of its 3.
    await ship(t, ingestToken, "a1", session("a1", { corrections: "above", "reviewer-scope": "plan_only" }));
    expect((await scorers(t)).scorers.map((each) => each.name)).toEqual(["reviewer-scope", "corrections"]);

    await describedAs(t, ingestToken, (description) => { description.scorers[1].sample_rate = 0; });
    expect((await scorers(t)).scorers.map((each) => [each.name, each.inactive])).toEqual([["corrections", false], ["reviewer-scope", true]]);
  });
});

describe("a session an older cockpit stored", () => {
  /** `t` as a cockpit before scores were kept left it: the sessions, and no score row of any. */
  async function older(t: Cockpit) {
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("scores").collect()) await ctx.db.delete(row._id);
      for (const record of await ctx.db.query("sessions").collect()) await ctx.db.patch(record._id, { scored: undefined });
    });
  }

  it("is scored once the backfill comes to it", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await describedAs(t, ingestToken);
    await ship(t, ingestToken, "a1", session("a1", { corrections: "above" }));
    await older(t);
    expect((await scorer(t, "corrections")).counted).toEqual([]);

    await t.mutation(internal.scores.backfill, {});
    expect((await scorer(t, "corrections")).counted).toEqual([{ session: "a1", failing: true }]);
  });

  it("is scored from its first event when its next batch comes before the backfill does", async () => {
    const { t, ingestToken } = await localOf(fakeForge());
    await describedAs(t, ingestToken);
    const events = session("a1", { corrections: "above", "reviewer-scope": "plan_only" });
    await ship(t, ingestToken, "a1", events.slice(0, -1));
    await older(t);

    await ship(t, ingestToken, "a1", events.slice(-1));
    expect((await scorer(t, "corrections")).counted).toEqual([{ session: "a1", failing: true }]);
    expect((await scorer(t, "reviewer-scope")).counted).toEqual([{ session: "a1", failing: true }]);
  });
});
