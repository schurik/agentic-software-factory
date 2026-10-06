/**
 * A factory's Overview (#119): what only it shows — not what is happening now
 * (that is Now's) nor any one session (Sessions') — over the last days the
 * viewer picked. Worked out here from rows already folded at ingest, never
 * from events: spend rows by day, session summaries for how sessions ended
 * and how long they took, phase rows for the gates.
 *
 * A session is the period's when it ended in it — finished, or, still going,
 * last heard from — as a station's record counts it.
 */
import type { Spend } from "./spend";
import { at, type Summary } from "./session";

/** One of the period's days: from the midnight that starts it, epoch ms. */
export interface Day extends Spend {
  from: number;
}

/** How the period's sessions ended, and how long they took. */
export interface Ended {
  sessions: number;
  done: number;
  failed: number;
  /** Still running, or waiting at a gate. */
  open: number;
  /** Median seconds from start to finish, of those that finished; null when none did. */
  finish: number | null;
}

export interface Outcomes extends Ended {
  /** The rounds a person answered at a gate, how many of them they rejected, and the median wait for an answer. */
  gates: { rounds: number; rejected: number; wait: number | null };
}

/** A workflow, as the Overview's table has it. */
export interface WorkflowLine extends Ended, Spend {
  workflow: string;
  /** When a phase of it last started, epoch ms; null when none did in the period. */
  last: number | null;
}

/** What the Overview reads of a phase's row. */
export interface PhaseFacts {
  workflow: string;
  kind: string;
  at: number;
  verdict: string;
  wait: number | null;
}

/** The middle value, or the mean of the two middle ones; null for none. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** `spent` summed by the days `days` (each one's midnight, and the one after the last) start. */
export function dailyOf(spent: ({ at: number } & Spend)[], days: number[]): Day[] {
  const daily = days.slice(0, -1).map((from): Day => ({ from, cost: 0, tokens: 0 }));
  for (const row of spent) {
    const day = daily.findLast((each) => each.from <= row.at);
    if (day === undefined || row.at >= days.at(-1)!) continue;
    day.cost += row.cost;
    day.tokens += row.tokens;
  }
  return daily;
}

type Outcome = "done" | "failed" | "open";

function outcomeOf(status: string): Outcome {
  return status === "success" ? "done" : status === "fail" ? "failed" : "open";
}

/** Seconds a finished session took from its start to its finish; null when either is unknown. */
function finishOf(summary: Summary): number | null {
  const start = at(summary.startedAt);
  const end = at(summary.endedAt);
  return start === null || end === null || outcomeOf(summary.status) === "open" ? null : Math.max(0, (end - start) / 1000);
}

function ended(outcomes: { outcome: Outcome; finish: number | null }[]): Ended {
  const count = (outcome: Outcome) => outcomes.filter((each) => each.outcome === outcome).length;
  return {
    sessions: outcomes.length, done: count("done"), failed: count("failed"), open: count("open"),
    finish: median(outcomes.flatMap((each) => (each.finish === null ? [] : [each.finish]))),
  };
}

/** How the period's sessions ended, and the gate rounds a person answered among the period's phases. */
export function outcomesOf(sessions: Summary[], phases: PhaseFacts[]): Outcomes {
  const answered = phases.filter((phase) => phase.kind === "gate" && phase.verdict);
  return {
    ...ended(sessions.map((summary) => ({ outcome: outcomeOf(summary.status), finish: finishOf(summary) }))),
    gates: {
      rounds: answered.length,
      rejected: answered.filter((phase) => phase.verdict === "reject").length,
      wait: median(answered.flatMap((phase) => (phase.wait === null ? [] : [phase.wait]))),
    },
  };
}

/**
 * Each workflow the period's sessions ran, most sessions first, then most
 * spent. A session counts toward every workflow it passed through: one it
 * went on from finished well there — a session moves on to its next workflow
 * only once the one before it ended well — and the one it is in now ended as
 * the session did, after as long as the session took. What a workflow spent
 * is what was charged to it (`spent`), and a workflow nothing ran in the
 * period but that spent in it is listed too.
 */
export function workflowsOf(sessions: Summary[], phases: PhaseFacts[], spent: ({ workflow: string } & Spend)[]): WorkflowLine[] {
  const runs = new Map<string, { outcome: Outcome; finish: number | null }[]>();
  for (const summary of sessions) {
    const passed = summary.workflows.length ? summary.workflows : [summary.workflow];
    passed.forEach((workflow, index) => {
      const last = index === passed.length - 1;
      const run = last ? { outcome: outcomeOf(summary.status), finish: finishOf(summary) } : { outcome: "done" as const, finish: null };
      runs.set(workflow, [...(runs.get(workflow) ?? []), run]);
    });
  }
  const names = new Set([...runs.keys(), ...spent.map((line) => line.workflow)]);
  return [...names].filter(Boolean).map((workflow): WorkflowLine => {
    const charged = spent.filter((line) => line.workflow === workflow);
    const started = phases.filter((phase) => phase.workflow === workflow).map((phase) => phase.at);
    return {
      workflow, ...ended(runs.get(workflow) ?? []),
      cost: charged.reduce((total, line) => total + line.cost, 0),
      tokens: charged.reduce((total, line) => total + line.tokens, 0),
      last: started.length ? Math.max(...started) : null,
    };
  }).sort((a, b) => b.sessions - a.sessions || b.cost - a.cost);
}
