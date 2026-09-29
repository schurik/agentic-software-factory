import type { WaitingFor } from "@/convex/model/session";

export function sessionHref(factory: string, session: string): string {
  return `/sessions/${factory.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(session)}`;
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
