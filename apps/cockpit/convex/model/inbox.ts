/**
 * The inbox's model: which waits a viewer may answer, why one cannot be
 * answered from here, and what the answer view shows — all read off the
 * session's own summary and events, never off a station.
 *
 * Who may answer is the factory's word, carried by `suspended` v2 as
 * `trusted` (the trust list of the wait's channel, empty for anyone the forge
 * lets reply). The cockpit offers the answer to those people and hides it from
 * everyone else; the factory's answers watcher is still what checks it, so a
 * row offered wrongly is a comment the factory ignores, never a decision.
 */
import { Payload } from "./payload";
import type { Summary, WaitingFor } from "./session";
import type { StoredEvent } from "./wire";

/**
 * Whether `login` passes a wait's trust list: none named (or none said) is
 * anyone. Compared exactly, as the factory's answers watcher compares a
 * comment's author: a mirror that matched more loosely would offer an answer
 * the factory then ignores.
 */
export function permitted(trusted: string[] | null, login: string | null): boolean {
  if (trusted === null || trusted.length === 0) return true;
  return login !== null && trusted.includes(login);
}

/** An answer this cockpit already posted for the round, as `gateAnswers` keeps it. */
export interface Sent {
  by: string;
  verdict: string;
  url: string;
  at: number;
}

/**
 * Why this wait cannot be answered from the inbox, or null when it can. The
 * row stays either way: a stuck run hidden from the inbox is a stuck run
 * nobody notices (spec #40). `ready` is whether the cockpit holds a forge
 * credential to post with at all.
 */
export function blocked(summary: Summary, sent: Sent | null, ready: boolean): string | null {
  const waiting = summary.waitingFor!;
  if (summary.status !== "waiting") {
    return "being asked at the station's terminal right now: the factory reads the forge once the run has suspended";
  }
  if (waiting.channel === "terminal") {
    return "started from a prompt, with no work item to answer on: it is answered at the station's terminal";
  }
  if (waiting.channel !== "issue" || !waiting.issueNumber) {
    const where = waiting.channel === "pr" ? "a pull request" : `the ${waiting.channel} channel`;
    return `the factory reads no answers on ${where} yet: it is answered at the station's terminal`;
  }
  if (waiting.published === false) {
    return "subject not on the forge: the station keeps this session's branch to itself (worktree.publish: on_integrate)";
  }
  if (waiting.answered) {
    return `answered by ${waiting.answered.by} (${waiting.answered.verdict}): the run goes on when the factory next looks`;
  }
  if (sent) return `answered by ${sent.by} in the cockpit (${sent.verdict}): waiting for the factory's answers watcher`;
  if (!ready) return "this cockpit has no forge credential to post an answer with";
  return null;
}

export interface Row {
  factory: string;
  session: string;
  gate: string;
  round: number;
  kind: string;                   // gate | questions
  questions: number;
  since: string;
  summary: string;
  channel: string;
  issueNumber: number;
  issueUrl: string;
  workItem: string;               // what asked for the session: `#42 title`, or the prompt
  workflow: string;
  station: string;
  /** Why this wait is the viewer's own work, if it is: sorted first, never the only ones shown. */
  forYou: ForYou[];
  blocked: string | null;
}

/**
 * Why a wait is for the viewer (spec #40): they triggered the run — labelled
 * the issue, or ran it — they wrote the issue, or it is assigned to them.
 */
export type ForYou = "triggered" | "wrote" | "assigned";

/**
 * Every reason `summary`'s session is for `login`. A forge's logins are one
 * person whatever their case, and this is a ranking, not a permission: what
 * may be answered is `permitted`'s, which compares as the factory does.
 */
export function forYou(summary: Summary, login: string | null): ForYou[] {
  if (login === null) return [];
  const is = (other: string) => other.toLowerCase() === login.toLowerCase();
  const reasons: ForYou[] = [];
  if (is(summary.triggeredBy)) reasons.push("triggered");
  if (is(summary.issueAuthor)) reasons.push("wrote");
  if (summary.issueAssignees.some(is)) reasons.push("assigned");
  return reasons;
}

export function row(factory: string, session: string, summary: Summary, login: string | null,
                    blockedBecause: string | null): Row {
  const waiting: WaitingFor = summary.waitingFor!;
  return {
    factory, session,
    gate: waiting.gate, round: waiting.round, kind: waiting.kind, questions: waiting.questions,
    since: waiting.since, summary: waiting.summary, channel: waiting.channel,
    issueNumber: waiting.issueNumber, issueUrl: summary.issueUrl, workItem: summary.request,
    workflow: summary.workflows.at(-1) ?? "", station: summary.stationName,
    forYou: forYou(summary, login),
    blocked: blockedBecause,
  };
}

/** The viewer's own first, then the longest wait. A ranking: every row stays. */
export function ranked(rows: Row[]): Row[] {
  const mine = (row: Row) => Number(row.forYou.length > 0);
  return [...rows].sort((a, b) => mine(b) - mine(a) || a.since.localeCompare(b.since) ||
    a.factory.localeCompare(b.factory) || a.session.localeCompare(b.session));
}

// ── the answer view ──────────────────────────────────────────────────────────

export interface Option {
  answer: string;
  because: string;
  recommended: boolean;
}

export interface Question {
  topic: string;
  question: string;
  why: string;
  blocking: boolean;
  /** Recommended first, the rest in the analyst's order — what `Question.ranked` shows on the issue. */
  options: Option[];
}

export interface SubjectFile {
  /** Where it is in the repository, which is where the forge has it. */
  path: string;
  /** As the factory named it, which is what its digest hashed. */
  absolute: string;
}

export interface Subject {
  headSha: string;
  baseCommit: string;
  files: SubjectFile[];
  /**
   * Paths outside the session's worktree — the integrate gate's own
   * `changes.diff`, a session file — which no commit holds. What they show
   * is the forge's comparison of `baseCommit` with `headSha`.
   */
  outside: string[];
}

export interface Earlier {
  round: number;
  verdict: string;
  by: string;
  notes: string;
  channel: string;
}

export interface Asked {
  notes: string;                  // the producing agent's notes for the next agent
  subject: Subject;
  questions: Question[];
  earlier: Earlier[];
}

/** What the session's events say the current wait asks, off its latest `suspended`. */
export function asked(events: StoredEvent[], acked: number, waiting: WaitingFor): Asked {
  let root = "";
  let suspended: Payload | null = null;
  const decided = new Map<number, Earlier>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq > acked) break;
    const p = Payload.parse(event.payload);
    if (event.kind === "session_started") root = p.str("repo_root") || root;
    if (event.kind === "suspended") suspended = p;
    if (event.kind === "decision_recorded" && p.bool("consumed")) {
      const d = p.obj("decision");
      const round = d?.num("round") || 1;
      if (d && d.str("gate") === waiting.gate && round < waiting.round && d.str("by") !== "policy") {
        decided.set(round, { round, verdict: d.str("verdict"), by: d.str("by"), notes: d.str("notes"),
                             channel: d.str("channel") });
      }
    }
  }
  const asking = suspended?.obj("waiting_for") ?? null;
  const prefix = root ? `${root.replace(/\/+$/, "")}/` : "";
  const files: SubjectFile[] = [];
  const outside: string[] = [];
  for (const absolute of asking?.strs("paths") ?? []) {
    if (prefix && absolute.startsWith(prefix)) files.push({ path: absolute.slice(prefix.length), absolute });
    else outside.push(absolute);
  }
  return {
    notes: asking?.str("notes") ?? "",
    subject: { headSha: suspended?.str("head_sha") ?? "", baseCommit: suspended?.str("base_commit") ?? "", files, outside },
    questions: (suspended?.list("questions") ?? []).map(readQuestion),
    earlier: [...decided.values()].sort((a, b) => a.round - b.round),
  };
}

function readQuestion(p: Payload): Question {
  const options = p.list("options").map((o) => ({
    answer: o.str("answer"), because: o.str("because"), recommended: o.bool("recommended"),
  }));
  return {
    topic: p.str("topic"), question: p.str("question"), why: p.str("why"),
    // Absent means blocking, as the factory's own default has it.
    blocking: p.value().blocking !== false,
    options: [...options.filter((o) => o.recommended), ...options.filter((o) => !o.recommended)],
  };
}
