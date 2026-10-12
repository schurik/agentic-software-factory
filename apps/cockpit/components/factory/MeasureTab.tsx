import Link from "next/link";
import type { Benchmarks, Measurement, Metrics, Scorers } from "@/convex/measure";
import type { Size, Stretch } from "@/convex/model/measure";
import type { Components } from "@/convex/model/pulls";
import { formatDollars as dollars, formatDuration, formatNumber, plural, prNumber, sessionHref } from "../format";
import { Card, cx, Loading, Notice, num, pillClass, Section, Table } from "../ui";
import { BenchmarksView } from "./BenchmarksView";
import { OVERVIEW_DAYS, type OverviewDays, PeriodFilter, Stat } from "./OverviewTab";
import { ScorersView } from "./ScorersView";
import { tabHref } from "./view";

/** The Measure tab's views, in the order its sub-navigation lists them: Metrics, Scorers (#190), Benchmarks (#199). */
export const MEASURE_VIEWS = { metrics: "Metrics", scorers: "Scorers", benchmarks: "Benchmarks" } as const;
export type MeasureView = keyof typeof MEASURE_VIEWS;

const AUTONOMY = "The share of merged pull requests that were autonomous: opened by the factory's own session, " +
  "and every commit of it at merge made by that session, or a merge from the base branch. Review rounds " +
  "driven by people's comments keep a pull request autonomous; a single push by a person does not.";

const CYCLE = "How long a merged pull request took, leg by leg: from its session's kickoff to the pull request the " +
  "session opened, from there to its first review, and from that review to its merge. Each leg is the median " +
  "of the merged pull requests whose both ends are known, so the legs need not add up to the whole.";

const COST = "List-price equivalent of the agent calls of the session that opened it, split evenly when that " +
  "session opened more than one. Work only: what measuring costs — a scorer's judge, a benchmark — is never in it.";

const COMPONENT: Record<keyof Components, string> = {
  input: "Input", output: "Output", cacheRead: "Cache reads", cacheWrite: "Cache writes", other: "Not itemized",
};

const SIZE: Record<Size, string> = {
  S: "under 100 lines", M: "100–499 lines", L: "500–999 lines", XL: "1,000 lines or more",
};

/** What started a chapter: a prompt, an issue, a pull request's review (model/chapters.ts). */
const TRIGGER: Record<string, string> = { prompt: "Prompt", issue: "Issue", pr: "Pull request review" };

const MEASURING = "What measuring the factory's own work cost: a scorer's judge reading a finished chapter, and a " +
  "benchmark's sessions. Paid from the factory's `measurement: {usd_per_day}` budget, never from the work's, and never " +
  "in cost per PR. Once a day's spend reaches it, judges stop until the next day (UTC), and a chapter one skipped says " +
  "\"not judged (budget)\" on its session's page; the call already running when it was reached may overrun it.";

const TRIGGERED = "What started each chapter that began in the period: a prompt someone typed, an issue someone " +
  "labelled, or a round of review comments on a pull request.";

/**
 * A factory's Measure tab (#184, #188, #190, #199): how the factory measures
 * its own work. One filter row — the view, then, on Metrics, the period, the
 * Overview's own: a scorer counts sessions and a benchmark repetitions, not
 * days — over the view open. Pure: `metrics`, `scorers` and `benchmarks` are
 * the queries' answers, undefined while they are asked and null for a factory
 * the viewer may not read.
 */
export function MeasureTab({ factory, metrics, scorers, openScorer, onOpenScorer, benchmarks, openBenchmark, onOpenBenchmark, now,
                             view, onView, days, midnights, timeZone, onDays }: {
  /** The factory's repository, `owner/name`: what its sessions and its Overview are addressed by. */
  factory: string;
  metrics: Metrics | null | undefined;
  scorers: Scorers | null | undefined;
  /** The scorer open in the Scorers view's accordion, by name: one at a time, or none. */
  openScorer: string | null;
  onOpenScorer: (scorer: string | null) => void;
  benchmarks: Benchmarks | null | undefined;
  /** The benchmark open in the Benchmarks view's accordion, by name: one at a time, or none. */
  openBenchmark: string | null;
  onOpenBenchmark: (benchmark: string | null) => void;
  /** Epoch ms: what a finished benchmark says how long ago it finished against. */
  now: number;
  view: MeasureView;
  onView: (view: MeasureView) => void;
  days: OverviewDays;
  /** The midnights that start each day of the period, and the one after its last (`lastDays`). */
  midnights: number[];
  timeZone: string;
  onDays: (days: OverviewDays) => void;
}) {
  const period = OVERVIEW_DAYS[days].toLowerCase();
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="Measure" className="flex gap-1.5">
          {(Object.keys(MEASURE_VIEWS) as MeasureView[]).map((each) => (
            <button key={each} type="button" aria-current={view === each ? "page" : undefined} onClick={() => onView(each)}
                    className={cx("cursor-pointer", pillClass(view === each))}>
              {MEASURE_VIEWS[each]}
            </button>
          ))}
        </nav>
        {view === "metrics" ? <PeriodFilter days={days} midnights={midnights} timeZone={timeZone} onDays={onDays} /> : null}
      </div>
      {view === "benchmarks" ? (
        benchmarks === undefined ? <Loading />
          : benchmarks === null ? <Notice>This is not a factory you can read.</Notice>
          : <BenchmarksView factory={factory} benchmarks={benchmarks} open={openBenchmark} onOpen={onOpenBenchmark} now={now} />
      ) : view === "scorers" ? (
        scorers === undefined ? <Loading />
          : scorers === null ? <Notice>This is not a factory you can read.</Notice>
          : <ScorersView factory={factory} scorers={scorers} open={openScorer} onOpen={onOpenScorer} />
      ) : metrics === undefined ? <Loading />
        : metrics === null ? <Notice>This is not a factory you can read.</Notice>
        : metrics.cut ? <Notice>More happened in the {period} than the cockpit counts at once: pick a shorter period.</Notice>
        : <MetricsView factory={factory} metrics={metrics} period={period} />}
    </div>
  );
}

const REACHES = (
  <>
    A merge reaches the cockpit when a station&apos;s pull request watcher (<code>asf prs</code>) sees the pull
    request closed, or when <code>asf score</code> asks the forge for a factory no watcher ran for.
  </>
);

/**
 * The Metrics view: the factory's pull requests, then — of the ones that
 * merged — their cycle time, their cost and the dearest of them, then its
 * chapters by trigger, and last, apart from all of it, what measuring them
 * cost. A period with none of it is one sentence.
 */
function MetricsView({ factory, metrics, period }: { factory: string; metrics: Metrics; period: string }) {
  const { opened, merged, autonomous, autonomy, chapters, measurement } = metrics;
  if (!opened && !merged && chapters.every((line) => !line.chapters) && !measurement.judges && !measurement.benchmarks) {
    return <Notice>Nothing to measure in the {period}: no chapter started, and no pull request was opened or merged. {REACHES}</Notice>;
  }
  return (
    <>
      <Section title="Pull requests">
        {!opened && !merged ? <Notice>No pull request was opened or merged in the {period}. {REACHES}</Notice> : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Stat label="Pull requests opened" value={opened} sub="by the factory's own sessions" />
            <Stat label="Merged" value={merged} sub={`in the ${period}`} />
            <Stat label="Autonomy" title={AUTONOMY} value={autonomy === null ? "—" : `${Math.round(autonomy * 100)}%`}
                  sub={autonomy === null ? "nothing merged yet" : `${autonomous} of ${merged} merged needed no human push`} />
          </div>
        )}
      </Section>
      {merged ? <Merged factory={factory} metrics={metrics} /> : null}
      <Section title="Chapters by trigger"
               right={<Link href={tabHref(factory, "overview")} className="text-sm">Sessions by workflow, on the Overview</Link>}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {chapters.map((line) => (
            <Stat key={line.trigger} label={TRIGGER[line.trigger] ?? line.trigger} title={TRIGGERED} value={line.chapters}
                  sub={plural(line.chapters, "chapter") + " started"} />
          ))}
        </div>
      </Section>
      <MeasurementCost measurement={measurement} />
    </>
  );
}

/** In whole cents: what the bar compares, so a sum of float costs is never "over by $0.00". */
const cents = (value: number) => Math.round(value * 100);

/**
 * Measurement cost: one bar the length of the period's budget — `usd_per_day`
 * for each of its days — filled by what judges spent, then benchmarks, then
 * what is left. Spending past the budget is never drawn inside it: the bar is
 * then what was spent, the budget a mark on it. "Over by" is what the days
 * spent past their own budget — a day's last judge can overrun it though the
 * period is under — so it is said whenever a day overran, never hidden by the
 * days that did not. A factory that never described its budget gets the spend alone.
 */
function MeasurementCost({ measurement: { judges, benchmarks, usdPerDay, days, budget, over } }: { measurement: Measurement }) {
  const spent = judges + benchmarks;
  const parts = [
    { key: "judges", label: "Judges", value: judges, fill: "bg-accent" },
    { key: "benchmarks", label: "Benchmarks", value: benchmarks, fill: "bg-accent/45" },
  ];
  if (budget === null || usdPerDay === null) {
    return (
      <Section title="Measurement cost">
        <Card className="px-4 py-3">
          <div className="text-2xl font-semibold tracking-tight tabular-nums" title={MEASURING}>{dollars(spent)}</div>
          <Legend parts={parts} />
          <p className="mt-2 text-xs text-muted">
            The factory has not said what measuring may spend: its default branch describes no{" "}
            <code>measurement: {"{usd_per_day}"}</code> yet — push its self-description from a stamp that has one.
          </p>
        </Card>
      </Section>
    );
  }
  const past = cents(spent) - cents(budget);
  const left = Math.max(0, -past) / 100;
  const scale = Math.max(budget, spent);
  const share = (value: number) => (scale > 0 ? (value / scale) * 100 : 0);
  const told = past > 0 ? parts : [...parts, { key: "left", label: "Left", value: left, fill: "bg-surface-3" }];
  return (
    <Section title="Measurement cost">
      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div title={MEASURING}>
            <span className="text-2xl font-semibold tracking-tight tabular-nums">{dollars(spent)}</span>{" "}
            <span className="text-sm text-muted tabular-nums">of {dollars(budget)} · {dollars(usdPerDay)} a day × {plural(days, "day")}</span>
          </div>
          {cents(over) > 0 ? <span className="text-sm font-medium text-bad tabular-nums">over by {dollars(over)}</span>
            : <span className="text-sm text-muted tabular-nums">{left === 0 ? "budget spent" : `${dollars(left)} left`}</span>}
        </div>
        <div role="img" className="relative mt-3 flex h-2.5 gap-0.5"
             aria-label={`${parts.map((part) => `${part.label} ${dollars(part.value)}`).join(", ")} of a ${dollars(budget)} budget`}>
          {told.filter((part) => part.value > 0).map((part) => (
            <span key={part.key} data-measure={part.key} title={`${part.label}: ${dollars(part.value)}`}
                  className={cx("block h-full rounded-[3px]", part.fill)} style={{ width: `${share(part.value)}%` }} />
          ))}
          {past > 0 ? (
            <span data-measure="budget" title={`The budget: ${dollars(budget)}`}
                  className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-fg" style={{ left: `${share(budget)}%` }} />
          ) : null}
        </div>
        <Legend parts={told} />
      </Card>
    </Section>
  );
}

/** What each part of the measurement came to, by name: a part is never told by its colour alone. */
function Legend({ parts }: { parts: { key: string; label: string; value: number; fill: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {parts.map((part) => (
        <span key={part.key} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cx("inline-block size-2.5 rounded-[3px]", part.fill)} />
          {part.label} <span className="text-fg tabular-nums">{dollars(part.value)}</span>
        </span>
      ))}
    </div>
  );
}

/** What became of the merged pull requests: how long they took, what they cost, and the dearest of them. */
function Merged({ factory, metrics: { cycle, cost, expensive } }: { factory: string; metrics: Metrics }) {
  const components = (Object.keys(COMPONENT) as (keyof Components)[])
    .filter((each) => each !== "other" || cost.components.other);
  return (
    <>
      <Section title="Cycle time">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stretched label="Kickoff → PR" stretch={cycle.toPr} />
          <Stretched label="PR → first review" stretch={cycle.toReview} />
          <Stretched label="First review → merge" stretch={cycle.toMerge} />
          <Stretched label="Kickoff → merge" stretch={cycle.total} />
        </div>
      </Section>

      <Section title="Cost per PR">
        <div className="grid gap-3 md:grid-cols-[1fr_2fr_2fr]">
          <Stat label="Cost per PR" title={COST} value={cost.median === null ? "—" : dollars(cost.median)}
                sub={<>median of {cost.prs} merged · work only: what measuring costs is never in it</>} />
          <Table>
            <thead><tr><th>Component</th><th className={num}>Median</th></tr></thead>
            <tbody>
              {components.map((each) => (
                <tr key={each}><td>{COMPONENT[each]}</td><td className={num}>{amount(cost.components[each])}</td></tr>
              ))}
            </tbody>
          </Table>
          <Table>
            <thead><tr><th>Size</th><th>Changed lines</th><th className={num}>Merged</th><th className={num}>Median</th></tr></thead>
            <tbody>
              {cost.sizes.map((line) => (
                <tr key={line.size}>
                  <td className="font-medium">{line.size}</td><td className="text-muted">{SIZE[line.size]}</td>
                  <td className={num}>{line.prs}</td><td className={num}>{amount(line.median)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
        {cost.unsized ? (
          <p className="mt-2 text-xs text-muted">
            {cost.unsized} merged before its station said how big a pull request is, and {cost.unsized === 1 ? "is" : "are"} in no size.
          </p>
        ) : null}
      </Section>

      <Section title="Most expensive pull requests">
        {!expensive.length ? <p className="text-muted">No merged pull request&apos;s cost is known yet.</p> : (
        <Table>
          <thead>
            <tr><th>Pull request</th><th>Session</th><th>Size</th><th className={num} title={COST}>Cost</th><th title={AUTONOMY}>Autonomous</th></tr>
          </thead>
          <tbody>
            {expensive.map((line) => (
              <tr key={`${line.session} ${line.url}`}>
                <td><a href={line.url} className="tabular-nums">#{prNumber(line.url) || "?"}</a></td>
                <td><Link href={sessionHref(factory, line.session)} className="font-mono text-[13px]">{line.session}</Link></td>
                <td className="whitespace-nowrap tabular-nums">
                  {line.size === null || line.lines === null ? <span className="text-muted">not said</span> : `${line.size} · ${formatNumber(line.lines)} lines`}
                </td>
                <td className={num}>{dollars(line.cost)}</td>
                <td className={cx(!line.autonomous && "text-muted")}>{line.autonomous ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        )}
      </Section>
    </>
  );
}

/** One leg of the cycle on a card: its median, and of how many merged pull requests. */
function Stretched({ label, stretch }: { label: string; stretch: Stretch }) {
  return (
    <Stat label={label} title={CYCLE} value={stretch.median === null ? "—" : formatDuration(stretch.median)}
          sub={stretch.prs ? `median of ${stretch.prs} merged` : "none to time"} />
  );
}

/** A median amount in USD, or a dash where there is none to take. */
function amount(value: number | null): string {
  return value === null ? "—" : dollars(value);
}
