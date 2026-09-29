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

export interface Event {
  seq: number;
  ts: string;
  kind: string;
  v: number;
  payload: Record<string, unknown>;
}

export type Unread = "unknown kind" | "newer version";

export interface Row extends Event {
  unread: Unread | null;   // why this is a generic row, or null when it was read
  detail: string;          // one line saying what happened, "" when unread
}

export interface SessionView {
  summary: Summary;
  phases: Phase[];
  events: Row[];
}

/** The whole page, folded from every stored event. */
export function view(events: Event[]): SessionView {
  const state: State = { summary: structuredClone(EMPTY_SUMMARY), phases: [] };
  const rows = [...events].sort((a, b) => a.seq - b.seq).map((event) => apply(state, event));
  return { summary: state.summary, phases: state.phases, events: rows };
}

/** `summary` moved on by `events`, which follow the ones it was folded from. */
export function advance(summary: Summary, events: Event[]): Summary {
  const state: State = { summary: structuredClone(summary), phases: [] };
  for (const event of events) apply(state, event);
  return state.summary;
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

function apply(state: State, event: Event): Row {
  const versions = READERS[event.kind];
  const reader = versions?.[event.v];
  if (reader === undefined) {
    state.summary.unread += 1;
    const unread: Unread = versions === undefined ? "unknown kind" : "newer version";
    return { ...event, unread, detail: "" };
  }
  const p = new Payload(event.payload);
  reader.fold?.(state, p);
  state.summary.lastEventAt = event.ts;
  return { ...event, unread: null, detail: reader.describe(p) };
}

/**
 * A payload read defensively. The factory validates what it writes, but a
 * reader that threw on a malformed event would wedge ingest for that session
 * forever — the station resends the same batch — so a missing or mistyped
 * field reads as empty instead.
 */
class Payload {
  constructor(private readonly raw: Record<string, unknown>) {}

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
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? new Payload(value as Record<string, unknown>)
      : null;
  }
}

function waitingFor(p: Payload | null): WaitingFor | null {
  if (p === null) return null;
  return { gate: p.str("gate"), round: p.num("round"), kind: p.str("kind"),
           channel: p.str("channel"), since: p.str("since") };
}

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
  phase_started: {
    1: {
      fold: (state, p) => {
        const found = phase(state, p.str("phase_id"));
        Object.assign(found, {
          name: p.str("name"), kind: p.str("kind"), owner: p.str("owner"),
          description: p.str("description"), status: "running", error: "", gate: "", round: 0,
        });
      },
      describe: (p) => `${p.str("name")} started · ${p.str("kind")}` +
        (p.str("owner") ? ` ${p.str("owner")}` : ""),
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
