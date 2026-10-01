/**
 * A factory's self-description, as the cockpit reads it (spec #40).
 *
 * The cockpit never interprets a workflow file. What it shows of a factory's
 * workflows — purpose, trigger, stages, agents, gates — and its per-session
 * budget is what the factory's own `asf check --json` printed
 * (`engine/describe.py`), shipped by the optional CI workflow as a CI station
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
export const KNOWN_FORMAT = 1;
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

export interface Description {
  format: number;
  /** Written in a format newer than this cockpit reads: upgrade the cockpit. */
  newer: boolean;
  skillVersion: string;
  checked: { head: string; ref: string; configHash: string };
  ok: boolean;
  budget: { maxCostUsd: number; maxTokens: number };
  workflows: DescribedWorkflow[];
  problems: { workflow: string; error: string }[];
}

export function readDescription(text: string): Description {
  const raw = Payload.parse(text);
  const checked = raw.obj("checked") ?? new Payload({});
  const budget = raw.obj("budget") ?? new Payload({});
  const format = raw.num("format");
  return {
    format,
    newer: format > KNOWN_FORMAT,
    skillVersion: raw.str("skill_version"),
    checked: { head: checked.str("head"), ref: checked.str("ref"), configHash: checked.str("config_hash") },
    ok: raw.bool("ok"),
    budget: { maxCostUsd: budget.num("max_cost_usd"), maxTokens: budget.num("max_tokens") },
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
