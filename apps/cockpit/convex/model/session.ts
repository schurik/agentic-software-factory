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
import { isRecord, type StoredEvent } from "./wire";

// ── the summary: what the sessions list shows, stored beside each session ────

export const waitingForValidator = v.object({
  gate: v.string(),
  round: v.number(),
  kind: v.string(),
  channel: v.string(),
  since: v.string(),
});

export const summaryValidator = v.object({
  status: v.string(),                 // unknown until session_started | running | waiting | success | fail
  workflows: v.array(v.string()),     // every workflow the session passed through, in order
  request: v.string(),
  branch: v.string(),
  baseRef: v.string(),
  trigger: v.string(),
  triggeredBy: v.string(),
  issueUrl: v.string(),
  prUrl: v.string(),
  stationName: v.string(),
  skillVersion: v.string(),
  startedAt: v.string(),
  endedAt: v.string(),
  lastEventAt: v.string(),
  waitingFor: v.union(v.null(), waitingForValidator),
  totalTokens: v.number(),
  totalCost: v.number(),
  unread: v.number(),                 // events no reader here could read: time to upgrade the cockpit
});

export type Summary = Infer<typeof summaryValidator>;
export type WaitingFor = Infer<typeof waitingForValidator>;

export const EMPTY_SUMMARY: Summary = {
  status: "unknown", workflows: [], request: "", branch: "", baseRef: "", trigger: "",
  triggeredBy: "", issueUrl: "", prUrl: "", stationName: "", skillVersion: "",
  startedAt: "", endedAt: "", lastEventAt: "", waitingFor: null,
  totalTokens: 0, totalCost: 0, unread: 0,
};

// ── the session page ─────────────────────────────────────────────────────────

export interface Phase {
  phaseId: string;
  name: string;
  kind: string;
  owner: string;
  description: string;
  status: string;
  error: string;
  gate: string;
  round: number;
}

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
  phases: Phase[];
  events: Row[];
}

/**
 * The whole page. Every stored event is a row, but only those up to `acked`
 * are folded, exactly as the list's summary is: past a gap, a later event
 * could be read before the one that explains it.
 */
export function view(events: StoredEvent[], acked: number): SessionView {
  const state: State = { summary: structuredClone(EMPTY_SUMMARY), phases: [] };
  const rows = [...events]
    .sort((a, b) => a.seq - b.seq)
    .map((event) => apply(state, event, event.seq <= acked));
  return { summary: state.summary, phases: state.phases, events: rows };
}

/** `summary` moved on by `events`, which follow the ones it was folded from. */
export function advance(summary: Summary, events: StoredEvent[]): Summary {
  const state: State = { summary: structuredClone(summary), phases: [] };
  for (const event of events) apply(state, event, true);
  return state.summary;
}

/** A stored summary, with anything a fold from an older cockpit never wrote filled in. */
export function readSummary(stored: unknown): Summary {
  return { ...EMPTY_SUMMARY, ...(isRecord(stored) ? stored : {}) } as Summary;
}



// ── readers ──────────────────────────────────────────────────────────────────

interface State {
  summary: Summary;
  phases: Phase[];
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
  }
  return { seq, ts, kind, v: version, unreadBecause: null, detail: reader.describe(p), raw };
}

/**
 * A payload read defensively. The factory validates what it writes, but a
 * reader that threw on a malformed event would wedge ingest for that session
 * forever — the station resends the same batch — so a missing or mistyped
 * field reads as empty instead.
 */
class Payload {
  constructor(private readonly raw: Record<string, unknown>) {}

  static parse(text: string): Payload {
    try {
      const value: unknown = JSON.parse(text);
      return new Payload(isRecord(value) ? value : {});
    } catch {
      return new Payload({});
    }
  }

  str(key: string): string {
    const value = this.raw[key];
    return typeof value === "string" ? value : "";
  }

  num(key: string): number {
    const value = this.raw[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  bool(key: string): boolean {
    return this.raw[key] === true;
  }

  obj(key: string): Payload | null {
    const value = this.raw[key];
    return isRecord(value) ? new Payload(value) : null;
  }
}

function waitingFor(p: Payload | null): WaitingFor | null {
  if (p === null) return null;
  return { gate: p.str("gate"), round: p.num("round"), kind: p.str("kind"),
           channel: p.str("channel"), since: p.str("since") };
}

/** Set each field the event actually carries. An empty or zero value is "not
 * known here", never "now empty" — the rule tests/projection.py's `_learn` has. */
function learn(summary: Summary, fields: Partial<Summary>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value) (summary as Record<string, unknown>)[key] = value;
  }
}

function phase(state: State, phaseId: string): Phase {
  let found = state.phases.find((each) => each.phaseId === phaseId);
  if (found === undefined) {
    found = { phaseId, name: "", kind: "", owner: "", description: "", status: "",
              error: "", gate: "", round: 0 };
    state.phases.push(found);
  }
  return found;
}

function phaseStarted(state: State, p: Payload): void {
  const found = phase(state, p.str("phase_id"));
  Object.assign(found, {
    name: p.str("name"), kind: p.str("kind"), owner: p.str("owner"),
    description: p.str("description"), status: "running", error: "", gate: "", round: 0,
  });
}

const describePhaseStarted = (p: Payload) =>
  `${p.str("name")} started · ${p.str("kind")}` + (p.str("owner") ? ` ${p.str("owner")}` : "");

const ANSWERING: Record<string, string> = { issue: "an issue", pr: "a pull request's review" };

const money = (cost: number) => `$${cost.toFixed(4)}`;
const gateRound = (p: Payload | null) => (p ? `${p.str("gate")} round ${p.num("round")}` : "a gate");

const READERS: Record<string, Record<number, Reader>> = {
  session_started: {
    1: {
      // A new session, or a process joining one (a resume, an answer): the
      // record re-opens and keeps what the session already learned.
      fold: ({ summary }, p) => {
        const workflow = p.str("workflow");
        if (workflow && !summary.workflows.includes(workflow)) summary.workflows.push(workflow);
        summary.status = "running";
        summary.endedAt = "";
        learn(summary, {
          request: p.str("request"), branch: p.str("branch"), baseRef: p.str("base_ref"),
          trigger: p.str("trigger"), triggeredBy: p.str("triggered_by"),
          issueUrl: p.str("issue_url"), prUrl: p.str("pr_url"),
          stationName: p.str("station_name"), skillVersion: p.str("skill_version"),
          startedAt: summary.startedAt ? "" : p.str("started_at"),
        });
      },
      describe: (p) => `session started: ${p.str("workflow")}` +
        (p.str("station_name") ? ` on ${p.str("station_name")}` : ""),
    },
  },
  provenance_recorded: {
    1: {
      fold: ({ summary }, p) =>
        learn(summary, { trigger: p.str("trigger"), issueUrl: p.str("issue_url"), prUrl: p.str("pr_url") }),
      describe: (p) => `provenance: ${p.str("request") || p.str("trigger")}`,
    },
  },
  // A chapter: one workflow the session passes through. The chapters themselves
  // are the session page's story, which is not built yet — until it is, these
  // read as rows.
  workflow_started: {
    1: {
      describe: (p) => `chapter ${p.num("chapter")}: ${p.str("workflow")} started` +
        (ANSWERING[p.str("input")] ? `, answering ${ANSWERING[p.str("input")]}` : ""),
    },
  },
  workflow_finished: {
    1: {
      describe: (p) => `chapter ${p.num("chapter")}: ${p.str("workflow")} finished: ` +
        p.str("status") + (p.str("reason") ? ` — ${p.str("reason")}` : ""),
    },
  },
  session_resumed: {
    1: { describe: (p) => `resumed chapter ${p.num("chapter")}: ${p.str("workflow")}` },
  },
  phase_started: {
    1: { fold: phaseStarted, describe: describePhaseStarted },
    // v2 adds what an agent phase was given: its task file and its prompt's digest.
    2: {
      fold: phaseStarted,
      describe: (p) => describePhaseStarted(p) + (p.str("task") ? ` · ${p.str("task")}` : ""),
    },
  },
  phase_replayed: {
    1: {
      describe: (p) => `${p.str("name")} replayed from the record, ${p.str("agent")} not called`,
    },
  },
  phase_ended: {
    1: {
      fold: (state, p) => {
        const found = phase(state, p.str("phase_id"));
        found.name ||= p.str("name");
        Object.assign(found, { status: p.str("status"), error: p.str("error"),
                               gate: p.str("gate"), round: p.num("round") });
      },
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
        summary.waitingFor = waitingFor(p.obj("waiting_for"));
      },
      describe: (p) => `suspended at ${gateRound(p.obj("waiting_for"))}`,
    },
  },
  decision_recorded: {
    1: {
      fold: ({ summary }, p) => {
        if (p.bool("consumed")) summary.waitingFor = null;
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
        (p.str("location") === "repo" ? "in the repository"
          : p.bool("truncated") ? "inline, cut at the cap" : "inline"),
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
