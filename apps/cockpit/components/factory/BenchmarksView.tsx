"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { type CSSProperties, type ReactNode, useState } from "react";
import type { Benchmarks } from "@/convex/measure";
import { type BenchmarkLine, type MetricLine, type Reading, sizeOf, type Value, valueOf } from "@/convex/model/benchmarks";
import { About, Named } from "../About";
import { formatAgoAt, plural, sessionHref } from "../format";
import { Card, cx, Notice } from "../ui";

/**
 * The Measure tab's Benchmarks view (#199): an accordion, newest first, one
 * benchmark open at a time. A row sits on the comparison's own grid — the
 * benchmark, one cell per variant over its column, how far it got — so a
 * variant heads the column it is compared in. The open one compares each
 * metric as value ± run-to-run noise per variant, drawn as a dot and a whisker
 * on the row's own scale, with a reading of the difference in words. Pure:
 * `benchmarks` is the query's answer, and `open` the benchmark open.
 *
 * Each variant has a colour of its own, a categorical series and never a
 * status colour (globals.css), on its column's tint and its marks. No colour,
 * sign or word says better or worse: a benchmark names no winner, a person
 * decides, and which way is better is said only in each metric's (i).
 */
export function BenchmarksView({ factory, benchmarks, open, onOpen, now }: {
  factory: string;
  benchmarks: Benchmarks;
  open: string | null;
  onOpen: (benchmark: string | null) => void;
  now: number;
}) {
  if (!benchmarks.described) {
    return (
      <Notice>
        No self-description yet: a factory&apos;s benchmarks are what its own <code>asf check --json</code> names, pushed by a CI
        station from the default branch.
      </Notice>
    );
  }
  if (!benchmarks.benchmarks.length) {
    return (
      <Notice>
        No benchmark is defined. A benchmark is one committed <code>asf/benchmarks/&lt;name&gt;.yaml</code>: past sessions&apos;
        requests worked again under two or more variants. <code>asf benchmark new --from-scorer &lt;scorer&gt;</code> seeds one
        from the sessions a scorer cited. A factory stamped before 1.3 describes none.
      </Notice>
    );
  }
  const widest = Math.max(...benchmarks.benchmarks.map((line) => line.variants.length));
  return (
    <Card className="overflow-hidden">
      <Legend widest={widest} />
      <ul className="divide-y divide-line">
        {benchmarks.benchmarks.map((line) => {
          const opened = line.name === open;
          return (
            <li key={line.name}>
              <button type="button" aria-expanded={opened} data-row={line.name} onClick={() => onOpen(opened ? null : line.name)}
                      style={grid(line.variants.length)}
                      className={cx(ROW, "group w-full cursor-pointer items-stretch text-left", opened ? "bg-surface-2" : "hover:bg-surface-2/60")}>
                <RowHead line={line} opened={opened} now={now} />
              </button>
              {opened ? <Comparison factory={factory} line={line} /> : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ── the variants' colours and the grid they share ───────────────────────────

/** A variant's marks and fills, by its place in the benchmark. A third variant, which no series token draws yet, is grey. */
const SERIES = [
  { dot: "bg-series-1", tint: "bg-series-1/10", whisker: "bg-series-1/45", edge: "border-t-series-1" },
  { dot: "bg-series-2", tint: "bg-series-2/10", whisker: "bg-series-2/45", edge: "border-t-series-2" },
] as const;
const UNSERIED = { dot: "bg-faint", tint: "bg-faint/10", whisker: "bg-faint/45", edge: "border-t-faint" };
const series = (index: number) => SERIES[index] ?? UNSERIED;

/** The comparison's columns — the metric, one per variant, the plot, the reading — which a benchmark's row shares. */
function colsOf(count: number): string {
  return `minmax(11rem,1.2fr) repeat(${count}, minmax(7.5rem,0.8fr)) minmax(10rem,1.6fr) minmax(9rem,0.9fr)`;
}

const grid = (count: number) => ({ "--cols": colsOf(count) }) as CSSProperties;

/** On a narrow screen a row is its name and how far it got; the variants head their columns from lg up. */
const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center lg:grid-cols-(--cols)";

const BENCHMARK = <>
  <p>A named list of past sessions&apos; requests, each pinned at the commit it started from, worked again under two or more <b>variants</b>, each a set number of times — <code>asf/benchmarks/&lt;name&gt;.yaml</code>, worked by <code>asf benchmark run</code> on a station.</p>
  <p>Its sessions are never published, integrated or reported on the tracker, are paid from the <code>measurement:</code> budget, and count toward no metric and no self-improvement.</p>
  <p>It names no winner: read each difference against the noise, then decide — merge the pull request, or don&apos;t.</p>
</>;

/** The column names, once, over the rows — each with what it means, since a row is a button and cannot hold an (i). */
function Legend({ widest }: { widest: number }) {
  return (
    <div className={cx(ROW, "hidden border-b border-line py-2 text-xs font-medium text-muted lg:grid")} style={grid(widest)}>
      <span className="px-4"><Named title="Benchmark" about={BENCHMARK}>Benchmark</Named></span>
      <span className="px-3" style={{ gridColumn: `span ${widest} / span ${widest}` }}>
        <Named title="Variants" about={<>
          <p>One configuration of the factory under benchmark each, named by a git ref of its files: the default branch, or a branch such as a self-improvement pull request&apos;s.</p>
          <p>Models, prose, task files and workflow options all vary the same way — by being committed. Each variant heads its own column, in its own colour, in every mark of the comparison.</p>
        </>}>Variants</Named>
      </span>
      <span className="col-span-2 justify-self-end px-4">
        <Named title="Sessions worked" about={<>
          <p>How many of the benchmark&apos;s sessions — each task, under each variant, each repetition — have ended, however they ended, of all it plans.</p>
          <p><b>working</b> while one is being worked; <b>stopped partway</b> when none is and some are still to work — the day&apos;s <code>measurement:</code> budget ran out, and <code>asf benchmark run</code> goes on where it stopped.</p>
        </>}>Sessions worked</Named>
      </span>
    </div>
  );
}

const STATE = { "not worked": "not worked yet", working: "working", partway: "stopped partway", finished: "finished" } as const;

function RowHead({ line, opened, now }: { line: BenchmarkLine; opened: boolean; now: number }) {
  const { progress } = line;
  return (
    <>
      <span className="flex min-w-0 flex-col justify-center px-4 py-3">
        <span className="truncate font-mono text-[14px] font-medium">{line.name}</span>
        <span className="text-xs text-muted tabular-nums">
          {plural(line.tasks.length, "task")} × {plural(line.variants.length, "variant")} × {plural(line.repetitions, "repetition")}
        </span>
      </span>
      {line.variants.map((variant, index) => (
        // Open, the cell takes its column's tint and edge, so the column runs unbroken from the row down.
        <span key={variant.label} className={cx("relative hidden min-w-0 flex-col justify-center border-t-[3px] px-3 py-3 lg:flex",
                                                opened ? cx("bg-surface", series(index).edge) : "border-t-transparent")}>
          {opened ? <span className={cx("pointer-events-none absolute inset-0", series(index).tint)} /> : null}
          <span className="relative flex items-center gap-1.5 text-sm font-semibold">
            <span aria-hidden className={cx("size-2.5 shrink-0 rounded-full", series(index).dot)} />
            <span className="whitespace-nowrap">{variant.label}</span>
          </span>
        </span>
      ))}
      <span className="flex flex-col items-end justify-center gap-1 px-4 py-3 lg:col-span-2">
        <span className="text-xs text-muted">
          {line.state === "finished" && progress.finishedAt !== null ? `finished ${formatAgoAt(progress.finishedAt, now)}` : STATE[line.state]}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted">
          <span role="progressbar" aria-label={`${line.name}: sessions worked`} aria-valuenow={progress.worked} aria-valuemin={0}
                aria-valuemax={progress.planned} className="block h-1.5 w-14 overflow-hidden rounded-full bg-line">
            <span className="block h-full rounded-full bg-fg/45" style={{ width: `${progress.planned ? (progress.worked / progress.planned) * 100 : 0}%` }} />
          </span>
          <span className="tabular-nums">{progress.worked}/{progress.planned}</span>
        </span>
      </span>
    </>
  );
}

// ── the open benchmark ──────────────────────────────────────────────────────

/** What a metric is called, in what it is counted, and what it means — the only place that says which way is better. */
function labelOf(metric: MetricLine): { name: string; label: ReactNode; per: string; about: ReactNode } {
  if (metric.scorer !== null) {
    return {
      name: `${metric.scorer} failing`, per: "of sessions",
      label: <><span className="font-mono text-[13px]">{metric.scorer}</span> failing</>,
      about: <><p>The share of this variant&apos;s benchmark sessions that the scorer <b>{metric.scorer}</b> scored in a failing class — of the sessions it scored.</p><p><b>Lower is better</b>: fewer sessions went wrong the way this scorer looks for.</p></>,
    };
  }
  return {
    accepted: {
      name: "Accepted", label: "Accepted", per: "of sessions",
      about: <><p>The share of sessions the factory finished as accepted — the same acceptance an ordinary session ends with.</p><p><b>Higher is better.</b></p></>,
    },
    corrections: {
      name: "Corrections", label: "Corrections", per: "a session",
      about: <><p>How many times, on average, a session&apos;s agent was sent back to correct itself: an envelope that did not parse, or a round of gates that failed.</p><p><b>Fewer is better.</b></p></>,
    },
    cost: {
      name: "Cost", label: "Cost", per: "a session",
      about: <><p>What a session spent on average, at the provider&apos;s list price. Benchmark sessions are paid from the <code>measurement:</code> budget and never count toward cost per PR.</p><p><b>Less is better</b> — when the other metrics hold.</p></>,
    },
    duration: {
      name: "Duration", label: "Duration", per: "a session",
      about: <><p>How long a session took on average, start to finish.</p><p><b>Shorter is better</b> — when the other metrics hold.</p></>,
    },
  }[metric.key]!;
}

/**
 * The comparison and the tasks it pinned. The row above names each variant
 * over its column, so the comparison's header holds each one's ref and the
 * commit it was compared at.
 */
function Comparison({ factory, line }: { factory: string; line: BenchmarkLine }) {
  const [tasks, setTasks] = useState(false);
  const { variants } = line;
  const [first] = variants;
  const later = variants.slice(1);
  return (
    <div data-comparison="" className="border-t border-line">
      {line.state === "not worked" ? (
        <div className="px-4 py-3">
          <Notice>Not worked yet: <code>asf benchmark run {line.name}</code> on a station works each task {plural(line.repetitions, "time")} under each variant.</Notice>
        </div>
      ) : (
        <div className="overflow-x-auto bg-surface">
          <div className="grid min-w-[44rem]" style={{ gridTemplateColumns: colsOf(variants.length) }}>
            <div className="flex items-center px-4 py-2.5 text-xs font-medium text-muted">Metric</div>
            {variants.map((variant, index) => (
              <div key={variant.label} className={cx("flex min-w-0 items-center px-3 py-2.5", series(index).tint)}>
                <span className="min-w-0 truncate font-mono text-xs text-muted" title={`${variant.ref} at ${variant.commit ?? "—"}`}>
                  {variant.ref}{variant.commit ? ` @ ${variant.commit.slice(0, 7)}` : ""}
                </span>
              </div>
            ))}
            <div className="flex items-center px-4 py-2.5 text-xs font-medium text-muted">
              <Named title="Value ± run-to-run noise" about={<>
                <p>Each variant worked the same pinned tasks {plural(line.repetitions, "time")}. The <b>value</b> is the average over those repetitions of what each came to; <b>±</b> is the <b>run-to-run noise</b>, one standard deviation: how far the number moves when the same variant works the same tasks again.</p>
                <p>Drawn: the <b>dot</b> is the value, the <b>whisker</b> its noise, on a scale that fits each row alone. Whiskers that overlap a lot mean the difference may be chance.</p>
                <p>More repetitions or more tasks make the noise smaller; one repetition leaves it unknown.</p>
              </>}>Value ± run-to-run noise</Named>
            </div>
            <div className="flex items-center px-4 py-2.5 text-xs font-medium text-muted">
              <Named title={`${later.map((each) => each.label).join(", ")} against ${first.label}`} about={<>
                <p>How each later variant differs from <b>{first.label}</b>, in the metric&apos;s own unit: &ldquo;27 pts lower&rdquo; means its value is 27 percentage points below {first.label}&apos;s.</p>
                <p>Whether lower is good depends on the metric — each metric&apos;s (i) says.</p>
                <p><b>More than the noise</b>: the difference is bigger than both variants&apos; noise together (√(σ₁² + σ₂²)), so it is unlikely to be chance. <b>Within the noise</b>: it could be chance — add repetitions before reading anything into it.</p>
              </>}>{later.map((each) => each.label).join(", ")} against {first.label}</Named>
            </div>

            {line.metrics.map((metric) => <MetricRow key={metric.key} metric={metric} line={line} />)}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-line bg-surface-2/40 px-4 py-2.5 text-xs text-muted">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <button type="button" aria-expanded={tasks} onClick={() => setTasks(!tasks)} className="inline-flex cursor-pointer items-center gap-1 font-medium hover:text-fg">
            <ChevronRight size={12} aria-hidden className={cx("transition-transform", tasks && "rotate-90")} />
            {plural(line.tasks.length, "pinned task")}
          </button>
          <span className="grow" />
          <span>Noise is one standard deviation over {plural(line.repetitions, "repetition")}. No winner is declared: read each difference against the noise.</span>
        </div>
        {line.progress.notComparable ? (
          <p>
            {plural(line.progress.notComparable, "session")} could not be compared: it reached a gate no person answered in the
            session it re-works. It is counted as worked, and in no metric.
          </p>
        ) : null}
        {line.progress.unpaired ? (
          <p>
            {plural(line.progress.unpaired, "session")} {line.progress.unpaired === 1 ? "is" : "are"} in no value yet: a task&apos;s
            repetition is compared once every variant has a session of it to compare.
          </p>
        ) : null}
        {tasks ? (
          <ul className="grid gap-1.5 pb-1 md:grid-cols-2">
            {line.tasks.map((task) => (
              <li key={task.session} className="rounded-md border border-line bg-surface px-2.5 py-1.5">
                <div className="text-sm text-fg">{task.request || "(no request recorded)"}</div>
                <div>from <Link href={sessionHref(factory, task.session)} className="font-mono">session {task.session}</Link> at <code>{task.commit.slice(0, 12)}</code></div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function MetricRow({ metric, line }: { metric: MetricLine; line: BenchmarkLine }) {
  const { name, label, per, about } = labelOf(metric);
  return (
    <div className="contents">
      <div className="flex flex-col justify-center border-t border-line px-4 py-2.5">
        <span className="text-sm">{label} <About title={name}>{about}</About></span>
        <span className="text-xs text-muted">{per}</span>
      </div>
      {metric.values.map((value, index) => (
        <div key={line.variants[index].label} className={cx("flex flex-col justify-center border-t border-line px-3 py-2.5", series(index).tint)}>
          {value ? (
            <>
              <span className="text-lg leading-tight font-semibold tabular-nums">{valueOf(metric.unit, value.mean)}</span>
              <span className="text-xs text-muted tabular-nums">{value.noise === null ? "one repetition" : `± ${sizeOf(metric.unit, value.noise)}`}</span>
            </>
          ) : <span className="text-muted">—</span>}
        </div>
      ))}
      <div className="flex items-center border-t border-line px-4 py-2.5">
        <span className="w-full"><RangePlot metric={metric} line={line} /></span>
      </div>
      <div className="flex flex-col justify-center gap-1.5 border-t border-line px-4 py-2.5 text-sm">
        {metric.readings.map((reading, index) => (index === 0 ? null
          : <Said key={line.variants[index].label} reading={reading} named={line.variants.length > 2} />))}
      </div>
    </div>
  );
}

/** A later variant against the first, in words: "27 pts lower", then whether that is more than the noise. */
function Said({ reading, named }: { reading: Reading | null; named: boolean }) {
  if (reading === null) return <span className="text-muted">—</span>;
  const clear = reading.noise === "more than the noise";
  return (
    <span className="flex flex-col">
      <span className={cx("font-medium tabular-nums", clear ? "text-fg" : "text-muted")}>
        {named ? `${reading.variant}: ` : ""}{reading.words}
      </span>
      <span className={cx("text-xs", clear ? "text-fg" : "text-muted")}>{reading.noise}</span>
    </span>
  );
}

/**
 * Each variant's value as a dot, its noise as a whisker, on a scale that fits
 * this row alone — a share never past 0–100%. The cells beside it say the
 * same in numbers, so the drawing is hidden from a screen reader; a dot says
 * its numbers on hover.
 */
function RangePlot({ metric, line }: { metric: MetricLine; line: BenchmarkLine }) {
  const present = metric.values.filter((value): value is Value => value !== null);
  if (!present.length) return null;
  const noiseOf = (value: Value) => value.noise ?? 0;
  let lo = Math.min(...present.map((value) => value.mean - noiseOf(value)));
  let hi = Math.max(...present.map((value) => value.mean + noiseOf(value)));
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.15 || 1;
  lo -= pad; hi += pad;
  // Nothing compared here is below zero, and a share is never past 100%.
  lo = Math.max(0, lo);
  if (metric.unit === "share") hi = Math.min(1, hi);
  const at = (value: number) => `${((Math.min(hi, Math.max(lo, value)) - lo) / (hi - lo)) * 100}%`;
  return (
    // Inset by a dot's radius, so a dot at either end of the scale is drawn whole.
    <div aria-hidden className="relative mx-1.5 min-w-32" style={{ height: `${8 + metric.values.length * 12}px` }}>
      <span className="absolute -inset-x-1.5 top-1/2 h-px bg-line" />
      {metric.values.map((value, index) => {
        if (value === null) return null;
        const { label } = line.variants[index];
        const said = `${label}: ${valueOf(metric.unit, value.mean)}${value.noise === null ? "" : ` ± ${sizeOf(metric.unit, value.noise)}`}`;
        return (
          <span key={label} className="absolute inset-x-0" style={{ top: `${8 + index * 12}px` }}>
            <span className={cx("absolute h-1 -translate-y-1/2 rounded-full", series(index).whisker)}
                  style={{ left: at(value.mean - noiseOf(value)), width: `calc(${at(value.mean + noiseOf(value))} - ${at(value.mean - noiseOf(value))})` }} />
            <span data-dot={label} title={said}
                  className={cx("absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface", series(index).dot)}
                  style={{ left: at(value.mean) }} />
          </span>
        );
      })}
    </div>
  );
}
