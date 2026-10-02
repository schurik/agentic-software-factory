import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { find, type Limits, STATUSES } from "./model/filter";
import { periodValidator } from "./model/period";
import type { StoredEvent } from "./model/wire";
import { roleOf } from "./commands";
import { defaultCheck, repoOf } from "./factory";
import { forgeWeb } from "./forge/memory";
import { readDescription } from "./model/description";
import { phaseView, readSummary, view } from "./model/session";
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
});

/**
 * The sessions the viewer may see, most recently active first, that `filter`
 * keeps (model/filter.ts): of one factory — its Sessions tab — or, without
 * one, of every factory they can read. Null for someone who has not signed
 * in to a team's cockpit, and for a factory they cannot read.
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
    return {
      ...found,
      sessions: found.sessions.map(({ factory: from, session, acked, summary }) => ({ factory: from, session, acked, summary })),
    };
  },
});

/** Each stored session with its summary read: what finding one goes by. */
async function* withSummaries(records: AsyncIterable<Doc<"sessions">>) {
  for await (const record of records) yield { ...record, summary: readSummary(record.summary) };
}

/**
 * One session's page: its summary, its phases in order and every stored
 * event, and the per-session budget its spend is shown against — the one the
 * factory's own `asf check` on its default branch last said factory.yaml
 * sets, null when none reached the cockpit.
 */
export const get = query({
  args: { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, signIn }) => {
    const stored = await storedSession(ctx, factory, session, signIn);
    if (stored === null) return null;
    const page = view(stored.events, stored.acked);
    const check = await defaultCheck(ctx, stored.factory, (await repoOf(ctx, stored.factory))?.defaultBranch || null);
    const budget = check && readDescription(check.description).budget;
    // Whether the viewer may purge its bodies (retention.ts): an admin of its repository.
    const mayPurge = (await roleOf(ctx, await viewing(ctx, signIn), stored.factory)) === "admin";
    return { factory: stored.factory, session, acked: stored.acked, forge: await forgeWeb(ctx), budget, mayPurge, ...page };
  },
});

/**
 * One phase of that page, opened into its tabs. Asked for when a person opens
 * the phase, not with the page: it carries the phase's artifacts and its
 * transcript, which the page as a whole has no use for.
 */
export const phase = query({
  args: { factory: v.string(), session: v.string(), phaseId: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, phaseId, signIn }) => {
    const stored = await storedSession(ctx, factory, session, signIn);
    return stored && phaseView(stored.events, stored.acked, phaseId);
  },
});

/**
 * A session's events and how far they were acknowledged, and the factory as
 * they are stored under it — or null when the viewer may not see it.
 */
export async function storedSession(ctx: QueryCtx, named: string, session: string, signIn?: string):
    Promise<{ factory: string; acked: number; events: StoredEvent[] } | null> {
  // A session the viewer may not see and one that does not exist answer alike.
  const factory = await readable(ctx, await viewing(ctx, signIn), named);
  if (factory === null) return null;
  const record = await ctx.db
    .query("sessions")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
    .unique();
  if (record === null) return null;
  const events = await ctx.db
    .query("events")
    .withIndex("by_session_seq", (q) => q.eq("factory", factory).eq("session", session))
    .collect();
  return { factory, acked: record.acked, events };
}
