/**
 * A workflow's record, stage by stage (#120): what the Workflows tab writes
 * on each card of a workflow's graph — how long a stage's phases worked in a
 * chapter and what they cost, how many chapters failed there, and what people
 * did at its gate. Worked out from the per-phase rows ingest keeps
 * (phases.ts), never from events.
 *
 * A stage is taken a chapter at a time: a verify that failed, the fix after
 * it and the verify that passed are one go at it. Its time is what its phases
 * worked, a gate's rounds aside — a person's wait is the gate's own figure,
 * not the stage's work — and it is timed only once every one of those phases
 * ended. It failed there when the last of them failed, or a person aborted
 * the session at its gate: a round suspended for a person who then aborted
 * never ends. A phase recorded before stages belongs to none, and counts only
 * toward a session's figures (the Overview's).
 */
import { type GateFigures, gatesOf, median } from "./overview";

/** What the Workflows tab reads of a phase's row. */
export interface StagedFacts {
  session: string;
  chapter: number;
  workflow: string;
  stage: string | null;
  stageIndex: number | null;
  kind: string;
  status: string;
  at: number;
  duration: number;
  cost: number;
  verdict: string;
  wait: number | null;
}

/** One stage of one workflow, at its place in the workflow's stages, over the rows it was given. */
export interface StageFigures {
  workflow: string;
  index: number;
  stage: string;
  /** The chapters that went through it and whose phases there all ended. */
  chapters: number;
  /** Median seconds its phases worked in one of those chapters, and median USD they cost; null when there were none. */
  time: number | null;
  cost: number | null;
  /** The chapters that failed there. */
  failures: number;
  gate: GateFigures;
}

const ENDED = new Set(["success", "fail"]);

/** Every stage `phases` ran in, by workflow and then by place. */
export function stagesOf(phases: StagedFacts[]): StageFigures[] {
  const stages = new Map<string, StagedFacts[]>();
  for (const phase of phases) {
    if (phase.stage === null || phase.stageIndex === null) continue;
    const key = JSON.stringify([phase.workflow, phase.stageIndex, phase.stage]);
    stages.set(key, [...(stages.get(key) ?? []), phase]);
  }
  return [...stages.values()].map((ofStage): StageFigures => {
    const { workflow, stageIndex, stage } = ofStage[0];
    const goes = new Map<string, StagedFacts[]>();
    for (const phase of ofStage) {
      const key = JSON.stringify([phase.session, phase.chapter]);
      goes.set(key, [...(goes.get(key) ?? []), phase]);
    }
    const work = (go: StagedFacts[]) => go.filter((phase) => phase.kind !== "gate").toSorted((a, b) => a.at - b.at);
    const aborted = (go: StagedFacts[]) => go.some((phase) => phase.kind === "gate" && phase.verdict === "abort");
    const ended = [...goes.values()].filter((go) => aborted(go) || work(go).every((phase) => ENDED.has(phase.status)));
    const sum = (go: StagedFacts[], of: (phase: StagedFacts) => number) => work(go).reduce((total, phase) => total + of(phase), 0);
    return {
      workflow, index: stageIndex!, stage: stage!, chapters: ended.length,
      time: median(ended.map((go) => sum(go, (phase) => phase.duration))),
      cost: median(ended.map((go) => sum(go, (phase) => phase.cost))),
      failures: ended.filter((go) => aborted(go) || work(go).at(-1)?.status === "fail").length,
      gate: gatesOf(ofStage),
    };
  }).sort((a, b) => a.workflow.localeCompare(b.workflow) || a.index - b.index);
}

/** A stage's figures as its card shows them: and whether it is the workflow's slowest. */
export interface StageRecord extends StageFigures {
  slowest: boolean;
}

/**
 * The figures for each of `stages` — a workflow's, as its description lists
 * them now — or null for a stage no phase worked at: a figure goes on a stage
 * only when the same stage held that place when the phases worked, because a
 * workflow changed since would otherwise lend one stage another's record. The
 * slowest is the one that took longest, when there are two or more to compare.
 */
export function recordOf(workflow: string, stages: string[], figures: StageFigures[]): (StageRecord | null)[] {
  const found = stages.map((stage, index) =>
    figures.find((each) => each.workflow === workflow && each.index === index && each.stage === stage) ?? null);
  const timed = found.filter((each) => each !== null && each.time !== null);
  const longest = timed.length > 1 ? Math.max(...timed.map((each) => each!.time!)) : null;
  return found.map((each) => each && { ...each, slowest: longest !== null && longest > 0 && each.time === longest });
}
