/**
 * A session's scores as rows (#190): one a scorer that judged any chapter of
 * it, with each chapter's latest score — what the Measure tab's Scorers view
 * reads a factory's sessions from, without reading an event.
 *
 * A self-improvement threshold counts DISTINCT SESSIONS (CONTEXT.md), so the
 * row is the session's, not the chapter's: it is failing when any chapter's
 * latest score is. A chapter scored again — `asf score` after the scorer was
 * fixed — keeps only its latest, the way the session page tells it.
 */
import { Payload } from "./payload";
import type { StoredEvent } from "./wire";

/** One chapter's latest score by the row's scorer. */
export interface ChapterScore {
  chapter: number;
  class: string;
  failing: boolean;
  /** The seqs of the events it cites, in the order it cites them. */
  evidence: number[];
  /** When the chapter started, epoch ms, as its row in `chapters` says; absent when the cockpit has none. */
  startedAt?: number;
}

export interface ScoreRow {
  scorer: string;
  /** Whether any chapter's latest score is failing: what a threshold counts. */
  failing: boolean;
  chapters: ChapterScore[];
}

/** The versions of each kind the rows fold. */
// v2 adds a judge's `reasoning`, which a row does not carry: the Scorers view reads classes.
const FOLDED: Record<string, number[]> = { chapter_scored: [1, 2] };

/** The versions of `kind` the rows fold, or [] for a kind they take nothing from (tests/measure.test.ts holds the corpus to it). */
export function foldedVersions(kind: string): number[] {
  return FOLDED[kind] ?? [];
}

/**
 * The rows `events` change, folded onto `rows` — the session's as they stand —
 * in seq order. `started` is when each chapter started, by number, where the
 * cockpit knows: what a self-improvement merge is counted from.
 */
export function scoredIn(rows: ScoreRow[], events: StoredEvent[], started: ReadonlyMap<number, number> = new Map()): ScoreRow[] {
  const scored = new Map(rows.map((row) => [row.scorer, structuredClone(row)]));
  const changed = new Set<string>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!foldedVersions(event.kind).includes(event.v)) continue;
    const p = Payload.parse(event.payload);
    const scorer = p.str("scorer");
    const row = scored.get(scorer) ?? { scorer, failing: false, chapters: [] };
    const chapter = p.num("chapter");
    const startedAt = started.get(chapter);
    const score: ChapterScore = { chapter, class: p.str("class"), failing: p.bool("failing"), evidence: p.nums("evidence"),
                                  ...(startedAt === undefined ? {} : { startedAt }) };
    row.chapters = [...row.chapters.filter((each) => each.chapter !== score.chapter), score].sort((a, b) => a.chapter - b.chapter);
    row.failing = row.chapters.some((each) => each.failing);
    scored.set(scorer, row);
    changed.add(scorer);
  }
  return [...changed].map((scorer) => scored.get(scorer)!);
}
