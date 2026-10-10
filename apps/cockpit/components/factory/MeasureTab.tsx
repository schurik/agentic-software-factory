import Link from "next/link";
import type { Metrics, Scorers } from "@/convex/measure";
import type { Size, Stretch } from "@/convex/model/measure";
import type { Components } from "@/convex/model/pulls";
import { formatDollars as dollars, formatDuration, formatNumber, plural, prNumber, sessionHref } from "../format";
import { cx, Loading, Notice, num, pillClass, Section, Table } from "../ui";
import { OVERVIEW_DAYS, type OverviewDays, PeriodFilter, Stat } from "./OverviewTab";
import { ScorersView } from "./ScorersView";
import { tabHref } from "./view";

/**
 * The Measure tab's views, in the order its sub-navigation lists them: Metrics,
 * then Scorers (#190); Benchmarks joins them here (#182).
 */
export const MEASURE_VIEWS = { metrics: "Metrics", scorers: "Scorers" } as const;
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

const TRIGGERED = "What started each chapter that began in the period: a prompt someone typed, an issue someone " +
  "labelled, or a round of review comments on a pull request.";

/**
 * A factory's Measure tab (#184, #188, #190): how the factory measures its own
 * work. One filter row — the view, then, on Metrics, the period, the
 * Overview's own: a scorer counts sessions, not days — over the view open.
 * Pure: `metrics` and `scorers` are the queries' answers, undefined while
 * they are asked and null for a factory the viewer may not read.
 */
export function MeasureTab({ factory, metrics, scorers, openScorer, onOpenScorer, view, onView, days, midnights, timeZone, onDays }: {
  /** The factory's repository, `owner/name`: what its sessions and its Overview are addressed by. */
  factory: string;
  metrics: Metrics | null | undefined;
  scorers: Scorers | null | undefined;
  /** The scorer open in the Scorers view's accordion, by name: one at a time, or none. */
  openScorer: string | null;
  onOpenScorer: (scorer: string | null) => void;
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
      {view === "scorers" ? (
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
 * chapters by trigger. A period with none of it is one sentence.
 */
function MetricsView({ factory, metrics, period }: { factory: string; metrics: Metrics; period: string }) {
  const { opened, merged, autonomous, autonomy, chapters } = metrics;
  if (!opened && !merged && chapters.every((line) => !line.chapters)) {
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
    </>
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
