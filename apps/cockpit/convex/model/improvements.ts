/**
 * A scorer's self-improvement (#196), as the Scorers view tells it inside the
 * scorer's item: the issue the factory filed on its own tracker, the pull
 * request a session opened for it, and where that merged — from domain events
 * alone, never the forge (ADR 0006).
 *
 *   an ISSUE      what `improvement_filed` says the factory filed, or added
 *                 new evidence to: one row per scorer and issue number;
 *   its PR        the pull request of a session whose `provenance_recorded`
 *                 says it `improves` the scorer (its issue carried the label),
 *                 as that session's pull request row has it (model/pulls.ts);
 *   the MERGE     the latest of those pull requests to merge — what the
 *                 scorer counts from afterwards, as the station does.
 *
 * An issue is OPEN until a pull request for it merges, or the factory files a
 * newer one for the scorer: the factory files only while none is open, so a
 * newer one says the older closed, however it did. Every other is past.
 */
import { Payload } from "./payload";
import { prNumber } from "./session";
import type { StoredEvent } from "./wire";

/** One issue self-improvement filed for a scorer, as its `improvement_filed` said it. */
export interface IssueRow {
  scorer: string;
  number: number;
  url: string;
  title: string;
  /** The diagnosis's cause; "" when none was made, or the row is known only from a comment. */
  cause: string;
  /** factory | application; "" without a diagnosis. */
  surface: string;
  /** Why no diagnosis was made; "" when one was. */
  notDiagnosed: string;
  /** When it was filed — or, known only from a comment, when that was — epoch ms. */
  at: number;
}

/** The versions of each kind the rows fold. */
const FOLDED: Record<string, number[]> = { improvement_filed: [1] };

/** The versions of `kind` the rows fold, or [] for a kind they take nothing from (tests/measure.test.ts holds the corpus to it). */
export function foldedVersions(kind: string): number[] {
  return FOLDED[kind] ?? [];
}

/**
 * The issue rows `events` change, folded onto `known` — each scorer's and
 * number's as stored — in seq order. A filing says everything about its
 * issue; a comment adds nothing to one known, and makes one known that was
 * filed where the cockpit never heard (an older factory's, say).
 */
export function filedIn(known: IssueRow[], events: StoredEvent[], fallback: number): IssueRow[] {
  const rows = new Map(known.map((row) => [`${row.scorer}#${row.number}`, row]));
  const changed = new Map<string, IssueRow>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!foldedVersions(event.kind).includes(event.v)) continue;
    const p = Payload.parse(event.payload);
    const key = `${p.str("scorer")}#${p.num("number")}`;
    const there = rows.get(key);
    if (there !== undefined && p.bool("commented")) continue;
    const at = Date.parse(event.ts);
    const row: IssueRow = {
      scorer: p.str("scorer"), number: p.num("number"), url: p.str("url"), title: p.str("title"),
      cause: p.str("cause"), surface: p.str("surface"), notDiagnosed: p.str("not_diagnosed"),
      at: there?.at ?? (Number.isNaN(at) ? fallback : at),
    };
    rows.set(key, row);
    changed.set(key, row);
  }
  return [...changed.values()];
}

/** A pull request of a session working a scorer's issue, as its row in `pulls` has it. */
export interface ImprovingPull {
  session: string;
  /** The issue the session worked. */
  issue: number;
  url: string;
  opened: number | null;
  closed: number | null;
  merged: boolean;
  mergedAt: number | null;
}

/** Where a self-improvement pull request stands, as the events said it last. */
export type PrState = "open" | "merged" | "closed";

export interface Improvement extends Omit<IssueRow, "scorer"> {
  /** The latest pull request a session opened for it; null while none has. */
  pr: { url: string; number: number; state: PrState } | null;
}

/** Where the scorer's self-improvement last merged: the improving session's pull request. */
export interface Merged {
  session: string;
  url: string;
  number: number;
  /** When it merged, epoch ms. */
  at: number;
}

export interface Improvements {
  /** The issue open for the scorer: the newest filed, until a pull request for it merges. */
  open: Improvement | null;
  /** Every other, newest first. */
  past: Improvement[];
  merge: Merged | null;
}

const stateOf = (pull: ImprovingPull): PrState => (pull.merged ? "merged" : pull.closed !== null ? "closed" : "open");
const numberOf = (pull: ImprovingPull) => Number(prNumber(pull.url)) || 0;

/** One scorer's self-improvement, from its issue rows and the pull requests of the sessions that worked them. */
export function improvementsOf(issues: Omit<IssueRow, "scorer">[], pulls: ImprovingPull[]): Improvements {
  const opened = pulls.filter((pull) => pull.url).sort((a, b) => (a.opened ?? 0) - (b.opened ?? 0));
  const told = [...issues].sort((a, b) => b.at - a.at || b.number - a.number).map((row): Improvement => {
    const pull = opened.findLast((each) => each.issue === row.number);
    return { ...row, pr: pull ? { url: pull.url, number: numberOf(pull), state: stateOf(pull) } : null };
  });
  const open = told[0] !== undefined && told[0].pr?.state !== "merged" ? told[0] : null;
  const merges = pulls.filter((pull) => pull.merged && pull.mergedAt !== null).sort((a, b) => a.mergedAt! - b.mergedAt!);
  const last = merges.at(-1);
  return {
    open, past: told.filter((each) => each !== open),
    merge: last ? { session: last.session, url: last.url, number: numberOf(last), at: last.mergedAt! } : null,
  };
}
