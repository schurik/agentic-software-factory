import { describe, expect, it } from "vitest";
import { CI, facetsOf, find, type Known, matches } from "../convex/model/filter";
import { EMPTY_SUMMARY, type Summary } from "../convex/model/session";

// Finding a session (spec #40): the Sessions pages' filters — workflow,
// station, person (who triggered it), status and period — each narrow the
// list to the sessions it names, and the choices each offers are read off
// the sessions there are. The Sessions page's one search box (#116) is a
// filter too: over a session's title, its issue or pull request, and its id.

const DAY = 86400_000;
const OCT_1 = Date.parse("2026-10-01T00:00:00.000Z");

function known(fields: Partial<Summary> = {}, activity = OCT_1, session = "a9f259f0"): Known {
  return {
    session, activity,
    summary: {
      ...EMPTY_SUMMARY, status: "success", workflows: ["issue"], triggeredBy: "alex",
      stationId: "st_alex", stationName: "alex@mbp:widgets", stationKind: "local",
      startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z", lastEventAt: "2026-10-01T11:00:00.000Z",
      ...fields,
    },
  };
}

describe("a filter", () => {
  it("lets every session through when it names nothing", () => {
    expect(matches(known(), {})).toBe(true);
  });

  it("by workflow keeps the sessions that passed through it, in any chapter", () => {
    const reviewed = known({ workflows: ["issue", "pr-review"] });

    expect(matches(reviewed, { workflow: "pr-review" })).toBe(true);
    expect(matches(reviewed, { workflow: "issue" })).toBe(true);
    expect(matches(known(), { workflow: "pr-review" })).toBe(false);
  });

  it("by person keeps the sessions they triggered, in whatever case the forge spelled their login", () => {
    expect(matches(known({ triggeredBy: "Alex" }), { person: "alex" })).toBe(true);
    expect(matches(known({ triggeredBy: "sam" }), { person: "alex" })).toBe(false);
    // Who ran the machine, wrote the issue or was assigned it is not who triggered the run.
    expect(matches(known({ triggeredBy: "sam", issueAuthor: "alex", issueAssignees: ["alex"] }), { person: "alex" })).toBe(false);
    expect(matches(known({ triggeredBy: "" }), { person: "alex" })).toBe(false);
  });

  it("by station keeps the sessions it holds", () => {
    expect(matches(known(), { station: "st_alex" })).toBe(true);
    expect(matches(known({ stationId: "st_sam", stationName: "sam@desk:widgets" }), { station: "st_alex" })).toBe(false);
  });

  it("by CI keeps every CI job's sessions, as the Stations tab collapses them into one entry", () => {
    const job = (id: string) => known({ stationId: id, stationName: `runner@${id}:widgets`, stationKind: "ci" });

    expect(matches(job("st_ci0001"), { station: CI })).toBe(true);
    expect(matches(job("st_ci0002"), { station: CI })).toBe(true);
    expect(matches(known(), { station: CI })).toBe(false);
  });

  it("by status keeps the sessions in it", () => {
    expect(matches(known({ status: "waiting" }), { status: "waiting" })).toBe(true);
    expect(matches(known({ status: "running" }), { status: "waiting" })).toBe(false);
    expect(matches(known({ status: "fail" }), { status: "success" })).toBe(false);
  });

  describe("by period", () => {
    const day = (start: number) => ({ period: { from: start, to: start + DAY } });

    it("keeps a session that was alive at any moment of it", () => {
      expect(matches(known(), day(OCT_1))).toBe(true);
      expect(matches(known(), day(OCT_1 + DAY))).toBe(false);
      expect(matches(known(), day(OCT_1 - DAY))).toBe(false);
    });

    it("keeps a session that ran over midnight in both days", () => {
      const late = known({ startedAt: "2026-09-30T23:00:00.000Z", endedAt: "2026-10-01T01:00:00.000Z" });

      expect(matches(late, day(OCT_1 - DAY))).toBe(true);
      expect(matches(late, day(OCT_1))).toBe(true);
    });

    it("keeps a live or suspended session in every period since it started, however long ago it last moved", () => {
      for (const status of ["running", "waiting"]) {
        const open = known({ status, startedAt: "2026-09-01T10:00:00.000Z", endedAt: "", lastEventAt: "2026-09-01T10:05:00.000Z" });

        expect(matches(open, day(OCT_1))).toBe(true);
        expect(matches(open, day(Date.parse("2026-08-31T00:00:00.000Z")))).toBe(false);
      }
    });

    it("ends a finished session that never said when at its last event, else when the cockpit last heard of it", () => {
      const quiet = known({ endedAt: "", lastEventAt: "2026-10-02T10:00:00.000Z" });
      expect(matches(quiet, day(OCT_1 + DAY))).toBe(true);

      const unheard = known({ startedAt: "", endedAt: "", lastEventAt: "" }, OCT_1 + 2 * DAY + 3600_000);
      expect(matches(unheard, day(OCT_1 + 2 * DAY))).toBe(true);
      expect(matches(unheard, day(OCT_1))).toBe(false);
    });
  });
});

describe("a search", () => {
  const issue = known({ request: "#42 Resolve relative due dates via the meeting date", issueUrl: "https://github.com/acme/widgets/issues/42" });
  const reviewed = known({ ...issue.summary, prUrl: "https://github.com/acme/widgets/pull/57" }, OCT_1, "c41e7b02");
  const prompt = known({ request: "Tidy the README's install section" }, OCT_1, "7d2f90aa");

  it("lets every session through when it is empty or blank", () => {
    expect(matches(prompt, { search: "" })).toBe(true);
    expect(matches(prompt, { search: "   " })).toBe(true);
  });

  it("finds a session by any part of its title, whatever the case", () => {
    expect(matches(issue, { search: "due dates" })).toBe(true);
    expect(matches(prompt, { search: "readme" })).toBe(true);
    expect(matches(prompt, { search: "due dates" })).toBe(false);
  });

  it("finds a session by its issue or its pull request, with or without the #", () => {
    for (const search of ["#42", "42", " #42 "]) expect(matches(issue, { search })).toBe(true);
    for (const search of ["#57", "57", "PR #57", "pr 57"]) expect(matches(reviewed, { search })).toBe(true);
    expect(matches(issue, { search: "#57" })).toBe(false);
  });

  it("takes a reference as a whole number, not as a part of a longer one", () => {
    const later = known({ request: "#421 Another issue", issueUrl: "https://github.com/acme/widgets/issues/421" });

    expect(matches(later, { search: "#42" })).toBe(false);
    expect(matches(later, { search: "#421" })).toBe(true);
  });

  it("finds a session by its id, or any part of it a person remembers", () => {
    expect(matches(reviewed, { search: "c41e7b02" })).toBe(true);
    expect(matches(reviewed, { search: "C41E" })).toBe(true);
    expect(matches(reviewed, { search: "7b02" })).toBe(true);
    expect(matches(reviewed, { search: "7b03" })).toBe(false);
  });
});

describe("the choices a filter offers", () => {
  // Most recently active first, as the list reads them.
  const sessions = [
    known({ workflows: ["issue", "pr-review"], triggeredBy: "Alex", stationId: "st_alex", stationName: "alex@mbp:widgets" }),
    known({ workflows: ["prompt"], triggeredBy: "sam", stationId: "st_sam", stationName: "sam@desk:widgets" }),
    known({ triggeredBy: "alex", stationId: "st_ci0001", stationName: "runner@a:widgets", stationKind: "ci" }),
    known({ triggeredBy: "", stationId: "st_ci0002", stationName: "runner@b:widgets", stationKind: "ci" }),
    known({ stationId: "st_alex", stationName: "alex@old-mbp:widgets" }),
    // From a factory too old to say which station: nothing to offer.
    known({ stationId: "", stationName: "", stationKind: "" }),
  ];

  it("are every workflow the sessions passed through, by name", () => {
    expect(facetsOf(sessions).workflows).toEqual(["issue", "pr-review", "prompt"]);
  });

  it("are every person who triggered one, once whatever the case, by login", () => {
    expect(facetsOf(sessions).people).toEqual(["Alex", "sam"]);
  });

  it("are every station by its latest name, and one CI entry for every CI job, last", () => {
    expect(facetsOf(sessions).stations).toEqual([
      { key: "st_alex", name: "alex@mbp:widgets" },
      { key: "st_sam", name: "sam@desk:widgets" },
      { key: CI, name: "CI" },
    ]);
  });

  it("are none for no sessions", () => {
    expect(facetsOf([])).toEqual({ workflows: [], people: [], stations: [] });
  });
});

describe("finding sessions", () => {
  const stored = (factory: string, session: string, fields: Partial<Summary> = {}) => ({ ...known(fields), factory, session });
  async function* each<T>(items: T[]) {
    yield* items;
  }
  const anything = { shown: 10, read: 10 };
  const readable = async (factory: string) => factory !== "acme/secret";

  it("neither shows nor offers a choice from a session the viewer may not read", async () => {
    const records = [stored("acme/secret", "s1", { triggeredBy: "eve", workflows: ["leak"] }), stored("acme/widgets", "w1")];

    const found = await find(each(records), readable, {}, anything);

    expect(found.sessions.map((row) => row.session)).toEqual(["w1"]);
    expect(found.facets.people).toEqual(["alex"]);
    expect(found.facets.workflows).toEqual(["issue"]);
    expect(found.looked).toBe(1);
  });

  it("stops once it has as many as it shows, and says older ones may match too", async () => {
    const records = ["a", "b", "c"].map((session) => stored("acme/widgets", session));

    const found = await find(each(records), readable, {}, { shown: 2, read: 10 });

    expect(found.sessions.map((row) => row.session)).toEqual(["a", "b"]);
    expect(found.cut).toBe(true);
  });

  it("stops once it has read as many as it may, readable or not, and says so", async () => {
    const records = [stored("acme/secret", "s1"), stored("acme/widgets", "w1"), stored("acme/widgets", "w2")];

    const found = await find(each(records), readable, { person: "nobody" }, { shown: 10, read: 2 });

    expect(found).toMatchObject({ sessions: [], looked: 1, cut: true });
  });

  it("is not cut when it read every session there was", async () => {
    const records = [stored("acme/widgets", "w1"), stored("acme/widgets", "w2")];

    expect((await find(each(records), readable, {}, { shown: 2, read: 2 })).cut).toBe(false);
  });
});
