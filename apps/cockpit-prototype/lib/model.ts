// PROTOTYPE, throwaway. What the graph reads off a chapter: a stage's status, which one is
// current, which are shown expanded, and the one number format for everything.
import { NOW, type Chapter, type Phase, type PhaseStatus, type Session, type Stage } from "./data";

export type StageStatus = "ok" | "running" | "waiting" | "failed" | "pending";

export function stageStatus(stage: Stage): StageStatus {
  const s = stage.phases.map((p) => p.status);
  if (!s.length) return "pending";
  if (s.includes("failed")) return "failed";
  if (s.includes("waiting")) return "waiting";
  if (s.includes("running")) return "running";
  return "ok";
}

export const hadRejection = (stage: Stage) => stage.phases.some((p) => p.status === "rejected");

/** The stage the chapter is in now: the first one still moving, stopped or failed. */
export function currentStageIndex(chapter: Chapter): number {
  return chapter.stages.findIndex((s) => ["running", "waiting", "failed"].includes(stageStatus(s)));
}

/** Expanded by default: the current stage, a failed one, or one with a rejected gate round. */
export function expandedByDefault(chapter: Chapter, i: number): boolean {
  const stage = chapter.stages[i];
  return i === currentStageIndex(chapter) || stageStatus(stage) === "failed" || hadRejection(stage);
}

export function chapterStatus(chapter: Chapter): StageStatus {
  const i = currentStageIndex(chapter);
  if (i >= 0) return stageStatus(chapter.stages[i]);
  if (chapter.end) return "ok";
  return "pending";
}

export const allPhases = (chapter: Chapter): Phase[] =>
  [chapter.start, ...chapter.stages.flatMap((s) => s.phases), chapter.end].filter(Boolean) as Phase[];

export const cost = (phases: Phase[]) => phases.reduce((n, p) => n + (p.cost ?? 0), 0);
export const tokens = (phases: Phase[]) => phases.reduce((n, p) => n + (p.tokens ?? 0), 0);
export const sessionPhases = (s: Session) => s.chapters.flatMap(allPhases);

export function chapterSecs(chapter: Chapter): number {
  const ps = allPhases(chapter);
  if (!ps.length) return 0;
  const last = ps[ps.length - 1];
  const end = last.status === "running" || last.status === "waiting" ? NOW : last.at + last.secs * 1000;
  return Math.round((end - ps[0].at) / 1000);
}

export function stageSecs(stage: Stage): number {
  return stage.phases.reduce((n, p) => n + (p.status === "waiting" ? Math.round((NOW - p.at) / 1000) : p.secs), 0);
}

export function elapsed(s: Session): number {
  return Math.round(((s.endedAt ?? NOW) - s.startedAt) / 1000);
}

/** Where the session is: its last chapter and that chapter's current stage. */
export function whereNow(s: Session): { chapter: Chapter; stage?: Stage; phase?: Phase } {
  const chapter = s.chapters[s.chapters.length - 1];
  const i = currentStageIndex(chapter);
  const stage = i >= 0 ? chapter.stages[i] : undefined;
  const phase = stage?.phases.find((p) => ["running", "waiting", "failed"].includes(p.status));
  return { chapter, stage, phase };
}

// ── One number format, everywhere ─────────────────────────────────────────────

const int = new Intl.NumberFormat("en-US");
export const fmtInt = (n: number) => int.format(n);
export const fmtCost = (n: number) => `$${n.toFixed(2)}`;
export const fmtTokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : int.format(n));

export function fmtDur(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${String(secs % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtAgo(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export const phaseWord: Record<PhaseStatus, string> = {
  ok: "done", running: "running", waiting: "waiting", failed: "failed", rejected: "rejected", pending: "not yet",
};
