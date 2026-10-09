/**
 * A session's pull request, as the Measure tab counts it (#184): when the
 * session's own integration opened it, how and when it closed, and whether it
 * was an AUTONOMOUS pull request (CONTEXT.md) — merged, opened by the session
 * itself, and every commit of it at merge either one the session made or a
 * merge from the base branch. Review chapters a person's comments drove are
 * the session's own commits too, so they keep it autonomous; one push by a
 * person does not.
 *
 * Folded at ingest from three kinds and nothing else, the way phases.ts
 * folds phase rows: `committed` says which commits the session made — kept
 * on the row, because its pull request's close is checked against them and
 * can come long after them, a reopened one's close again —
 * `pull_request_opened` that it opened one, and the late `pull_request_closed`
 * how it ended. Never the forge (ADR 0006).
 */
import { Payload } from "./payload";
import type { StoredEvent } from "./wire";

export interface PullRow {
  /** The pull request, once the session opened or heard of one; "" before. */
  url: string;
  /** When the session's own integration opened it, epoch ms; null when it never did. */
  opened: number | null;
  /** When the station heard it closed, epoch ms; null while it is open. */
  closed: number | null;
  merged: boolean;
  mergedAt: number | null;
  /** When its first review was submitted, epoch ms; null when nobody reviewed it. */
  firstReviewAt: number | null;
  autonomous: boolean;
  /** Every commit the session made, by sha: what its pull request's commits are checked against. */
  commits: string[];
}

const FOLDED = new Set(["committed", "pull_request_opened", "pull_request_closed"]);

function ms(ts: string): number | null {
  const parsed = Date.parse(ts);
  return ts && !Number.isNaN(parsed) ? parsed : null;
}

/** `row` moved on by `events`, in seq order; null while nothing of a pull request has happened. */
export function pulledIn(row: PullRow | null, events: StoredEvent[]): PullRow | null {
  let pull = row && structuredClone(row);
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!FOLDED.has(event.kind) || event.v !== 1) continue;
    pull ??= { url: "", opened: null, closed: null, merged: false, mergedAt: null, firstReviewAt: null,
               autonomous: false, commits: [] };
    const p = Payload.parse(event.payload);
    if (event.kind === "committed") {
      if (!pull.commits.includes(p.str("sha"))) pull.commits.push(p.str("sha"));
    } else if (event.kind === "pull_request_opened") {
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
      });
    }
  }
  return pull;
}
