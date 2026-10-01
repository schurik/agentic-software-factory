import type { WaitingFor } from "@/convex/model/session";

export function sessionHref(factory: string, session: string): string {
  return `/sessions/${factory.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(session)}`;
}

/** The inbox, with this session's wait open in it. */
export function inboxHref(factory: string, session: string): string {
  return `/?open=${encodeURIComponent(`${factory}/${session}`)}`;
}

export function formatCost(value: number): string {
  return value ? `$${value.toFixed(2)}` : "—";
}

export function formatTime(ts: string): string {
  if (!ts) return "—";
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString();
}

export function formatWaitingFor(waiting: WaitingFor | null): string {
  return waiting ? `${waiting.gate} · round ${waiting.round}` : "—";
}

/** How long something took, to the precision a person reads it at. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "…";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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

/** A span of time in its largest whole unit: "2 d", "5 h", "12 m", "40 s". */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

export function formatClock(ts: string): string {
  const date = new Date(ts);
  return !ts || Number.isNaN(date.getTime()) ? "" :
    date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
