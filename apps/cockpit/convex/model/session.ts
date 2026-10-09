/**
 * What a session is, read off its domain events — the cockpit's half of the
 * projection `tests/projection.py` does for the factory, with the same rules
 * (a resumed session re-opens its record and keeps what it learned; a consumed
 * decision stops the wait; `session_finished` says how it ended).
 *
 * Every view is a fold over events in seq order, so rebuilding one after an
 * upgrade is folding again from zero. Readers are keyed by kind AND version:
 * the cockpit keeps reading every version a factory ever wrote, and an event it
 * has no reader for is kept, shown as a generic row and folded into nothing —
 * never guessed at, never refused. The fixtures under `tests/golden/events/`
 * are the list of what must have a reader here.
 */
import { v, type Infer } from "convex/values";
import { Payload } from "./payload";
import { beginDetail, detail, finishDetail, type DetailState, type PhaseDetail } from "./phase";
import { prunedOf, prunedWord } from "./retention";
import { begin, finish, tell, type Story, type StoryState } from "./story";
import { isRecord, type StoredEvent } from "./wire";

// ── the summary: what the sessions list shows, stored beside each session ────

export const waitingForValidator = v.object({
  gate: v.string(),
  round: v.number(),
  kind: v.string(),               // gate | questions
  channel: v.string(),            // issue | pr | terminal
  since: v.string(),
  // What an inbox row says, and decides whether it may be answered with.
  issueNumber: v.number(),
  summary: v.string(),
  subjectDigest: v.string(),
  questions: v.number(),          // how many a question round asks
  // Whose reply the factory will hear: null when the station's factory did not
  // say (a `suspended` before v2), [] for anyone the forge lets reply.
  trusted: v.union(v.null(), v.array(v.string())),
  // Whether the subject is on the forge at the pinned commit; null when not said.
  published: v.union(v.null(), v.boolean()),
  // A decision recorded for this round that the run has not acted on yet.
  answered: v.union(v.null(), v.object({ by: v.string(), verdict: v.string() })),
});

export const summaryValidator = v.object({
  status: v.string(),                 // unknown until session_started | running | waiting | success | fail
  workflows: v.array(v.string()),     // every workflow the session passed through, in order
  workflow: v.string(),               // the one running now: what the latest process said it ran
  chapter: v.number(),                // the chapter it is in now; 0 for a factory before chapters
  stages: v.array(v.string()),        // that chapter's stages, as its `workflow_started` v2 named them; [] when it did not
  request: v.string(),
  branch: v.string(),
  baseRef: v.string(),
  trigger: v.string(),
  triggeredBy: v.string(),             // the forge login of whoever started it: a labeller, or the operator
  issueAuthor: v.string(),             // who wrote the issue it answers, when it answers one
  issueAssignees: v.array(v.string()), // whom that issue was assigned to when the run read it
  issueUrl: v.string(),
  prUrl: v.string(),
  stationId: v.string(),               // the station that holds it: where its commands go
  stationName: v.string(),
  stationKind: v.string(),             // local | ci; "" from a factory before session_started v2
  skillVersion: v.string(),
  startedAt: v.string(),
  endedAt: v.string(),
  lastEventAt: v.string(),
  waitingFor: v.union(v.null(), waitingForValidator),
  totalTokens: v.number(),
  totalCost: v.number(),
  unread: v.number(),                 // events no reader here could read: time to upgrade the cockpit
  // How many days after it finished factory.yaml lets a cockpit keep the
  // session's transcript (`session_started` v3): the lowest any of its
  // processes ran under, 0 when none set one and the deployment's own applies.
  transcriptDays: v.number(),
});

export type Summary = Infer<typeof summaryValidator>;
export type WaitingFor = Infer<typeof waitingForValidator>;

const EMPTY_WAITING: WaitingFor = {
  gate: "", round: 0, kind: "gate", channel: "issue", since: "", issueNumber: 0, summary: "",
  subjectDigest: "", questions: 0, trusted: null, published: null, answered: null,
};

export const EMPTY_SUMMARY: Summary = {
  status: "unknown", workflows: [], workflow: "", chapter: 0, stages: [], request: "", branch: "", baseRef: "", trigger: "",
  triggeredBy: "", issueAuthor: "", issueAssignees: [], issueUrl: "", prUrl: "", stationId: "", stationName: "", stationKind: "", skillVersion: "",
  startedAt: "", endedAt: "", lastEventAt: "", waitingFor: null,
  totalTokens: 0, totalCost: 0, unread: 0, transcriptDays: 0,
};

// ── the session page ─────────────────────────────────────────────────────────

export type Unread = "unknown kind" | "newer version";

export interface Row {
  seq: number;
  ts: string;
  kind: string;
  v: number;
  unreadBecause: Unread | null;   // why this is a generic row, or null when it was read
  detail: string;                 // one line saying what happened, "" when unread
  raw: string;                    // the payload as the JSON text it arrived as
}

export interface SessionView {
  summary: Summary;
  story: Story;
  events: Row[];
  // Whether the session shipped any transcript event: its factory opted in
  // (`cockpit: {transcripts: true}`). Their bodies age out; that they came does not.
  transcripts: boolean;
}

const TRANSCRIPT_KINDS = ["prompt_rendered", "harness_output"];

/** The whole page: every stored event a row, and what those up to `acked` tell (`fold`). */
export function view(events: StoredEvent[], acked: number): SessionView {
  const state: State = { summary: structuredClone(EMPTY_SUMMARY), story: begin(), detail: null };
  const rows = fold(state, events, acked);
  return { summary: state.summary, story: finish(state.story!, state.summary), events: rows,
           transcripts: rows.some((row) => TRANSCRIPT_KINDS.includes(row.kind)) };
}

/** One phase of the page, opened into its tabs (phase.ts); null for a phase it never started. */
export function phaseView(events: StoredEvent[], acked: number, phaseId: string): PhaseDetail | null {
  const state: State = { summary: structuredClone(EMPTY_SUMMARY), story: null, detail: beginDetail(phaseId) };
  return finishDetail(state.detail!, fold(state, events, acked));
}

/**
 * Every stored event as a row, in seq order, folding into `state` only those
 * up to `acked`: past a gap, a later event could be read before the one that
 * explains it.
 */
function fold(state: State, events: StoredEvent[], acked: number): Row[] {
  return [...events].sort((a, b) => a.seq - b.seq).map((event) => apply(state, event, event.seq <= acked));
}

/** `summary` moved on by `events`, which follow the ones it was folded from. */
export function advance(summary: Summary, events: StoredEvent[]): Summary {
  const state: State = { summary: structuredClone(summary), story: null, detail: null };
  for (const event of events) apply(state, event, true);
  return state.summary;
}

/** When a session ended, epoch ms: its finish, else its last event, else `activity` — when the cockpit last heard of it. */
export function endedAt({ summary, activity }: { summary: Summary; activity: number }): number {
  return at(summary.endedAt) ?? at(summary.lastEventAt) ?? activity;
}

/** Whether a session is still going: running, or waiting at a gate. */
/** The workflow a session is in now: what its latest process said it ran, else the last it passed through. */
export function workflowOf(summary: Summary): string {
  return summary.workflow || (summary.workflows.at(-1) ?? "");
}

/** A pull request's number, off its forge URL; "" for a URL that names none. */
export function prNumber(url: string): string {
  return /\/pull\/(\d+)\/?$/.exec(url)?.[1] ?? "";
}

/** An issue's number, off its forge URL; "" for a URL that names none. */
export function issueNumber(url: string): string {
  return /\/issues\/(\d+)\/?$/.exec(url)?.[1] ?? "";
}

export function isLive(summary: Summary): boolean {
  return summary.status === "running" || summary.status === "waiting";
}

/** Where a session's clock stops, epoch ms: `now` while it is live, else when it ended (NaN when it never said). */
export function until(summary: Summary, now: number): number {
  return isLive(summary) ? now : Date.parse(summary.endedAt || summary.lastEventAt);
}

/** A summary's timestamp in epoch ms; null when it has none. */
export function at(ts: string): number | null {
  const parsed = Date.parse(ts);
  return ts && !Number.isNaN(parsed) ? parsed : null;
}

/** A stored summary, with anything a fold from an older cockpit never wrote filled in. */
export function readSummary(stored: unknown): Summary {
  const summary = { ...EMPTY_SUMMARY, ...(isRecord(stored) ? stored : {}) } as Summary;
  const waiting: unknown = summary.waitingFor;
  summary.waitingFor = isRecord(waiting) ? { ...EMPTY_WAITING, ...waiting } as WaitingFor : null;
  return summary;
}



// ── readers ──────────────────────────────────────────────────────────────────

interface State {
  summary: Summary;
  story: StoryState | null;         // only the session page tells the story; the list needs none
  detail: DetailState | null;       // and only an opened phase folds its tabs
}

interface Reader {
  fold?: (state: State, p: Payload) => void;
  describe: (p: Payload) => string;
}

function apply(state: State, event: StoredEvent, fold: boolean): Row {
  const { seq, ts, kind, v: version, payload: raw } = event;
  const versions = READERS[kind];
  const reader = versions?.[version];
  if (reader === undefined) {
    if (fold) state.summary.unread += 1;
    const unreadBecause: Unread = versions === undefined ? "unknown kind" : "newer version";
    return { seq, ts, kind, v: version, unreadBecause, detail: "", raw };
  }
  const p = Payload.parse(raw);
  if (fold) {
    reader.fold?.(state, p);
    state.summary.lastEventAt = ts;
    if (state.story) tell(state.story, kind, version, p, { seq, ts });
    if (state.detail) detail(state.detail, kind, version, p, { seq, ts });
  }
  return { seq, ts, kind, v: version, unreadBecause: null, detail: reader.describe(p), raw };
}

function waitingFor(p: Payload | null): WaitingFor | null {
  if (p === null) return null;
  return { ...EMPTY_WAITING, gate: p.str("gate"), round: p.num("round"), kind: p.str("kind") || "gate",
           channel: p.str("channel") || "issue", since: p.str("since"), issueNumber: p.num("issue_number"),
           summary: p.str("summary"), subjectDigest: p.str("subject_digest") };
}

/** What a `suspended` says the session waits for: v2 adds who may answer, the questions, and whether it is on the forge. */
function suspendedFor(p: Payload, version: number): WaitingFor | null {
  const waiting = waitingFor(p.obj("waiting_for"));
  if (waiting === null || version < 2) return waiting;
  return { ...waiting, questions: p.list("questions").length, trusted: p.strs("trusted"),
           published: p.bool("published") };
}

/** Set each field the event actually carries. An empty or zero value is "not
 * known here", never "now empty" — the rule tests/projection.py's `_learn` has. */
function learn(summary: Summary, fields: Partial<Summary>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value) (summary as Record<string, unknown>)[key] = value;
  }
}

function learnProvenance(summary: Summary, p: Payload): void {
  learn(summary, { trigger: p.str("trigger"), issueUrl: p.str("issue_url"), prUrl: p.str("pr_url") });
  // A run started on an issue was typed no prompt: what asked for it is the
  // first work item a provenance named (`#42 title`), as the story's title has it.
  summary.request ||= p.str("request");
}

const describeProvenance = (p: Payload) => `provenance: ${p.str("request") || p.str("trigger")}`;

const describePhaseStarted = (p: Payload) =>
  `${p.str("name")} started · ${p.str("kind")}` + (p.str("owner") ? ` ${p.str("owner")}` : "");
const describePhaseGiven = (p: Payload) => describePhaseStarted(p) + (p.str("task") ? ` · ${p.str("task")}` : "");

/** How an artifact reached the cockpit. A repo file is only named; a handoff
 * file is here whole, cut at the factory's cap, or (not text) not sent at all. */
function travelled(p: Payload): string {
  if (p.str("location") === "repo") return "in the repository";
  const pruned = prunedOf(p);
  if (pruned !== null) return `${prunedWord(pruned.reason)} since`;
  if (!p.bool("truncated")) return "inline";
  return p.str("content") === "" ? "not text, not sent" : "inline, cut at the cap";
}

const ANSWERING: Record<string, string> = { issue: "an issue", pr: "a pull request's review" };
const describeWorkflowStarted = (p: Payload) => `chapter ${p.num("chapter")}: ${p.str("workflow")} started` +
  (ANSWERING[p.str("input")] ? `, answering ${ANSWERING[p.str("input")]}` : "");

function chapterStarted(summary: Summary, p: Payload, stages: string[]): void {
  Object.assign(summary, { chapter: p.num("chapter"), stages });
}

const money = (cost: number) => `$${cost.toFixed(4)}`;
const gateRound = (p: Payload | null) => (p ? `${p.str("gate")} round ${p.num("round")}` : "a gate");

/** A new session, or a process joining one (a resume, an answer): the record re-opens and keeps what the session already learned. */
const sessionStarted: Reader = {
  fold: ({ summary }, p) => {
    const workflow = p.str("workflow");
    if (workflow && !summary.workflows.includes(workflow)) summary.workflows.push(workflow);
    summary.status = "running";
    summary.endedAt = "";
    learn(summary, {
      workflow, request: p.str("request"), branch: p.str("branch"), baseRef: p.str("base_ref"),
      trigger: p.str("trigger"), triggeredBy: p.str("triggered_by"),
      issueUrl: p.str("issue_url"), prUrl: p.str("pr_url"),
      stationId: p.str("station_id"), stationName: p.str("station_name"), stationKind: p.str("station_kind"),
      skillVersion: p.str("skill_version"),
      startedAt: summary.startedAt ? "" : p.str("started_at"),
    });
  },
  describe: (p) => `session started: ${p.str("workflow")}` +
    (p.str("station_name") ? ` on ${p.str("station_name")}` : ""),
};

/** v3: the transcript retention the process ran under, which can only shorten what the session already had. */
const sessionStartedWithRetention: Reader = {
  fold: (state, p) => {
    sessionStarted.fold!(state, p);
    const days = p.num("transcript_retention_days");
    const { summary } = state;
    if (days > 0 && (summary.transcriptDays === 0 || days < summary.transcriptDays)) summary.transcriptDays = days;
  },
  describe: sessionStarted.describe,
};

const READERS: Record<string, Record<number, Reader>> = {
  session_started: {
    1: sessionStarted,
    // v2: station_kind — a session that ran in CI has no station to resume it.
    2: sessionStarted,
    3: sessionStartedWithRetention,
  },
  provenance_recorded: {
    1: { fold: (state, p) => learnProvenance(state.summary, p), describe: describeProvenance },
    // v2: who wrote the issue, and whom it was assigned to — what the inbox ranks a viewer's own work by.
    2: {
      fold: ({ summary }, p) => {
        learnProvenance(summary, p);
        const assignees = p.strs("issue_assignees");
        learn(summary, { issueAuthor: p.str("issue_author"), ...(assignees.length ? { issueAssignees: assignees } : {}) });
      },
      describe: describeProvenance,
    },
  },
  // A chapter: one workflow the session passes through (the story, story.ts).
  workflow_started: {
    1: { fold: (state, p) => chapterStarted(state.summary, p, []), describe: describeWorkflowStarted },
    // v2 adds the workflow's stages, in order: the chapter's shape, as it ran.
    2: {
      fold: (state, p) => chapterStarted(state.summary, p, p.strs("stages")),
      describe: (p) => describeWorkflowStarted(p) +
        (p.strs("stages").length ? ` · ${p.strs("stages").join(" → ")}` : ""),
    },
  },
  workflow_finished: {
    1: {
      describe: (p) => `chapter ${p.num("chapter")}: ${p.str("workflow")} finished: ` +
        p.str("status") + (p.str("reason") ? ` — ${p.str("reason")}` : ""),
    },
    // v2 adds whether the workflow accepted the chapter: false is "its phases passed, and it was still not accepted".
    2: {
      describe: (p) => `chapter ${p.num("chapter")}: ${p.str("workflow")} finished: ` +
        p.str("status") + (p.bool("accepted") ? "" : ", not accepted") +
        (p.str("reason") ? ` — ${p.str("reason")}` : ""),
    },
  },
  session_resumed: {
    1: {
      // A process picking up the chapter it was in keeps its stages; any other, whose stages it never said, has none.
      fold: ({ summary }, p) => {
        if (p.num("chapter") !== summary.chapter) Object.assign(summary, { chapter: p.num("chapter"), stages: [] });
      },
      describe: (p) => `resumed chapter ${p.num("chapter")}: ${p.str("workflow")}`,
    },
  },
  phase_started: {
    1: { describe: describePhaseStarted },
    // v2 adds what an agent phase was given: its task file and its prompt's digest.
    2: { describe: describePhaseGiven },
    // v3 adds the stage it belongs to, as an index into its chapter's stages; none for the work item and the report.
    3: {
      describe: (p) => {
        const index = p.numOrNull("stage_index");
        return describePhaseGiven(p) + (index === null ? "" : ` · stage ${index + 1} of its chapter`);
      },
    },
  },
  phase_replayed: {
    1: {
      describe: (p) => `${p.str("name")} replayed from the record, ${p.str("agent")} not called`,
    },
  },
  phase_ended: {
    1: {
      describe: (p) => `${p.str("name")} ended: ${p.str("status")}` +
        (p.str("gate") ? ` at ${gateRound(p)}` : "") + (p.str("error") ? ` — ${p.str("error")}` : ""),
    },
  },
  envelope_accepted: {
    1: {
      describe: (p) => `${p.str("agent")}'s ${p.str("output_type")} accepted: ` +
        (p.obj("envelope")?.str("summary") ?? ""),
    },
  },
  envelope_rejected: {
    1: {
      describe: (p) => `${p.str("agent")}'s ${p.str("output_type")} rejected ` +
        `(attempt ${p.num("attempt")}): ${p.str("error")}`,
    },
  },
  gate_result: {
    1: {
      describe: (p) => `gate ${p.str("gate")} ${p.bool("passed") ? "passed" : "failed"}` +
        ` (attempt ${p.num("attempt")})`,
    },
  },
  gate_opened: {
    1: {
      fold: ({ summary }, p) => {
        summary.waitingFor = waitingFor(p.obj("waiting_for"));
      },
      describe: (p) => `${gateRound(p.obj("waiting_for"))} opened on the ` +
        `${p.obj("waiting_for")?.str("channel") || "issue"} channel`,
    },
  },
  suspended: {
    1: {
      fold: ({ summary }, p) => {
        summary.status = "waiting";
        summary.waitingFor = suspendedFor(p, 1);
      },
      describe: (p) => `suspended at ${gateRound(p.obj("waiting_for"))}`,
    },
    // v2 adds whether the subject reached the forge, a question round's questions, and whose reply the factory hears.
    2: {
      fold: ({ summary }, p) => {
        summary.status = "waiting";
        summary.waitingFor = suspendedFor(p, 2);
      },
      describe: (p) => `suspended at ${gateRound(p.obj("waiting_for"))}` +
        (p.bool("published") ? "" : ", its subject not on the forge"),
    },
  },
  decision_recorded: {
    1: {
      fold: ({ summary }, p) => {
        const decision = p.obj("decision");
        const waiting = summary.waitingFor;
        if (p.bool("consumed")) summary.waitingFor = null;
        else if (waiting && decision && decision.str("gate") === waiting.gate && decision.num("round") === waiting.round) {
          waiting.answered = { by: decision.str("by"), verdict: decision.str("verdict") };
        }
      },
      describe: (p) => {
        const d = p.obj("decision");
        return `decision on ${gateRound(d)}: ${d?.str("verdict") ?? ""}` +
          (d?.str("by") ? ` by ${d.str("by")}` : "") + (p.bool("consumed") ? "" : " (not yet consumed)");
      },
    },
  },
  journal_noted: {
    1: {
      describe: (p) => {
        const entry = p.obj("entry");
        const note = entry?.obj("note");
        if (note) return `journal: ${note.str("kind")} — ${note.str("what")}`;
        return `journal: ${entry?.str("kind") ?? ""} ${entry?.str("phase") ?? ""}`.trimEnd();
      },
    },
  },
  usage: {
    1: {
      fold: ({ summary }, p) => {
        learn(summary, { totalTokens: p.num("session_tokens"), totalCost: p.num("session_cost") });
      },
      describe: (p) => `${p.str("agent")} · ${p.str("model")}: ${p.num("tokens")} tokens, ` +
        money(p.num("cost")),
    },
  },
  artifact_written: {
    1: {
      describe: (p) => `${p.str("role")} ${p.str("path")} written: ${p.num("size")} bytes, ` +
        travelled(p),
    },
  },
  committed: {
    1: {
      describe: (p) => `committed ${p.str("sha").slice(0, 7)}: ${p.str("message")} ` +
        `(${p.num("files_total")} file${p.num("files_total") === 1 ? "" : "s"})`,
    },
  },
  // Never a tool's arguments or its result: the factory does not send them.
  tool_called: {
    1: {
      describe: (p) => `${p.str("agent")} called ${p.str("tool")}: ` +
        `${p.bool("ok") ? "ok" : "failed"} after ${p.num("duration_ms")}ms`,
    },
  },
  process_started: {
    1: { describe: (p) => `process ${p.num("pid")} started: ${p.str("command") || p.str("name")}` },
  },
  process_ended: {
    1: { describe: (p) => `process ${p.num("pid")} ended` },
  },
  command_finished: {
    1: {
      describe: (p) => `${p.str("name")} exited ${p.num("exit_code")} after ` +
        `${p.num("duration_seconds")}s`,
    },
  },
  command_result: {
    1: {
      describe: (p) => `command ${p.str("verb")} by ${p.str("by")}: ` +
        (p.bool("ok") ? "done" : "refused") + (p.str("detail") ? ` — ${p.str("detail")}` : ""),
    },
  },
  // A pull request the session's own integration opened — not one it found open.
  pull_request_opened: {
    1: { describe: (p) => `opened pull request #${p.num("number")}` },
  },
  // How its pull request ended, as the PR watcher found it: usually after
  // `session_finished`, so it folds into nothing a finished session shows.
  pull_request_closed: {
    1: {
      describe: (p) => {
        const commits = p.strs("head_shas").length;
        return `pull request #${p.num("number")} ${p.bool("merged") ? "merged" : "closed unmerged"}` +
          ` with ${commits} commit${commits === 1 ? "" : "s"}`;
      },
    },
  },
  // An agent wrote outside its `writes:`, and the factory undid what it could before failing the phase.
  permission_rolled_back: {
    1: {
      describe: (p) => `${p.str("agent")} wrote outside its boundary: ` +
        [p.strs("paths").length ? `${p.strs("paths").join(", ")} rolled back` : "",
         p.strs("not_undone").length ? `${p.strs("not_undone").join(", ")} not undone` : ""]
          .filter(Boolean).join("; "),
    },
  },
  // A budget ceiling refused an agent's next send, or a turn ran past its wall clock.
  limit_hit: {
    1: {
      describe: (p) => {
        const unit = (value: number) => p.str("kind") === "cost" ? money(value)
          : p.str("kind") === "timeout" ? `${value}s` : `${value} tokens`;
        return `${p.str("phase")} (${p.str("agent")}) stopped at the ${p.str("kind")} limit: ` +
          `${unit(p.num("reached"))} of ${unit(p.num("limit"))}`;
      },
    },
  },
  // A scorer's score of a chapter that has ended: late by nature, usually after `session_finished`.
  chapter_scored: {
    1: {
      describe: (p) => {
        const cited = p.nums("evidence").length;
        return `chapter ${p.num("chapter")} scored by ${p.str("scorer")}: ${p.str("class")}` +
          (p.bool("failing") ? ", failing" : "") + `, citing ${cited} event${cited === 1 ? "" : "s"}`;
      },
    },
  },
  // Transcript events: present only for a factory that opted in. Nothing but a
  // transcript view may be built from them — their bodies age out.
  prompt_rendered: {
    1: {
      describe: (p) => `prompt ${p.num("send")} sent to ${p.str("agent")}` +
        (p.bool("truncated") ? ", cut at the cap" : ""),
    },
  },
  harness_output: {
    1: { describe: (p) => `${p.str("agent")}'s harness output, chunk ${p.num("chunk")}` },
  },
  session_finished: {
    1: {
      fold: ({ summary }, p) => {
        summary.status = p.str("status") || summary.status;
        summary.endedAt = p.str("ended_at");
      },
      describe: (p) => `session finished: ${p.str("status")}` +
        (p.str("reason") ? ` — ${p.str("reason")}` : ""),
    },
  },
};
