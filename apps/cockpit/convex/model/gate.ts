/**
 * What a gate's drawer shows beside its subject (#113), read off the
 * session's own events: the request in the reporter's words, what the scout
 * found, the checks the latest verify ran, the reviewer's verdict, and every
 * flag an agent filed in the chapter the gate asks in. The subject itself —
 * the plan, the branch's diff — is the forge's, read when the drawer opens
 * (inbox.subject); nothing here reads a forge.
 *
 * A phase is found by the stage it belongs to (`phase_started` v3). A chapter
 * recorded before stages has none, and there the phase named after the stage
 * — `scout`, `verify_2`, `review_1` — is the one: a tab is a reading aid, not
 * the graph, which never guesses a stage.
 */
import type { AgentItem, Chapter, CodeItem, Story } from "./story";
import type { Note } from "./journal";
import { phaseView } from "./session";
import type { StoredEvent } from "./wire";

/** A file as the drawer renders it: a handoff travels inline, cut at the factory's cap. */
export interface Doc {
  path: string;
  content: string;
  truncated: boolean;
  /** Its content purged from this cockpit (retention.ts): the file was here, and is no longer. */
  pruned: boolean;
}

/** ⚑ An agent's flag: what it declared on an accepted envelope, as the journal files it. */
export interface Flag extends Note {
  by: string;
}

export interface Check {
  name: string;
  argv: string[];
  ok: boolean;
  exitCode: number;
  seconds: number;
}

export interface Material {
  flags: Flag[];
  issue: Doc | null;
  findings: Doc | null;
  checks: Check[];
  review: { summary: string; doc: Doc | null } | null;
}

/** What the drawer shows beside the subject of the gate asking in `story`'s latest chapter. */
export function materialOf(events: StoredEvent[], acked: number, story: Story): Material {
  const chapter = story.chapters.at(-1);
  if (!chapter) return { flags: [], issue: null, findings: null, checks: [], review: null };
  const agents = chapter.items.filter((item): item is AgentItem => item.type === "agent");
  const written = (phase: AgentItem | undefined) => (phase ? output(events, acked, phase.phaseId) : null);
  const verify = inStage(chapter, "verify").filter((item): item is CodeItem => item.type === "code" && item.commands.length > 0).at(-1);
  const reviewer = inStage(chapter, "review").filter((item): item is AgentItem => item.type === "agent").at(-1);
  const asked = chapter.asked;
  return {
    flags: agents.flatMap((phase) => phase.notes.map((note) => ({ ...note, by: phase.owner }))),
    issue: asked && { path: asked.path, content: asked.content, truncated: asked.truncated, pruned: asked.pruned !== null },
    findings: written(inStage(chapter, "scout").filter((item): item is AgentItem => item.type === "agent").at(-1)),
    checks: (verify?.commands ?? []).map((command) => ({
      name: command.name, argv: command.argv, ok: command.exitCode === 0, exitCode: command.exitCode, seconds: command.durationSeconds,
    })),
    review: reviewer ? { summary: reviewer.summary, doc: written(reviewer) } : null,
  };
}

/** The chapter's phases in `stage`, in order: by its stage index, or — before stages — by name. */
function inStage(chapter: Chapter, stage: string) {
  const named = new RegExp(`^${stage}(_\\d+)?$`);
  return chapter.items.filter((item) => (item.type === "agent" || item.type === "code") && (chapter.stages.length
    ? item.stageIndex !== null && chapter.stages[item.stageIndex] === stage
    : named.test(item.name)));
}

/** The last handoff file a phase wrote as its output: what travelled inline. */
function output(events: StoredEvent[], acked: number, phaseId: string): Doc | null {
  const artifact = phaseView(events, acked, phaseId)?.artifacts
    .filter((each) => each.location === "handoff" && each.role === "output").at(-1);
  return artifact
    ? { path: artifact.path, content: artifact.content, truncated: artifact.truncated, pruned: artifact.pruned !== null }
    : null;
}
