/**
 * A session's chapters as rows (#188): one a workflow's passage through it
 * (CONTEXT.md), with what started it and when — what the Measure tab counts
 * chapters by trigger from, without reading an event.
 *
 * A chapter's TRIGGER is what it answers, as its `workflow_started` says
 * (`input`): a prompt someone typed, an issue someone labelled, or a pull
 * request's review — the comments people left on one. A session's own
 * trigger is learned once and never unlearned, so it would count every
 * review chapter of an issue's session as the issue again.
 */
import { Payload } from "./payload";
import type { StoredEvent } from "./wire";

export interface ChapterRow {
  chapter: number;
  workflow: string;
  /** prompt | issue | pr: what started it. */
  trigger: string;
  /** When it started, epoch ms: what a period takes it by. */
  at: number;
}

/** Every trigger a chapter has, in the order Metrics lists them. */
export const TRIGGERS = ["prompt", "issue", "pr"] as const;

/** The versions of each kind the rows fold. */
const FOLDED: Record<string, number[]> = { workflow_started: [1, 2] };

/** The versions of `kind` the rows fold, or [] for a kind they take nothing from (tests/measure.test.ts holds the corpus to it). */
export function foldedVersions(kind: string): number[] {
  return FOLDED[kind] ?? [];
}

/**
 * The chapters `events` started, in seq order. One `workflow_started` opens
 * each — a resume continues its chapter and says so otherwise — and an event
 * whose timestamp cannot be read happened at `fallback`, when the cockpit took it in.
 */
export function chaptersIn(events: StoredEvent[], fallback: number): ChapterRow[] {
  return [...events].sort((a, b) => a.seq - b.seq)
    .filter((event) => foldedVersions(event.kind).includes(event.v))
    .map((event) => {
      const p = Payload.parse(event.payload);
      const at = Date.parse(event.ts);
      return { chapter: p.num("chapter"), workflow: p.str("workflow"), trigger: p.str("input"), at: Number.isNaN(at) ? fallback : at };
    });
}

export interface TriggerLine {
  trigger: string;
  chapters: number;
}

/** `chapters` counted by trigger: every one there is, at none too, then any a newer factory writes. */
export function byTrigger(chapters: Pick<ChapterRow, "trigger">[]): TriggerLine[] {
  const triggers = new Set<string>([...TRIGGERS, ...chapters.map((row) => row.trigger)]);
  return [...triggers].map((trigger) => ({ trigger, chapters: chapters.filter((row) => row.trigger === trigger).length }));
}
