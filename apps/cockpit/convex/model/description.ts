/**
 * A factory's self-description, as the cockpit reads it (spec #40).
 *
 * The cockpit never interprets a workflow file. What it shows of a factory's
 * workflows — purpose, trigger, stages, agents, gates — its per-session
 * budget and, from format 2, its settings are what the factory's own
 * `asf check --json` printed (`engine/describe.py`), shipped by the optional CI workflow as a CI station
 * with the factory's ingest token. It carries its own format version, and the
 * golden corpus holds one fixture per version (`tests/golden/self-description/
 * v<N>.json`): every one ever written must read here.
 *
 * Read the way an event payload is (`payload.ts`): loosely. A field that is
 * missing or mistyped reads as empty, a newer format reads as far as this
 * cockpit understands it and says it is newer, and nothing here throws.
 */
import { Payload } from "./payload";
import { isRecord } from "./wire";

/** The newest format this cockpit was written against. */
export const KNOWN_FORMAT = 2;
/** The most a description may weigh as it arrives: it is kept whole, in one document. */
export const MAX_DESCRIPTION_BYTES = 900_000;

export interface DescribedAgent {
  name: string;
  harness: string;
  model: string;
  thinking: string;
  purpose: string;
  /** null: every tool. */
  tools: string[] | null;
  /** null: anything but the roster's protected files; []: read-only. */
  writes: string[] | null;
}

export interface DescribedStage {
  stage: string;
  kind: string;
  agents: string[];
  /** The gate it places, by name; "" for none. */
  gate: string;
}

export interface DescribedGate {
  name: string;
  stage: string;
  /** gate: a verdict on a work product, stopping when `on`; questions: asked whenever the agent cannot settle something. */
  kind: string;
  on: boolean;
}

export interface DescribedWorkflow {
  name: string;
  description: string;
  input: string;
  trigger: { labels: string[]; watched: boolean };
  stages: DescribedStage[];
  agents: DescribedAgent[];
  gates: DescribedGate[];
  warnings: string[];
}

/** The per-session budget factory.yaml sets — the only ceiling the factory enforces: 0 for one it does not set. */
export interface Budget {
  maxCostUsd: number;
  maxTokens: number;
}

/**
 * The factory's settings, from format 2: factory.yaml as the factory's own code
 * reads it, every default resolved there — the cockpit never parses
 * factory.yaml (`DescribedSettings` in `engine/data_types.py` says what each
 * field means). Grouped by what each decides, as the Config tab shows them.
 */
export interface Settings {
  /** Where work comes from. */
  intake: {
    issues: boolean;
    /** label → workflow */
    routes: Record<string, string>;
    queuedLabel: string;
    /** []: anyone whose issue gets labelled. */
    trustedAuthors: string[];
    maxConcurrent: number;
    reviews: {
      watched: boolean;
      workflow: string;
      /** []: anyone who can review. */
      trustedReviewers: string[];
      ignoreAuthors: string[];
      replyToThreads: boolean;
      resolveThreads: boolean;
      maxThreads: number;
      maxConcurrent: number;
      reapMerged: boolean;
    };
    promptWorkflows: string[];
  };
  /** People at gates. */
  hitl: {
    default: boolean;
    /** Every gate a workflow places or factory.yaml names, as factory.yaml switches it. */
    gates: Record<string, boolean>;
    waitSeconds: number;
    whenUnattended: string;
    /** 0: until the person approves or aborts. */
    maxRounds: number;
    notifyCommand: string[];
  };
  /** How work lands. */
  landing: {
    /** A prompt run's: merge | pr. */
    mode: string;
    /** An issue run's, which `issues.force_pr` holds to pr. */
    issueMode: string;
    openPr: boolean;
    remote: string;
    branchPrefix: string;
    /** "": the branch each station's checkout has out. */
    baseRef: string;
    /** on_create | on_integrate */
    publish: string;
    worktrees: boolean;
    worktreeDir: string;
    keepOnSuccess: boolean;
  };
  /** Limits and data. */
  limits: {
    /** The description's own budget, described since format 1. */
    budget: Budget;
    transcripts: boolean;
    /** 0: the cockpit's own limit. */
    transcriptRetentionDays: number;
    /** What a cockpit may ask a station to do. */
    commands: string[];
  };
  /** The forge and tracker. */
  forge: {
    /** "": neither set nor resolvable from the origin remote. */
    project: string;
    reviewProject: string;
    remote: string;
    /** queued, running, done, failed, refined, pr_failed */
    labels: Record<string, string>;
  };
}

export interface Description {
  format: number;
  /** Written in a format newer than this cockpit reads: upgrade the cockpit. */
  newer: boolean;
  skillVersion: string;
  checked: { head: string; ref: string; configHash: string };
  ok: boolean;
  budget: Budget;
  /** null in a description written before format 2, which had none. */
  settings: Settings | null;
  workflows: DescribedWorkflow[];
  problems: { workflow: string; error: string }[];
}

export function readDescription(text: string): Description {
  const raw = Payload.parse(text);
  const checked = raw.obj("checked") ?? new Payload({});
  const budget = raw.obj("budget") ?? new Payload({});
  const format = raw.num("format");
  const ceiling = { maxCostUsd: budget.num("max_cost_usd"), maxTokens: budget.num("max_tokens") };
  const settings = raw.obj("settings");
  return {
    format,
    newer: format > KNOWN_FORMAT,
    skillVersion: raw.str("skill_version"),
    checked: { head: checked.str("head"), ref: checked.str("ref"), configHash: checked.str("config_hash") },
    ok: raw.bool("ok"),
    budget: ceiling,
    settings: settings === null ? null : readSettings(settings, ceiling),
    workflows: raw.list("workflows").map(readWorkflow),
    problems: raw.list("problems").map((problem) => ({ workflow: problem.str("workflow"), error: problem.str("error") })),
  };
}

function readWorkflow(raw: Payload): DescribedWorkflow {
  const trigger = raw.obj("trigger") ?? new Payload({});
  return {
    name: raw.str("name"),
    description: raw.str("description"),
    input: raw.str("input"),
    trigger: { labels: trigger.strs("labels"), watched: trigger.bool("watched") },
    stages: raw.list("stages").map((step) => ({
      stage: step.str("stage"), kind: step.str("kind"), agents: step.strs("agents"), gate: step.str("gate"),
    })),
    agents: raw.list("agents").map((agent) => ({
      name: agent.str("name"), harness: agent.str("harness"), model: agent.str("model"),
      thinking: agent.str("thinking"), purpose: agent.str("purpose"),
      tools: orNull(agent, "tools"), writes: orNull(agent, "writes"),
    })),
    gates: raw.list("gates").map((gate) => ({
      name: gate.str("name"), stage: gate.str("stage"), kind: gate.str("kind"), on: gate.bool("on"),
    })),
    warnings: raw.strs("warnings"),
  };
}

function readSettings(raw: Payload, budget: Budget): Settings {
  const part = (from: Payload, key: string) => from.obj(key) ?? new Payload({});
  const intake = part(raw, "intake");
  const reviews = part(intake, "reviews");
  const hitl = part(raw, "hitl");
  const landing = part(raw, "landing");
  const limits = part(raw, "limits");
  const forge = part(raw, "forge");
  return {
    intake: {
      issues: intake.bool("issues"), routes: mapOf(intake, "routes", "string"),
      queuedLabel: intake.str("queued_label"), trustedAuthors: intake.strs("trusted_authors"),
      maxConcurrent: intake.num("max_concurrent"),
      reviews: {
        watched: reviews.bool("watched"), workflow: reviews.str("workflow"),
        trustedReviewers: reviews.strs("trusted_reviewers"), ignoreAuthors: reviews.strs("ignore_authors"),
        replyToThreads: reviews.bool("reply_to_threads"), resolveThreads: reviews.bool("resolve_threads"),
        maxThreads: reviews.num("max_threads"), maxConcurrent: reviews.num("max_concurrent"),
        reapMerged: reviews.bool("reap_merged"),
      },
      promptWorkflows: intake.strs("prompt_workflows"),
    },
    hitl: {
      default: hitl.bool("default"), gates: mapOf(hitl, "gates", "boolean"),
      waitSeconds: hitl.num("wait_seconds"), whenUnattended: hitl.str("when_unattended"),
      maxRounds: hitl.num("max_rounds"), notifyCommand: hitl.strs("notify_command"),
    },
    landing: {
      mode: landing.str("mode"), issueMode: landing.str("issue_mode"), openPr: landing.bool("open_pr"),
      remote: landing.str("remote"), branchPrefix: landing.str("branch_prefix"), baseRef: landing.str("base_ref"),
      publish: landing.str("publish"), worktrees: landing.bool("worktrees"),
      worktreeDir: landing.str("worktree_dir"), keepOnSuccess: landing.bool("keep_on_success"),
    },
    limits: {
      budget, transcripts: limits.bool("transcripts"),
      transcriptRetentionDays: limits.num("transcript_retention_days"), commands: limits.strs("commands"),
    },
    forge: {
      project: forge.str("project"), reviewProject: forge.str("review_project"), remote: forge.str("remote"),
      labels: mapOf(forge, "labels", "string"),
    },
  };
}

/** A map's entries whose values are of `type`; anything else is left out. */
function mapOf<T extends "string" | "boolean">(raw: Payload, key: string, type: T):
    Record<string, T extends "string" ? string : boolean> {
  const value = raw.value()[key];
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === type)) as
    Record<string, T extends "string" ? string : boolean>;
}

/** A list that may be null, and means something different when it is. */
function orNull(raw: Payload, key: string): string[] | null {
  return Array.isArray(raw.value()[key]) ? raw.strs(key) : null;
}

// ── the wire: `/describe` ────────────────────────────────────────────────────

export interface Describing {
  station: { id: string; name: string; kind: string };
  /** The description, as the JSON text it is kept as. */
  text: string;
  description: Description;
}

export interface Refusal {
  status: 400 | 403 | 413;
  error: string;
}

/** A CI station's push, or why it is refused. Checks only what every format has. */
export function parseDescribing(body: unknown): Describing | Refusal {
  if (!isRecord(body)) return { status: 400, error: "the body is not a JSON object" };
  const { station, description } = body;
  if (!isRecord(station) || !["id", "name", "kind"].every((key) => typeof station[key] === "string" && station[key] !== "")) {
    return { status: 400, error: "`station` names its id, name and kind" };
  }
  // The default branch's description is what every station's config drift is
  // measured against: a checkout's own edits must not become it.
  if (station.kind !== "ci") {
    return { status: 403, error: "a self-description is pushed by a CI station — the factory's CI workflow — never a local checkout" };
  }
  if (!isRecord(description) || !Number.isInteger(description.format) || (description.format as number) < 1
      || !isRecord(description.checked)) {
    return { status: 400, error: "`description` is what `asf check --json` prints: a format, and the checkout it checked" };
  }
  const text = JSON.stringify(description);
  if (text.length > MAX_DESCRIPTION_BYTES) {
    return { status: 413, error: `a description holds at most ${MAX_DESCRIPTION_BYTES} bytes` };
  }
  return {
    station: { id: station.id as string, name: station.name as string, kind: station.kind as string },
    text, description: readDescription(text),
  };
}

export function isRefusal(parsed: Describing | Refusal): parsed is Refusal {
  return "error" in parsed;
}
