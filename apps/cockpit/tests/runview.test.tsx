import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunForm, type RunRow, runWords, type Targets } from "../components/run/RunForm";

// Running a prompt workflow (spec #40, #55): the form that queues a `run` for
// one of the viewer's own stations — their default, or one they pick from a
// list that says when each was last seen — and what became of each run.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const TARGETS: Targets = {
  refused: null,
  stations: [
    { station: "st_de5k00", name: "alex@desk:widgets", seenAt: NOW - 2000, default: true, refused: null },
    { station: "st_7f3a9c", name: "alex@mbp:widgets", seenAt: NOW - 3 * 3600_000, default: false, refused: null },
  ],
};
const RUN: RunRow = {
  id: "c1" as RunRow["id"], workflow: "quick", prompt: "add a health check", station: "alex@mbp:widgets", seenAt: NOW - 3 * 3600_000,
  state: "queued", by: "alex", issuedAt: NOW - 60_000, expiresAt: NOW + 14 * 60_000, detail: "", started: "",
};

function form(targets: Targets | null, runs: RunRow[] = []): string {
  return renderToStaticMarkup(<RunForm factory="acme/widgets" targets={targets} runs={runs} now={NOW} busy={false}
                                       problem="" onRun={() => undefined} />);
}

describe("the run form", () => {
  it("runs on the viewer's default station, and lists their others with when each was last seen", () => {
    const html = form(TARGETS);
    expect(html).toMatch(/<option value="st_de5k00" selected="">alex@desk:widgets · online · default<\/option>/);
    expect(html).toContain("alex@mbp:widgets · last seen 3h ago");
    expect(html).toContain("Only your own stations");
    expect(html).not.toContain('class="notice');               // nothing in the way but what is still to type
  });

  it("is disabled, saying why, when the viewer may not run or has no station", () => {
    expect(form({ refused: "commands need write or higher on this repository, and the forge says you have read", stations: [] }))
      .toContain("commands need write or higher");
    expect(form({ refused: null, stations: [] })).toContain("asf station register");
    expect(form({ refused: null, stations: [] })).toMatch(/<button[^>]*disabled/);
  });

  it("says why the chosen station would refuse a run — off unless opted in", () => {
    const because = "alex@desk:widgets does not take run: its asf/factory.yaml's cockpit.commands does not list it — run is off unless it is listed";
    const html = form({ ...TARGETS, stations: [{ ...TARGETS.stations[0], refused: because }, TARGETS.stations[1]] });
    expect(html.replace(/&#x27;/g, "'")).toContain(because);
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});

describe("what became of a run", () => {
  it("is queued, station offline, until the station is back or the TTL runs out", () => {
    expect(runWords(RUN, NOW)).toMatch(/^queued, station offline: alex@mbp:widgets takes it when it is back, until \S/);
    expect(runWords({ ...RUN, seenAt: NOW - 1000 }, NOW)).toBe("queued: alex@mbp:widgets takes it within seconds");
    expect(runWords({ ...RUN, state: "expired" }, NOW)).toBe("expired: alex@mbp:widgets did not take it in time — pick another station");
    expect(runWords(RUN, RUN.expiresAt + 1)).toBe("expired: alex@mbp:widgets did not take it in time — pick another station");
  });

  it("is done only when the station says which session it started, and refused as the station put it", () => {
    expect(runWords({ ...RUN, state: "delivered" }, NOW)).toBe("sent to alex@mbp:widgets: waiting for it to say it started");
    expect(runWords({ ...RUN, state: "done", started: "a1b2c3d4" }, NOW)).toBe("started session a1b2c3d4 on alex@mbp:widgets");
    expect(runWords({ ...RUN, state: "refused", detail: "no workflow 'nope'" }, NOW)).toBe("refused by alex@mbp:widgets: no workflow 'nope'");
    expect(form(TARGETS, [{ ...RUN, state: "done", started: "a1b2c3d4" }])).toContain('href="/sessions/acme/widgets/a1b2c3d4"');
  });
});
