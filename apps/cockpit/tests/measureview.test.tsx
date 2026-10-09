import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeasureTab } from "../components/factory/MeasureTab";
import { FACTORY_TABS, tabOf } from "../components/factory/view";
import type { Metrics } from "../convex/measure";
import { lastDays } from "../convex/model/period";

// A factory's Measure tab (#184), rendered from the query's answer with no
// backend: a sub-navigation with Metrics as its one view so far, the same
// period filter as the Overview, and what the factory's pull requests came to.

const NOW = Date.parse("2026-10-06T12:00:00Z");
const WEEK = lastDays(7, NOW, "UTC");

const METRICS: Metrics = { cut: false, opened: 4, merged: 2, autonomous: 1, autonomy: 0.5 };

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

/** The tab over `shown`: the metrics above, unless the query answered otherwise — undefined while it asks. */
const render = (...shown: [Metrics | null | undefined] | []) => renderToStaticMarkup(
  <MeasureTab metrics={shown.length ? shown[0] : METRICS} view="metrics" onView={() => {}} days={7} midnights={WEEK} timeZone="UTC" onDays={() => {}} />,
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

  it("says why there is nothing to show when no pull request was opened or merged", () => {
    const said = text(render({ cut: false, opened: 0, merged: 0, autonomous: 0, autonomy: null }));

    expect(said).toContain("No pull request was opened or merged in the last 7 days.");
    expect(said).toContain("asf prs");
    expect(said).not.toContain("Autonomy");
  });

  it("has no share to give when pull requests were opened but none merged", () => {
    expect(text(render({ cut: false, opened: 3, merged: 0, autonomous: 0, autonomy: null })))
      .toContain("Autonomy — nothing merged yet");
  });

  it("asks for a shorter period when there was more than it counts at once, and says when it may not read the factory", () => {
    expect(text(render({ ...METRICS, cut: true }))).toContain("pick a shorter period");
    expect(text(render(null))).toContain("This is not a factory you can read.");
    expect(render(undefined)).toContain("Loading");
  });
});
