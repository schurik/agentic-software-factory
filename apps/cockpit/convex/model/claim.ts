/**
 * Claims, as a model (spec #40, ADR 0003): which station starts a work item.
 *
 * The forge label is not a lock — it has no conditional edit, so two watchers
 * that listed the same queued issue both flip it — so a station asks the
 * shared cockpit for a CLAIM before it touches a label, and exactly one is
 * granted: to the first session that asks, again to that session on that
 * station, and to no other. The key is the work item — its repository, issue
 * or pull request, and its number — never the factory: an item is one item
 * whichever factory asks.
 *
 * A claim is held until its session's own events say it finished, or was
 * aborted (`settle`). A failure keeps it, so that session can be resumed; so
 * does a station being offline, which for a laptop is a weekend, not a death.
 * Nothing releases a claim by the clock. A writer frees one (Release claim),
 * which puts the item back as the claim says — `requeue`, in the factory's own
 * label names, which the station sent with it — and abandons the session.
 *
 * The other end of this wire is `engine/claims.py` in the factory.
 */
import { type Infer, v } from "convex/values";
import { type Refusal } from "./command";
import { type StoredEvent, isRecord } from "./wire";
import { Payload } from "./payload";

export const claimKindValidator = v.union(v.literal("issue"), v.literal("pr"));
export type ClaimKind = Infer<typeof claimKindValidator>;

/** How a release puts the item back: labels to add, and labels to take off. */
export const requeueValidator = v.object({ add: v.array(v.string()), remove: v.array(v.string()) });
export type Requeue = Infer<typeof requeueValidator>;

export const releasedValidator = v.object({
  at: v.number(),
  by: v.string(),                     // the writer's forge login; "" when the session's own events freed it
  why: v.union(v.literal("finished"), v.literal("aborted"), v.literal("released"), v.literal("never started")),
});
export type Released = Infer<typeof releasedValidator>;

export const askedValidator = v.object({
  repo: v.string(),
  kind: claimKindValidator,
  number: v.number(),
  session: v.string(),
  since: v.number(),
  station: v.object({ id: v.string(), name: v.string() }),
  requeue: requeueValidator,
});
/** One station's request about one work item, as the wire carries it. */
export type Asked = Infer<typeof askedValidator>;

/** How many labels a claim may name to put its item back, and how long each may be. */
const MOST_LABELS = 8;
const LONGEST_LABEL = 100;

/**
 * A claim request's body: `{op: take | drop, repo, kind, number, session,
 * since, station: {id, name}, requeue: {add, remove}}`. `repo` "" is the
 * asking factory's own repository, which only the token says.
 */
export function parseClaim(body: unknown, factory: string): { op: "take" | "drop"; asked: Asked } | Refusal {
  const refused = (error: string): Refusal => ({ status: 400, error });
  if (!isRecord(body)) return refused("a claim is a JSON object");
  const op = body.op === "drop" ? "drop" : body.op === "take" ? "take" : null;
  if (op === null) return refused("a claim's op is take or drop");
  if (body.kind !== "issue" && body.kind !== "pr") return refused("a claim is on an issue or a pull request: kind issue | pr");
  const number = body.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return refused("a claim names the item's number");
  if (!name(body.session)) return refused("a claim names the session it is for");
  const station = isRecord(body.station) ? body.station : {};
  if (!name(station.id)) return refused("a claim names the station asking: {station: {id, name}}");
  const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : factory;
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return refused("a claim's repo is owner/name");
  const since = typeof body.since === "number" && Number.isInteger(body.since) && body.since > 0 ? body.since : 0;
  const requeue = isRecord(body.requeue) ? body.requeue : {};
  return {
    op,
    asked: {
      repo: repo.toLowerCase(), kind: body.kind, number, session: body.session as string, since,
      station: { id: station.id as string, name: typeof station.name === "string" && station.name ? station.name : station.id as string },
      requeue: { add: labels(requeue.add), remove: labels(requeue.remove) },
    },
  };
}

function name(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((label): label is string => typeof label === "string" && label.length > 0 &&
    label.length <= LONGEST_LABEL).slice(0, MOST_LABELS);
}

/** Whether a held claim is the asker's to have again: the same session, on the same station. */
export function sameHolder(held: { station: string; session: string }, asked: Asked): boolean {
  return held.station === asked.station.id && held.session === asked.session;
}

/**
 * What a session's events, in seq order, say about a claim held for it: the
 * end of the run it is for, or nothing yet. Only events after `since` count —
 * an older chapter's finish, shipped late, ended an earlier run. A finish
 * frees it when the run succeeded, or when a decision after `since` aborted it;
 * a failure keeps it.
 */
export function settles(claim: { since: number; aborted: boolean }, events: StoredEvent[]):
    { aborted: boolean; released: "finished" | "aborted" | null } {
  let aborted = claim.aborted;
  for (const event of events) {
    if (event.seq <= claim.since) continue;
    const p = Payload.parse(event.payload);
    if (event.kind === "decision_recorded" && p.obj("decision")?.str("verdict") === "abort") aborted = true;
    if (event.kind === "session_finished" && (p.str("status") === "success" || aborted)) {
      return { aborted, released: aborted ? "aborted" : "finished" };
    }
  }
  return { aborted, released: null };
}

/** What a writer's Release claim does, in words the confirmation shows. */
export function consequence(claim: { kind: ClaimKind; number: number; session: string; requeue: Requeue }): string {
  const item = `#${claim.number}`;
  const { add, remove } = claim.requeue;
  const done = add.length ? `relabels ${item} ${add.map((label) => `\`${label}\``).join(", ")}`
    : remove.length ? `takes ${remove.map((label) => `\`${label}\``).join(", ")} off ${item}`
    : `frees ${item}`;
  return `${done} and abandons session ${claim.session}`;
}

/** A claim as the session page shows it (claims.ofSession). */
export interface ClaimView {
  id: string;
  kind: ClaimKind;
  number: number;
  repo: string;
  /** The holding station's name, and when its loop last polled: 0 for never. */
  stationName: string;
  seenAt: number;
  grantedAt: number;
  released: Released | null;
  /** What releasing it does, for the confirmation. */
  consequence: string;
  /** Why the viewer may not release it, or null when they may; null once it was let go. */
  refused: string | null;
}
