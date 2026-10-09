/**
 * How the cockpit says a status's tone, a channel, what a chapter answers and
 * a phase's name — one table each, shared by the pages that say them (the
 * status pill in components/ui.tsx, the stage graph, the Now card, the
 * timeline), so a thing never reads one way in one place and another where it
 * links to.
 */

import type { Limit, Rollback } from "@/convex/model/story";
import { formatDollars, formatDuration, formatTokenCount, formatTokens } from "../format";

/** The colour a status is drawn in; `none` for one that says nothing about how things went. */
export type Tone = "ok" | "bad" | "wait" | "run" | "none";

// Every status a session, a phase or a gate can be in, as the colour it is drawn in.
const TONES: Record<string, Exclude<Tone, "none">> = {
  success: "ok", passed: "ok", approved: "ok", answered: "ok",
  fail: "bad", failed: "bad", rejected: "bad", aborted: "bad",
  running: "run", waiting: "wait",
  // A stage's status, as the stage graph says it.
  done: "ok",
};

export const toneOf = (status: string): Tone => TONES[status] ?? "none";

const CHANNELS: Record<string, string> = {
  issue: "the issue", pr: "the pull request", cli: "the terminal", terminal: "the terminal",
};

/** Where a question was asked or answered: the work item by number when there is one. */
export function channelWords(channel: string, issueNumber = 0): string {
  if (channel === "issue" && issueNumber) return `issue #${issueNumber}`;
  return CHANNELS[channel] ?? (channel || "the terminal");
}

const NAMED: Record<string, string> = {
  commit_plan: "commit plan", commit_implement: "commit code", commit_document: "commit docs",
  issue: "read the issue", pr: "read the review", changes: "collect the diff",
};

/**
 * A phase's name for people (#104): "plan revision 1", "verify #2", "commit
 * code". The engine's own names stay where the record is read — a phase's
 * Events tab and the Journal — and a name this table does not know is shown
 * as it is.
 */
export function phaseName(phase: { type?: string; name: string; gate?: string; round?: number; kind?: string }): string {
  if (phase.type === "gate") {
    return `${phase.gate || phase.name} ${phase.kind === "questions" ? "questions" : "gate"} · round ${phase.round || 1}`;
  }
  const revision = /^plan_revise_(\d+)$/.exec(phase.name);
  if (revision) return `plan revision ${revision[1]}`;
  const again = /^(verify|fix|review)_(\d+)$/.exec(phase.name);
  if (again) return `${again[1]} #${again[2]}`;
  return NAMED[phase.name] ?? phase.name;
}

/** What a chapter answers, in words: "answering issue #42", "answering pull request #9". */
export function answeringWords(answering: { kind: "issue" | "pr"; number: number } | null): string {
  return answering ? `answering ${answering.kind === "issue" ? "issue" : "pull request"} #${answering.number}` : "";
}

// What each stage of the closed vocabulary is for, in a sentence: the line a
// stage's drawer opens on. Presentation, like the names above; a stage the
// vocabulary gained since this cockpit was built has none, and says nothing.
const PURPOSES: Record<string, string> = {
  scout: "Find the code the request actually touches, so the plan is written against the repository.",
  refine: "Settle what the request actually asks for, with a person, before anyone plans.",
  plan: "Turn the request into a plan the builder can implement without asking questions.",
  commit: "Land what the stage before produced on the session's branch, in its author's own words.",
  implement: "Turn the plan, or the prompt itself, into code.",
  verify: "Run the repository's known commands; on a failure the builder fixes and they run again.",
  review: "Confirm that what was built is what was asked for, against the plan or the prompt.",
  document: "Write up what the session changed, from the diff, for the engineer who arrives next.",
  integrate: "Land the session's branch on its base the way this repository wants it landed.",
};

export const stagePurpose = (stage: string): string => PURPOSES[stage] ?? "";

/**
 * What stopped a phase, when the factory said so as a fact rather than only as
 * its error: the limit it met, or the writes it made outside its boundary.
 * Told in place of the error's prose wherever a phase says how it ended. ""
 * when neither stopped it.
 */
export function stoppedWords({ rollback, limit }: { rollback: Rollback | null; limit: Limit | null }): string {
  if (limit) return limitWords(limit);
  if (rollback) return rollbackWords(rollback);
  return "";
}

/** "stopped at the cost limit: $2.04 spent of $2.00", in the limit's own unit. */
export function limitWords({ kind, limit, reached }: Limit): string {
  if (kind === "cost") return `stopped at the cost limit: ${formatDollars(reached)} spent of ${formatDollars(limit)}`;
  if (kind === "tokens") return `stopped at the token limit: ${formatTokenCount(reached)} of ${formatTokens(limit)} used`;
  return `stopped at the time limit: a turn ran ${formatDuration(reached)} of the ${formatDuration(limit)} it may take`;
}

/** "wrote outside its boundary: a.py rolled back; README.md not undone". */
export function rollbackWords({ paths, notUndone }: Rollback): string {
  return "wrote outside its boundary: " + [
    paths.length ? `${paths.join(", ")} rolled back` : "",
    notUndone.length ? `${notUndone.join(", ")} not undone` : "",
  ].filter(Boolean).join("; ");
}

/** The mark a stopped phase's fact is told with: a limit is a stop, a rollback an undo. */
export function stoppedMark({ limit }: { limit: Limit | null }): string {
  return limit ? "⏹" : "↺";
}

/** "not accepted: test still failed after 3 attempt(s)" — a chapter whose phases passed, refused by its workflow. */
export function notAccepted({ reason }: { reason: string }): string {
  return `not accepted${reason ? `: ${reason}` : ""}`;
}
