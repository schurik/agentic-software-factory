// PROTOTYPE, throwaway. Static data, hand-derived from
// tests/golden/sessions/issue-then-two-reviews/events.jsonl (+ journal.md), then re-id'd,
// time-shifted and varied into a few sessions: done, waiting at a gate, running, failed.
//
// Phases are mapped to stages BY HAND here: today's events do not say which stage a phase
// belongs to (phase_started v2 has no stage index). The real build waits for
// workflow_started v2 + phase_started v3.

export const NOW = Date.UTC(2026, 9, 3, 14, 30, 0);
const min = 60_000;
export const VIEWER = "schurik";

export type PhaseStatus = "ok" | "running" | "waiting" | "failed" | "rejected" | "pending";
export type Kind = "agent" | "code" | "gate";

export interface Note { kind: "risk" | "deviation" | "discovery"; what: string; because: string; insteadOf?: string; by: string }
export interface Remark { verdict: "approve" | "reject"; by: string; text: string; round: number; channel: string }
export interface Artifact { path: string; location: "repo" | "handoff"; size: number; role: "request" | "output"; preview?: string }
export interface Check { gate: string; passed: boolean; items: { item: string; ok: boolean; note: string }[] }

export interface Phase {
  id: string;
  seq: number;
  name: string;
  kind: Kind;
  owner: string;
  description: string;
  status: PhaseStatus;
  at: number;
  secs: number;
  cost?: number;
  tokens?: number;
  model?: string;
  task?: string;
  tools?: { tool: string; ok: boolean }[];
  summary?: string;
  outputType?: string;
  notes?: Note[];
  remark?: Remark;
  gate?: { name: string; round: number; channel?: string };
  artifacts?: Artifact[];
  checks?: Check[];
  replayed?: boolean;
  corrections?: number;
  error?: string;
  commit?: { sha: string; message: string };
  command?: { argv: string; exit: number; secs: number; tail?: string };
}

export interface Stage { name: string; phases: Phase[]; gate?: string }

export interface Chapter {
  n: number;
  workflow: string;
  input: "issue" | "pr" | "prompt";
  ref: string;
  start?: Phase;
  stages: Stage[];
  end?: Phase;
}

export type SessionStatus = "running" | "waiting" | "failed" | "done";

export interface Session {
  id: string;
  factory: string;
  title: string;
  ref: string;
  status: SessionStatus;
  chapters: Chapter[];
  station: string;
  stationOnline: boolean;
  owner: string;
  branch: string;
  base: string;
  triggeredBy: string;
  issueUrl?: string;
  prUrl?: string;
  startedAt: number;
  endedAt?: number;
  budget: number;
  transcripts: boolean;
  now: string;
}

export interface Gate {
  id: string;
  session: string;
  factory: string;
  ref: string;
  title: string;
  gate: string;
  question: string;
  round: number;
  since: number;
  askedOf: string;
  channel: string;
  subject: string;
  subjectFile: string;
  subjectBody: string;
  earlier: { round: number; verdict: "approve" | "reject"; by: string; text: string }[];
  record: string[];
  cost: number;
  tokens: number;
  station: string;
  digest: string;
}

// ── The stage vocabulary (what a stage is FOR — shown in the stage drawer) ──────

export const STAGE_ABOUT: Record<string, string> = {
  scout: "Find the code the request actually touches, so the plan is written against the repository.",
  plan: "Turn the request into a plan the builder can implement without asking questions. Gated: a person approves it.",
  commit: "Land what the stage before produced on the session's branch, in its agent's words.",
  implement: "Implement the plan exactly, or the request itself when nothing planned it.",
  verify: "Run the repository's known commands; on a failure the builder fixes and they run again.",
  review: "Confirm the build matches what was asked, against the plan or the prompt.",
  document: "Write up the completed change, from the diff, for the engineer who arrives next.",
  integrate: "Land the branch the way this repository wants it landed — here, as a pull request.",
};

export const WORKFLOWS: Record<string, { input: Chapter["input"]; stages: string[]; about: string }> = {
  issue: {
    input: "issue",
    stages: ["scout", "plan", "commit", "implement", "verify", "review", "commit", "document", "commit", "integrate"],
    about: "a tracked work item, scouted, planned, built, verified, reviewed, documented and proposed as a pull request",
  },
  "pr-review": {
    input: "pr",
    stages: ["implement", "verify", "commit"],
    about: "answer the open review threads on one of this factory's pull requests, in the session that opened it",
  },
  quick: {
    input: "prompt",
    stages: ["implement", "verify", "commit"],
    about: "implement straight from the prompt, verify, commit",
  },
};

// ── Builders ───────────────────────────────────────────────────────────────────

type P = Omit<Phase, "id" | "seq" | "at" | "status"> & { status?: PhaseStatus };

function chapter(
  sid: string,
  n: number,
  workflow: string,
  ref: string,
  at: number,
  start: P | null,
  stages: (P[] | undefined)[],
  end: P | null,
  seqFrom: number,
): { chapter: Chapter; seq: number; at: number } {
  let seq = seqFrom;
  let t = at;
  const mk = (p: P): Phase => {
    seq += 1;
    const phase: Phase = {
      ...p,
      id: `${sid}_${String(seq).padStart(2, "0")}_${p.name}`,
      seq,
      at: t,
      status: p.status ?? "ok",
    };
    t += p.secs * 1000 + 2000;
    return phase;
  };
  const wf = WORKFLOWS[workflow];
  const built: Chapter = {
    n,
    workflow,
    input: wf.input,
    ref,
    start: start ? mk(start) : undefined,
    stages: wf.stages.map((name, i) => ({
      name,
      phases: (stages[i] ?? []).map(mk),
      gate: name === "plan" ? "plan · on" : name === "integrate" ? "integrate · off" : undefined,
    })),
    end: undefined,
  };
  built.end = end ? mk(end) : undefined;
  return { chapter: built, seq, at: t };
}

// Recurring phase shapes, worded as the recorded session words them.
const issuePhase = (title: string): P => ({
  name: "issue", kind: "code", owner: "tracker", secs: 1,
  description: "Read the reporter's own words and labels, before anyone paraphrases them into a task",
  summary: title,
  artifacts: [{ path: "context_handoff/issue.md", location: "handoff", size: 524, role: "request",
    preview: "# Resolve relative due dates via the meeting date\n\nRules and decisions from a meeting are extracted as tasks, and a relative deadline (\"in four weeks\") stays relative." }],
});
const prPhase = (summary: string): P => ({
  name: "pr", kind: "code", owner: "review", secs: 2,
  description: "Read the reviewers' own words and where each one hangs, before anyone paraphrases them into a task",
  summary,
  artifacts: [{ path: "context_handoff/pr_review.md", location: "handoff", size: 338, role: "request",
    preview: "# Review feedback\n\n**app.py:14** — the date should read like Sep 25, 2026" }],
});
const scout = (extra: Partial<P> = {}): P => ({
  name: "scout", kind: "agent", owner: "scout", secs: 28, cost: 0.021, tokens: 1900, model: "sonnet",
  task: "asf/stages/scout/task.md", outputType: "ScoutOutput",
  description: "Find the code the request actually touches, so the plan is written against the repository and not against a guess",
  summary: "the prompt is built in app.py; no date reaches it",
  tools: [{ tool: "grep", ok: true }, { tool: "read", ok: true }, { tool: "read", ok: false }],
  artifacts: [{ path: "context_handoff/scout_findings.md", location: "handoff", size: 112, role: "output",
    preview: "# Findings\n\n- `app.py: build_prompt` assembles the prompt\n- no meeting date reaches it" }],
  checks: [
    { gate: "artifacts_exist", passed: true, items: [{ item: "scout_findings.md", ok: true, note: "exists, 112B" }] },
    { gate: "files_non_empty", passed: true, items: [{ item: "scout_findings.md", ok: true, note: "112B" }] },
  ],
  ...extra,
});
const plan = (extra: Partial<P> = {}): P => ({
  name: "plan", kind: "agent", owner: "planner", secs: 14, cost: 0.102, tokens: 6100, model: "opus",
  task: "asf/stages/plan/task.md", outputType: "PlanOutput",
  description: "Turn the request into an implementable plan, before any code exists to blur what was asked",
  summary: "a required meeting date, and a test for its format",
  tools: [{ tool: "read", ok: true }],
  notes: [{ kind: "risk", what: "the date is local midnight", because: "converted in UTC it is the previous day", by: "planner" }],
  artifacts: [{ path: "docs/asf/spec/plan.md", location: "repo", size: 77, role: "output",
    preview: "# Plan\n\n- R1: `build_prompt` takes a required meeting date\n- R2: a test pins its format" }],
  checks: [
    { gate: "artifacts_exist", passed: true, items: [{ item: "docs/asf/spec/plan.md", ok: true, note: "exists, 77B" }] },
    { gate: "files_non_empty", passed: true, items: [{ item: "docs/asf/spec/plan.md", ok: true, note: "77B" }] },
  ],
  ...extra,
});
const approve = (round: number, remark: Remark | null, status: PhaseStatus, secs: number): P => ({
  name: round === 1 ? "approve_plan" : `approve_plan_${round}`, kind: "gate", owner: remark?.by ?? "schurik", secs,
  description: "Hand the plan to the engineer and wait for a verdict",
  gate: { name: "plan", round, channel: "issue" },
  remark: remark ?? undefined,
  status,
});
const revise = (n: number, summary: string, extra: Partial<P> = {}): P => ({
  name: `plan_revise_${n}`, kind: "agent", owner: "planner", secs: 40, cost: 0.041, tokens: 2400, model: "opus",
  task: "asf/stages/plan/task.md", outputType: "PlanOutput", corrections: 1,
  description: "Rework the plan along the engineer's notes, in the same session",
  summary,
  artifacts: [{ path: "docs/asf/spec/plan.md", location: "repo", size: 122, role: "output",
    preview: "# Plan\n\n- R1: `build_prompt` takes a required meeting date, converted in `dates.py`\n- R2: a test pins its format" }],
  checks: [
    { gate: "artifacts_exist", passed: true, items: [{ item: "docs/asf/spec/plan.md", ok: true, note: "exists, 122B" }] },
    { gate: "files_non_empty", passed: true, items: [{ item: "docs/asf/spec/plan.md", ok: true, note: "122B" }] },
  ],
  ...extra,
});
const commit = (what: string, sha: string, message: string, extra: Partial<P> = {}): P => ({
  name: `commit_${what}`, kind: "code", owner: "git", secs: 2,
  description: `Land the ${what} on the run's branch, in the words of the agent that produced it`,
  summary: `${sha} ${message}`, commit: { sha, message },
  ...extra,
});
const implement = (summary: string, extra: Partial<P> = {}): P => ({
  name: "implement", kind: "agent", owner: "builder", secs: 13, cost: 0.135, tokens: 8200, model: "opus",
  task: "asf/stages/implement/task.md", outputType: "BuildOutput",
  description: "Implement the plan exactly, or the request itself when nothing planned it",
  summary,
  tools: [{ tool: "read", ok: true }, { tool: "edit", ok: true }, { tool: "bash", ok: true }],
  checks: [{ gate: "diff_matches_claims", passed: true, items: [{ item: "app.py", ok: true, note: "exists, 56B" }] }],
  ...extra,
});
const verify = (n: number, extra: Partial<P> = {}): P => ({
  name: `verify_${n}`, kind: "code", owner: "quality", secs: 6,
  description: "Run test — known commands, so code runs them and no agent rediscovers them",
  summary: "passed · checks 1/1",
  command: { argv: "python -c \"import runpy; runpy.run_path('app.py')\"", exit: 0, secs: 0.04 },
  ...extra,
});
const review = (): P => ({
  name: "review_1", kind: "agent", owner: "reviewer", secs: 21, cost: 0.066, tokens: 3300, model: "opus",
  task: "asf/stages/review/task.md", outputType: "ReviewOutput",
  description: "Confirm the build matches what was asked, against the plan or the prompt",
  summary: "approved: R1 and R2 are met",
  artifacts: [{ path: "context_handoff/review.md", location: "handoff", size: 48, role: "output", preview: "# Review\n\nVerdict: approved. R1 and R2 are met." }],
  checks: [
    { gate: "artifacts_exist", passed: true, items: [{ item: "review.md", ok: true, note: "exists, 48B" }] },
    { gate: "verdict_consistent", passed: true, items: [{ item: "approved vs blocking", ok: true, note: "no blocking items" }] },
  ],
});
const changes = (): P => ({
  name: "changes", kind: "code", owner: "git", secs: 1,
  description: "Diff the whole run against its pinned baseline, for the documenter",
  summary: "2 files · +7 −0 since ddfd5cb",
  artifacts: [{ path: "context_handoff/changes.diff", location: "handoff", size: 611, role: "output" }],
});
const document = (): P => ({
  name: "document", kind: "agent", owner: "documenter", secs: 19, cost: 0.018, tokens: 1200, model: "sonnet",
  task: "asf/stages/document/task.md", outputType: "DocumentOutput",
  description: "Write up the completed change, from the diff, for the engineer who arrives next",
  summary: "documented the meeting date",
  artifacts: [{ path: "docs/asf/meeting-date.md", location: "repo", size: 41, role: "output", preview: "# The meeting date\n\nEvery prompt now carries it." }],
});
const integrate = (pr: number): P => ({
  name: "integrate", kind: "code", owner: "git", secs: 4,
  description: "Land the run's branch on its base branch, the way this repository has said it wants it landed",
  summary: `opened pull request #${pr}`,
  remark: { verdict: "approve", by: "policy", text: "", round: 1, channel: "policy" },
});
const reportIssue = (n: number): P => ({
  name: "report", kind: "code", owner: "tracker", secs: 1,
  description: "Tell the reporter what happened and where the work went",
  summary: `commented on #${n}`,
});
const reportPr = (pr: number): P => ({
  name: "report", kind: "code", owner: "review", secs: 1,
  description: "Answer each thread that was addressed, and say once what the run as a whole did",
  summary: `addressed · 1 thread replied and resolved · commented on #${pr}`,
});

const tests = (by: string): Remark => ({ verdict: "reject", by, text: "name the module the date is converted in", round: 1, channel: "terminal" });

// ── Sessions ───────────────────────────────────────────────────────────────────

function recorded(): Session {
  const sid = "a9f259f0";
  const start = NOW - 3 * 60 * min - 25 * min;
  const c1 = chapter(sid, 1, "issue", "#42", start, issuePhase("#42 Resolve relative due dates via the meeting date"), [
    [scout()],
    [
      plan(),
      approve(1, tests("schurik"), "rejected", 29),
      revise(1, "the plan now names the module"),
      approve(2, { verdict: "approve", by: "schurik", text: "keep the prompt in English", round: 2, channel: "terminal" }, "ok", 61),
    ],
    [commit("plan", "2512a3c", "docs: plan the meeting date")],
    [implement("build_prompt takes the meeting date", {
      notes: [{ kind: "deviation", what: "kept the summary helpers", insteadOf: "reworking every prompt", because: "only the action items need a date", by: "builder" }],
    })],
    [verify(1)],
    [review()],
    [commit("implement", "813c30e", "feat: the prompt knows the meeting date")],
    [changes(), document()],
    [commit("document", "fba4ec9", "docs: the meeting date")],
    [integrate(9)],
  ], reportIssue(42), 0);
  const c2 = chapter(sid, 2, "pr-review", "PR #9", c1.at + 52 * min, prPhase("1 open thread of 1 · the date should read like Sep 25, 2026"), [
    [implement("addressed: the date should read like Sep 25, 2026", { cost: 0.04, tokens: 2000, tools: [{ tool: "edit", ok: true }] })],
    [verify(1)],
    [commit("implement", "65ab701", "fix: the date reads like Sep 25, 2026")],
  ], reportPr(9), c1.seq);
  const c3 = chapter(sid, 3, "pr-review", "PR #9", c2.at + 71 * min, prPhase("1 open thread of 1 · use that format two lines below too"), [
    [implement("addressed: use that format two lines below too", { cost: 0.04, tokens: 2000, tools: [{ tool: "edit", ok: true }] })],
    [verify(1)],
    [commit("implement", "54551da", "fix: one date format throughout")],
  ], reportPr(9), c2.seq);
  return {
    id: sid, factory: "acme/widgets", title: "Resolve relative due dates via the meeting date", ref: "#42",
    status: "done", chapters: [c1.chapter, c2.chapter, c3.chapter],
    station: "schurik@mbp:widgets", stationOnline: true, owner: "schurik",
    branch: "asf/a9f259f0", base: "main at ddfd5cb", triggeredBy: "label asf:queued + asf:ship",
    issueUrl: "#", prUrl: "#", startedAt: start, endedAt: c3.at, budget: 2.5, transcripts: true,
    now: "All work landed in pull request #9 over 3 chapters.",
  };
}

function waitingMine(): Session {
  const sid = "c41e7b02";
  const start = NOW - 58 * min;
  const c1 = chapter(sid, 1, "issue", "#57", start, issuePhase("#57 Export action items as CSV"), [
    [scout({ summary: "export lives in export.py; only JSON today" })],
    [
      plan({ summary: "a CSV writer beside the JSON one, same columns", notes: [] }),
      approve(1, { verdict: "reject", by: "schurik", text: "quote every field — titles contain commas", round: 1, channel: "issue" }, "rejected", 14 * 60),
      revise(1, "every field is quoted; a test with a comma in a title"),
      approve(2, null, "waiting", 0),
    ],
  ], null, 0);
  return {
    id: sid, factory: "acme/widgets", title: "Export action items as CSV", ref: "#57",
    status: "waiting", chapters: [c1.chapter],
    station: "schurik@mbp:widgets", stationOnline: true, owner: "schurik",
    branch: "asf/c41e7b02", base: "main at 3f1c2a9", triggeredBy: "label asf:queued + asf:ship",
    issueUrl: "#", startedAt: start, budget: 2.5, transcripts: true,
    now: "Waiting on you at the plan gate, round 2 — the planner reworked the plan along your note.",
  };
}

function waitingMine2(): Session {
  const sid = "2a7c9e15";
  const start = NOW - 22 * min;
  const c1 = chapter(sid, 1, "issue", "#18", start, issuePhase("#18 Retry webhook deliveries with backoff"), [
    [scout({ summary: "deliveries are sent once, from hooks/send.py" })],
    [
      plan({ summary: "three retries, exponential backoff, a dead-letter log", notes: [{ kind: "discovery", what: "the receiver is idempotent already", because: "it dedupes on the delivery id", by: "planner" }] }),
      approve(1, null, "waiting", 0),
    ],
  ], null, 0);
  return {
    id: sid, factory: "acme/gadgets", title: "Retry webhook deliveries with backoff", ref: "#18",
    status: "waiting", chapters: [c1.chapter],
    station: "ci@gadgets", stationOnline: true, owner: "—",
    branch: "asf/2a7c9e15", base: "main at 91ab03e", triggeredBy: "label asf:queued + asf:ship",
    issueUrl: "#", startedAt: start, budget: 2.5, transcripts: false,
    now: "Waiting on you at the plan gate, round 1.",
  };
}

function waitingOther(): Session {
  const sid = "0f9a6c3d";
  const start = NOW - 74 * min;
  const c1 = chapter(sid, 1, "issue", "#31", start, issuePhase("#31 Rate-limit the public API"), [
    [scout({ summary: "middleware is wired in server.ts" })],
    [plan({ summary: "a token bucket per API key, 60 req/min", notes: [] }), approve(1, null, "waiting", 0)],
  ], null, 0);
  return {
    id: sid, factory: "acme/gadgets", title: "Rate-limit the public API", ref: "#31",
    status: "waiting", chapters: [c1.chapter],
    station: "mira@thinkpad:gadgets", stationOnline: true, owner: "mira",
    branch: "asf/0f9a6c3d", base: "main at 91ab03e", triggeredBy: "label asf:queued + asf:ship",
    issueUrl: "#", startedAt: start, budget: 2.5, transcripts: false,
    now: "Waiting on mira at the plan gate, round 1.",
  };
}

function running(): Session {
  const sid = "7d2f90aa";
  const start = NOW - 9 * min;
  const c1 = chapter(sid, 1, "issue", "#61", start, issuePhase("#61 Paginate the meetings list"), [
    [scout({ summary: "the list query is in meetings/list.py" })],
    [plan({ summary: "cursor pagination, 50 per page", notes: [] }), approve(1, { verdict: "approve", by: "schurik", text: "", round: 1, channel: "issue" }, "ok", 95)],
    [commit("plan", "a01b7c2", "docs: plan meetings pagination")],
    [implement("", { status: "running", secs: 140, cost: 0.09, tokens: 5400, summary: undefined, checks: undefined,
      tools: [{ tool: "read", ok: true }, { tool: "read", ok: true }, { tool: "edit", ok: true }] })],
  ], null, 0);
  return {
    id: sid, factory: "acme/widgets", title: "Paginate the meetings list", ref: "#61",
    status: "running", chapters: [c1.chapter],
    station: "schurik@mbp:widgets", stationOnline: true, owner: "schurik",
    branch: "asf/7d2f90aa", base: "main at 3f1c2a9", triggeredBy: "label asf:queued + asf:ship",
    issueUrl: "#", startedAt: start, budget: 2.5, transcripts: true,
    now: "The builder is implementing the plan — 3 tool calls so far.",
  };
}

function runningReview(): Session {
  const sid = "3b8e11d0";
  const start = NOW - 2 * 60 * min;
  const c1 = chapter(sid, 1, "issue", "#12", start, issuePhase("#12 Signed webhook payloads"), [
    [scout()], [plan({ notes: [] }), approve(1, { verdict: "approve", by: "mira", text: "", round: 1, channel: "issue" }, "ok", 300)],
    [commit("plan", "77aa120", "docs: plan signed payloads")], [implement("payloads carry an HMAC header")], [verify(1)], [review()],
    [commit("implement", "c0ffe12", "feat: sign webhook payloads")], [changes(), document()],
    [commit("document", "d0c5e11", "docs: signed payloads")], [integrate(14)],
  ], reportIssue(12), 0);
  const c2 = chapter(sid, 2, "pr-review", "PR #14", NOW - 4 * min, prPhase("2 open threads of 2"), [
    [implement("addressed 2 threads: constant-time compare; header name", { cost: 0.06, tokens: 3100 })],
    [verify(1, { status: "running", secs: 75, summary: undefined, command: { argv: "bun test", exit: -1, secs: 75 } })],
  ], null, c1.seq);
  return {
    id: sid, factory: "acme/gadgets", title: "Signed webhook payloads", ref: "#12",
    status: "running", chapters: [c1.chapter, c2.chapter],
    station: "ci@gadgets", stationOnline: true, owner: "—",
    branch: "asf/3b8e11d0", base: "main at 91ab03e", triggeredBy: "review on PR #14",
    issueUrl: "#", prUrl: "#", startedAt: start, budget: 2.5, transcripts: false,
    now: "Running bun test after addressing 2 review threads on PR #14.",
  };
}

function runningQuick(): Session {
  const sid = "e01d44b7";
  const start = NOW - 3 * min;
  const c1 = chapter(sid, 1, "quick", "prompt", start, null, [
    [implement("fixed 6 links", { cost: 0.03, tokens: 1700 })], [verify(1)],
    [commit("implement", "", "", { status: "running", secs: 4, summary: undefined, commit: undefined })],
  ], null, 0);
  return {
    id: sid, factory: "acme/docs-site", title: "Fix the broken links in the changelog", ref: "prompt",
    status: "running", chapters: [c1.chapter],
    station: "schurik@mbp:docs-site", stationOnline: true, owner: "schurik",
    branch: "asf/e01d44b7", base: "main at 5e5e001", triggeredBy: "Run a prompt · schurik",
    startedAt: start, budget: 1, transcripts: true,
    now: "Committing the fix on asf/e01d44b7.",
  };
}

function failed(): Session {
  const sid = "e5b3a118";
  const start = NOW - 2 * 60 * min - 40 * min;
  const c1 = chapter(sid, 1, "issue", "#23", start, issuePhase("#23 Drop the legacy v1 API"), [
    [scout({ summary: "v1 routes in api/v1/*, 4 callers in tests" })],
    [plan({ summary: "delete api/v1, move 4 tests to v2", notes: [] }), approve(1, { verdict: "approve", by: "mira", text: "", round: 1, channel: "issue" }, "ok", 410)],
    [commit("plan", "4e4e4e1", "docs: plan dropping v1")],
    [implement("api/v1 removed; tests moved to v2")],
    [
      verify(1, { status: "failed", summary: "failed · bun test exits 1", command: { argv: "bun test", exit: 1, secs: 31, tail: "tests/api.test.ts:\n✗ GET /v1/health falls back to v2 [3.1ms]\n  expected 200, received 404\n\n 41 pass\n 1 fail" } }),
      { name: "fix_1", kind: "agent", owner: "builder", secs: 22, cost: 0.07, tokens: 4100, model: "opus", task: "asf/stages/verify/fix.md", outputType: "BuildOutput",
        description: "Fix what the failed check reported, and nothing else", summary: "kept /v1/health as a redirect" },
      verify(2, { status: "failed", summary: "failed · bun test exits 1", command: { argv: "bun test", exit: 1, secs: 30, tail: "tests/api.test.ts:\n✗ GET /v1/health falls back to v2 [2.9ms]\n  expected 200, received 301\n\n 41 pass\n 1 fail" },
        error: "verify failed twice; the stage allows one fix" }),
    ],
  ], null, 0);
  return {
    id: sid, factory: "acme/gadgets", title: "Drop the legacy v1 API", ref: "#23",
    status: "failed", chapters: [c1.chapter],
    station: "mira@thinkpad:gadgets", stationOnline: false, owner: "mira",
    branch: "asf/e5b3a118", base: "main at 91ab03e", triggeredBy: "label asf:queued + asf:ship",
    issueUrl: "#", startedAt: start, endedAt: NOW - 2 * 60 * min, budget: 2.5, transcripts: false,
    now: "verify failed twice: bun test still fails GET /v1/health. The branch is kept for resume.",
  };
}

export const SESSIONS: Session[] = [waitingMine(), waitingMine2(), running(), runningReview(), runningQuick(), waitingOther(), failed(), recorded()];

export const HISTORY: { id: string; factory: string; title: string; ref: string; workflow: string; status: SessionStatus; cost: number; at: number }[] = [
  { id: "b71a0c55", factory: "acme/widgets", title: "Timezone in the meeting header", ref: "#40", workflow: "issue", status: "done", cost: 0.51, at: NOW - 26 * 60 * min },
  { id: "19fe3d2a", factory: "acme/docs-site", title: "Bump the theme", ref: "prompt", workflow: "quick", status: "done", cost: 0.07, at: NOW - 30 * 60 * min },
  { id: "6c0b9a7e", factory: "acme/gadgets", title: "CORS for the admin app", ref: "#9", workflow: "issue", status: "failed", cost: 0.33, at: NOW - 49 * 60 * min },
];

export const sessionById = (id: string) => SESSIONS.find((s) => s.id === id);

// ── Gates: the Inbox (waiting on the viewer) and Waiting on others ────────────

export const GATES: Gate[] = [
  {
    id: "g-c41e7b02-2", session: "c41e7b02", factory: "acme/widgets", ref: "#57", title: "Export action items as CSV",
    gate: "plan", question: "Approve the plan?", round: 2, since: NOW - 36 * min, askedOf: VIEWER, channel: "issue",
    subject: "every field is quoted; a test with a comma in a title",
    subjectFile: "docs/asf/spec/plan.md",
    subjectBody: "## Plan\n\n- **R1** `export.py` gains `write_csv`, beside `write_json`, with the same columns.\n- **R2** Every field is quoted (`csv.QUOTE_ALL`) — titles contain commas.\n- **R3** A test exports an item titled `Ship it, then tell sales` and reads it back.\n\nOut of scope: Excel dialects, a download button.",
    earlier: [{ round: 1, verdict: "reject", by: "schurik", text: "quote every field — titles contain commas" }],
    record: ["⚑ risk (planner): CSV readers differ on line endings — because Excel wants CRLF"],
    cost: 0.16, tokens: 10400, station: "schurik@mbp:widgets", digest: "6151fe4319d0",
  },
  {
    id: "g-2a7c9e15-1", session: "2a7c9e15", factory: "acme/gadgets", ref: "#18", title: "Retry webhook deliveries with backoff",
    gate: "plan", question: "Approve the plan?", round: 1, since: NOW - 11 * min, askedOf: VIEWER, channel: "issue",
    subject: "three retries, exponential backoff, a dead-letter log",
    subjectFile: "docs/asf/spec/plan.md",
    subjectBody: "## Plan\n\n- **R1** `hooks/send.py` retries a failed delivery 3 times: 1s, 4s, 16s.\n- **R2** After the last, the delivery goes to `dead_letters.jsonl` with its last error.\n- **R3** Tests use a fake clock.",
    earlier: [],
    record: ["⚑ discovery (planner): the receiver is idempotent already — because it dedupes on the delivery id"],
    cost: 0.12, tokens: 8000, station: "ci@gadgets", digest: "0a8be2c4d771",
  },
];

export const OTHERS: Gate[] = [
  {
    id: "g-0f9a6c3d-1", session: "0f9a6c3d", factory: "acme/gadgets", ref: "#31", title: "Rate-limit the public API",
    gate: "plan", question: "Approve the plan?", round: 1, since: NOW - 61 * min, askedOf: "mira", channel: "issue",
    subject: "a token bucket per API key, 60 req/min", subjectFile: "docs/asf/spec/plan.md", subjectBody: "",
    earlier: [], record: [], cost: 0.12, tokens: 8000, station: "mira@thinkpad:gadgets", digest: "",
  },
];

// ── Needs attention, aggregated across factories (attention.ts's rule, minus gates: those are the Inbox) ──

export type Attention =
  | { kind: "failed"; factory: string; session: string; title: string; ref: string; ago: number; reason: string }
  | { kind: "claim"; factory: string; station: string; ref: string; away: number }
  | { kind: "drift"; factory: string; station: string; what: string }
  | { kind: "check"; factory: string; what: string }
  | { kind: "unwatched"; factory: string; issues: number[] };

export const ATTENTION: Attention[] = [
  { kind: "failed", factory: "acme/gadgets", session: "e5b3a118", title: "Drop the legacy v1 API", ref: "#23", ago: 2 * 60 * min, reason: "verify failed twice" },
  { kind: "check", factory: "acme/widgets", what: "workflow nightly does not load: agent 'nobody' is not in the roster" },
  { kind: "claim", factory: "acme/gadgets", station: "mira@thinkpad:gadgets", ref: "#23", away: 26 * 60 * min },
  { kind: "unwatched", factory: "acme/docs-site", issues: [7, 9] },
  { kind: "drift", factory: "acme/widgets", station: "ci@widgets", what: "factory.yaml differs from main at 3f1c2a9" },
];

export const FACTORIES = [
  { name: "acme/widgets", stations: 2, online: 2, running: 1, attention: 2 },
  { name: "acme/gadgets", stations: 3, online: 2, running: 1, attention: 2 },
  { name: "acme/docs-site", stations: 1, online: 1, running: 1, attention: 1 },
];
