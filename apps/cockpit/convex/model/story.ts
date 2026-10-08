/**
 * The session page's story: a session told in chapters, one per workflow it
 * passed through, built from nothing but its domain events.
 *
 * A chapter opens with what it was ASKED — the request artifact its first
 * phase wrote (the issue, or the reviewers' threads) — and then tells what
 * happened in the order it happened, in three shapes because they are three
 * kinds of thing:
 *
 *   * an AGENT phase is a card: its outcome, tool calls, cost, the artifacts
 *     it wrote and the notes it filed — judgement, worth reading;
 *   * a CODE phase is a one-line row: what it ran or committed — mechanics;
 *   * a GATE is its own card: where it was asked, and the verdict and remark
 *     of the person who answered it.
 *
 * Two rules are about authority, and they are why this is a fold of its own
 * rather than a reading of the event rows. A decision `by: policy` is an
 * AUTOMATIC row, never a gate card — nobody was asked, so nobody's name goes
 * on it — and only a person's words are ever shown as an instruction. And a
 * resume FOLDS: the phases a resumed process answers from the record are the
 * phases the session already has, keyed by phase id, marked replayed and
 * never shown twice, with one row saying the resume happened.
 *
 * Nothing here reads a transcript event (`prompt_rendered`, `harness_output`):
 * their bodies age out, and no view but the Transcript tab may depend on them.
 * Handlers are keyed by kind and version like session.ts's readers, and are
 * only ever called for an event a reader there could read.
 */
import { graphOf, type Graph, markOfStatus, type Standing } from "./graph";
import { file, numbered, type Numbered, readEntry, render, type Entry, type Note } from "./journal";
import type { Payload } from "./payload";
import { prunedOf, type Pruned } from "./retention";
import type { Summary } from "./session";

// ── what the page gets ───────────────────────────────────────────────────────

export interface Asked {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
  pruned: Pruned | null;  // its content purged (retention.ts)
}

export interface Chip {
  path: string;
  location: string;       // handoff | repo
  size: number;
}

export interface Commit {
  sha: string;
  message: string;
  filesTotal: number;
}

export interface Command {
  name: string;
  argv: string[];
  exitCode: number;
  durationSeconds: number;
  outputTail: string;
  pruned: Pruned | null;  // its output tail purged
}

export interface Decision {
  verdict: string;
  by: string;
  channel: string;
  notes: string;
  decidedAt: string;
}

interface Placed {
  seq: number;            // where in the chapter it happened
  at: string;
}

interface PhaseFacts extends Placed {
  phaseId: string;
  name: string;
  stageIndex: number | null;  // into its chapter's stages; null for the work item, the report, or a factory before them
  owner: string;
  description: string;
  status: string;
  error: string;
  // Seconds spent working: the live runs only, a replay did none. Null while one is still running.
  duration: number | null;
}

export interface AgentItem extends PhaseFacts {
  type: "agent";
  task: string;
  outputType: string;
  summary: string;
  corrections: number;    // envelopes refused and re-prompted in the same session
  model: string;          // the model its latest turn ran on, "" before one reported
  toolCalls: number;
  toolFailures: number;
  cost: number;
  tokens: number;
  changedFiles: string[];
  artifacts: Chip[];
  notes: Note[];
  replayed: boolean;
}

export interface CodeItem extends PhaseFacts {
  type: "code";
  commits: Commit[];
  commands: Command[];
}

export interface GateItem extends Placed {
  type: "gate";
  phaseId: string;
  name: string;
  stageIndex: number | null;  // the stage that asked it
  gate: string;
  round: number;
  kind: string;           // gate | questions
  status: string;         // waiting | approved | rejected | answered | aborted | passed | failed | open
  channel: string;
  issueNumber: number;
  headSha: string;
  summary: string;        // what the producing agent said it made, as the person was shown
  decision: Decision | null;
}

/** A gate hitl left off: passed by policy, and nobody was asked. */
export interface AutomaticItem extends Placed {
  type: "automatic";
  gate: string;
  round: number;
}

/** A process picked the chapter up again, and answered these phases from the record. */
export interface ResumedItem extends Placed {
  type: "resumed";
  replayed: string[];
}

export type Item = AgentItem | CodeItem | GateItem | AutomaticItem | ResumedItem;

export interface Answering {
  kind: "issue" | "pr";
  number: number;
  url: string;
}

export interface Chapter {
  number: number;         // 0 for a factory that did not say (older than chapters)
  workflow: string;
  title: string;
  input: string;          // issue | pr | prompt
  // The workflow's stages in order, by their names in the closed vocabulary,
  // as the chapter's `workflow_started` (v2) recorded them. [] from a factory
  // before it: the chapter is a flat chain of phases, and no stage is guessed.
  stages: string[];
  answering: Answering | null;
  startedAt: string;
  endedAt: string;
  status: string;
  reason: string;
  cost: number;
  asked: Asked | null;
  // The code phase that read what was asked — the issue, or the threads. Its
  // card IS the Asked card, so it is not among the items, but it is still a
  // phase of the session: the page names it and opens it like any other.
  reader: CodeItem | null;
  items: Item[];
  graph: Graph;           // the chapter as its stage graph draws it (graph.ts)
}

export interface Now {
  status: string;
  chapter: string;        // the title of the chapter the session is in
  // `since` is when its latest run started: a phase resumed starts its clock again.
  phase: { name: string; owner: string; kind: string; since: string } | null;
  waiting: { gate: string; round: number; kind: string; channel: string; issueNumber: number } | null;
  failed: { phaseId: string; name: string; error: string } | null;
  prUrl: string;
  chapters: number;
}

export interface Story {
  // What the session is about: what was typed, or else the work item it was
  // started on — a run from an issue has no prompt, only a provenance.
  title: string;
  chapters: Chapter[];
  now: Now;
  journal: string;        // exactly as the next agent reads it, "" before anything closed
  journalEntries: Numbered[];   // the same journal, one entry per number, for the page to draw
  station: { id: string; name: string; runBy: string };
  baseCommit: string;
  headCommit: string;     // the latest commit the session made, "" before it made one
  agentPhases: number;
  toolCalls: number;
}

// ── the fold ─────────────────────────────────────────────────────────────────

interface Run {
  started: string;
  ended: string;
  replay: boolean;
}

interface PhaseState {
  phaseId: string;
  number: number;         // the phase's place in the session, as the journal numbers it
  seq: number;
  at: string;
  chapter: number;
  stageIndex: number | null;
  name: string;
  kind: string;
  owner: string;
  description: string;
  task: string;
  status: string;
  error: string;
  runs: Run[];
  replayed: boolean;
  outputType: string;
  summary: string;
  corrections: number;
  model: string;
  toolCalls: number;
  toolFailures: number;
  cost: number;
  tokens: number;
  changedFiles: string[];
  artifacts: Chip[];
  request: Asked | null;
  commits: Commit[];
  commands: Command[];
  gate: string;
  round: number;
  gateKind: string;
  channel: string;
  issueNumber: number;
  headSha: string;
  gateSummary: string;
  askedAt: string;
  decision: Decision | null;
}

interface ChapterState {
  number: number;
  workflow: string;
  input: string;
  stages: string[];
  startedAt: string;
  endedAt: string;
  status: string;
  reason: string;
  issueNumber: number;
  issueUrl: string;
  prUrl: string;
}

export interface StoryState {
  chapters: ChapterState[];
  current: number | null;
  phases: PhaseState[];
  extras: { chapter: number; item: AutomaticItem | ResumedItem }[];
  resumed: ResumedItem | null;      // the row of the process now running, if it is a resume
  open: PhaseState | null;          // the phase running now, if any
  journal: Entry[];
  workflow: string;                 // what session_started named, for a factory without chapters
  station: { id: string; name: string; runBy: string };
  baseCommit: string;
  headCommit: string;
  issueNumber: number;              // of the work item the session is waiting on, if any
  request: string;                  // the first work item a provenance named
}

export function begin(): StoryState {
  return { chapters: [], current: null, phases: [], extras: [], resumed: null, open: null,
           journal: [], workflow: "", station: { id: "", name: "", runBy: "" }, baseCommit: "", headCommit: "",
           issueNumber: 0, request: "" };
}

export interface At {
  seq: number;
  ts: string;
}

type Teller = (state: StoryState, p: Payload, at: At) => void;

/**
 * The versions of `kind` the story reads, or [] for a kind it has nothing to
 * take from. A kind it tells must be told at every version a factory writes:
 * a reader in session.ts alone would keep the row and drop the kind from the
 * story without a sound (tests/story.test.ts holds the corpus to that).
 */
export function toldVersions(kind: string): number[] {
  return Object.keys(TELLERS[kind] ?? {}).map(Number);
}

/** Fold one event in, if the story has anything to take from it. */
export function tell(state: StoryState, kind: string, version: number, p: Payload, at: At): void {
  TELLERS[kind]?.[version]?.(state, p, at);
}

function chapter(state: StoryState, number: number, workflow = ""): ChapterState {
  let found = state.chapters.find((each) => each.number === number);
  if (found === undefined) {
    found = { number, workflow: workflow || state.workflow, input: "", stages: [], startedAt: "", endedAt: "",
              status: "running", reason: "", issueNumber: 0, issueUrl: "", prUrl: "" };
    state.chapters.push(found);
  }
  return found;
}

/** The chapter things happen in now. A factory older than chapters gets one numbered 0. */
function current(state: StoryState): ChapterState {
  if (state.current === null) state.current = 0;
  return chapter(state, state.current);
}

function phaseOf(state: StoryState, phaseId: string): PhaseState | undefined {
  return state.phases.find((each) => each.phaseId === phaseId);
}

function provenance(state: StoryState, p: Payload): void {
  state.request ||= p.str("request");
  const where = current(state);
  where.issueNumber ||= p.num("issue_number");
  where.issueUrl ||= p.str("issue_url");
  where.prUrl ||= p.str("pr_url");
}

function phaseStarted(state: StoryState, p: Payload, { seq, ts }: At): void {
  let found = phaseOf(state, p.str("phase_id"));
  if (found === undefined) {
    found = {
      phaseId: p.str("phase_id"), number: p.num("seq"), seq, at: ts, chapter: current(state).number,
      stageIndex: null, name: "", kind: "", owner: "", description: "", task: "", status: "", error: "", runs: [],
      replayed: false, outputType: "", summary: "", corrections: 0, model: "", toolCalls: 0, toolFailures: 0,
      cost: 0, tokens: 0, changedFiles: [], artifacts: [], request: null, commits: [], commands: [],
      gate: "", round: 0, gateKind: "gate", channel: "", issueNumber: 0, headSha: "",
      gateSummary: "", askedAt: "", decision: null,
    };
    state.phases.push(found);
  }
  Object.assign(found, {
    name: p.str("name") || found.name, kind: p.str("kind") || found.kind,
    owner: p.str("owner") || found.owner, description: p.str("description") || found.description,
    task: p.str("task") || found.task, status: "running", error: "",
  });
  found.runs.push({ started: ts, ended: "", replay: false });
  state.open = found;
}

/** The waiting a suspend or an opened gate describes, put on the gate phase it names. */
function asked(state: StoryState, waiting: Payload | null, at: At, headSha = ""): void {
  if (waiting === null) return;
  state.issueNumber = waiting.num("issue_number");
  const found = phaseOf(state, waiting.str("phase_id"));
  if (found === undefined) return;
  Object.assign(found, {
    gate: waiting.str("gate"), round: waiting.num("round"), gateKind: waiting.str("kind") || "gate",
    channel: waiting.str("channel"), issueNumber: waiting.num("issue_number"),
    gateSummary: waiting.str("summary"), headSha: headSha || found.headSha,
    askedAt: found.askedAt || at.ts,
  });
}

function withPhase(fold: (phase: PhaseState, p: Payload, at: At) => void): Teller {
  return (state, p, at) => {
    const found = phaseOf(state, p.str("phase_id"));
    if (found !== undefined) fold(found, p, at);
  };
}

function workflowStarted(state: StoryState, p: Payload, { ts }: At): ChapterState {
  const opened = chapter(state, p.num("chapter"), p.str("workflow"));
  Object.assign(opened, { workflow: p.str("workflow") || opened.workflow, input: p.str("input"),
                          startedAt: ts, status: "running" });
  state.current = opened.number;
  return opened;
}

const tellStarted: Teller = (state, p) => {
  state.workflow ||= p.str("workflow");
  state.resumed = null;             // a new process: whatever it replays, it says so itself
  state.station = { id: p.str("station_id") || state.station.id,
                    name: p.str("station_name") || state.station.name,
                    runBy: p.str("engineer") || state.station.runBy };
  state.baseCommit = p.str("base_commit") || state.baseCommit;
};

const TELLERS: Record<string, Record<number, Teller>> = {
  session_started: {
    1: tellStarted,
    2: tellStarted,                 // v2 adds station_kind, which the story has no use for
    3: tellStarted,                 // v3 adds the transcript's retention: the summary's, not the story's
  },
  workflow_started: {
    1: workflowStarted,
    2: (state, p, at) => {
      workflowStarted(state, p, at).stages = p.strs("stages");
    },
  },
  workflow_finished: {
    1: (state, p, { ts }) => {
      const closed = chapter(state, p.num("chapter"), p.str("workflow"));
      Object.assign(closed, { status: p.str("status"), reason: p.str("reason"), endedAt: ts });
    },
  },
  session_resumed: {
    1: (state, p, { seq, ts }) => {
      const resumed = chapter(state, p.num("chapter"), p.str("workflow"));
      Object.assign(resumed, { status: "running", reason: "", endedAt: "" });
      state.current = resumed.number;
      state.resumed = { type: "resumed", seq, at: ts, replayed: [] };
      state.extras.push({ chapter: resumed.number, item: state.resumed });
    },
  },
  // v2 adds the issue's author and assignees, which the story does not tell.
  provenance_recorded: { 1: provenance, 2: provenance },
  phase_started: {
    1: phaseStarted,
    2: phaseStarted,
    // v3: the stage it belongs to. Each walk of a phase says it again, and the latest stands.
    3: (state, p, at) => {
      phaseStarted(state, p, at);
      phaseOf(state, p.str("phase_id"))!.stageIndex = p.numOrNull("stage_index");
    },
  },
  phase_replayed: {
    1: (state, p) => {
      const found = phaseOf(state, p.str("phase_id"));
      if (found === undefined) return;
      found.replayed = true;
      const run = found.runs.at(-1);
      if (run) run.replay = true;
      if (state.resumed && !state.resumed.replayed.includes(found.name)) state.resumed.replayed.push(found.name);
    },
  },
  phase_ended: {
    1: (state, p, { ts }) => {
      const found = phaseOf(state, p.str("phase_id"));
      if (found === undefined) return;
      found.status = p.str("status");
      found.error = p.str("error");
      if (p.str("gate")) Object.assign(found, { gate: p.str("gate"), round: p.num("round") });
      const run = found.runs.at(-1);
      if (run && !run.ended) run.ended = ts;
      if (state.open === found) state.open = null;
    },
  },
  envelope_accepted: {
    1: withPhase((phase, p) => {
      const envelope = p.obj("envelope");
      phase.outputType = p.str("output_type");
      phase.summary = envelope?.str("summary") ?? "";
      phase.changedFiles = envelope?.strs("changed_files") ?? [];
    }),
  },
  envelope_rejected: { 1: withPhase((phase) => { phase.corrections += 1; }) },
  tool_called: {
    1: withPhase((phase, p) => {
      phase.toolCalls += 1;
      if (!p.bool("ok")) phase.toolFailures += 1;
    }),
  },
  usage: {
    1: withPhase((phase, p) => {
      phase.cost += p.num("cost");
      phase.tokens += p.num("tokens");
      phase.model = p.str("model") || phase.model;
    }),
  },
  artifact_written: {
    1: withPhase((phase, p) => {
      if (p.str("role") === "request" && phase.request === null) {
        phase.request = { path: p.str("path"), size: p.num("size"), content: p.str("content"),
                          truncated: p.bool("truncated"), pruned: prunedOf(p) };
      } else if (!phase.artifacts.some((chip) => chip.path === p.str("path"))) {
        phase.artifacts.push({ path: p.str("path"), location: p.str("location"), size: p.num("size") });
      }
    }),
  },
  committed: {
    1: (state, p, at) => {
      state.headCommit = p.str("sha") || state.headCommit;
      withPhase((phase) => {
        phase.commits.push({ sha: p.str("sha"), message: p.str("message"), filesTotal: p.num("files_total") });
      })(state, p, at);
    },
  },
  command_finished: {
    1: withPhase((phase, p) => {
      phase.commands.push({ name: p.str("name"), argv: p.strs("argv"), exitCode: p.num("exit_code"),
                            durationSeconds: p.num("duration_seconds"), outputTail: p.str("output_tail"),
                            pruned: prunedOf(p) });
    }),
  },
  gate_opened: { 1: (state, p, at) => asked(state, p.obj("waiting_for"), at) },
  suspended: {
    1: (state, p, at) => {
      asked(state, p.obj("waiting_for"), at, p.str("head_sha"));
      current(state).status = "waiting";
    },
    // v2's additions are the inbox's (inbox.ts): the story tells the wait as v1 did.
    2: (state, p, at) => {
      asked(state, p.obj("waiting_for"), at, p.str("head_sha"));
      current(state).status = "waiting";
    },
  },
  decision_recorded: {
    1: (state, p, { seq, ts }) => {
      const d = p.obj("decision");
      if (d === null) return;
      const gate = d.str("gate");
      const round = d.num("round") || 1;
      if (d.str("by") === "policy") {
        // Trust, written down — and a resumed process passing the same gate
        // again is the same pass, not a second one.
        const where = current(state).number;
        const again = state.extras.some(({ chapter, item }) =>
          chapter === where && item.type === "automatic" && item.gate === gate && item.round === round);
        if (!again) state.extras.push({ chapter: where, item: { type: "automatic", seq, at: ts, gate, round } });
        return;
      }
      // A person's answer, to the gate phase that asked this round — or, answered
      // in place at a terminal without a suspend, to the gate phase still open.
      // Two chapters may well ask the same round of the same gate: the one
      // being answered is the latest asked, in the chapter the session is in.
      const asking = [...state.phases].reverse()
        .filter((each) => each.kind === "engineer" && each.gate === gate && each.round === round);
      const found = asking.find((each) => each.chapter === state.current)
        ?? (state.open?.kind === "engineer" && !state.open.gate ? state.open : undefined)
        ?? asking[0];
      if (found === undefined) return;
      Object.assign(found, { gate, round });
      found.decision = { verdict: d.str("verdict"), by: d.str("by"), channel: d.str("channel"),
                         notes: d.str("notes"), decidedAt: d.str("decided_at") || ts };
    },
  },
  journal_noted: {
    1: (state, p) => {
      const entry = readEntry(p.obj("entry"));
      if (entry !== null) state.journal = file(state.journal, entry);
    },
  },
  session_finished: {
    // A killed process says only that the session ended: whatever phase it was
    // in ended there too, the way the session did.
    1: (state, p, { ts }) => {
      for (const phase of state.phases) {
        const run = phase.runs.at(-1);
        if (!run || run.ended) continue;
        run.ended = ts;
        if (phase.status === "running") {
          phase.status = p.str("status") || "fail";
          phase.error ||= p.str("reason");
        }
      }
      state.open = null;
    },
  },
};

// ── the story, from the fold ─────────────────────────────────────────────────

const VERDICTS: Record<string, string> = {
  approve: "approved", reject: "rejected", answer: "answered", abort: "aborted",
};

function duration(phase: PhaseState): number | null {
  let seconds = 0;
  for (const [index, run] of phase.runs.entries()) {
    if (run.replay) continue;
    if (!run.ended) {
      // Still going — or cut short by a process that never said so, which a
      // later run then took over: no end to count from.
      if (index === phase.runs.length - 1) return null;
      continue;
    }
    seconds += Math.max(0, (Date.parse(run.ended) - Date.parse(run.started)) / 1000);
  }
  return seconds;
}

/** Whether a phase of `kind` is a person at a gate, an agent, or code: the type its item and its icon say. */
export function phaseType(kind: string): "gate" | "agent" | "code" {
  return kind === "engineer" ? "gate" : kind === "agent" ? "agent" : "code";
}

function item(phase: PhaseState, journal: Entry[]): Item {
  const placed = { seq: phase.seq, at: phase.at, phaseId: phase.phaseId, name: phase.name,
                   stageIndex: phase.stageIndex };
  if (phase.kind === "engineer") {
    const status = phase.decision ? VERDICTS[phase.decision.verdict] ?? phase.decision.verdict
      : phase.status === "waiting" ? "waiting"
      : phase.status === "success" ? "passed"
      : phase.status === "fail" ? "failed" : "open";
    return { ...placed, type: "gate", gate: phase.gate, round: phase.round, kind: phase.gateKind, status,
             channel: phase.channel, issueNumber: phase.issueNumber, headSha: phase.headSha,
             summary: phase.gateSummary, decision: phase.decision, at: phase.askedAt || phase.at };
  }
  const facts = factsOf(phase);
  if (phase.kind === "agent") {
    const notes = journal
      .filter((entry) => entry.note !== null && entry.seq === phase.number && entry.phase === phase.name)
      .map((entry) => entry.note!);
    return { ...facts, type: "agent", task: phase.task, outputType: phase.outputType, summary: phase.summary,
             corrections: phase.corrections, model: phase.model, toolCalls: phase.toolCalls, toolFailures: phase.toolFailures,
             cost: phase.cost, tokens: phase.tokens, changedFiles: phase.changedFiles,
             artifacts: phase.artifacts, notes, replayed: phase.replayed };
  }
  return codeItem(phase);
}

/** What an agent card and a code row both say of their phase. */
function factsOf(phase: PhaseState) {
  return { seq: phase.seq, at: phase.at, phaseId: phase.phaseId, name: phase.name,
           stageIndex: phase.stageIndex, owner: phase.owner,
           description: phase.description, status: phase.status, error: phase.error, duration: duration(phase) };
}

function codeItem(phase: PhaseState): CodeItem {
  return { ...factsOf(phase), type: "code", commits: phase.commits, commands: phase.commands };
}

function answering(chapter: ChapterState): Answering | null {
  if (chapter.input === "issue" && chapter.issueNumber) {
    return { kind: "issue", number: chapter.issueNumber, url: chapter.issueUrl };
  }
  const pr = /\/pull\/(\d+)\/?$/.exec(chapter.prUrl);
  if (chapter.input === "pr" && pr) return { kind: "pr", number: Number(pr[1]), url: chapter.prUrl };
  return null;
}

export function finish(state: StoryState, summary: Summary): Story {
  const ordered = [...state.chapters].sort((a, b) => a.number - b.number);
  const live = summary.status === "running" || summary.status === "waiting";
  const inChapter = state.current ?? ordered.at(-1)?.number;
  // A chapter that did not say how it ended stopped where the session did, if the session stopped.
  const standing = (chapter: ChapterState): Standing => {
    const ended = markOfStatus(chapter.status === "success" || chapter.status === "fail" || live ? chapter.status : summary.status);
    return { here: chapter.number === inChapter, ended: ended === "done" || ended === "failed" ? ended : null };
  };
  const rounds = new Map<string, number>();
  const chapters = ordered.map((each): Chapter => {
    const mine = state.phases.filter((phase) => phase.chapter === each.number);
    const requester = mine.find((phase) => phase.request !== null);
    // The code phase that read the issue or the threads IS the chapter's Asked;
    // an agent or a gate that wrote a request did more than that, and keeps its card.
    const reader = requester?.kind === "code" ? requester : undefined;
    const shown = mine.filter((phase) => phase !== reader);
    const items = [
      ...shown.map((phase) => item(phase, state.journal)),
      ...state.extras.filter(({ chapter }) => chapter === each.number).map(({ item }) => item),
    ].sort((a, b) => a.seq - b.seq);
    const round = (rounds.get(each.workflow) ?? 0) + 1;
    rounds.set(each.workflow, round);
    const told = { stages: each.stages, reader: reader ? codeItem(reader) : null, items };
    return {
      ...told, graph: graphOf(told, standing(each)), number: each.number, workflow: each.workflow, input: each.input,
      title: each.input === "pr" ? `${each.workflow}, round ${round}` : each.workflow,
      answering: answering(each), startedAt: each.startedAt || (mine[0]?.at ?? ""),
      endedAt: each.endedAt, status: each.status, reason: each.reason,
      cost: mine.reduce((total, phase) => total + phase.cost, 0),
      asked: requester?.request ?? null,
    };
  });

  const here = chapters.find((each) => each.number === state.current) ?? chapters.at(-1);
  const failed = [...state.phases].reverse().find((phase) => phase.status === "fail");
  const open = summary.status === "running" ? state.open : null;
  const waiting = summary.status === "waiting" ? summary.waitingFor : null;
  return {
    title: summary.request || state.request,
    chapters,
    now: {
      status: summary.status,
      chapter: here?.title ?? "",
      phase: open && { name: open.name, owner: open.owner, kind: open.kind, since: open.runs.at(-1)?.started ?? open.at },
      waiting: waiting && { gate: waiting.gate, round: waiting.round, kind: waiting.kind,
                            channel: waiting.channel, issueNumber: state.issueNumber },
      failed: summary.status === "fail" && failed ? { phaseId: failed.phaseId, name: failed.name, error: failed.error } : null,
      prUrl: summary.prUrl,
      chapters: chapters.length,
    },
    journal: render(state.journal),
    journalEntries: numbered(state.journal),
    station: state.station,
    baseCommit: state.baseCommit,
    headCommit: state.headCommit,
    agentPhases: state.phases.filter((phase) => phase.kind === "agent").length,
    toolCalls: state.phases.reduce((total, phase) => total + phase.toolCalls, 0),
  };
}
