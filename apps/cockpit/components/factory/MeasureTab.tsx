import type { Metrics } from "@/convex/measure";
import { cx, Loading, Notice, pillClass, Section } from "../ui";
import { OVERVIEW_DAYS, type OverviewDays, PeriodFilter, Stat } from "./OverviewTab";

/**
 * The Measure tab's views, in the order its sub-navigation lists them. Metrics
 * first and alone for now; Scorers and Benchmarks join it here (#182).
 */
export const MEASURE_VIEWS = { metrics: "Metrics" } as const;
export type MeasureView = keyof typeof MEASURE_VIEWS;

const AUTONOMY = "The share of merged pull requests that were autonomous: opened by the factory's own session, " +
  "and every commit of it at merge made by that session, or a merge from the base branch. Review rounds " +
  "driven by people's comments keep a pull request autonomous; a single push by a person does not.";

/**
 * A factory's Measure tab (#184): how the factory measures its own work. One
 * filter row — the view, then the period, the Overview's own — over the view
 * open. Pure: `metrics` is the query's answer, undefined while it is asked and
 * null for a factory the viewer may not read.
 */
export function MeasureTab({ metrics, view, onView, days, midnights, timeZone, onDays }: {
  metrics: Metrics | null | undefined;
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
        <PeriodFilter days={days} midnights={midnights} timeZone={timeZone} onDays={onDays} />
      </div>
      {metrics === undefined ? <Loading />
        : metrics === null ? <Notice>This is not a factory you can read.</Notice>
        : metrics.cut ? <Notice>More happened in the {period} than the cockpit counts at once: pick a shorter period.</Notice>
        : <MetricsView metrics={metrics} period={period} />}
    </div>
  );
}

function MetricsView({ metrics: { opened, merged, autonomous, autonomy }, period }: { metrics: Metrics; period: string }) {
  if (!opened && !merged) {
    return (
      <Notice>
        No pull request was opened or merged in the {period}. A merge reaches the cockpit when a
        station&apos;s pull request watcher (<code>asf prs</code>) sees the pull request closed, or
        when <code>asf score</code> asks the forge for a factory no watcher ran for.
      </Notice>
    );
  }
  return (
    <Section title="Pull requests">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Stat label="Pull requests opened" value={opened} sub="by the factory's own sessions" />
        <Stat label="Merged" value={merged} sub={`in the ${period}`} />
        <Stat label="Autonomy" title={AUTONOMY} value={autonomy === null ? "—" : `${Math.round(autonomy * 100)}%`}
              sub={autonomy === null ? "nothing merged yet" : `${autonomous} of ${merged} merged needed no human push`} />
      </div>
    </Section>
  );
}
