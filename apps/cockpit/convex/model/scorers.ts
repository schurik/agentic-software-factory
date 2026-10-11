/**
 * The Measure tab's Scorers view (#190), worked out from the rows ingest keeps
 * of each session's scores (model/scores.ts) and the scorers the factory's own
 * self-description names, with the threshold it resolved for each — never
 * from an event, never from the forge (ADR 0006).
 *
 * Two windows, which need not be the same sessions:
 *
 *   the STRIP     the factory's last `STRIP` sessions, oldest first, the same
 *                 for every scorer — so one session sits at one place in every
 *                 strip — each judged by the scorer or not;
 *   the COUNTED   the sessions a self-improvement threshold counts: the last
 *                 `ofLast` distinct sessions the scorer judged, however far
 *                 back that reaches — and, once a self-improvement pull
 *                 request for the scorer merged (#196), by the chapters that
 *                 started after it alone, as the station counts them: the
 *                 failures it was meant to fix are not evidence against it.
 */
import type { DescribedScorer, Threshold } from "./description";
import type { Improvement, Improvements, Merged } from "./improvements";
import type { ChapterScore } from "./scores";

/** How many of the factory's latest sessions the strip spans. */
export const STRIP = 30;

/** How many sessions a threshold counts: its `ofLast`, and at least one. */
export const windowOf = (threshold: Threshold) => Math.max(1, threshold.ofLast);

/** One session as a scorer's row has it: where it stands among the factory's, and its chapters' scores. */
export interface Judged {
  session: string;
  at: number;
  failing: boolean;
  chapters: ChapterScore[];
}

/** One session of the strip, as one scorer saw it. */
export interface Mark {
  session: string;
  /** Whether the scorer judged any chapter of it: not, for another workflow's, one not sampled, one still running. */
  judged: boolean;
  failing: boolean;
  /** Whether it is among the sessions counted toward the threshold. */
  counted: boolean;
}

/** The first event a failing score cites, as the session page names it, and the phase it is in ("" for none). */
export interface Cite {
  seq: number;
  detail: string;
  phaseId: string;
}

/** A failing counted session: its latest failing chapter, the class it was given, and the first event it cites. */
export interface Failing {
  session: string;
  chapter: number;
  class: string;
  cite: Cite | null;
}

/** Where the scorer's self-improvement last merged, and where on the strip that falls. */
export interface MergePoint extends Merged {
  /** How many of the strip's sessions the cockpit stored before it merged: where its rule is drawn. Null when it merged before the strip begins. */
  index: number | null;
}

/** One session of the strip: its id, and when the cockpit first stored it, epoch ms. */
export interface Stored {
  session: string;
  at: number;
}

export interface ScorerLine {
  name: string;
  /** code | judge */
  kind: string;
  workflow: string;
  /** "": the whole chapter. */
  focus: string;
  sampleRate: number;
  classes: DescribedScorer["classes"];
  /** The resolved threshold: the scorer's own `improve_after:`, else the factory's `self_improvement:`. */
  threshold: Threshold;
  /** `sample_rate: 0`: present, and judging nothing. */
  inactive: boolean;
  /** The factory's last sessions, oldest first. */
  strip: Mark[];
  /** The sessions counted toward the threshold, oldest first: at most `threshold.ofLast`. */
  counted: { session: string; failing: boolean }[];
  /** How many of the counted failed. */
  failures: number;
  /** The share of failing sessions among the strip's judged sessions before the counted ones, and among the counted; null over none. */
  shares: { before: number | null; counted: number | null };
  /** The counted sessions that failed, newest first. */
  failing: (Omit<Failing, "cite"> & { seq: number | null })[];
  /** The latest self-improvement merge for the scorer: what it counts from. Null before any. */
  merge: MergePoint | null;
  /** Its open self-improvement issue; null while none is. */
  issue: Improvement | null;
  /** Its other self-improvement issues, newest first. */
  past: Improvement[];
}

const NOTHING: Improvements = { open: null, past: [], merge: null };

/** `row` as counted after a merge at `after`: the chapters that started since, alone; null when none did. */
function since(row: Judged, after: number | null): Judged | null {
  if (after === null) return row;
  const chapters = row.chapters.filter((each) => (each.startedAt ?? row.at) > after);
  return chapters.length ? { ...row, chapters, failing: chapters.some((each) => each.failing) } : null;
}

const share = (sessions: { failing: boolean }[]): number | null =>
  (sessions.length ? sessions.filter((each) => each.failing).length / sessions.length : null);

/**
 * One scorer's line: `strip` is the factory's last sessions, oldest first;
 * `judged` every row of the scorer's the view read — those in the strip, and
 * its latest `ofLast` since its last self-improvement merge — in any order,
 * each once; `improvements` its self-improvement (model/improvements.ts).
 */
export function scorerLine(scorer: DescribedScorer, strip: Stored[], judged: Judged[], improvements: Improvements = NOTHING): ScorerLine {
  const threshold = scorer.improveAfter;
  const merged = improvements.merge;
  const latest = judged.flatMap((row) => since(row, merged?.at ?? null) ?? [])
    .sort((a, b) => a.at - b.at).slice(-windowOf(threshold));
  const counted = new Set(latest.map((row) => row.session));
  const bySession = new Map(judged.map((row) => [row.session, row]));
  const before = merged === null ? 0 : strip.filter((each) => each.at <= merged.at).length;
  const marks = strip.map(({ session }): Mark => {
    const row = bySession.get(session);
    return { session, judged: row !== undefined, failing: row?.failing ?? false, counted: counted.has(session) };
  });
  return {
    name: scorer.name, kind: scorer.kind, workflow: scorer.workflow, focus: scorer.focus, sampleRate: scorer.sampleRate,
    classes: scorer.classes, threshold, inactive: scorer.sampleRate === 0,
    strip: marks,
    counted: latest.map((row) => ({ session: row.session, failing: row.failing })),
    failures: latest.filter((row) => row.failing).length,
    shares: { before: share(marks.filter((mark) => mark.judged && !mark.counted)), counted: share(latest) },
    failing: latest.filter((row) => row.failing).reverse().map((row) => {
      const chapter = row.chapters.findLast((each) => each.failing)!;
      return { session: row.session, chapter: chapter.chapter, class: chapter.class, seq: chapter.evidence[0] ?? null };
    }),
    merge: merged === null ? null : { ...merged, index: before === 0 && strip.length ? null : before },
    issue: improvements.open,
    past: improvements.past,
  };
}

/** How many more failing sessions open an issue; 0 at the threshold or past it. */
export function leftOf(line: Pick<ScorerLine, "threshold" | "failures">): number {
  return Math.max(0, line.threshold.failures - line.failures);
}

/** `lines` nearest their threshold first — fewest failing sessions short of it, then the most counted — and the inactive last. */
export function ordered<T extends Pick<ScorerLine, "name" | "inactive" | "threshold" | "failures" | "counted">>(lines: T[]): T[] {
  return [...lines].sort((a, b) => Number(a.inactive) - Number(b.inactive) || leftOf(a) - leftOf(b) ||
                                   b.counted.length - a.counted.length || a.name.localeCompare(b.name));
}
