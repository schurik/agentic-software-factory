/**
 * How the cockpit says a status and a channel — one table each, shared by the
 * status pill (components/ui.tsx), the now card, the timeline and the outline,
 * so a status never reads one way in one place and another where it links to.
 */

/** The colour a status is drawn in; `none` for one that says nothing about how things went. */
export type Tone = "ok" | "bad" | "wait" | "run" | "none";

// Every status a session, a phase or a gate can be in, as the colour it is drawn in.
const TONES: Record<string, Exclude<Tone, "none">> = {
  success: "ok", passed: "ok", approved: "ok", answered: "ok",
  fail: "bad", failed: "bad", rejected: "bad", aborted: "bad",
  running: "run", waiting: "wait",
};

const GLYPHS: Record<Exclude<Tone, "none">, string> = { ok: "✓", bad: "✕", run: "●", wait: "◐" };

export const toneOf = (status: string): Tone => TONES[status] ?? "none";
export const glyphOf = (status: string): string => (TONES[status] ? GLYPHS[TONES[status]] : "·");

const CHANNELS: Record<string, string> = {
  issue: "the issue", pr: "the pull request", cli: "the terminal", terminal: "the terminal",
};

/** Where a question was asked or answered: the work item by number when there is one. */
export function channelWords(channel: string, issueNumber = 0): string {
  if (channel === "issue" && issueNumber) return `issue #${issueNumber}`;
  return CHANNELS[channel] ?? (channel || "the terminal");
}
