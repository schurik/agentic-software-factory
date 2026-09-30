/**
 * How the session page says a status and a channel — one table each, shared by
 * the top bar, the now card, the timeline and the outline, so a status never
 * reads one way in the sidebar and another in the chapter it links to.
 */

type Tone = "ok" | "bad" | "wait" | "run";

// Every status a session, a phase or a gate can be in, as the colour it is drawn in.
const TONES: Record<string, Tone> = {
  success: "ok", passed: "ok", approved: "ok", answered: "ok",
  fail: "bad", failed: "bad", rejected: "bad", aborted: "bad",
  running: "run", waiting: "wait",
};

const GLYPHS: Record<Tone, string> = { ok: "✓", bad: "✕", run: "●", wait: "◐" };
// A tone as the `.status` pill's colour class.
const PILLS: Record<Tone, string> = { ok: "success", bad: "fail", wait: "waiting", run: "running" };

export const toneOf = (status: string): string => TONES[status] ?? "none";
export const glyphOf = (status: string): string => (TONES[status] ? GLYPHS[TONES[status]] : "·");
export const pillOf = (status: string): string => (TONES[status] ? PILLS[TONES[status]] : "unknown");

const CHANNELS: Record<string, string> = {
  issue: "the issue", pr: "the pull request", cli: "the terminal", terminal: "the terminal",
};

/** Where a question was asked or answered: the work item by number when there is one. */
export function channelWords(channel: string, issueNumber = 0): string {
  if (channel === "issue" && issueNumber) return `issue #${issueNumber}`;
  return CHANNELS[channel] ?? (channel || "the terminal");
}
