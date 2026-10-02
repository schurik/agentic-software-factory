/**
 * What a cockpit keeps of a session, and for how long (#63).
 *
 * Every event is one of three weights:
 *
 *   core        everything a view is built from — phases, gates, decisions,
 *               spend, commits. Kept forever.
 *   handoff     the bodies a session handed on: an artifact's content, a
 *               command's output tail. Kept forever, unless someone purges them.
 *   transcript  `prompt_rendered` and `harness_output`, which a factory sends
 *               only when it opted in. Their bodies AGE OUT once the session
 *               has been finished for as long as the retention allows.
 *
 * Aging out and purging both PRUNE: the event's body is replaced by a
 * `pruned: {on, reason, by?}` marker, and the event, its seq and every field
 * that is not body stay. So nothing a view is built from goes, a station's
 * replay finds every seq already stored, and the Events tab still lists the
 * line and says what became of it.
 *
 * The invariant this rests on: no view but the Transcript tab derives from a
 * transcript body (`tests/pruned.test.ts` rebuilds every other one from a
 * pruned corpus and finds them unchanged).
 */
import { Payload } from "./payload";
import { at, type Summary } from "./session";
import { isRecord } from "./wire";

export type Weight = "core" | "handoff" | "transcript";

/** The kinds that carry a body, and which of their fields it is. */
const BODIES: Record<string, { weight: Weight; fields: string[] }> = {
  artifact_written: { weight: "handoff", fields: ["content"] },
  command_finished: { weight: "handoff", fields: ["output_tail"] },
  prompt_rendered: { weight: "transcript", fields: ["system", "prompt"] },
  harness_output: { weight: "transcript", fields: ["text"] },
};

export function weightOf(kind: string): Weight {
  return BODIES[kind]?.weight ?? "core";
}

export type PruneReason = "aged_out" | "purged";

/** What an event's body was replaced by: when, why, and — for a purge from the cockpit — by whom. */
export interface Pruned {
  on: string;
  reason: PruneReason;
  by: string;             // "" when nobody: an age-out, or a purge from the deployment's CLI
}

/**
 * The payload of an event of `kind` with its body replaced by `pruned`, as
 * the JSON text it is stored as — or null when there is nothing to prune: a
 * core event, or one pruned before.
 */
export function prune(kind: string, payload: string, pruned: Pruned): string | null {
  const body = BODIES[kind];
  if (body === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    raw = {};
  }
  const kept = isRecord(raw) ? { ...raw } : {};
  if (isRecord(kept.pruned)) return null;
  for (const field of body.fields) delete kept[field];
  kept.pruned = { on: pruned.on, reason: pruned.reason, ...(pruned.by ? { by: pruned.by } : {}) };
  return JSON.stringify(kept);
}

/** How a person reads why a body went: "purged", "aged out". */
export function prunedWord(reason: PruneReason): string {
  return reason === "purged" ? "purged" : "aged out";
}

/** The marker on a pruned event, or null for one whose body is still here. */
export function prunedOf(p: Payload): Pruned | null {
  const marker = p.obj("pruned");
  if (marker === null) return null;
  return { on: marker.str("on"), reason: marker.str("reason") === "purged" ? "purged" : "aged_out", by: marker.str("by") };
}

// ── how long a transcript is kept ────────────────────────────────────────────

/** A deployment's maximum when its operator set none. */
export const DEFAULT_TRANSCRIPT_DAYS = 30;
const DAY = 24 * 3600_000;

/**
 * The most days any session's transcript is kept after it finished: the
 * deployment's `COCKPIT_TRANSCRIPT_DAYS`, or 30. A local cockpit's owner
 * raises it the same way (`ASF_COCKPIT_TRANSCRIPT_DAYS`, which `asf up` hands it).
 */
export function deploymentDays(): number {
  const days = Number(process.env.COCKPIT_TRANSCRIPT_DAYS);
  return Number.isInteger(days) && days >= 1 ? days : DEFAULT_TRANSCRIPT_DAYS;
}

/** The days this session's transcript is kept: the lower of the deployment's and its factory's. */
export function transcriptDays(summary: Summary): number {
  const maximum = deploymentDays();
  return summary.transcriptDays > 0 ? Math.min(maximum, summary.transcriptDays) : maximum;
}

/**
 * When this session's transcript ages out, epoch ms — null while the session
 * is not finished, because the clock starts when it finishes, and a resume
 * stops it again.
 */
export function agesOutAt(summary: Summary): number | null {
  const ended = at(summary.endedAt);
  return ended === null ? null : ended + transcriptDays(summary) * DAY;
}

/**
 * What a session's record says of its transcript once `fresh` events folded
 * into `summary`: whether it holds bodies, and when they age out. `held` is
 * what the record said before — undefined for a session stored before
 * retention existed, which stays undefined until the backfill has looked.
 */
export function retained(held: boolean | undefined, fresh: { kind: string }[], summary: Summary):
    { transcripts: boolean | undefined; transcriptsDue: number | undefined } {
  const transcripts = fresh.some((event) => weightOf(event.kind) === "transcript") ? true : held;
  return { transcripts, transcriptsDue: transcripts ? agesOutAt(summary) ?? undefined : undefined };
}
