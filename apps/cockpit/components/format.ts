import { type Pruned, prunedWord } from "@/convex/model/retention";
import { sameLogin } from "@/convex/model/inbox";
import type { WaitingFor } from "@/convex/model/session";

export function sessionHref(factory: string, session: string): string {
  return `/sessions/${factory.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(session)}`;
}

// ── One set of formats, every page (#105) ────────────────────────────────────
// Numbers are grouped the en-US way whatever the browser's locale, so a page
// never says "10.400" in one place and "10,400" in the next; durations keep
// seconds only while they matter; a clock is the viewer's own, on 24 hours.

const grouped = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "10,400". */
export function formatNumber(value: number): string {
  return grouped.format(value);
}

export function formatCost(value: number): string {
  return value ? formatDollars(value) : "—";
}

/** An amount in USD, zero included: what a roll-up or a ceiling says. "$1,234.50". */
export function formatDollars(value: number): string {
  return dollars.format(value);
}

/** A token count: exact below ten thousand, then "12.3k", then "2.5M". */
export function formatTokenCount(count: number): string {
  if (count < 10_000) return formatNumber(count);
  const thousands = Math.round(count / 100) / 10;
  if (thousands < 1000) return `${trim(thousands)}k`;
  return `${trim(Math.round(count / 100_000) / 10)}M`;
}

const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");

/** "27.1k tokens". */
export function formatTokens(count: number): string {
  return `${formatTokenCount(count)} ${count === 1 ? "token" : "tokens"}`;
}

const clock = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dayOfYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/** "Oct 4, 14:05" in the viewer's timezone — with the year when it is not `now`'s. */
export function formatTime(ts: string, now = Date.now()): string {
  if (!ts) return "—";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return `${(thisYear ? day : dayOfYear).format(date)}, ${clock.format(date)}`;
}

export function formatWaitingFor(waiting: WaitingFor | null): string {
  return waiting ? `${waiting.gate} · round ${waiting.round}` : "—";
}

/** How long something took, to the precision a person reads it at: "28s", "4m 34s", "58m", "2h 8m", "2d 5h". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "…";
  if (seconds < 1) return "<1s";
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (whole < 600) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** Who a login is to the viewer: "you" for their own, the login for anyone else. */
export function who(login: string, viewer: string | null): string {
  return login && viewer && sameLogin(login, viewer) ? "you" : login;
}

/** "1 job", "3 jobs". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** How long ago `at` (epoch ms) was, as of `now`. */
export function formatAgoAt(at: number, now: number): string {
  return formatAgo(new Date(at).toISOString(), now);
}

/** How long ago `ts` was, as of `now` (epoch ms). */
export function formatAgo(ts: string, now: number): string {
  const then = Date.parse(ts);
  if (!ts || Number.isNaN(then)) return "—";
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** A span of time in its largest whole unit: "2d", "5h", "12m", "40s". */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** "14:05", in the viewer's timezone. */
export function formatClock(ts: string): string {
  const date = new Date(ts);
  return !ts || Number.isNaN(date.getTime()) ? "" : clock.format(date);
}

/** A size in bytes, the way a file listing says it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, "KB"] : [bytes / (1024 * 1024), "MB"];
  return `${value.toFixed(1).replace(/\.0$/, "")} ${unit}`;
}

/** A payload as the JSON text it arrived as, indented to be read. */
export function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** "Oct 3, 2026": the day `ts` fell on, in UTC, so every viewer reads the same day. */
export function formatDay(ts: string): string {
  const date = new Date(ts);
  if (!ts || Number.isNaN(date.getTime())) return "an unknown day";
  return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** What became of a pruned body (`model/retention.ts`): "transcript aged out on Oct 3, 2026", "content purged on … by alex". */
export function formatPruned(what: string, pruned: Pruned, who: (login: string) => string = (login) => login): string {
  return `${what} ${prunedWord(pruned.reason)} on ${formatDay(pruned.on)}${pruned.by ? ` by ${who(pruned.by)}` : ""}`;
}

/** What a session works on, when not a prompt: an issue or a pull request. */
export type WorkItemKind = "issue" | "pr";

/** Where a work item of `repo` is on the forge at `forge` (its web origin); "" while the cockpit knows no forge. */
export function workItemHref(forge: string, repo: string, kind: WorkItemKind, number: number): string {
  return forge && repo ? `${forge}/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}` : "";
}

/** Where a branch of `repo` is on the forge at `forge`; "" while the cockpit knows no forge. */
export function branchHref(forge: string, repo: string, branch: string): string {
  return forge && repo && branch ? `${forge}/${repo}/tree/${branch}` : "";
}

// A work item's number, off its forge URL: the model reads them too, to find a session by one.
export { issueNumber, prNumber } from "@/convex/model/session";

/** Seconds from `from` to `to` (epoch ms), never below zero; null when either end is unknown. */
export function secondsBetween(from: string, to: number): number | null {
  const start = Date.parse(from);
  return Number.isNaN(start) || Number.isNaN(to) ? null : Math.max(0, (to - start) / 1000);
}
