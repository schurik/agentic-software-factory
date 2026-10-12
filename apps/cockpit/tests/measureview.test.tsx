import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeasureTab } from "../components/factory/MeasureTab";
import { FACTORY_TABS, tabOf } from "../components/factory/view";
import type { Metrics } from "../convex/measure";
import { lastDays } from "../convex/model/period";

// A factory's Measure tab (#184, #188), rendered from the query's answer with
// no backend: a sub-navigation with Metrics as its one view so far, the same
// period filter as the Overview, and what the factory's work came to — its
// pull requests, their cycle time and cost, the dearest of them, and its
// chapters by trigger.

const NOW = Date.parse("2026-10-06T12:00:00Z");
const WEEK = lastDays(7, NOW, "UTC");

const HOUR = 3600;
const NO_CHAPTERS: Metrics["chapters"] = [{ trigger: "prompt", chapters: 0 }, { trigger: "issue", chapters: 0 }, { trigger: "pr", chapters: 0 }];

const METRICS: Metrics = {
  cut: false, opened: 4, merged: 2, autonomous: 1, autonomy: 0.5,
  cycle: {
    toPr: { median: 1.5 * HOUR, prs: 2 }, toReview: { median: 3 * HOUR, prs: 1 },
    toMerge: { median: 20 * HOUR, prs: 1 }, total: { median: 26 * HOUR, prs: 2 },
  },
  cost: {
    prs: 2, median: 2.5,
    components: { input: 0.5, output: 1.25, cacheRead: 0.5, cacheWrite: 0.25, other: 0 },
    sizes: [
      { size: "S", prs: 1, median: 1 }, { size: "M", prs: 0, median: null },
      { size: "L", prs: 1, median: 4 }, { size: "XL", prs: 0, median: null },
    ],
    unsized: 0,
  },
  expensive: [
    { session: "a2", url: "https://github.com/acme/widgets/pull/7", cost: 4, lines: 620, size: "L", autonomous: false },
    { session: "a1", url: "https://github.com/acme/widgets/pull/5", cost: 1, lines: 40, size: "S", autonomous: true },
  ],
  chapters: [{ trigger: "prompt", chapters: 1 }, { trigger: "issue", chapters: 3 }, { trigger: "pr", chapters: 2 }],
  measurement: { judges: 3, benchmarks: 0, usdPerDay: 5, days: 7, budget: 35, over: 0 },
};

/** The tab over the metrics above, measuring having cost `judges` against $5 a day for the week. */
const measured = (judges: number, measurement: Partial<Metrics["measurement"]> = {}) =>
  render({ ...METRICS, measurement: { ...METRICS.measurement, judges, ...measurement } });

/** The width a segment of the bar is drawn at, in percent of the bar. */
function width(html: string, part: string): number | null {
  const found = html.match(new RegExp(`data-measure="${part}"[^>]*style="width:([0-9.]+)%"`));
  return found ? Number(found[1]) : null;
}

/** A factory whose pull requests came to nothing in the period: none opened, none merged. */
const NO_PRS: Metrics = {
  ...METRICS, opened: 0, merged: 0, autonomous: 0, autonomy: null,
  cost: { ...METRICS.cost, prs: 0, median: null }, expensive: [],
  measurement: { ...METRICS.measurement, judges: 0 },
};

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

/** The tab over `shown`: the metrics above, unless the query answered otherwise — undefined while it asks. */
const render = (...shown: [Metrics | null | undefined] | []) => renderToStaticMarkup(
  <MeasureTab factory="acme/widgets" metrics={shown.length ? shown[0] : METRICS} scorers={undefined} openScorer={null} onOpenScorer={() => {}}
              benchmarks={undefined} openBenchmark={null} onOpenBenchmark={() => {}} now={0} view="metrics" onView={() => {}} days={7} midnights={WEEK} timeZone="UTC" onDays={() => {}} />,
);

describe("the factory page's Measure tab", () => {
  it("is a tab of its own, its address `?tab=measure`", () => {
    expect(FACTORY_TABS.measure).toBe("Measure");
    expect(tabOf("measure")).toBe("measure");
  });

  it("opens on Metrics, in a sub-navigation with room for more views", () => {
    const html = render();

    expect(html).toMatch(/<nav aria-label="Measure"/);
    expect(html).toMatch(/aria-current="page"[^>]*>Metrics</);
    expect(html).toMatch(/role="radiogroup" aria-label="Period"/);
    expect(text(html)).toContain("Sep 30 – Oct 6");
  });

  it("says how many pull requests the factory opened, how many merged, and their autonomy", () => {
    const said = text(render());

    expect(said).toContain("Pull requests opened 4 by the factory's own sessions");
    expect(said).toContain("Merged 2 in the last 7 days");
    expect(said).toContain("Autonomy 50% 1 of 2 merged needed no human push");
  });

  it("says what autonomy means where it is shown", () => {
    expect(render()).toMatch(/title="The share of merged pull requests that were autonomous: opened by the factory&#x27;s own session[^"]*"/);
  });

  it("says why there is nothing to show for a factory that did nothing in the period", () => {
    const said = text(render({ ...NO_PRS, chapters: NO_CHAPTERS }));

    expect(said).toContain("Nothing to measure in the last 7 days: no chapter started, and no pull request was opened or merged.");
    expect(said).toContain("asf prs");
    expect(said).toContain("asf score");
    for (const section of ["Autonomy", "Cycle time", "Cost per PR", "Most expensive", "Chapters by trigger"]) expect(said).not.toContain(section);
  });

  it("counts the chapters of a period no pull request came of, and says why there are no pull requests", () => {
    const said = text(render(NO_PRS));

    expect(said).toContain("No pull request was opened or merged in the last 7 days.");
    expect(said).toContain("Chapters by trigger");
    for (const section of ["Autonomy", "Cycle time", "Cost per PR", "Most expensive"]) expect(said).not.toContain(section);
  });

  it("has no share to give when pull requests were opened but none merged, nor any cycle or cost", () => {
    const said = text(render({ ...NO_PRS, opened: 3 }));
    expect(said).toContain("Autonomy — nothing merged yet");
    expect(said).not.toContain("Cycle time");
  });

  it("times each leg of a merged pull request's cycle by its median", () => {
    const said = text(render());

    expect(said).toContain("Cycle time");
    expect(said).toContain("Kickoff → PR 1h 30m median of 2 merged");
    expect(said).toContain("PR → first review 3h median of 1 merged");
    expect(said).toContain("First review → merge 20h median of 1 merged");
    expect(said).toContain("Kickoff → merge 1d 2h median of 2 merged");
  });

  it("says what a merged pull request cost, by component and by size, and that measuring is never in it", () => {
    const html = render();
    const said = text(html);

    expect(said).toContain("Cost per PR $2.50 median of 2 merged");
    expect(said).toContain("work only: what measuring costs is never in it");
    expect(said).toMatch(/Input \$0\.50 Output \$1\.25 Cache reads \$0\.50 Cache writes \$0\.25/);
    expect(said).not.toContain("Not itemized");
    expect(said).toMatch(/S under 100 lines 1 \$1\.00 M 100–499 lines 0 — L 500–999 lines 1 \$4\.00 XL 1,000 lines or more 0 —/);
    expect(html).toMatch(/title="List-price equivalent of the agent calls of the session that opened it/);
  });

  it("says how many merged pull requests no size is known for, and what a total the harness never itemized came to", () => {
    const said = text(render({ ...METRICS, cost: { ...METRICS.cost, unsized: 1, components: { ...METRICS.cost.components, other: 0.75 } } }));
    expect(said).toContain("1 merged before its station said how big a pull request is");
    expect(said).toContain("Not itemized $0.75");
  });

  it("lists the most expensive pull requests, each linking to its session and to itself", () => {
    const html = render();
    const said = text(html);

    expect(said).toMatch(/Most expensive pull requests.*#7 .*a2 .*L · 620 lines .*\$4\.00 .*#5 .*a1 .*S · 40 lines .*\$1\.00/);
    expect(html).toContain('href="/sessions/acme/widgets/a2"');
    expect(html).toContain('href="https://github.com/acme/widgets/pull/7"');
  });

  it("counts chapters by trigger, and leaves their split by workflow to the Overview, linked", () => {
    const html = render();

    expect(text(html)).toMatch(/Chapters by trigger.*Prompt 1 .*Issue 3 .*Pull request review 2/);
    expect(html).toMatch(/href="\/factories\/acme\/widgets"[^>]*>[^<]*by workflow/);
  });

  it("draws measurement cost as one bar the length of the period's budget: judges, then benchmarks, then what is left", () => {
    const html = measured(3, { benchmarks: 0.5 });
    const said = text(html);

    expect(said).toContain("Measurement cost $3.50 of $35.00 · $5.00 a day × 7 days $31.50 left");
    expect(said).toMatch(/Judges \$3\.00 .*Benchmarks \$0\.50 .*Left \$31\.50/);
    expect(width(html, "judges")).toBeCloseTo((3 / 35) * 100, 3);
    expect(width(html, "benchmarks")).toBeCloseTo((0.5 / 35) * 100, 3);
    expect(width(html, "left")).toBeCloseTo((31.5 / 35) * 100, 3);
    expect(html.indexOf('data-measure="judges"')).toBeLessThan(html.indexOf('data-measure="benchmarks"'));
    expect(html.indexOf('data-measure="benchmarks"')).toBeLessThan(html.indexOf('data-measure="left"'));
    expect(html).not.toContain('data-measure="budget"');
    expect(html).toMatch(/title="What measuring the factory&#x27;s own work cost/);
  });

  it("says the budget is spent when measuring reached it, with nothing left to draw", () => {
    const html = measured(35);

    expect(text(html)).toContain("$35.00 of $35.00 · $5.00 a day × 7 days budget spent");
    expect(width(html, "judges")).toBe(100);
    expect(width(html, "left")).toBeNull();
    expect(text(html)).not.toContain("over by");
  });

  it("never draws an overspent budget as under it: the bar is what was spent, the budget a mark on it, and over by $x", () => {
    const html = measured(36.5, { over: 1.5 });
    const said = text(html);

    expect(said).toContain("$36.50 of $35.00 · $5.00 a day × 7 days over by $1.50");
    expect(width(html, "judges")).toBe(100);
    expect(width(html, "left")).toBeNull();
    expect(html).toMatch(new RegExp(`data-measure="budget"[^>]*style="left:${(35 / 36.5) * 100}%`));
    expect(html).toMatch(/class="[^"]*text-bad[^"]*">over by \$1\.50</);
  });

  it("says over by what a day overran its own budget, though the period as a whole is under it", () => {
    const html = measured(6.5, { over: 0.5 });
    const said = text(html);

    expect(said).toContain("$6.50 of $35.00 · $5.00 a day × 7 days over by $0.50");
    expect(said).toContain("Left $28.50");
    expect(width(html, "left")).toBeCloseTo((28.5 / 35) * 100, 3);
    expect(html).not.toContain('data-measure="budget"');           // the period's budget was not reached
  });

  it("says what measuring cost even before the factory said what it may, and never inside cost per PR", () => {
    const said = text(measured(2, { usdPerDay: null, budget: null, over: 0 }));

    expect(said).toContain("Measurement cost");
    expect(said).toMatch(/Judges \$2\.00 .*Benchmarks \$0\.00/);
    expect(said).toContain("measurement: {usd_per_day}");
    expect(said).toContain("Cost per PR $2.50");                // the work's, untouched by it
  });

  it("shows measurement cost in a period whose only spending was on measuring", () => {
    const said = text(render({ ...NO_PRS, chapters: NO_CHAPTERS, measurement: { ...METRICS.measurement, judges: 1 } }));

    expect(said).not.toContain("Nothing to measure");
    expect(said).toContain("Measurement cost $1.00 of $35.00");
  });

  it("asks for a shorter period when there was more than it counts at once, and says when it may not read the factory", () => {
    expect(text(render({ ...METRICS, cut: true }))).toContain("pick a shorter period");
    expect(text(render(null))).toContain("This is not a factory you can read.");
    expect(render(undefined)).toContain("Loading");
  });
});
