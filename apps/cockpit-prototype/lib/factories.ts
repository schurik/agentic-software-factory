// PROTOTYPE, throwaway. What a factory page shows, as static data: its self-description
// (workflows, stages, agents — `asf check --json` at one commit), its stations, its config and
// its spend. Values follow today's cockpit screenshots and tests/golden/self-description/v1.json.
import { NOW } from "./data";

const min = 60_000;
const hour = 60 * min;

export interface Agent { name: string; harness: "claude_code" | "pi"; model: string; effort: string; tools: string[]; writes: string; purpose: string }
export interface StageShape { name: string; agents: string[]; gate?: { name: string; on: boolean } }
/** One stage's record over the last 30 days, from the events of every run of the workflow. */
export interface StageStat { medianSecs: number; medianCost: number; failures: number; gate?: { rounds: number; rejected: number; medianWait: number } }
export interface Workflow {
  name: string;
  input: "issue" | "pr" | "prompt";
  about: string;
  startedBy: string;
  /** The self-description's `trigger`: the labels that start it, and whether a station loop watches for them. */
  trigger: { labels: string[]; watched: boolean };
  stages: StageShape[];
  /** Per stage, aligned with `stages`; absent when nothing ran in the period. */
  stats?: StageStat[];
  warnings?: string[];
  broken?: string;
}
export interface Station {
  name: string;
  owner: string | null;
  kind: "machine" | "ci";
  state: "online" | "away" | "never";
  lastSeen: number | null;
  commit: string | null;
  drift: "in sync" | "drifted" | "no report";
  driftWhat?: string;
  claims: number;
  ciJobs?: string;
  /** What its loop runs and what it obeys — its own report on every poll. */
  watchers: ("issues" | "pull_requests")[];
  verbs: string[];
  /** The release it runs: `skill_version` from the sessions it started. */
  release: string;
  running: number;
  last30: { sessions: number; failed: number; spend: number };
  /** Commands queued for it and not yet taken: they wait out their TTL. */
  pending: { verb: string; session: string; by: string; issuedAt: number; expiresAt: number }[];
  revoked?: boolean;
}
export interface Spend { total: number; tokens: number; byWorkflow: [string, number][]; byStation: [string, number][]; byPerson: [string, number][] }
/** How a workflow did over a period: what a factory's owner tunes — not any one session. */
export interface WorkflowStats { workflow: string; sessions: number; done: number; failed: number; medianSecs: number; spend: number; lastRun: number }
export interface Outcomes {
  sessions: number;
  done: number;
  failed: number;
  open: number;
  medianSecs: number;
  /** How long sessions waited on people at gates, median. */
  medianGateWait: number;
  gateRounds: number;
  rejectedRounds: number;
  byWorkflow: WorkflowStats[];
}
export type Period = "last7" | "last30";
/** factory.yaml on the default branch, as the Config tab groups it. */
export interface FactoryConfig {
  forge: { name: "GitHub"; host: string };
  issues: { enabled: boolean; project: string; via: string; routes: [string, string][]; states: Record<string, string>; refinedLabel: string; trustedAuthors: string[]; maxConcurrent: number };
  pullRequests: { enabled: boolean; workflow: string; trustedReviewers: string[]; ignoreAuthors: string[]; replyToThreads: boolean; resolveThreads: boolean; maxThreads: number; maxConcurrent: number; reapMerged: boolean };
  hitl: { default: "on" | "off"; gates: Record<string, "on" | "off">; waitSeconds: number; maxRounds: number; whenUnattended: "suspend" | "auto"; notify: string };
  integration: { mode: "pr" | "merge"; openPr: boolean; remote: string; branchPrefix: string; baseRef: string; keepOnSuccess: boolean };
  cockpitCommands: string[];
  files: string[];
  proposals: { n: number; title: string; by: string; at: number }[];
}

export interface FactoryDetail {
  name: string;
  defaultBranch: string;
  sha: string;
  check: { state: "passing" | "failing" | "unchecked"; pushedBy: string; at: number; skill: string };
  budget: number;
  tokensCap: number;
  transcripts: boolean;
  retentionDays: number;
  hitl: string[];
  lastActivity: number;
  workflows: Workflow[];
  agents: Agent[];
  stations: Station[];
  spend: { month: Spend; last30: Spend };
  /** Spend per day, oldest first, for the last 30 days. */
  daily: number[];
  outcomes: Record<Period, Outcomes>;
  purged: { session: string; by: string; at: number; why: string }[];
  config: FactoryConfig;
  /** Stations asking to be registered: a person who may write approves them by their code. */
  registrations: { name: string; kind: "machine" | "ci"; code: string; at: number; expiresAt: number }[];
}

const RW = ["Read", "Bash", "Edit", "Write", "Grep", "Glob"];
const AGENTS: Agent[] = [
  { name: "analyst", harness: "claude_code", model: "opus", effort: "high", tools: ["Read", "Glob", "Write", "WebFetch"], writes: "read-only", purpose: "Turn a request into requirements; ask about what cannot be settled." },
  { name: "builder", harness: "claude_code", model: "opus", effort: "high", tools: RW, writes: "anything not protected", purpose: "Implement the plan exactly; report every changed file in the envelope." },
  { name: "documenter", harness: "claude_code", model: "sonnet", effort: "medium", tools: RW, writes: "docs/, **/*.md, *.md", purpose: "Write up the change that was just made, from the diff; document only." },
  { name: "planner", harness: "claude_code", model: "opus", effort: "high", tools: RW, writes: "docs/asf/spec/", purpose: "Turn a request into a plan the builder can implement without asking questions." },
  { name: "reviewer", harness: "claude_code", model: "opus", effort: "high", tools: RW, writes: "read-only", purpose: "Confirm that what was built is what was asked for; change nothing." },
  { name: "scout", harness: "claude_code", model: "sonnet", effort: "medium", tools: RW, writes: "read-only", purpose: "Find and report where things live; change nothing." },
];

const SHIP: StageShape[] = [
  { name: "scout", agents: ["scout"] },
  { name: "plan", agents: ["planner"], gate: { name: "plan", on: true } },
  { name: "commit", agents: [] },
  { name: "implement", agents: ["builder"] },
  { name: "verify", agents: ["builder"] },
  { name: "review", agents: ["reviewer", "builder"] },
  { name: "commit", agents: [] },
  { name: "document", agents: ["documenter"] },
  { name: "commit", agents: [] },
  { name: "integrate", agents: [], gate: { name: "integrate", on: false } },
];
const st = (medianSecs: number, medianCost: number, failures = 0, gate?: StageStat["gate"]): StageStat => ({ medianSecs, medianCost, failures, gate });
const offGates = (stages: StageShape[]) => stages.map((s) => (s.gate ? { ...s, gate: { ...s.gate, on: false } } : s));

const WORKFLOWS: Workflow[] = [
  { name: "issue", input: "issue", about: "a tracked work item, scouted, planned, built, verified, reviewed, documented and proposed as a pull request", startedBy: "an issue labelled asf:queued + asf:ship", trigger: { labels: ["asf:ship"], watched: true }, stages: SHIP, stats: [
    st(32, 0.02), st(140, 0.12, 0, { rounds: 9, rejected: 2, medianWait: 14 * 60 }), st(2, 0), st(370, 0.31), st(65, 0, 1), st(41, 0.07), st(2, 0), st(26, 0.02), st(2, 0), st(4, 0, 0, { rounds: 4, rejected: 0, medianWait: 0 }),
  ] },
  { name: "pr-review", input: "pr", about: "answer the open review threads on one of this factory's pull requests, in the session that opened it", startedBy: "review threads on one of the factory's pull requests, by the review watcher", trigger: { labels: [], watched: true }, stats: [st(50, 0.04), st(12, 0), st(2, 0)], stages: [{ name: "implement", agents: ["builder"] }, { name: "verify", agents: ["builder"] }, { name: "commit", agents: [] }] },
  { name: "quick", input: "prompt", about: "implement straight from the prompt, verify, commit — for a change one sentence describes", startedBy: "a prompt: asf run, or Run a prompt here", trigger: { labels: [], watched: false }, stats: [st(64, 0.05), st(15, 0), st(2, 0)], stages: [{ name: "implement", agents: ["builder"] }, { name: "verify", agents: ["builder"] }, { name: "commit", agents: [] }] },
  { name: "refine", input: "issue", about: "read the item and the code, ask what cannot be decided, and write the agreed requirements back onto it", startedBy: "an issue labelled asf:queued + asf:refine", trigger: { labels: ["asf:refine"], watched: true }, warnings: ["the analyst may write, but `writes:` is read-only — it can only report what it found"], stages: [{ name: "refine", agents: ["analyst", "scout"], gate: { name: "requirements", on: true } }] },
  { name: "refine-ship", input: "issue", about: "settle the requirements with a person, then plan, build, verify, review and propose a pull request", startedBy: "an issue labelled asf:queued + asf:refine-ship", trigger: { labels: ["asf:refine-ship"], watched: true }, stages: [{ name: "refine", agents: ["analyst", "scout"], gate: { name: "requirements", on: true } }, ...offGates(SHIP.slice(1))] },
  { name: "sdlc", input: "prompt", about: "plan, implement, verify, commit — for work whose shape is clear enough to plan in one pass", startedBy: "a prompt: asf run, or Run a prompt here", trigger: { labels: [], watched: false }, stages: [{ name: "plan", agents: ["planner"], gate: { name: "plan", on: false } }, { name: "implement", agents: ["builder"] }, { name: "verify", agents: ["builder"] }, { name: "commit", agents: [] }] },
  { name: "ship", input: "prompt", about: "scout, plan, implement, verify, review, document, integrate — three commits, for work whose shape is not obvious", startedBy: "a prompt: asf run, or Run a prompt here", trigger: { labels: [], watched: false }, stages: offGates(SHIP) },
  { name: "nightly", input: "prompt", about: "", startedBy: "", trigger: { labels: [], watched: false }, stages: [], broken: "workflow 'nightly' (asf/workflows/nightly/workflow.yaml) is not runnable:\n- stages[1] implement: agent 'nobody' is neither in the roster nor bound under agents: (analyst, builder, documenter, planner, reviewer, scout)" },
];

/** Thirty days of spend that add up to `total`: a seeded wobble, weekends nearly idle. */
function dailyOf(total: number, seed: number): number[] {
  let x = seed;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const raw = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(NOW - (29 - i) * 24 * hour).getUTCDay();
    const weekend = day === 0 || day === 6;
    return weekend ? (rnd() < 0.7 ? 0 : rnd() * 0.2) : 0.3 + rnd();
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => Math.round((v / sum) * total * 100) / 100);
}

const ago = (h: number) => NOW - h * hour;

function spend(total: number, tokens: number, wf: [string, number][], st: [string, number][], pe: [string, number][]): Spend {
  return { total, tokens, byWorkflow: wf, byStation: st, byPerson: pe };
}

function config(project: string, gates: Record<string, "on" | "off">, trusted: string[], proposals: FactoryConfig["proposals"]): FactoryConfig {
  return {
    forge: { name: "GitHub", host: "github.com" },
    issues: {
      enabled: true, project, via: "gh",
      routes: [["asf:ship", "issue"], ["asf:refine", "refine"], ["asf:refine-ship", "refine-ship"]],
      states: { queued: "asf:queued", running: "asf:running", done: "asf:done", failed: "asf:failed" },
      refinedLabel: "asf:refined", trustedAuthors: trusted, maxConcurrent: 2,
    },
    pullRequests: {
      enabled: true, workflow: "pr-review", trustedReviewers: trusted, ignoreAuthors: ["codecov[bot]"],
      replyToThreads: true, resolveThreads: true, maxThreads: 20, maxConcurrent: 2, reapMerged: true,
    },
    hitl: { default: "off", gates, waitSeconds: 900, maxRounds: 0, whenUnattended: "suspend", notify: "" },
    integration: { mode: "pr", openPr: true, remote: "origin", branchPrefix: "asf/", baseRef: "", keepOnSuccess: false },
    cockpitCommands: ["answer", "abort", "kill", "resume", "run"],
    files: ["asf/factory.yaml", "asf/workflows/issue/workflow.yaml", "asf/workflows/pr-review/workflow.yaml", "asf/agents/builder/agent.md"],
    proposals,
  };
}

export const FACTORY_DETAILS: FactoryDetail[] = [
  {
    name: "acme/widgets", defaultBranch: "main", sha: "3f1c2a9",
    check: { state: "failing", pushedBy: "runner@gha:ci", at: NOW - 41 * min, skill: "1.0.0" },
    budget: 2.5, tokensCap: 2_000_000, transcripts: true, retentionDays: 30, hitl: ["plan"], lastActivity: NOW - 3 * min,
    workflows: WORKFLOWS, agents: AGENTS,
    stations: [
      { name: "schurik@mbp:widgets", owner: "schurik", kind: "machine", state: "online", lastSeen: NOW - 20_000, commit: "3f1c2a9", drift: "in sync", claims: 4,
        watchers: ["issues", "pull_requests"], verbs: ["answer", "abort", "kill", "resume", "run"], release: "1.1.0", running: 1, last30: { sessions: 10, failed: 1, spend: 1.97 }, pending: [] },
      { name: "ci@widgets", owner: null, kind: "ci", state: "online", lastSeen: NOW - 41 * min, commit: "1a2b3c4", drift: "drifted", driftWhat: "factory.yaml differs from main at 3f1c2a9", claims: 0, ciJobs: "2 jobs · 1 check push",
        watchers: [], verbs: [], release: "1.0.0", running: 0, last30: { sessions: 1, failed: 0, spend: 0.14 }, pending: [] },
    ],
    spend: {
      month: spend(1.48, 92_100, [["issue", 1.32], ["pr-review", 0.08], ["quick", 0.08]], [["schurik@mbp:widgets", 1.48]], [["schurik", 1.48]]),
      last30: spend(2.11, 131_400, [["issue", 1.85], ["pr-review", 0.14], ["quick", 0.12]], [["schurik@mbp:widgets", 1.97], ["ci@widgets", 0.14]], [["schurik", 1.97], ["not named by the factory", 0.14]]),
    },
    daily: dailyOf(2.11, 7),
    outcomes: {
      last30: { sessions: 11, done: 7, failed: 1, open: 3, medianSecs: 41 * 60, medianGateWait: 14 * 60, gateRounds: 9, rejectedRounds: 2, byWorkflow: [
        { workflow: "issue", sessions: 6, done: 3, failed: 1, medianSecs: 58 * 60, spend: 1.85, lastRun: ago(0.1) },
        { workflow: "pr-review", sessions: 4, done: 4, failed: 0, medianSecs: 2 * 60, spend: 0.14, lastRun: ago(2) },
        { workflow: "quick", sessions: 1, done: 0, failed: 0, medianSecs: 0, spend: 0.12, lastRun: ago(30) },
      ] },
      last7: { sessions: 6, done: 3, failed: 0, open: 3, medianSecs: 49 * 60, medianGateWait: 21 * 60, gateRounds: 5, rejectedRounds: 1, byWorkflow: [
        { workflow: "issue", sessions: 4, done: 1, failed: 0, medianSecs: 61 * 60, spend: 0.91, lastRun: ago(0.1) },
        { workflow: "pr-review", sessions: 2, done: 2, failed: 0, medianSecs: 2 * 60, spend: 0.08, lastRun: ago(2) },
      ] },
    },
    purged: [],
    config: config("acme/widgets", { plan: "on" }, ["schurik"], [{ n: 18, title: "asf: run the nightly workflow on the builder", by: "schurik", at: NOW - 3 * hour }]),
    registrations: [{ name: "lena@xps:widgets", kind: "machine", code: "KQ7F-29TX", at: NOW - 6 * min, expiresAt: NOW + 9 * min }],
  },
  {
    name: "acme/gadgets", defaultBranch: "main", sha: "91ab03e",
    check: { state: "passing", pushedBy: "mira@gha:ci", at: NOW - 5 * hour, skill: "1.0.0" },
    budget: 2.5, tokensCap: 2_000_000, transcripts: false, retentionDays: 14, hitl: ["plan"], lastActivity: NOW - 4 * min,
    workflows: WORKFLOWS.filter((w) => w.name !== "nightly"), agents: AGENTS,
    stations: [
      { name: "mira@thinkpad:gadgets", owner: "mira", kind: "machine", state: "away", lastSeen: NOW - 26 * hour, commit: "91ab03e", drift: "in sync", claims: 2,
        watchers: ["issues"], verbs: ["answer", "abort", "kill", "resume"], release: "1.1.0", running: 0, last30: { sessions: 4, failed: 2, spend: 0.68 },
        pending: [{ verb: "resume", session: "e5b3a118", by: "schurik", issuedAt: NOW - 12 * min, expiresAt: NOW + 48 * min }] },
      { name: "schurik@mbp:gadgets", owner: "schurik", kind: "machine", state: "online", lastSeen: NOW - 15_000, commit: "91ab03e", drift: "in sync", claims: 0,
        watchers: [], verbs: ["answer", "abort", "kill", "resume", "run"], release: "1.1.0", running: 0, last30: { sessions: 1, failed: 0, spend: 0.2 }, pending: [] },
      { name: "ci@gadgets", owner: null, kind: "ci", state: "online", lastSeen: NOW - 4 * min, commit: "91ab03e", drift: "in sync", claims: 2, ciJobs: "3 jobs · 2 sessions",
        watchers: ["pull_requests"], verbs: [], release: "1.1.0", running: 1, last30: { sessions: 4, failed: 0, spend: 0.74 }, pending: [] },
    ],
    spend: {
      month: spend(1.17, 71_800, [["issue", 0.97], ["pr-review", 0.2]], [["ci@gadgets", 0.52], ["mira@thinkpad:gadgets", 0.45], ["schurik@mbp:gadgets", 0.2]], [["mira", 0.45], ["schurik", 0.2], ["not named by the factory", 0.52]]),
      last30: spend(1.62, 99_000, [["issue", 1.31], ["pr-review", 0.31]], [["ci@gadgets", 0.74], ["mira@thinkpad:gadgets", 0.68], ["schurik@mbp:gadgets", 0.2]], [["mira", 0.68], ["schurik", 0.2], ["not named by the factory", 0.74]]),
    },
    daily: dailyOf(1.62, 3),
    outcomes: {
      last30: { sessions: 9, done: 4, failed: 2, open: 3, medianSecs: 1 * 3600 + 12 * 60, medianGateWait: 52 * 60, gateRounds: 6, rejectedRounds: 0, byWorkflow: [
        { workflow: "issue", sessions: 6, done: 2, failed: 2, medianSecs: 84 * 60, spend: 1.31, lastRun: ago(0.4) },
        { workflow: "pr-review", sessions: 3, done: 2, failed: 0, medianSecs: 9 * 60, spend: 0.31, lastRun: ago(0.1) },
      ] },
      last7: { sessions: 5, done: 1, failed: 1, open: 3, medianSecs: 1 * 3600 + 30 * 60, medianGateWait: 61 * 60, gateRounds: 3, rejectedRounds: 0, byWorkflow: [
        { workflow: "issue", sessions: 4, done: 1, failed: 1, medianSecs: 92 * 60, spend: 0.82, lastRun: ago(0.4) },
        { workflow: "pr-review", sessions: 1, done: 0, failed: 0, medianSecs: 0, spend: 0.2, lastRun: ago(0.1) },
      ] },
    },
    purged: [{ session: "4c2d0e11", by: "mira", at: NOW - 9 * 24 * hour, why: "a customer's address in the issue body" }],
    config: config("acme/gadgets", { plan: "on" }, ["mira", "schurik"], []),
    registrations: [],
  },
  {
    name: "acme/docs-site", defaultBranch: "main", sha: "5e5e001",
    check: { state: "passing", pushedBy: "schurik@gha:ci", at: NOW - 2 * 24 * hour, skill: "1.0.0" },
    budget: 1, tokensCap: 500_000, transcripts: true, retentionDays: 30, hitl: [], lastActivity: NOW - 3 * min,
    workflows: WORKFLOWS.filter((w) => ["quick", "issue"].includes(w.name)), agents: AGENTS.filter((a) => ["builder", "scout", "planner", "reviewer", "documenter"].includes(a.name)),
    stations: [
      { name: "schurik@mbp:docs-site", owner: "schurik", kind: "machine", state: "online", lastSeen: NOW - 30_000, commit: "5e5e001", drift: "in sync", claims: 1,
        watchers: [], verbs: ["answer", "abort", "kill", "resume", "run"], release: "1.1.0", running: 1, last30: { sessions: 5, failed: 0, spend: 0.24 }, pending: [] },
    ],
    spend: {
      month: spend(0.1, 6_200, [["quick", 0.1]], [["schurik@mbp:docs-site", 0.1]], [["schurik", 0.1]]),
      last30: spend(0.24, 15_100, [["quick", 0.17], ["issue", 0.07]], [["schurik@mbp:docs-site", 0.24]], [["schurik", 0.24]]),
    },
    daily: dailyOf(0.24, 11),
    outcomes: {
      last30: { sessions: 5, done: 4, failed: 0, open: 1, medianSecs: 3 * 60, medianGateWait: 0, gateRounds: 0, rejectedRounds: 0, byWorkflow: [
        { workflow: "quick", sessions: 4, done: 3, failed: 0, medianSecs: 3 * 60, spend: 0.17, lastRun: ago(0.05) },
        { workflow: "issue", sessions: 1, done: 1, failed: 0, medianSecs: 14 * 60, spend: 0.07, lastRun: ago(200) },
      ] },
      last7: { sessions: 2, done: 1, failed: 0, open: 1, medianSecs: 3 * 60, medianGateWait: 0, gateRounds: 0, rejectedRounds: 0, byWorkflow: [
        { workflow: "quick", sessions: 2, done: 1, failed: 0, medianSecs: 3 * 60, spend: 0.1, lastRun: ago(0.05) },
      ] },
    },
    purged: [],
    config: { ...config("acme/docs-site", {}, ["schurik"], []), issues: { ...config("acme/docs-site", {}, ["schurik"], []).issues, routes: [["asf:ship", "issue"]] } },
    registrations: [],
  },
];

export const factoryByName = (name: string) => FACTORY_DETAILS.find((f) => f.name === name);
