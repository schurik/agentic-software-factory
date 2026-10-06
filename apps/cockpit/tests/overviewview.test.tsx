import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewTab } from "../components/factory/OverviewTab";
import { ViewerLogin } from "../components/viewer";
import type { Overview } from "../convex/overview";
import { lastDays } from "../convex/model/period";

// A factory's Overview (#119), rendered from the query's answer with no
// backend: one filter row over everything it filters, then Spend, Outcomes
// and By workflow — only what no other page shows.

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-10-06T12:00:00Z");
const WEEK = lastDays(7, NOW, "UTC");
const DAILY = [0, 0, 0.037, 0, 0.463, 0.0185, 0];

const OVERVIEW: Overview = {
  cut: false,
  spend: {
    total: { cost: 0.5185, tokens: 30_700 },
    sessions: 3,
    days: WEEK.slice(0, -1).map((from, index) => ({ from, cost: DAILY[index], tokens: DAILY[index] ? 1000 : 0 })),
    stations: [
      { station: "st_8d58", name: "schurik@mbp:widgets", owner: "", cost: 0.463, tokens: 27_100 },
      { station: "st_7f3a9c", name: "alex@mbp:widgets", owner: "alex", cost: 0.056, tokens: 3_600 },
    ],
    people: [
      { person: "schurik", cost: 0.463, tokens: 27_100 },
      { person: "alex", cost: 0.037, tokens: 2_400 },
      { person: "", cost: 0.0185, tokens: 1_200 },
    ],
  },
  outcomes: { sessions: 3, done: 1, failed: 1, open: 1, finish: 667.48, gates: { rounds: 2, rejected: 1, wait: 0.457 } },
  workflows: [
    { workflow: "ship", sessions: 2, done: 0, failed: 1, open: 1, finish: 1320, cost: 0.056, tokens: 3_600, last: at("2026-10-05T08:00:00Z") },
    { workflow: "issue", sessions: 1, done: 1, failed: 0, open: 0, finish: null, cost: 0.383, tokens: 23_100, last: at("2026-10-04T22:41:42Z") },
  ],
};

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/\s+/g, " ");
}

const render = (overview: Overview | null | undefined = OVERVIEW, days: 7 | 30 = 7) => renderToStaticMarkup(
  <ViewerLogin.Provider value="alex">
    <OverviewTab overview={overview} days={days} midnights={WEEK} now={NOW} timeZone="UTC" onDays={() => {}} />
  </ViewerLogin.Provider>,
);

describe("a factory's Overview, first paint", () => {
  it("has one period filter above everything it filters, on the period it was given", () => {
    const html = render();

    expect(html).toMatch(/role="radiogroup" aria-label="Period"/);
    expect(html).toMatch(/aria-checked="true"[^>]*>Last 7 days</);
    expect(html).toMatch(/aria-checked="false"[^>]*>Last 30 days</);
    expect(text(html)).toContain("Sep 30 – Oct 6");
    expect(html.indexOf("Last 7 days")).toBeLessThan(html.indexOf("Spend"));
  });

  it("switches its filter to the last 30 days when that is the period", () => {
    expect(render(OVERVIEW, 30)).toMatch(/aria-checked="true"[^>]*>Last 30 days</);
  });

  it("spends the total with its tokens, per day and per session, then a column a day with its own tooltip", () => {
    const html = render();
    const said = text(html);

    expect(said).toContain("$0.52");
    expect(said).toContain("30.7k tokens");
    expect(said).toContain("$0.07 a day · $0.17 a session");
    expect(html).toContain('aria-label="Spend per day, 7 days"');
    expect(html.match(/data-day=/g)).toHaveLength(7);
    expect(said).toContain("Oct 4 $0.46");
  });

  it("says whose key paid and who started it, the viewer as you", () => {
    const said = text(render());

    expect(said).toContain("By station — whose key paid");
    expect(said).toMatch(/schurik@mbp:widgets \$0\.46 .*alex@mbp:widgets you \$0\.06/);
    expect(said).toContain("By person — who started it");
    expect(said).toMatch(/schurik \$0\.46 you \$0\.04 not named by the factory \$0\.02/);
  });

  it("says how the sessions ended, how long they took, and how long the gates waited", () => {
    const said = text(render());

    expect(said).toContain("Sessions 3 1 done · 1 failed · 1 open");
    expect(said).toContain("Finished well 50% of the sessions that finished");
    expect(said).toContain("Time to finish 11m median, start to finish");
    expect(said).toContain("Wait at gates <1s median · 2 rounds, 1 rejected");
  });

  it("lists each workflow: sessions, how they finished, median time, spend and last run", () => {
    const said = text(render());

    expect(said).toContain("ship 2 1 failed · 1 open 22m $0.06 1d ago");
    expect(said).toContain("issue 1 1 done — $0.38 1d ago");
  });
});

describe("a factory's Overview, when there is little to show", () => {
  it("says nothing was spent, and no gate asked a person, rather than drawing empty charts", () => {
    const empty: Overview = {
      cut: false,
      spend: { total: { cost: 0, tokens: 0 }, sessions: 0, days: OVERVIEW.spend.days.map((day) => ({ ...day, cost: 0, tokens: 0 })), stations: [], people: [] },
      outcomes: { sessions: 0, done: 0, failed: 0, open: 0, finish: null, gates: { rounds: 0, rejected: 0, wait: null } },
      workflows: [],
    };
    const said = text(render(empty));

    expect(said).toContain("Nothing was spent in the last 7 days.");
    expect(said).toContain("no gate asked a person");
    expect(said).toContain("No session ran in the last 7 days.");
  });

  it("asks for a shorter period when there was more than it sums at once", () => {
    expect(text(render({ ...OVERVIEW, cut: true }))).toContain("pick a shorter period");
  });

  it("says when the factory is not one the viewer can read", () => {
    expect(text(render(null))).toContain("not a factory you can read");
  });
});
