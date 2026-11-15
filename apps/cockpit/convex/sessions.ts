import { type ObjectType, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { find, type Limits, STATUSES } from "./model/filter";
import { periodValidator } from "./model/period";
import type { StoredEvent } from "./model/wire";
import { roleOf } from "./commands";
import { defaultCheck, repoOf } from "./factory";
import { readableFactories } from "./factories";
import { forgeWeb } from "./forge/memory";
import { statesOf } from "./items";
import { readDescription } from "./model/description";
import { miniOf } from "./model/graph";
import { outputOf, promptsOf } from "./model/phase";
import { phaseTools as toolsOf, phaseView, readSummary, type Recorded, rowsOf, view } from "./model/session";
import { phaseType } from "./model/story";
import { canRead, readable, viewing } from "./viewer";

// Who sees a session is the forge's call, not the cockpit's: in a team
// cockpit, whoever the forge lets read its factory's repository
// (`viewer.canRead`); in a local one, the one person whose machine it is.

/** How many sessions the list shows, and how many stored ones it reads to find them. */
const LIMITS: Limits = { shown: 200, read: 2000 };

const filterValidator = v.object({
  workflow: v.optional(v.string()),
  person: v.optional(v.string()),
  station: v.optional(v.string()),
  status: v.optional(v.union(...STATUSES.map((status) => v.literal(status)))),
  period: v.optional(periodValidator),
  search: v.optional(v.string()),
});

/**
 * The sessions the viewer may see, most recently active first, that `filter`
 * keeps (model/filter.ts): of one factory — its Sessions tab — or, without
 * one, of every factory they can read. With them, every factory they can
 * read, by name, for the page to narrow to. Null for someone who has not
 * signed in to a team's cockpit, and for a factory they cannot read.
 */
export const list = query({
  args: { signIn: v.optional(v.string()), factory: v.optional(v.string()), filter: v.optional(filterValidator) },
  handler: async (ctx, { signIn, factory: named, filter = {} }) => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return null;
    const factory = named === undefined ? null : await readable(ctx, who, named);
    if (named !== undefined && factory === null) return null;
    const records = factory === null
      ? ctx.db.query("sessions").withIndex("by_activity").order("desc")
      : ctx.db.query("sessions").withIndex("by_factory_activity", (q) => q.eq("factory", factory)).order("desc");
    const readability = new Map<string, boolean>();
    const canSee = async (each: string) => {
      if (!readability.has(each)) readability.set(each, await canRead(ctx, who, each));
      return readability.get(each)!;
    };
    const found = await find(withSummaries(records), canSee, filter, LIMITS);
    // As their stations spell them: what the sessions are stored under, and what the page links to.
    const factories = (await readableFactories(ctx, who, true)).map(({ names: [name] }) => name);
    return {
      ...found,
      factories,
      sessions: await Promise.all(found.sessions.map(async ({ factory: from, session, acked, summary }) => ({
        factory: from, session, acked, summary, states: await statesOf(ctx, from, summary),
      }))),
    };
  },
});

/** Each stored session with its summary read: what finding one goes by. */
async function* withSummaries(records: AsyncIterable<Doc<"sessions">>) {
  for await (const record of records) yield { ...record, summary: readSummary(record.summary) };
}

/**
 * One session's page: its summary, its phases in order, the events it cannot
 * read, and the per-session budget its spend is shown against — the one the
 * factory's own `asf check` on its default branch last said factory.yaml
 * sets, null when none reached the cockpit. It reads no transcript (#275):
 * those are a phase's tabs' own queries, below.
 */
export const get = query({
  args: { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, signIn }) => {
    const stored = await storedSession(ctx, factory, session, signIn);
    if (stored === null) return null;
    const page = view(stored.events, stored.acked, stored.recorded);
    const check = await defaultCheck(ctx, stored.factory, (await repoOf(ctx, stored.factory))?.defaultBranch || null);
    const budget = check && readDescription(check.description).budget;
    // Whether the viewer may purge its bodies (retention.ts): an admin of its repository.
    const mayPurge = (await roleOf(ctx, await viewing(ctx, signIn), stored.factory)) === "admin";
    const states = await statesOf(ctx, stored.factory, page.summary);
    return { factory: stored.factory, session, acked: stored.acked, forge: await forgeWeb(ctx), budget, mayPurge, states, ...page };
  },
});

const phaseArgs = { factory: v.string(), session: v.string(), phaseId: v.string(), signIn: v.optional(v.string()) };

/**
 * One phase of that page, opened into its tabs. Asked for when a person opens
 * the phase, not with the page: it carries the phase's artifacts, which the
 * page as a whole has no use for. What its Tools, Events, Agent prompt and
 * Harness output tabs show is each a query of its own, asked for when that tab
 * is: a phase is opened to look at one thing, not all of them.
 */
export const phase = query({
  args: phaseArgs,
  handler: async (ctx, { factory, session, phaseId, signIn }) => {
    const stored = await storedSession(ctx, factory, session, signIn);
    const detail = stored && phaseView(stored.events, stored.acked, phaseId);
    return detail && { ...detail, transcripts: stored!.recorded.transcribed };
  },
});

/** A phase's Tools tab: the tool calls it made. Null for a session the viewer may not see. */
export const phaseTools = query({
  args: phaseArgs,
  handler: async (ctx, { factory, session, phaseId, signIn }) => {
    const stored = await storedSession(ctx, factory, session, signIn);
    return stored && toolsOf(stored.events, stored.acked, phaseId);
  },
});

/**
 * A session's events as rows, in seq order — or, with a phase, that phase's
 * Events tab. Its transcript is not among them: that is the transcript tabs'.
 * Null for a session the viewer may not see.
 */
export const events = query({
  args: { factory: v.string(), session: v.string(), phaseId: v.optional(v.string()), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, phaseId, signIn }) => {
    const stored = await storedSession(ctx, factory, session, signIn);
    return stored && rowsOf(stored.events, phaseId);
  },
});

/**
 * A phase's Agent prompt tab: the prompts it sent, read off that phase's own
 * `prompt_rendered` events — one index range of `transcripts`, and nothing else
 * of the session. Null for a session the viewer may not see.
 */
export const prompts = query({
  args: phaseArgs,
  handler: async (ctx, args) => {
    const events = await transcriptOf(ctx, args, "prompt_rendered");
    return events && promptsOf(events);
  },
});

/** A phase's Harness output tab, the same way: off its own `harness_output` events alone. */
export const output = query({
  args: phaseArgs,
  handler: async (ctx, args) => {
    const events = await transcriptOf(ctx, args, "harness_output");
    return events && outputOf(events);
  },
});

/** One phase's transcript events of `kind` up to what was acknowledged, or null when the viewer may not see the session. */
async function transcriptOf(ctx: QueryCtx, { factory: named, session, phaseId, signIn }: ObjectType<typeof phaseArgs>,
                            kind: string): Promise<StoredEvent[] | null> {
  const found = await sessionRecord(ctx, named, session, signIn);
  if (found === null) return null;
  return await ctx.db
    .query("transcripts")
    .withIndex("by_phase", (q) => q.eq("factory", found.factory).eq("session", session).eq("phase", phaseId)
      .eq("kind", kind).lte("seq", found.record.acked))
    .collect();
}

/**
 * Where a session is now, for a list's row (Now's Running): the chapter it is
 * in as a mini graph, the stage it is in — null in a chapter drawn without
 * stages — and the phase running, since when. Null for a session the viewer
 * may not see. A query of its own per row, so one session's long record
 * weighs on its own row and nothing else.
 */
export const progress = query({
  args: { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, signIn }) => {
    const stored = await storedSession(ctx, factory, session, signIn);
    if (stored === null) return null;
    const { story } = view(stored.events, stored.acked);
    const here = story.chapters.find((chapter) => chapter.graph.current !== null) ?? story.chapters.at(-1);
    const graph = here?.graph ?? null;
    const phase = story.now.phase;
    return {
      mini: graph ? miniOf(graph) : { blocks: [], current: null },
      stage: graph?.kind === "stages" && graph.current !== null ? graph.stages[graph.current].name : null,
      phase: phase && { name: phase.name, type: phaseType(phase.kind), since: phase.since },
    };
  },
});

/**
 * A session's events and how far they were acknowledged, what its record says
 * of them (`Recorded`), and the factory as they are stored under it — or null
 * when the viewer may not see it. Its transcript is not among the events: those
 * are stored apart (schema.ts), so no query that starts here reads one.
 */
export async function storedSession(ctx: QueryCtx, named: string, session: string, signIn?: string):
    Promise<{ factory: string; acked: number; events: StoredEvent[]; recorded: Recorded } | null> {
  const found = await sessionRecord(ctx, named, session, signIn);
  if (found === null) return null;
  const { factory, record } = found;
  const events = await ctx.db
    .query("events")
    .withIndex("by_session_seq", (q) => q.eq("factory", factory).eq("session", session))
    .collect();
  return { factory, acked: record.acked, events,
           recorded: { summary: readSummary(record.summary), transcribed: record.transcribed === true } };
}

/** A session's record and the factory it is stored under, or null when the viewer may not see it. */
async function sessionRecord(ctx: QueryCtx, named: string, session: string, signIn?: string):
    Promise<{ factory: string; record: Doc<"sessions"> } | null> {
  // A session the viewer may not see and one that does not exist answer alike.
  const factory = await readable(ctx, await viewing(ctx, signIn), named);
  if (factory === null) return null;
  const record = await ctx.db
    .query("sessions")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
    .unique();
  return record && { factory, record };
}
