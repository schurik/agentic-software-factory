import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunForm, type RunRow, runWords, type Targets } from "../components/run/RunForm";

// Running a prompt workflow (spec #40, #55, #108): the header's dialog, which
// queues a `run` for the viewer's own default station on the factory chosen,
// with one of its prompt workflows and a prompt — and what became of each run.

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

const OFFERED = { described: true, workflows: ["quick", "sdlc"] };

function form(fields: Partial<Parameters<typeof RunForm>[0]> = {}): string {
  return renderToStaticMarkup(
    <RunForm factories={["acme/gadgets", "acme/widgets"]} state={{ open: true, factory: "acme/widgets", workflow: "", prompt: "" }}
             workflows={OFFERED} targets={TARGETS} runs={[]} now={NOW} busy={false} problem=""
             onChange={() => undefined} onRun={() => undefined} onCancel={() => undefined} {...fields} />);
}

const typed = { open: true, factory: "acme/widgets", workflow: "", prompt: "add a health check" };
const runButton = (html: string) => html.match(/<button[^>]*type="submit"[^>]*>Run<\/button>/)![0];

describe("the run dialog", () => {
  it("is the factory and workflow, the prompt, then Cancel and Run", () => {
    const html = form({ state: typed });
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toMatch(/Factory acme\/widgets .*Workflow quick .*Prompt .*Cancel Run/);
    expect(html).toContain("add a health check</textarea>");
    expect(runButton(html)).not.toContain('disabled=""');
  });

  it("opens on the workflow it was asked for, when the factory has it", () => {
    expect(form({ state: { ...typed, workflow: "sdlc" } })).toMatch(/Workflow.*<span[^>]*>sdlc<\/span>/);
    expect(form({ state: { ...typed, workflow: "nightly" } })).toMatch(/Workflow.*<span[^>]*>quick<\/span>/);
  });

  it("will not run an empty prompt", () => {
    expect(runButton(form())).toContain('disabled=""');
    expect(runButton(form({ state: { ...typed, prompt: " \n " } }))).toContain('disabled=""');
  });

  it("names the station it runs on: the viewer's default, and whether it is listening", () => {
    expect(form()).toContain("Runs on alex@desk:widgets · online");
    expect(form()).toContain("only ever one of your own");
    expect(form()).not.toContain('class="my-3');                       // no notice: nothing in the way
  });

  it("says why it cannot run, and will not", () => {
    const cannot = (fields: Partial<Parameters<typeof RunForm>[0]>) => {
      const html = form({ state: typed, ...fields });
      expect(runButton(html)).toContain('disabled=""');
      return html.replace(/&#x27;/g, "'");
    };
    expect(cannot({ targets: { refused: "commands need write or higher on this repository, and the forge says you have read", stations: [] } }))
      .toContain("commands need write or higher");
    expect(cannot({ targets: { refused: null, stations: [] } })).toContain("asf station register");
    const because = "alex@desk:widgets does not take run: its asf/factory.yaml's cockpit.commands does not list it — run is off unless it is listed";
    expect(cannot({ targets: { ...TARGETS, stations: [{ ...TARGETS.stations[0], refused: because }] } })).toContain(because);
    expect(cannot({ targets: null })).toContain("acme/widgets is not a repository you can read");
    expect(cannot({ workflows: { described: true, workflows: [] } })).toContain("acme/widgets has no workflow that takes a prompt");
    expect(cannot({ workflows: { described: false, workflows: [] } })).toContain("has not described itself");
  });

  it("says why the last Run was not queued, and lets it be tried again", () => {
    const html = form({ state: typed, problem: "the station is busy" });
    expect(html).toContain("Not queued: the station is busy.");
    expect(runButton(html)).not.toContain('disabled=""');
  });

  it("asks for a factory when none is chosen, and says when the viewer has none to run on", () => {
    expect(runButton(form({ state: { ...typed, factory: "" } }))).toContain('disabled=""');
    expect(form({ factories: [], state: { ...typed, factory: "" } })).toContain("You have no station yet");
  });

  it("lists the viewer's latest runs on the factory, and what became of each", () => {
    expect(form({ runs: [{ ...RUN, state: "done", started: "a1b2c3d4" }] })).toContain('href="/sessions/acme/widgets/a1b2c3d4"');
  });
});

describe("what became of a run", () => {
  it("is queued, station offline, until the station is back or the TTL runs out", () => {
    expect(runWords(RUN, NOW)).toMatch(/^queued, station offline: alex@mbp:widgets takes it when it is back, until \S/);
    expect(runWords({ ...RUN, seenAt: NOW - 1000 }, NOW)).toBe("queued: alex@mbp:widgets takes it within seconds");
    expect(runWords({ ...RUN, state: "expired" }, NOW)).toBe("expired: alex@mbp:widgets did not take it in time");
    expect(runWords(RUN, RUN.expiresAt + 1)).toBe("expired: alex@mbp:widgets did not take it in time");
  });

  it("is done only when the station says which session it started, and refused as the station put it", () => {
    expect(runWords({ ...RUN, state: "delivered" }, NOW)).toBe("sent to alex@mbp:widgets: waiting for it to say it started");
    expect(runWords({ ...RUN, state: "done", started: "a1b2c3d4" }, NOW)).toBe("started session a1b2c3d4 on alex@mbp:widgets");
    expect(runWords({ ...RUN, state: "refused", detail: "no workflow 'nope'" }, NOW)).toBe("refused by alex@mbp:widgets: no workflow 'nope'");
  });
});
