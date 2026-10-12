/**
 * A benchmark's comparison (#199): what the Measure tab's Benchmarks view
 * draws, from the benchmark's sessions' own events (CONTEXT.md, Benchmark).
 *
 * Each session of a benchmark is folded, as its events arrive, into one row —
 * which variant, task and repetition it re-worked, how it ended, what it
 * spent and how long it took, its corrections and the scorers' scores, which
 * come after it ended. A benchmark's comparison is read off those rows:
 *
 *   VALUE   per variant and metric, the mean over its repetitions of what each
 *           repetition came to across the tasks — a share, or a session's average;
 *   NOISE   the run-to-run noise: one (sample) standard deviation of the same,
 *           unknown from a single repetition;
 *   READING each later variant against the first, in words — "27 pts lower",
 *           "$0.80 less", "the same" — and "more than the noise" when
 *           |Δ| > √(σa² + σb²), else "within the noise".
 *
 * A reading never carries a sign to decode and never says "better": which way
 * is better is said only in each metric's (i). A benchmark names no winner.
 *
 * A session that could not be compared (`not comparable`: a gate no person
 * answered in the session it re-works) is worked, never compared; one still
 * running is neither. Variants are compared over the same work: a task's
 * repetition counts only once every variant has a session of it to compare —
 * for a scorer's share, one the scorer scored — so a task one variant could
 * not compare, or has not reached yet, is in neither's value. A variant is compared at the commit its ref last
 * resolved to: once its ref moves, `asf benchmark run` works it again from the
 * start (engine/benchmarks.py), and the sessions at the older commit are a
 * comparison of their own that no longer stands.
 */
import { formatDollars, formatDuration } from "./format";
import { Payload } from "./payload";
import type { BenchmarkOf, Summary } from "./session";
import type { DescribedBenchmark } from "./description";
import type { StoredEvent } from "./wire";

/** How a benchmark's session ended, as the station's own tally says it (engine/benchmark_session.py). */
export type Outcome = "accepted" | "not accepted" | "not comparable" | "failed" | "running";

/** How the session's latest chapter was refused, if it was: what a failed session's outcome is told by. */
type Refusal = "not accepted" | "not comparable" | "failed";

/** One benchmark session, folded. */
export interface BenchmarkedRow extends BenchmarkOf {
  /** Epoch ms; endedAt null while it has not ended. */
  startedAt: number;
  endedAt: number | null;
  status: string;
  refusal: Refusal | null;
  /** List-price equivalent, USD. */
  cost: number;
  /** Envelopes refused, and the rounds of gates that failed, each `<phase_id> <attempt>`. */
  rejected: number;
  rounds: string[];
  /** Each chapter's latest score, by scorer. */
  scores: { scorer: string; chapter: number; failing: boolean }[];
}

/** The versions of each kind the rows fold. */
const FOLDED: Record<string, number[]> = {
  envelope_rejected: [1], gate_result: [1], workflow_finished: [1, 2], chapter_scored: [1, 2],
};

/** The versions of `kind` the rows fold, or [] for a kind they take nothing from (tests/measure.test.ts holds the corpus to it). */
export function foldedVersions(kind: string): number[] {
  return FOLDED[kind] ?? [];
}

/** How the station says a session could not be compared: its reason starts so (engine/benchmark_session.py). */
const NOT_COMPARABLE = "not comparable";

const at = (iso: string): number | null => {
  const parsed = Date.parse(iso);
  return iso && !Number.isNaN(parsed) ? parsed : null;
};

/**
 * `row` — the session's as it stands, or null for none yet — with `events`
 * folded in, in seq order; `summary` is the session's, already advanced past
 * them. Null for a session that is not a benchmark's.
 */
export function benchmarkRowIn(row: BenchmarkedRow | null, events: StoredEvent[], summary: Summary): BenchmarkedRow | null {
  if (summary.benchmark === null) return null;
  const next: BenchmarkedRow = {
    refusal: null, rejected: 0, rounds: [], scores: [], ...structuredClone(row ?? {}),
    ...summary.benchmark,
    // A start the summary could not read is its first event's: never the epoch, which would make it decades long.
    startedAt: at(summary.startedAt) ?? row?.startedAt ?? Math.min(...events.map((event) => at(event.ts) ?? Infinity)),
    endedAt: at(summary.endedAt),
    status: summary.status,
    cost: summary.totalCost,
  };
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!foldedVersions(event.kind).includes(event.v)) continue;
    const p = Payload.parse(event.payload);
    if (event.kind === "envelope_rejected") next.rejected += 1;
    else if (event.kind === "gate_result" && p.value().passed === false) {
      const round = `${p.str("phase_id")} ${p.num("attempt")}`;
      if (!next.rounds.includes(round)) next.rounds.push(round);
    } else if (event.kind === "workflow_finished") {
      next.refusal = p.str("status") === "success" ? null
        : p.str("reason").startsWith(NOT_COMPARABLE) ? "not comparable"
        // `accepted` is v2's: false when every phase passed and the workflow refused the chapter.
        : p.value().accepted === false ? "not accepted" : "failed";
    } else if (event.kind === "chapter_scored") {
      const score = { scorer: p.str("scorer"), chapter: p.num("chapter"), failing: p.bool("failing") };
      next.scores = [...next.scores.filter((each) => each.scorer !== score.scorer || each.chapter !== score.chapter), score];
    }
  }
  return next;
}

export function outcomeOf(row: Pick<BenchmarkedRow, "status" | "refusal">): Outcome {
  if (row.status === "success") return "accepted";
  if (row.status === "fail") return row.refusal ?? "failed";
  return "running";
}

// ── the comparison ───────────────────────────────────────────────────────────

/** What a metric counts in: a share of sessions, a count, USD, seconds. */
export type Unit = "share" | "count" | "usd" | "seconds";

/** A metric's value as a variant's cell says it: "75%", "0.5", "$2.50", "10m". */
export function valueOf(unit: Unit, value: number): string {
  return unit === "share" ? `${Math.round(value * 100)}%` : sizeOf(unit, value);
}

/** A difference, or a noise, in the metric's own unit: "27 pts", "0.5", "$0.80", "3m 05s". */
export function sizeOf(unit: Unit, value: number): string {
  if (unit === "share") return `${Math.round(value * 100)} pts`;
  if (unit === "count") return value.toFixed(1);
  if (unit === "usd") return formatDollars(value);
  // Under half a second is none: a duration's noise of 0 is "0s", never "<1s".
  return value < 0.5 ? "0s" : formatDuration(value);
}

/** How a difference is said in each unit: going down, going up. */
const WORDS: Record<Unit, [down: string, up: string]> = {
  share: ["lower", "higher"], count: ["fewer", "more"], usd: ["less", "more"], seconds: ["shorter", "longer"],
};

export interface Value {
  /** The mean over the repetitions that had any session to count. */
  mean: number;
  /** One sample standard deviation over them; null from one alone. */
  noise: number | null;
  repetitions: number;
}

export type Noise = "more than the noise" | "within the noise" | "noise not known: one repetition";

/** A later variant against the first, in words, never a sign and never "better". */
export interface Reading {
  variant: string;
  against: string;
  /** "27 pts lower", "$0.80 less", "the same". */
  words: string;
  noise: Noise;
}

export interface MetricLine {
  /** `scorer:<name>` for a scorer's failing share; accepted | corrections | cost | duration otherwise. */
  key: string;
  /** The scorer's name, for its failing share; null otherwise. */
  scorer: string | null;
  unit: Unit;
  /** Per variant, in the benchmark's order; null where no session of it counts. */
  values: (Value | null)[];
  /** Per variant: null for the first, and where either side has no value. */
  readings: (Reading | null)[];
}

export type BenchmarkState = "not worked" | "working" | "partway" | "finished";

export interface Progress {
  /** tasks × variants × repetitions. */
  planned: number;
  /** Ended, however it ended. */
  worked: number;
  running: number;
  notComparable: number;
  /** Ended and comparable, but in no value: no other variant has a session of its task and repetition to compare with yet. */
  unpaired: number;
  /** Epoch ms: its first session's start, and the end of its last once every one was worked. */
  startedAt: number | null;
  finishedAt: number | null;
}

export interface BenchmarkLine {
  name: string;
  /** When its latest session started, epoch ms; null before any did. What the view orders by. */
  latest: number | null;
  tasks: DescribedBenchmark["tasks"];
  repetitions: number;
  /** In the definition's order; `commit` is the one compared, null before it was worked. */
  variants: { label: string; ref: string; commit: string | null }[];
  state: BenchmarkState;
  progress: Progress;
  metrics: MetricLine[];
}

/** The mean and sample standard deviation of `values`; null for none. */
function spread(values: number[]): Value | null {
  if (!values.length) return null;
  const mean = values.reduce((sum, each) => sum + each, 0) / values.length;
  if (values.length < 2) return { mean, noise: null, repetitions: 1 };
  const variance = values.reduce((sum, each) => sum + (each - mean) ** 2, 0) / (values.length - 1);
  return { mean, noise: Math.sqrt(variance), repetitions: values.length };
}

/** `b` against `a`, in `unit`'s words — and a difference too small to say is never more than the noise. */
function reading(unit: Unit, a: Value, b: Value, variant: string, against: string): Reading {
  const difference = b.mean - a.mean;
  const size = sizeOf(unit, Math.abs(difference));
  const same = size === sizeOf(unit, 0);
  const words = same ? "the same" : `${size} ${WORDS[unit][difference < 0 ? 0 : 1]}`;
  const noise: Noise = a.noise === null || b.noise === null ? "noise not known: one repetition"
    : !same && Math.abs(difference) > Math.hypot(a.noise, b.noise) ? "more than the noise" : "within the noise";
  return { variant, against, words, noise };
}

const average = (values: number[]) => values.reduce((sum, each) => sum + each, 0) / values.length;
const ended = (row: BenchmarkedRow) => outcomeOf(row) !== "running";

/**
 * `benchmark`, as its default branch describes it, compared over `rows` —
 * every session of it the cockpit holds, at any commit.
 */
export function compare(benchmark: DescribedBenchmark, rows: BenchmarkedRow[]): BenchmarkLine {
  const tasks = new Set(benchmark.tasks.map((task) => task.session));
  const kept = new Map<string, BenchmarkedRow>();
  const variants = benchmark.variants.map(({ label, ref }) => {
    const mine = rows.filter((row) => row.variant === label && tasks.has(row.task) && row.repetition >= 1 && row.repetition <= benchmark.repetitions)
      .sort((a, b) => a.startedAt - b.startedAt);
    const commit = mine.at(-1)?.commit ?? null;
    // One session a slot: the latest started, of the commit compared.
    for (const row of mine.filter((each) => each.commit === commit)) kept.set(`${label} ${row.task} ${row.repetition}`, row);
    return { label, ref, commit };
  });
  const slots = [...kept.values()];
  const planned = benchmark.tasks.length * benchmark.variants.length * benchmark.repetitions;
  const worked = slots.filter(ended);
  // Each task's repetition, with a session of every variant to compare — or fewer, and so compared in none.
  const compared = worked.filter((row) => outcomeOf(row) !== "not comparable");
  const byWork = new Map<string, Map<string, BenchmarkedRow>>();
  for (const row of compared) {
    const work = `${row.repetition} ${row.task}`;
    byWork.set(work, (byWork.get(work) ?? new Map()).set(row.variant, row));
  }
  const paired = [...byWork.values()].filter((each) => each.size === variants.length);
  const progress: Progress = {
    planned, worked: worked.length, running: slots.length - worked.length,
    notComparable: worked.length - compared.length,
    unpaired: compared.length - paired.length * variants.length,
    startedAt: slots.length ? Math.min(...slots.map((row) => row.startedAt)) : null,
    finishedAt: worked.length >= planned && worked.length ? Math.max(...worked.map((row) => row.endedAt ?? row.startedAt)) : null,
  };
  const state: BenchmarkState = !slots.length ? "not worked" : progress.running ? "working"
    : worked.length >= planned ? "finished" : "partway";

  const scorers = [...new Set(compared.flatMap((row) => row.scores.map((score) => score.scorer)))].sort();
  /**
   * Per variant: what each repetition came to over the paired work `of` counts
   * for every variant — null where it counts a session not at all — averaged into a value.
   */
  const metric = (key: string, scorer: string | null, unit: Unit, of: (row: BenchmarkedRow) => number | null): MetricLine => {
    const byRepetition = variants.map(() => new Map<number, number[]>());
    for (const work of paired) {
      const said = variants.map(({ label }) => of(work.get(label)!));
      if (said.some((value) => value === null)) continue;
      const { repetition } = work.get(variants[0].label)!;
      said.forEach((value, index) => byRepetition[index].set(repetition, [...(byRepetition[index].get(repetition) ?? []), value!]));
    }
    const values = byRepetition.map((each) => spread([...each.keys()].sort((a, b) => a - b).map((repetition) => average(each.get(repetition)!))));
    const [first] = values;
    const readings = values.map((value, index) => (index === 0 || first === null || value === null ? null
      : reading(unit, first, value, variants[index].label, variants[0].label)));
    return { key, scorer, unit, values, readings };
  };
  const metrics = [
    ...scorers.map((scorer) => metric(`scorer:${scorer}`, scorer, "share", (row) => {
      const mine = row.scores.filter((score) => score.scorer === scorer);
      return mine.length ? Number(mine.some((score) => score.failing)) : null;
    })),
    metric("accepted", null, "share", (row) => Number(outcomeOf(row) === "accepted")),
    metric("corrections", null, "count", (row) => row.rejected + row.rounds.length),
    metric("cost", null, "usd", (row) => row.cost),
    metric("duration", null, "seconds", (row) => (row.endedAt === null ? null : (row.endedAt - row.startedAt) / 1000)),
  ];
  const latest = slots.length ? Math.max(...slots.map((row) => row.startedAt)) : null;
  return { name: benchmark.name, latest, tasks: benchmark.tasks, repetitions: benchmark.repetitions, variants, state, progress, metrics };
}

/** Newest first — by when each last started a session — and the never worked last, by name. */
export function newestFirst(lines: BenchmarkLine[]): BenchmarkLine[] {
  return [...lines].sort((a, b) => (b.latest ?? -Infinity) - (a.latest ?? -Infinity) || a.name.localeCompare(b.name));
}
