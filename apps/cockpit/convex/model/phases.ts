/**
 * What each phase of a session did, one row a phase (#119): what a factory's
 * pages count stages, gates and their waits from, without reading a single
 * event — the way `spend.ts` keeps what agent calls cost.
 *
 * Folded at ingest, a batch at a time, onto the rows the batches before it
 * left: so a row carries, besides what it says, what the next batch needs to
 * go on from (`since`, `replay`). Its rules are the story's (story.ts), kept
 * to the few a figure needs:
 *
 *   * a phase is one row however often a resume walked it, keyed by its id,
 *     in the chapter it first started in;
 *   * it belongs to the stage its latest `phase_started` (v3) named, by the
 *     stages its chapter's `workflow_started` (v2) listed — never by its name,
 *     and none for the work item, the report or a factory before stages;
 *   * its duration is the time its live runs worked: a replay did none, and a
 *     run a later one took over without an end has no end to count from;
 *   * a gate's row is a round a person was asked: what they answered, and how
 *     long it waited for them. A gate the policy passed asked nobody, and has
 *     no phase to be a row of.
 */
import { Payload } from "./payload";
import { advance, type Summary } from "./session";
import type { StoredEvent } from "./wire";

export interface PhaseRow {
  /** The phase's id: what a row is found by. */
  phase: string;
  chapter: number;
  workflow: string;
  /** Its stage, by name in the closed vocabulary, and where that stands in its chapter's; null for none. */
  stage: string | null;
  stageIndex: number | null;
  /** agent | code | gate: a gate is a phase a person is asked at. */
  kind: string;
  name: string;
  /** As the factory last said: running | waiting | success | fail. */
  status: string;
  /** When it first started, epoch ms: what a period takes it by. */
  at: number;
  /** Seconds its live runs worked. */
  duration: number;
  /** When the run going on now started, epoch ms; null when none is. */
  since: number | null;
  /** Whether that run answers from the record, and so counts no time. */
  replay: boolean;
  /** What its agent calls cost, list-price equivalent USD, and the tokens they took. */
  cost: number;
  tokens: number;
  /** A gate's round, as it was asked: "" and 0 for any other phase. */
  gate: string;
  round: number;
  /** When it was asked, epoch ms; null before it was. */
  askedAt: number | null;
  /** What the person answered — approve | reject | answer | abort — "" before they did. */
  verdict: string;
  /** Seconds from being asked to the answer; null before one, or when it was never asked. */
  wait: number | null;
}

const KINDS: Record<string, string> = { engineer: "gate" };

/**
 * The versions of `kind` the rows read, or [] for a kind they take nothing
 * from. Like the story's tellers, a kind folded here must be folded at every
 * version a factory writes, or a new one would ship counting nothing
 * (tests/phases.test.ts holds the corpus to that).
 */
export function foldedVersions(kind: string): number[] {
  return Object.keys(FOLDS[kind] ?? {}).map(Number);
}

/**
 * The rows `events` started or changed, folded onto `rows` — every row the
 * session had before them — with the session's summary folded up to `before`
 * when they start, in the order their phases first started. An event whose
 * timestamp cannot be read happened at `fallback`, when the cockpit took it in.
 */
export function phasedIn(rows: PhaseRow[], events: StoredEvent[], before: Summary, fallback: number): PhaseRow[] {
  const all = rows.map((row) => ({ ...row }));
  const changed = new Set<PhaseRow>();
  let summary = before;
  for (const event of events) {
    summary = advance(summary, [event]);
    const fold = FOLDS[event.kind]?.[event.v];
    if (fold === undefined) continue;
    const ts = Date.parse(event.ts);
    const touched = fold(all, Payload.parse(event.payload), { at: Number.isNaN(ts) ? fallback : ts, summary });
    for (const row of touched) changed.add(row);
  }
  return all.filter((row) => changed.has(row)).sort((a, b) => a.at - b.at);
}

interface Context {
  at: number;
  /** The session as the event left it: the chapter it is in, that chapter's stages, its workflow. */
  summary: Summary;
}

/** An event's change to the rows: those it touched. */
type Fold = (rows: PhaseRow[], p: Payload, context: Context) => PhaseRow[];

const byId = (rows: PhaseRow[], phase: string) => rows.filter((row) => row.phase === phase);

function started(rows: PhaseRow[], p: Payload, { at, summary }: Context, stageIndex?: number | null): PhaseRow[] {
  let row = byId(rows, p.str("phase_id"))[0];
  if (row === undefined) {
    row = {
      phase: p.str("phase_id"), chapter: summary.chapter, workflow: summary.workflow || (summary.workflows.at(-1) ?? ""),
      stage: null, stageIndex: null, kind: KINDS[p.str("kind")] ?? p.str("kind"), name: p.str("name"), status: "",
      at, duration: 0, since: null, replay: false, cost: 0, tokens: 0,
      gate: "", round: 0, askedAt: null, verdict: "", wait: null,
    };
    rows.push(row);
  }
  Object.assign(row, { status: "running", since: at, replay: false });
  if (stageIndex !== undefined) {
    // Each walk says it again, and the latest stands. A stage its chapter never named is none.
    const stage = stageIndex === null ? null : summary.stages[stageIndex] ?? null;
    Object.assign(row, { stage, stageIndex: stage === null ? null : stageIndex });
  }
  return [row];
}

/** The run going on now ends at `at`: its time counts, unless it was a replay. */
function ended(row: PhaseRow, at: number): void {
  if (row.since !== null && !row.replay) row.duration += Math.max(0, (at - row.since) / 1000);
  Object.assign(row, { since: null, replay: false });
}

/** A suspend or an opened gate puts what it asks on the gate phase it names. */
function asked(rows: PhaseRow[], waiting: Payload | null, at: number): PhaseRow[] {
  if (waiting === null) return [];
  return byId(rows, waiting.str("phase_id")).map((row) => {
    const since = Date.parse(waiting.str("since"));
    return Object.assign(row, {
      gate: waiting.str("gate"), round: waiting.num("round"),
      askedAt: row.askedAt ?? (Number.isNaN(since) ? at : since),
    });
  });
}

const FOLDS: Record<string, Record<number, Fold>> = {
  phase_started: {
    1: (rows, p, context) => started(rows, p, context),
    2: (rows, p, context) => started(rows, p, context),
    3: (rows, p, context) => started(rows, p, context, p.numOrNull("stage_index")),
  },
  phase_replayed: {
    1: (rows, p) => byId(rows, p.str("phase_id")).map((row) => Object.assign(row, { replay: true })),
  },
  phase_ended: {
    1: (rows, p, { at }) => byId(rows, p.str("phase_id")).map((row) => {
      ended(row, at);
      row.status = p.str("status");
      if (p.str("gate")) Object.assign(row, { gate: p.str("gate"), round: p.num("round") });
      return row;
    }),
  },
  usage: {
    1: (rows, p) => byId(rows, p.str("phase_id")).map((row) =>
      Object.assign(row, { cost: row.cost + p.num("cost"), tokens: row.tokens + p.num("tokens") })),
  },
  gate_opened: { 1: (rows, p, { at }) => asked(rows, p.obj("waiting_for"), at) },
  suspended: {
    1: (rows, p, { at }) => asked(rows, p.obj("waiting_for"), at),
    2: (rows, p, { at }) => asked(rows, p.obj("waiting_for"), at),
  },
  decision_recorded: {
    1: (rows, p, { at, summary }) => {
      const d = p.obj("decision");
      // The policy's pass asked nobody: there is no round a person answered.
      if (d === null || d.str("by") === "policy") return [];
      const gate = d.str("gate");
      const round = d.num("round") || 1;
      // The phase that asked this round — in the chapter the session is in, the
      // latest asked — or, answered in place without a suspend, the gate open now.
      const asking = rows.filter((row) => row.kind === "gate" && row.gate === gate && row.round === round).reverse();
      const row = asking.find((each) => each.chapter === summary.chapter)
        ?? rows.find((each) => each.kind === "gate" && each.since !== null && !each.gate)
        ?? asking[0];
      if (row === undefined) return [];
      const decided = Date.parse(d.str("decided_at"));
      const answered = Number.isNaN(decided) ? at : decided;
      return [Object.assign(row, {
        gate, round, verdict: d.str("verdict"),
        wait: row.askedAt === null ? null : Math.max(0, (answered - row.askedAt) / 1000),
      })];
    },
  },
  session_finished: {
    // A killed process says only that the session ended: whatever phase it was in ended there too.
    1: (rows, p, { at }) => rows.filter((row) => row.since !== null).map((row) => {
      ended(row, at);
      if (row.status === "running") row.status = p.str("status") || "fail";
      return row;
    }),
  },
};
