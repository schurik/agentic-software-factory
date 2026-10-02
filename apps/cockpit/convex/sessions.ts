import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { StoredEvent } from "./model/wire";
import { defaultCheck, repoOf } from "./factory";
import { forgeWeb } from "./forge/memory";
import { readDescription } from "./model/description";
import { phaseView, readSummary, view } from "./model/session";
import { canRead, readable, viewing } from "./viewer";

// Who sees a session is the forge's call, not the cockpit's: in a team
// cockpit, whoever the forge lets read its factory's repository
// (`viewer.canRead`); in a local one, the one person whose machine it is.

/** How many sessions the list shows, and how far back it looks for them. */
const SHOWN = 200;
const SCANNED = 2000;

/** The sessions the viewer may see, most recently active first. */
export const list = query({
  args: { signIn: v.optional(v.string()) },
  handler: async (ctx, { signIn }) => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return [];
    const readable = new Map<string, boolean>();
    const shown = [];
    let scanned = 0;
    for await (const record of ctx.db.query("sessions").withIndex("by_activity").order("desc")) {
      if (shown.length === SHOWN || (scanned += 1) > SCANNED) break;
      if (!readable.has(record.factory)) readable.set(record.factory, await canRead(ctx, who, record.factory));
      if (!readable.get(record.factory)) continue;
      const { factory, session, acked, summary } = record;
      shown.push({ factory, session, acked, summary: readSummary(summary) });
    }
    return shown;
  },
});

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
    return { factory: stored.factory, session, acked: stored.acked, forge: await forgeWeb(ctx), budget, ...page };
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
