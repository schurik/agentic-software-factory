/**
 * One phase opened into its tabs: Overview · Diff · Artifacts · Checks · Tools ·
 * Agent prompt · Harness output · Events — the detail a phase card keeps one
 * click away.
 *
 * Folded from the session's events like the story (story.ts), keyed by kind and
 * version the same way, but for one phase and on demand: a phase's detail holds
 * its artifacts' bodies, which the session page as a whole has no reason to
 * carry. Its tool calls, its event rows and its transcript are each a query of
 * their own, asked for when their tab is shown (#275) — the transcript read
 * from its own table (`promptsOf`, `outputOf`), never folded with the rest.
 */
import { Payload } from "./payload";
import { prunedOf, type Pruned } from "./retention";
import type { Row } from "./session";
import type { At } from "./story";
import type { StoredEvent } from "./wire";

// ── what the tabs get ────────────────────────────────────────────────────────

/** The most of a repo file the cockpit shows: the cap the factory puts on a handoff file (`BODY_BYTES`). */
export const READ_BYTES = 256 * 1024;

export interface Artifact {
  seq: number;
  at: string;
  path: string;
  role: string;           // request | output
  location: string;       // handoff | repo
  size: number;           // of the whole file
  digest: string;         // sha256 of the whole file
  content: string;        // a handoff file, as shipped; "" for a repo file, read from the forge
  truncated: boolean;
  pruned: Pruned | null;  // its content purged (retention.ts): the file was here, and is no longer
  // A repo file only: the commit whose tree holds this version — the first one
  // after it was written — or, when another phase wrote the file again before
  // anything committed it, that phase: this version never reached the forge.
  committed: Pin | null;
  rewritten: { phase: string; seq: number } | null;
  changedLater: Pin | null;   // the latest commit after `committed` that changed the file again
}

export interface Pin {
  sha: string;
  phase: string;          // the phase that committed it
}

export interface GateCheck {
  seq: number;
  at: string;
  gate: string;
  attempt: number;
  passed: boolean;
  replayed: boolean;      // a resume checking the record it answers from (attempt 0), not a run of the agent
  violations: string[];
  checks: { item: string; ok: boolean; note: string }[];
}

/** An envelope the gates never saw: refused as unreadable, and re-prompted in the same session. */
export interface Rejection {
  seq: number;
  at: string;
  attempt: number;
  outputType: string;
  error: string;
  raw: string;            // what the agent answered instead
}

export interface Command {
  seq: number;
  at: string;
  name: string;
  argv: string[];
  exitCode: number;
  durationSeconds: number;
  outputTail: string;
  pruned: Pruned | null;  // its output tail purged
}

/**
 * A tool call: its name, whether it worked and how long it took — the factory sends nothing more.
 * `parentCallId` is the call whose subagent made it (Claude Code's `Task`), "" for the agent's own;
 * both ids are "" before tool_called v2.
 */
export interface ToolCall {
  seq: number;
  at: string;
  agent: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  callId: string;
  parentCallId: string;
}

/** One agent turn's spend, and the context window's occupancy after it. */
export interface Turn {
  seq: number;
  at: string;
  agent: string;
  model: string;
  tokens: number;
  cost: number;
  breakdown: { inputTokens: number; outputTokens: number; cacheReadTokens: number;
               cacheWriteTokens: number; reasoningTokens: number };
  contextTokens: number;
  contextWindow: number;  // 0 when the harness did not say
}

export interface Envelope {
  seq: number;
  agent: string;
  outputType: string;
  attempt: number;        // 0: answered from the record by a resume
  json: string;           // the envelope as the agent reported it
}

export interface CommitMade {
  seq: number;
  sha: string;
  message: string;
  files: string[];
  filesTotal: number;
}

export interface Send {
  seq: number;
  at: string;
  send: number;           // from 1 within a run: the task first, then each correction
  digest: string;
  system: string;         // the agent's identity, on the first send only
  prompt: string;
  truncated: boolean;
}

/** A piece of the harness's raw stream, cut where a chunk filled (`engine/agents.py`'s `_HarnessOutput`). */
export interface Chunk {
  seq: number;
  chunk: number;
  text: string;
}

/** Where one walk of the phase began: its `phase_started`. What a transcript's events are told apart by (`runsOf`). */
export interface Walked {
  seq: number;
  at: string;
}

/**
 * One part of a phase's transcript, as its tab reads it: the prompts it sent,
 * or its harness's output. `pruned` says when it aged out or was purged
 * (retention.ts): its events are still here, and their bodies are not.
 * `newer` counts its events of a version this cockpit cannot read, which the
 * tab says rather than hide.
 */
export interface TranscriptPart<T> {
  pruned: Pruned | null;
  items: T[];
  newer: number;
}

export type Prompts = TranscriptPart<Send>;
export type Output = TranscriptPart<Chunk>;

export interface PhaseDetail {
  phaseId: string;
  name: string;
  kind: string;
  owner: string;
  description: string;
  task: string;
  promptDigest: string;
  status: string;
  error: string;
  envelope: Envelope | null;
  commits: CommitMade[];
  // Whether the session shipped any transcript at all. A factory writes one
  // for every prompt it sends once `cockpit.transcripts` is on, so a session
  // with none has it off — not a transcript that went missing.
  transcripts: boolean;
  walks: Walked[];
  artifacts: Artifact[];
  checks: GateCheck[];
  rejections: Rejection[];
  commands: Command[];
  // How many tool calls it made: whether it has a Tools tab. The calls are that tab's own query.
  toolCalls: number;
  usage: Turn[];
}

// ── the fold ─────────────────────────────────────────────────────────────────

interface Written {
  seq: number;
  path: string;
  phaseId: string;
}

interface Commit {
  seq: number;
  sha: string;
  files: string[];
  phaseId: string;
}

export interface DetailState {
  phaseId: string;
  name: string;
  kind: string;
  owner: string;
  description: string;
  task: string;
  promptDigest: string;
  status: string;
  error: string;
  envelope: Envelope | null;
  commits: CommitMade[];               // this phase's own
  walks: Walked[];
  transcripts: boolean;             // whether the session shipped any transcript event
  artifacts: Artifact[];
  checks: GateCheck[];
  rejections: Rejection[];
  commands: Command[];
  tools: ToolCall[];
  usage: Turn[];
  // The whole session's, not just this phase's: where a repo file is on the
  // forge depends on what every phase after it wrote and committed.
  phaseNames: Map<string, string>;
  repoWrites: Written[];
  sessionCommits: Commit[];
}

export function beginDetail(phaseId: string): DetailState {
  return { phaseId, name: "", kind: "", owner: "", description: "", task: "", promptDigest: "", status: "",
           error: "", envelope: null, commits: [], walks: [], transcripts: false,
           artifacts: [], checks: [], rejections: [], commands: [], tools: [], usage: [],
           phaseNames: new Map(), repoWrites: [], sessionCommits: [] };
}

type Detailer = (state: DetailState, p: Payload, at: At) => void;

/**
 * The versions of `kind` the tabs read, or [] for a kind they take nothing
 * from. Like the story's (`toldVersions`), a kind read at all is read at every
 * version a factory writes, or it would drop out of a tab without a sound.
 */
export function detailedVersions(kind: string): number[] {
  return Object.keys(DETAILERS[kind] ?? {}).map(Number);
}

/** Fold one event in, if the phase's tabs have anything to take from it. */
export function detail(state: DetailState, kind: string, version: number, p: Payload, at: At): void {
  DETAILERS[kind]?.[version]?.(state, p, at);
}

const mine = (state: DetailState, p: Payload) => p.str("phase_id") === state.phaseId;

/** A handler for this phase's own events only. */
function own(fold: Detailer): Detailer {
  return (state, p, at) => {
    if (mine(state, p)) fold(state, p, at);
  };
}

const toolCalled = own((state, p, { seq, ts }) => {
  state.tools.push({ seq, at: ts, agent: p.str("agent"), tool: p.str("tool"), ok: p.bool("ok"),
                     durationMs: p.num("duration_ms"), callId: p.str("call_id"),
                     parentCallId: p.str("parent_call_id") });
});

function phaseStarted(state: DetailState, p: Payload, { seq, ts }: At): void {
  if (p.str("name")) state.phaseNames.set(p.str("phase_id"), p.str("name"));
  if (!mine(state, p)) return;
  // A replay announces the phase without a digest: it sent nothing, so it keeps the one the live run had.
  Object.assign(state, {
    name: p.str("name") || state.name, kind: p.str("kind") || state.kind, owner: p.str("owner") || state.owner,
    description: p.str("description") || state.description, task: p.str("task") || state.task,
    promptDigest: p.str("prompt_digest") || state.promptDigest, status: "running", error: "",
  });
  state.walks.push({ seq, at: ts });
}

const DETAILERS: Record<string, Record<number, Detailer>> = {
  phase_started: { 1: phaseStarted, 2: phaseStarted, 3: phaseStarted },   // v3's stage is the story's
  artifact_written: {
    1: (state, p, { seq, ts }) => {
      if (p.str("location") === "repo") state.repoWrites.push({ seq, path: p.str("path"), phaseId: p.str("phase_id") });
      if (!mine(state, p)) return;
      state.artifacts.push({
        seq, at: ts, path: p.str("path"), role: p.str("role"), location: p.str("location"),
        size: p.num("size"), digest: p.str("digest"), content: p.str("content"), truncated: p.bool("truncated"),
        pruned: prunedOf(p), committed: null, rewritten: null, changedLater: null,
      });
    },
  },
  phase_ended: {
    1: own((state, p) => {
      state.status = p.str("status");
      state.error = p.str("error");
    }),
  },
  envelope_accepted: {
    1: own((state, p, { seq }) => {
      // The live report stands; a resume answering from the record reports it again, unchanged.
      if (state.envelope !== null && state.envelope.attempt > 0 && p.num("attempt") === 0) return;
      const envelope = p.obj("envelope");
      state.envelope = { seq, agent: p.str("agent"), outputType: p.str("output_type"), attempt: p.num("attempt"),
                         json: JSON.stringify(envelope?.value() ?? {}, null, 2) };
    }),
  },
  // Transcript events: stored apart (schema.ts), and read by their own tabs (`promptsOf`, `outputOf`), so
  // a session's are not folded here at all. Handed one all the same, the tabs take only that it came.
  prompt_rendered: { 1: (state) => { state.transcripts = true; } },
  harness_output: { 1: (state) => { state.transcripts = true; } },
  gate_result: {
    1: own((state, p, { seq, ts }) => {
      const checks = p.list("checks").map((check) => ({ item: check.str("item"), ok: check.bool("ok"), note: check.str("note") }));
      state.checks.push({ seq, at: ts, gate: p.str("gate"), attempt: p.num("attempt"), passed: p.bool("passed"),
                          replayed: p.num("attempt") === 0, violations: p.strs("violations"), checks });
    }),
  },
  envelope_rejected: {
    1: own((state, p, { seq, ts }) => {
      state.rejections.push({ seq, at: ts, attempt: p.num("attempt"), outputType: p.str("output_type"),
                              error: p.str("error"), raw: p.str("raw") });
    }),
  },
  command_finished: {
    1: own((state, p, { seq, ts }) => {
      state.commands.push({ seq, at: ts, name: p.str("name"), argv: p.strs("argv"), exitCode: p.num("exit_code"),
                            durationSeconds: p.num("duration_seconds"), outputTail: p.str("output_tail"),
                            pruned: prunedOf(p) });
    }),
  },
  // v2 adds the ids, which read as "" off a v1 line.
  tool_called: { 1: toolCalled, 2: toolCalled },
  usage: {
    1: own((state, p, { seq, ts }) => {
      const usage = p.obj("usage");
      const count = (key: string) => usage?.num(key) ?? 0;
      state.usage.push({
        seq, at: ts, agent: p.str("agent"), model: p.str("model"), tokens: p.num("tokens"), cost: p.num("cost"),
        breakdown: { inputTokens: count("input_tokens"), outputTokens: count("output_tokens"),
                     cacheReadTokens: count("cache_read_tokens"), cacheWriteTokens: count("cache_write_tokens"),
                     reasoningTokens: count("reasoning_tokens") },
        contextTokens: p.num("context_tokens"), contextWindow: p.num("context_window"),
      });
    }),
  },
  committed: {
    1: (state, p, { seq }) => {
      state.sessionCommits.push({ seq, sha: p.str("sha"), files: p.strs("files"), phaseId: p.str("phase_id") });
      if (mine(state, p)) {
        state.commits.push({ seq, sha: p.str("sha"), message: p.str("message"), files: p.strs("files"),
                                 filesTotal: p.num("files_total") });
      }
    },
  },
};

/**
 * Where a repo file of this phase is on the forge. A phase commits the run's
 * whole tree (`run.commit`), so the first commit after the file was written
 * holds it as written — unless a phase wrote it again first. Which commits
 * changed it later is what their `files` name; one that names more paths than
 * it lists (`files_total`) may have too, and is not guessed at.
 */
function locate(state: DetailState, artifact: Artifact): Artifact {
  if (artifact.location !== "repo") return artifact;
  const name = (phaseId: string) => state.phaseNames.get(phaseId) ?? "";
  const next = state.sessionCommits.find((commit) => commit.seq > artifact.seq);
  const again = state.repoWrites.find((write) =>
    write.path === artifact.path && write.seq > artifact.seq && (next === undefined || write.seq < next.seq));
  if (again !== undefined) return { ...artifact, rewritten: { phase: name(again.phaseId), seq: again.seq } };
  if (next === undefined) return artifact;
  const changed = state.sessionCommits.filter((commit) => commit.seq > next.seq && commit.files.includes(artifact.path)).at(-1);
  return {
    ...artifact,
    committed: { sha: next.sha, phase: name(next.phaseId) },
    changedLater: changed ? { sha: changed.sha, phase: name(changed.phaseId) } : null,
  };
}

/**
 * Whether a row is about this phase: an event naming it, or the wait it asked.
 * The Events tab is this phase's share of the session's rows, unread ones
 * included — nothing is hidden here either.
 */
export function isAbout(row: Row, phaseId: string): boolean {
  const p = Payload.parse(row.raw);
  return p.str("phase_id") === phaseId || p.obj("waiting_for")?.str("phase_id") === phaseId;
}

/** The tabs, or null for a phase the session never started. */
export function finishDetail(state: DetailState): PhaseDetail | null {
  if (!state.name) return null;
  return {
    phaseId: state.phaseId, name: state.name, kind: state.kind, owner: state.owner,
    description: state.description, task: state.task, promptDigest: state.promptDigest,
    status: state.status, error: state.error, envelope: state.envelope, commits: state.commits,
    transcripts: state.transcripts, walks: state.walks,
    artifacts: state.artifacts.map((artifact) => locate(state, artifact)),
    checks: state.checks, rejections: state.rejections, commands: state.commands,
    toolCalls: state.tools.length, usage: state.usage,
  };
}

// ── the transcript: each of its tabs, read from its own table ────────────────

/**
 * The Agent prompt tab: what one phase sent its agent, read off its
 * `prompt_rendered` events alone (the `transcripts` table's `by_phase` range).
 * Only the version this cockpit reads is taken; a newer one is counted, for
 * the tab to say an upgrade would show it.
 */
export function promptsOf(events: StoredEvent[]): Prompts {
  return part(events, "prompt_rendered", (p, { seq, ts }) => ({
    seq, at: ts, send: p.num("send"), digest: p.str("digest"), system: p.str("system"), prompt: p.str("prompt"),
    truncated: p.bool("truncated"),
  }));
}

/** The Harness output tab: one phase's raw stream, read off its `harness_output` events alone. */
export function outputOf(events: StoredEvent[]): Output {
  return part(events, "harness_output", (p, { seq }) => ({ seq, chunk: p.num("chunk"), text: p.str("text") }));
}

function part<T>(events: StoredEvent[], kind: string, read: (p: Payload, at: At) => T): TranscriptPart<T> {
  let pruned: Pruned | null = null;
  let newer = 0;
  const items: T[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.kind !== kind) continue;
    if (event.v !== 1) {
      newer += 1;
      continue;
    }
    const p = Payload.parse(event.payload);
    pruned ??= prunedOf(p);
    items.push(read(p, { seq: event.seq, ts: event.ts }));
  }
  return { pruned, items, newer };
}

/**
 * A transcript's items told apart by the walk of the phase each came in — the
 * last `phase_started` of it before them — leaving out a walk that sent
 * nothing. One that came before any walk (a stream cut short) is a walk of its
 * own, of no known time.
 */
export function runsOf<T extends { seq: number }>(walks: Walked[], items: T[]): { at: string; items: T[] }[] {
  const runs = [{ seq: -Infinity, at: "" }, ...[...walks].sort((a, b) => a.seq - b.seq)]
    .map((walk) => ({ ...walk, items: [] as T[] }));
  for (const item of items) {
    let run = runs[0];
    for (const each of runs) if (each.seq < item.seq) run = each;
    run.items.push(item);
  }
  for (const run of runs) run.items.sort((a, b) => a.seq - b.seq);
  return runs.filter((run) => run.items.length > 0).map(({ at, items: each }) => ({ at, items: each }));
}

/** A run's harness output as one text: its chunks in the order they were cut. */
export function joined(chunks: Chunk[]): string {
  return [...chunks].sort((a, b) => a.chunk - b.chunk).map((chunk) => chunk.text).join("");
}
