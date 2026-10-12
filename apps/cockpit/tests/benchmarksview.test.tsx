import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeasureTab } from "../components/factory/MeasureTab";
import type { Benchmarks } from "../convex/measure";
import type { BenchmarkLine, MetricLine } from "../convex/model/benchmarks";
import { lastDays } from "../convex/model/period";

// The Measure tab's Benchmarks view (#199), rendered from the query's answer
// with no backend: an accordion, newest first, a row on the comparison's own
// grid — the benchmark, one cell per variant, how far it got — and the open
// one comparing each metric as value ± run-to-run noise, with a reading in
// words. No sign to decode, never "better", and no winner declared.

const NOW = Date.parse("2026-10-12T12:00:00Z");
const WEEK = lastDays(7, NOW, "UTC");

const TASKS = [
  { session: "5c0be7ed", request: "#42 The /health endpoint returns 500", commit: "9d885f9e1c2b3a4d5e6f708192a3b4c5d6e7f809" },
  { session: "7e1a2b3c", request: "add a /ready endpoint", commit: "a514b96f0e1d2c3b4a5968778695a4b3c2d1e0f1" },
];

const line = (key: string, unit: MetricLine["unit"], a: [number, number | null], b: [number, number | null],
              words: string, noise: string): MetricLine => ({
  key, scorer: key.startsWith("scorer:") ? key.slice(7) : null, unit,
  values: [{ mean: a[0], noise: a[1], repetitions: 2 }, { mean: b[0], noise: b[1], repetitions: 2 }],
  readings: [null, { variant: "PR #9", against: "main", words, noise: noise as never }],
});

const SCOPE: BenchmarkLine = {
  name: "reviewer-scope", latest: NOW - 3_600_000, tasks: TASKS, repetitions: 2,
  variants: [{ label: "main", ref: "main", commit: "a".repeat(40) }, { label: "PR #9", ref: "asf/1a2b3c4d", commit: "9".repeat(40) }],
  state: "finished",
  progress: { planned: 8, worked: 8, running: 0, notComparable: 1, startedAt: NOW - 7_200_000, finishedAt: NOW - 3_000_000 },
  metrics: [
    line("scorer:corrections", "share", [0.75, 0.3536], [0, 0], "75 pts lower", "more than the noise"),
    line("accepted", "share", [0.75, 0.3536], [1, 0], "25 pts higher", "within the noise"),
    line("corrections", "count", [0.5, 0.7071], [0, 0], "0.5 fewer", "within the noise"),
    line("cost", "usd", [2.5, 0.7071], [0.75, 0.3536], "$1.75 less", "more than the noise"),
    line("duration", "seconds", [600, 0], [600, 0], "the same", "within the noise"),
  ],
};

const WORKING: BenchmarkLine = {
  ...SCOPE, name: "builder-writes", latest: NOW - 60_000, state: "working",
  progress: { planned: 8, worked: 3, running: 1, notComparable: 0, startedAt: NOW - 600_000, finishedAt: null },
};

const FRESH: BenchmarkLine = {
  ...SCOPE, name: "fresh", latest: null, state: "not worked",
  variants: SCOPE.variants.map((variant) => ({ ...variant, commit: null })),
  progress: { planned: 6, worked: 0, running: 0, notComparable: 0, startedAt: null, finishedAt: null },
  metrics: SCOPE.metrics.map((metric) => ({ ...metric, values: [null, null], readings: [null, null] })),
};

const BENCHMARKS: Benchmarks = { described: true, benchmarks: [WORKING, SCOPE, FRESH] };

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/ ([:;.,])/g, "$1");
}

const render = (benchmarks: Benchmarks | null | undefined = BENCHMARKS, open: string | null = null) => renderToStaticMarkup(
  <MeasureTab factory="acme/widgets" metrics={undefined} scorers={undefined} openScorer={null} onOpenScorer={() => {}}
              benchmarks={benchmarks} openBenchmark={open} onOpenBenchmark={() => {}} now={NOW}
              view="benchmarks" onView={() => {}} days={7} midnights={WEEK} timeZone="UTC" onDays={() => {}} />,
);

/** The open benchmark's comparison alone. */
const comparison = (html: string) => text(html.split('data-comparison=""')[1] ?? "");

describe("the Benchmarks view", () => {
  it("is a view of the Measure tab, after Scorers, with no period", () => {
    const html = render();
    expect(text(html)).toMatch(/Metrics Scorers Benchmarks/);
    expect(html).toMatch(/aria-current="page"[^>]*>Benchmarks</);
    expect(html).not.toMatch(/aria-label="Period"/);
  });

  it("lists each benchmark as a row in the order the query gave: what it is, a cell per variant, how far it got", () => {
    const said = text(render());
    expect(said).toMatch(/Benchmark .*Variants .*Sessions worked/);
    expect(said.indexOf("builder-writes")).toBeLessThan(said.indexOf("reviewer-scope"));
    expect(said.indexOf("reviewer-scope")).toBeLessThan(said.indexOf("fresh"));
    expect(said).toMatch(/reviewer-scope 2 tasks × 2 variants × 2 repetitions main PR #9 finished 50m ago 8\/8/);
    expect(said).toMatch(/fresh 2 tasks × 2 variants × 2 repetitions main PR #9 not worked yet 0\/6/);
  });

  it("shows progress while sessions are still being worked", () => {
    const html = render();
    expect(text(html)).toMatch(/builder-writes .* working 3\/8/);
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="3"[^>]*aria-valuemax="8"/);
  });

  it("opens one benchmark at a time, the rest closed", () => {
    const html = render(BENCHMARKS, "reviewer-scope");
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-expanded="true"[^>]*data-row="reviewer-scope"/);
    expect(html.match(/data-comparison=""/g)).toHaveLength(1);
  });

  it("compares each metric as value ± run-to-run noise per variant, and reads the difference in words", () => {
    const said = comparison(render(BENCHMARKS, "reviewer-scope"));
    expect(said).toMatch(/corrections failing of sessions 75% ± 35 pts 0% ± 0 pts 75 pts lower more than the noise/);
    expect(said).toMatch(/Accepted of sessions 75% ± 35 pts 100% ± 0 pts 25 pts higher within the noise/);
    expect(said).toMatch(/Corrections a session 0\.5 ± 0\.7 0\.0 ± 0\.0 0\.5 fewer within the noise/);
    expect(said).toMatch(/Cost a session \$2\.50 ± \$0\.71 \$0\.75 ± \$0\.35 \$1\.75 less more than the noise/);
    expect(said).toMatch(/Duration a session 10m ± 0s 10m ± 0s the same within the noise/);
    expect(said).toMatch(/PR #9 against main/);
  });

  it("never says a reading with a sign, nor which is better: that is each metric's (i)", () => {
    const said = comparison(render(BENCHMARKS, "reviewer-scope"));
    expect(said).not.toMatch(/[+−]\s?\d|-\d|-\$/);
    expect(said).not.toMatch(/better|worse/i);
    expect(render(BENCHMARKS, "reviewer-scope")).toMatch(/aria-label="About: Cost"/);
  });

  it("declares no winner, on every benchmark opened", () => {
    for (const each of BENCHMARKS.benchmarks) expect(comparison(render(BENCHMARKS, each.name))).toMatch(/No winner is declared/);
  });

  it("keeps the pinned tasks behind a toggle", () => {
    const html = render(BENCHMARKS, "reviewer-scope");
    expect(html).toMatch(/aria-expanded="false"[^>]*>.*2 pinned tasks/);
    expect(text(html)).not.toMatch(/add a \/ready endpoint/);
  });

  it("draws each value as a dot and a whisker in its variant's series colour, never a status colour", () => {
    const html = render(BENCHMARKS, "reviewer-scope").split('data-comparison=""')[1];
    expect(html).toMatch(/data-dot="main"[^>]*bg-series-1|bg-series-1[^>]*data-dot="main"/);
    expect(html).toMatch(/data-dot="PR #9"[^>]*bg-series-2|bg-series-2[^>]*data-dot="PR #9"/);
    expect(html).not.toMatch(/\b(bg|text)-(ok|bad|wait)\b/);
  });

  it("says what is left out: a session that could not be compared, a benchmark not worked yet", () => {
    expect(comparison(render(BENCHMARKS, "reviewer-scope"))).toMatch(/1 session could not be compared/);
    expect(comparison(render(BENCHMARKS, "fresh"))).toMatch(/Not worked yet: .*asf benchmark run fresh/);
  });

  it("says why there is nothing to compare", () => {
    expect(text(render({ described: false, benchmarks: [] }))).toMatch(/No self-description yet/);
    expect(text(render({ described: true, benchmarks: [] }))).toMatch(/No benchmark is defined.*asf benchmark new/);
    expect(text(render(null))).toMatch(/not a factory you can read/);
  });
});
