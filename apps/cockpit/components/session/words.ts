/**
 * How the cockpit says a status's tone, a channel, what a chapter answers and
 * a phase's name — one table each, shared by the pages that say them (the
 * status pill in components/ui.tsx, the stage graph, the Now card, the
 * timeline), so a thing never reads one way in one place and another where it
 * links to.
 */

/** The colour a status is drawn in; `none` for one that says nothing about how things went. */
export type Tone = "ok" | "bad" | "wait" | "run" | "none";

// Every status a session, a phase or a gate can be in, as the colour it is drawn in.
const TONES: Record<string, Exclude<Tone, "none">> = {
  success: "ok", passed: "ok", approved: "ok", answered: "ok",
  fail: "bad", failed: "bad", rejected: "bad", aborted: "bad",
  running: "run", waiting: "wait",
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
