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
import type { Role } from "../forge/forge";
import { commandRefusal, type CommandState, liveness, type StationFacts } from "./command";
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
 * Whether a wait is answered by a COMMAND to its station rather than a comment:
 * it waits on the terminal channel — a prompt run's, with no work item to
 * answer on. Anywhere else the forge's public record is the way (a pull
 * request's, once something reads it), and a station refuses the command.
 */
export function byCommand(waiting: WaitingFor): boolean {
  return waiting.channel === "terminal";
}

/** The newest answer queued by command for the wait in front of the run. */
export interface Commanded {
  by: string;
  verdict: string;
  state: CommandState;
  detail: string;
  /** Still on its way: queued or delivered, and not past its TTL. */
  pending: boolean;
}

/** What weighing an answer by command takes: who asks, as what, of which station, and what was queued already. */
export interface Commanding {
  /** Why the viewer cannot ask any station for anything, or null. */
  anonymous: string | null;
  role: Role | null;
  station: StationFacts | null;
  last: Commanded | null;
}

/** Why the station would not take each kind of answer: `answer` covers approve, reject and answer; `abort` is its own verb. */
export interface Refused {
  answer: string | null;
  abort: string | null;
}

export function refusedVerdicts({ role, station }: Commanding): Refused {
  return { answer: commandRefusal("answer", role, station), abort: commandRefusal("abort", role, station) };
}

/**
 * Why this wait cannot be answered from the inbox, or null when it can. The
 * row stays either way: a stuck run hidden from the inbox is a stuck run
 * nobody notices (spec #40). `ready` is whether the cockpit holds a forge
 * credential to post with at all; `commanding` is what a wait answered by
 * command is weighed by instead, null for one answered by comment.
 */
export function blocked(summary: Summary, sent: Sent | null, ready: boolean, commanding: Commanding | null = null): string | null {
  const waiting = summary.waitingFor!;
  const command = byCommand(waiting);
  // A run asking at its terminal polls for the decision file a command writes;
  // the forge it reads only once it has suspended.
  if (!command && summary.status !== "waiting") {
    return "being asked at the station's terminal right now: the factory reads the forge once the run has suspended";
  }
  if (waiting.published === false) {
    return "subject not on the forge: the station keeps this session's branch to itself (worktree.publish: on_integrate)";
  }
  if (waiting.answered) {
    return `answered by ${waiting.answered.by} (${waiting.answered.verdict}): the run goes on when the factory next looks`;
  }
  if (command) {
    if (commanding === null) return "it is answered at the station's terminal";
    if (commanding.last?.pending) return `answered by ${commanding.last.by} in the cockpit (${commanding.last.verdict})`;
    if (commanding.anonymous !== null) return commanding.anonymous;
    const refused = refusedVerdicts(commanding);
    return refused.answer !== null && refused.abort !== null ? refused.answer : null;
  }
  if (waiting.channel !== "issue" || !waiting.issueNumber) {
    const where = waiting.channel === "pr" ? "a pull request" : `the ${waiting.channel} channel`;
    return `the factory reads no answers on ${where} yet: it is answered at the station's terminal`;
  }
  if (sent) return `answered by ${sent.by} in the cockpit (${sent.verdict}): waiting for the factory's answers watcher`;
  if (!ready) return "this cockpit has no forge credential to post an answer with";
  return null;
}

/** What became of the last answer by command, when the station turned it down or never took it: "" otherwise. */
export function lastWord(commanding: Commanding | null): string {
  const last = commanding?.last;
  const name = commanding?.station?.name ?? "the station";
  if (!last || last.pending) return "";
  if (last.state === "refused") return `${name} refused the last answer: ${last.detail}`;
  if (last.state === "expired") return `the last answer expired before ${name} took it`;
  return "";
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
  /** How an answer reaches the factory: a comment on the work item, or a command to the station. */
  via: "comment" | "command";
  /** A command row's: why the station would not take each kind of answer. Null on a comment row. */
  refused: Refused | null;
  /** A command row's answer already on its way, if there is one. */
  queued: { by: string; verdict: string } | null;
  /** When the station's loop and the run's own shipper last polled: whether it is listening, by the page's clock. */
  stationSeenAt: number;
  attendedAt: number | null;
  /** What became of an earlier answer that did not land, or "". */
  note: string;
}

/** What weighing a wait found, beside the summary: what blocks it and, answered by command, the station's side. */
export interface Judged {
  blocked: string | null;
  commanding: Commanding | null;
  stationSeenAt: number;
  attendedAt: number | null;
}

/**
 * Why a wait is for the viewer (spec #40): they triggered the run — labelled
 * the issue, or ran it — they wrote the issue, or it is assigned to them.
 */
export type ForYou = "triggered" | "wrote" | "assigned";

/** Whether two forge logins are one person: the forge does not tell them apart by case. */
export function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Every reason `summary`'s session is for `login`. A forge's logins are one
 * person whatever their case, and this is a ranking, not a permission: what
 * may be answered is `permitted`'s, which compares as the factory does.
 */
export function forYou(summary: Summary, login: string | null): ForYou[] {
  if (login === null) return [];
  const is = (other: string) => sameLogin(other, login);
  const reasons: ForYou[] = [];
  if (is(summary.triggeredBy)) reasons.push("triggered");
  if (is(summary.issueAuthor)) reasons.push("wrote");
  if (summary.issueAssignees.some(is)) reasons.push("assigned");
  return reasons;
}

export function row({ factory, session }: { factory: string; session: string }, summary: Summary,
                    login: string | null, judged: Judged): Row {
  const waiting: WaitingFor = summary.waitingFor!;
  const { commanding } = judged;
  const last = commanding?.last;
  return {
    factory, session,
    gate: waiting.gate, round: waiting.round, kind: waiting.kind, questions: waiting.questions,
    since: waiting.since, summary: waiting.summary, channel: waiting.channel,
    issueNumber: waiting.issueNumber, issueUrl: summary.issueUrl, workItem: summary.request,
    workflow: summary.workflows.at(-1) ?? "", station: commanding?.station?.name ?? summary.stationName,
    forYou: forYou(summary, login),
    blocked: judged.blocked,
    via: byCommand(waiting) ? "command" : "comment",
    refused: commanding ? refusedVerdicts(commanding) : null,
    queued: last?.pending ? { by: last.by, verdict: last.verdict } : null,
    stationSeenAt: judged.stationSeenAt,
    attendedAt: judged.attendedAt,
    note: lastWord(commanding),
  };
}

/**
 * Whether a command row's station is listening by the page's clock, and what
 * that means for an answer sent to it, in the words the inbox says it in.
 */
export function stationWords(row: Pick<Row, "station" | "stationSeenAt" | "attendedAt">, now: number): string {
  const live = liveness(row.stationSeenAt, row.attendedAt, now);
  return live.attended || live.online ? `${row.station} takes it within seconds` : `resumes when ${row.station} is back online`;
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
