/**
 * A chapter as the session page's stage graph draws it: the phases it went
 * through, grouped under the stages its `workflow_started` (v2) named, by the
 * stage index each `phase_started` (v3) carried — never by a phase's name.
 *
 * The phase that read the work item and the report belong to no stage: they
 * are the chain's two ends. A chapter from a factory before stages, or one
 * whose phases do not all sit in a stage it named, is drawn as what it is —
 * a flat chain of its phases — rather than a grouping guessed at.
 *
 * A stage's status is its latest phase's: a stage whose verify failed once and
 * then passed is done. It also counts the gate rounds a person rejected.
 */
import type { AgentItem, Chapter, CodeItem, GateItem } from "./story";

/** A phase of the graph: what an agent or code ran, or a gate a person was asked at. */
export type Phase = AgentItem | CodeItem | GateItem;

/** How a phase went, in the graph's words: a gate a person turned down is `rejected`. */
export type Mark = "done" | "running" | "waiting" | "failed" | "rejected" | "pending";

export type StageStatus = "pending" | "running" | "waiting" | "done" | "failed";

export interface Stage {
  index: number;
  name: string;              // in the closed vocabulary
  status: StageStatus;
  rejected: number;          // gate rounds a person rejected
  phases: Phase[];
}

export type Graph =
  // `current` is the stage the chapter is in now: the first one moving, waiting or failed.
  | { kind: "stages"; start: Phase | null; stages: Stage[]; end: Phase | null; current: number | null }
  // `current` indexes `phases` the same way.
  | { kind: "phases"; phases: Phase[]; current: number | null };

const GATE_MARKS: Record<string, Mark> = {
  approved: "done", answered: "done", passed: "done", rejected: "rejected",
  waiting: "waiting", open: "waiting", aborted: "failed", failed: "failed",
};

const MARKS: Record<string, Mark> = { success: "done", fail: "failed", running: "running", waiting: "waiting" };

export function markOf(phase: Phase): Mark {
  return (phase.type === "gate" ? GATE_MARKS : MARKS)[phase.status] ?? "pending";
}

// A rejected round is the latest word only until the revision starts: the stage goes on.
const STAGE_OF: Record<Mark, StageStatus> = {
  done: "done", running: "running", waiting: "waiting", failed: "failed", rejected: "running", pending: "pending",
};

const moving = (status: StageStatus | Mark) => status === "running" || status === "waiting" || status === "failed";

export function graphOf(chapter: Pick<Chapter, "stages" | "reader" | "items">): Graph {
  const phases: Phase[] = [
    ...(chapter.reader ? [chapter.reader] : []),
    ...chapter.items.filter((item): item is Phase => item.type === "agent" || item.type === "code" || item.type === "gate"),
  ];
  const flat = (): Graph => {
    const current = phases.findIndex((phase) => moving(markOf(phase)));
    return { kind: "phases", phases, current: current === -1 ? null : current };
  };
  if (!chapter.stages.length) return flat();

  const start = chapter.reader;
  const unstaged = phases.filter((phase) => phase !== start && phase.stageIndex === null);
  const placed = phases.every((phase) => phase.stageIndex === null || phase.stageIndex < chapter.stages.length);
  if (unstaged.length > 1 || !placed) return flat();

  const stages = chapter.stages.map((name, index): Stage => {
    const mine = phases.filter((phase) => phase.stageIndex === index);
    const last = mine.at(-1);
    return {
      index, name, phases: mine,
      status: last ? STAGE_OF[markOf(last)] : "pending",
      rejected: mine.filter((phase) => markOf(phase) === "rejected").length,
    };
  });
  const current = stages.findIndex((stage) => moving(stage.status));
  return { kind: "stages", start, stages, end: unstaged[0] ?? null, current: current === -1 ? null : current };
}
