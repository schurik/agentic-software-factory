import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { type Choice, SessionFilters } from "../components/sessions/SessionFilters";
import { type Listed, SessionsTable } from "../components/sessions/SessionsTable";
import { ViewerLogin } from "../components/viewer";
import { CI, type Facets } from "../convex/model/filter";
import { EMPTY_SUMMARY, type Summary } from "../convex/model/session";

// The Sessions pages, rendered to static markup with no backend (spec #40):
// one table and one row of filters, which a factory's Sessions tab shows
// without the factory column and the page across factories shows with it.

/** The markup's text, one space between words, the way a person reads it. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&gt;/g, ">").replace(/\s+/g, " ");
}

function listed(session: string, fields: Partial<Summary> = {}, factory = "acme/widgets"): Listed {
  return {
    factory, session, acked: 4,
    summary: {
      ...EMPTY_SUMMARY, status: "success", workflows: ["issue", "pr-review"], triggeredBy: "sam",
      stationId: "st_alex", stationName: "alex@mbp:widgets", stationKind: "local", totalCost: 1.25,
      startedAt: "2026-10-01T10:00:00.000Z", lastEventAt: "2026-10-01T11:00:00.000Z", ...fields,
    },
  };
}

const NOW = Date.parse("2026-10-01T12:00:00.000Z");

describe("the sessions table", () => {
  const rows = [listed("a1"), listed("g1", { stationId: "st_ci0001", stationName: "runner@fv-az1:gadgets", stationKind: "ci" }, "acme/gadgets")];

  it("across factories names each session's factory, linked to its page", () => {
    const html = renderToStaticMarkup(<SessionsTable rows={rows} across now={NOW} />);

    expect(text(html)).toContain("Factory");
    expect(html).toContain('href="/factories/acme/gadgets"');
    expect(html).toContain('href="/sessions/acme/gadgets/g1"');
  });

  it("in a factory's tab leaves the factory out: every row is that factory's", () => {
    const html = renderToStaticMarkup(<SessionsTable rows={[rows[0]]} across={false} now={NOW} />);

    expect(text(html)).not.toContain("Factory");
    expect(html).toContain('href="/sessions/acme/widgets/a1"');
  });

  it("says of each session the workflows it passed through, who triggered it, where it ran and what it cost", () => {
    const said = text(renderToStaticMarkup(<SessionsTable rows={rows} across now={NOW} />));

    expect(said).toContain("Triggered by");
    expect(said).toContain("issue → pr-review");
    expect(said).toContain("sam");
    expect(said).toContain("alex@mbp:widgets");
    expect(said).toContain("runner@fv-az1:gadgets CI");
    expect(said).toContain("$1.25");
  });

  it("says the viewer's own runs were triggered by you", () => {
    const said = text(renderToStaticMarkup(
      <ViewerLogin.Provider value="sam"><SessionsTable rows={rows} across now={NOW} /></ViewerLogin.Provider>));
    expect(said).toContain("issue → pr-review success — you alex@mbp:widgets");
  });
});

describe("the filters", () => {
  const facets: Facets = {
    workflows: ["issue", "pr-review"], people: ["alex", "sam"],
    stations: [{ key: "st_alex", name: "alex@mbp:widgets" }, { key: CI, name: "CI" }],
  };
  const any: Choice = { workflow: "", person: "", station: "", status: "", period: "" };
  const render = (choice: Choice = any) =>
    renderToStaticMarkup(<SessionFilters choice={choice} facets={facets} me="alex" onChange={() => {}} />);

  it("offer every workflow, person who triggered a run and station the sessions hold, CI as one", () => {
    const html = render();

    for (const value of ["issue", "pr-review", "alex", "sam", "st_alex", CI]) expect(html).toContain(`value="${value}"`);
    expect(text(html)).toContain("Triggered by");
    expect(html).toMatch(/<option value="alex">you<\/option>/);    // the viewer's own login reads "you"
    expect(html).toMatch(/<option value="sam">sam<\/option>/);
    expect(text(html)).toContain("CI");
  });

  it("offer every status, and the calendar periods of the viewer's own timezone", () => {
    const said = text(render());

    for (const status of ["running", "waiting", "success", "fail"]) expect(said).toContain(status);
    for (const period of ["any time", "today", "this week", "this month"]) expect(said).toContain(period);
  });

  it("keep a choice the sessions looked at no longer hold, so it can still be seen and undone", () => {
    const html = render({ ...any, person: "mallory" });

    expect(html).toContain('value="mallory"');
  });
});
