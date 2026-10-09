/**
 * A session's pull request, as the Measure tab counts it (#184, #188): when
 * the session's own integration opened it, how and when it closed, and whether
 * it was an AUTONOMOUS pull request (CONTEXT.md) — merged, opened by the
 * session itself, and every commit of it at merge either one the session made
 * or a merge from the base branch. Review chapters a person's comments drove
 * are the session's own commits too, so they keep it autonomous; one push by a
 * person does not. And what it took: when the session started, how big the
 * pull request was, and what the session's agent calls cost, by component.
 *
 * Folded at ingest from five kinds and nothing else, the way phases.ts
 * folds phase rows: `session_started` when the work was kicked off,
 * `committed` which commits the session made — kept on the row, because its
 * pull request's close is checked against them and can come long after them,
 * a reopened one's close again — `usage` what each agent call cost,
 * `pull_request_opened` that it opened one, and the late `pull_request_closed`
 * how it ended. Never the forge (ADR 0006).
 *
 * MEASUREMENT COST IS NEVER HERE. What a scorer's judge spends is the `usage`
 * inside its `chapter_scored`, never a `usage` event of its own, so it is not
 * folded: measuring a session does not make its pull request look dearer.
 */
import { Payload } from "./payload";
import type { StoredEvent } from "./wire";

/**
 * What the session's agent calls cost, list-price equivalent USD, by the
 * components a `usage` event's breakdown prices — and `other`, what a call
 * cost beyond them: a harness that reports only a total.
 */
export interface Components {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  other: number;
}

export interface PullRow {
  /** When the session started, epoch ms: where its pull request's cycle time starts. */
  kickoff: number | null;
  /** The pull request, once the session opened or heard of one; "" before. */
  url: string;
  /** When the session's own integration opened it, epoch ms; null when it never did. */
  opened: number | null;
  /** How many pull requests the session's own integration opened: what its cost is split evenly between. */
  prs: number;
  /** When the station heard it closed, epoch ms; null while it is open. */
  closed: number | null;
  merged: boolean;
  mergedAt: number | null;
  /** When its first review was submitted, epoch ms; null when nobody reviewed it. */
  firstReviewAt: number | null;
  autonomous: boolean;
  /** Its changed lines at close, added and deleted; null until a close that says them (v2). */
  lines: number | null;
  /** Every commit the session made, by sha: what its pull request's commits are checked against. */
  commits: string[];
  /** What the session's agent calls cost, by component. */
  spent: Components;
}

/** The versions of each kind the row folds: every one a factory writes, of a kind it takes anything from. */
const FOLDED: Record<string, number[]> = {
  session_started: [1, 2, 3], committed: [1], usage: [1], pull_request_opened: [1], pull_request_closed: [1, 2],
};

/** The versions of `kind` the row folds, or [] for a kind it takes nothing from (tests/measure.test.ts holds the corpus to it). */
export function foldedVersions(kind: string): number[] {
  return FOLDED[kind] ?? [];
}

function ms(ts: string): number | null {
  const parsed = Date.parse(ts);
  return ts && !Number.isNaN(parsed) ? parsed : null;
}

/** Every component, in the order Metrics lists them. */
export const COMPONENTS: (keyof Components)[] = ["input", "output", "cacheRead", "cacheWrite", "other"];

/** A row's cost: its components summed. */
export function costOf(spent: Components): number {
  return COMPONENTS.reduce((total, each) => total + spent[each], 0);
}

/** `row` moved on by `events`, in seq order; null while nothing of a pull request has happened. */
export function pulledIn(row: PullRow | null, events: StoredEvent[]): PullRow | null {
  let pull = row && structuredClone(row);
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!foldedVersions(event.kind).includes(event.v)) continue;
    pull ??= { kickoff: null, url: "", opened: null, prs: 0, closed: null, merged: false, mergedAt: null, firstReviewAt: null,
               autonomous: false, lines: null, commits: [], spent: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, other: 0 } };
    const p = Payload.parse(event.payload);
    if (event.kind === "session_started") {
      // Its first process's start: a resume, a join or an answer is a later process of the same session.
      pull.kickoff ??= ms(p.str("started_at")) ?? ms(event.ts);
    } else if (event.kind === "committed") {
      if (!pull.commits.includes(p.str("sha"))) pull.commits.push(p.str("sha"));
    } else if (event.kind === "usage") {
      const usage = p.obj("usage");
      const priced = { input: usage?.num("input_cost") ?? 0, output: usage?.num("output_cost") ?? 0,
                       cacheRead: usage?.num("cache_read_cost") ?? 0, cacheWrite: usage?.num("cache_write_cost") ?? 0 };
      const spent = pull.spent;
      spent.input += priced.input;
      spent.output += priced.output;
      spent.cacheRead += priced.cacheRead;
      spent.cacheWrite += priced.cacheWrite;
      spent.other += Math.max(0, p.num("cost") - (priced.input + priced.output + priced.cacheRead + priced.cacheWrite));
    } else if (event.kind === "pull_request_opened") {
      if (p.str("url") !== pull.url) pull.prs += 1;
      Object.assign(pull, { url: p.str("url"), opened: ms(event.ts) });
    } else {
      const url = p.str("url") || pull.url;
      // Opened by this session — this very pull request, not another it once opened.
      const own = pull.opened !== null && url === pull.url;
      const merges = new Set(p.strs("base_merges"));
      const made = new Set(pull.commits);
      const merged = p.bool("merged");
      const head = p.strs("head_shas");
      Object.assign(pull, {
        url, closed: ms(event.ts), merged, mergedAt: merged ? ms(p.str("merged_at")) ?? ms(event.ts) : null,
        firstReviewAt: ms(p.str("first_review_at")),
        // Its commits as they were at close, every one accounted for — and some at all: a close that
        // names none checked nothing, and vouches for nothing.
        autonomous: merged && own && head.length > 0 && head.every((sha) => merges.has(sha) || made.has(sha)),
        lines: event.v >= 2 ? p.num("additions") + p.num("deletions") : null,
      });
    }
  }
  return pull;
}
