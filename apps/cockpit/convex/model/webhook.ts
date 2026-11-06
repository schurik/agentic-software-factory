/**
 * What a webhook delivery from the team's App asks the cockpit to do.
 *
 * Deliveries are hints, never the record: GitHub sends each one once and does
 * not retry, so everything a delivery can tell the cockpit the catch-up poll
 * (discovery.ts) can find out for itself. That is also why a delivery is
 * never de-duplicated — acting on one twice is one more look at the forge.
 *
 * Two things can come of one. `asks` is what the cockpit itself looks at
 * again: a factory's default branch, or the set of repositories. `nudges` is
 * which of a station's watchers would find work on one item sooner than its
 * interval (ADR 0008) — the station is told in the answer to its command poll
 * (nudges.ts), and the watcher reads the forge as any pass would.
 */
import { v } from "convex/values";
import { isRecord } from "./wire";

export type Asked =
  | { look: string }     // this repository's default branch moved: ask again whether it holds a factory
  | "list"               // the set of repositories changed: list them again
  | null;                // nothing this cockpit reads

export function asks(event: string, payload: unknown): Asked {
  if (!isRecord(payload)) return null;
  switch (event) {
    case "push": {
      const repository = isRecord(payload.repository) ? payload.repository : {};
      const { full_name: name, default_branch: branch } = repository;
      if (typeof name !== "string" || typeof branch !== "string") return null;
      // A factory is what the default branch holds; any other branch changes nothing here.
      return payload.ref === `refs/heads/${branch}` ? { look: name } : null;
    }
    // Installed, uninstalled, suspended; repositories added or removed; one
    // renamed, transferred, deleted, or given another default branch.
    case "installation":
    case "installation_repositories":
    case "repository":
      return "list";
    default:
      return null;
  }
}

/** The watchers a station runs that a nudge can wake: `engine/supervise.py`'s WATCHERS. */
export const WATCHED = ["issues", "answers", "prs"] as const;
export type Watched = (typeof WATCHED)[number];
export const watchedValidator = v.union(v.literal("issues"), v.literal("answers"), v.literal("prs"));

/** How long a nudge is kept for a station to collect: after that the watcher's own poll has found it anyway. */
export const NUDGE_FOR = 10 * 60_000;
/**
 * Nudges are live while the App holds a webhook secret and a delivery arrived
 * within this: GitHub can reach the cockpit. A station slows its own poll
 * only while they are — a quiet hour costs it nothing but today's interval.
 */
export const LIVE_FOR = 60 * 60_000;

/** One work item a delivery was about, and the watchers it concerns. */
export interface Nudge {
  repo: string;          // `owner/name`, as the delivery spells it
  number: number;
  kinds: Watched[];
}

/**
 * Which watchers a delivery would wake, and about which item — or null for
 * one no watcher acts on. Only the moves that can put an item in a queue:
 * a label (the route, or `queued`), a reply (to a waiting session, or on a
 * pull request's conversation), a review, and a close (the review watcher
 * reaps the session and records how it ended). A review edited or dismissed
 * puts nothing in a queue, so it wakes nobody.
 */
export function nudges(event: string, payload: unknown): Nudge | null {
  if (!isRecord(payload)) return null;
  const repository = isRecord(payload.repository) ? payload.repository : {};
  const repo = repository.full_name;
  const item = isRecord(payload.issue) ? payload.issue : isRecord(payload.pull_request) ? payload.pull_request : {};
  const number = item.number;
  if (typeof repo !== "string" || typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  const kinds = woken(event, payload.action, isRecord(payload.issue) && isRecord(payload.issue.pull_request));
  return kinds.length ? { repo, number, kinds } : null;
}

function woken(event: string, action: unknown, onPull: boolean): Watched[] {
  switch (`${event}.${String(action)}`) {
    case "issues.labeled":
      return ["issues"];
    case "issue_comment.created":
      // GitHub sends a comment on a pull request's conversation as one on an issue.
      return onPull ? ["answers", "prs"] : ["answers"];
    case "pull_request_review.submitted":
    case "pull_request_review_comment.created":
    case "pull_request.closed":
      return ["prs"];
    default:
      return [];
  }
}
