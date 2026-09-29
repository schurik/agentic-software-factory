import { v } from "convex/values";
import { query } from "./_generated/server";
import { readSummary, view } from "./model/session";

// No sign-in yet: every factory's sessions are visible to whoever reaches the
// deployment. Forge identity, and the permission filter that comes with it,
// is a later slice of #40 — until then a cockpit is not to be exposed publicly.

/** Every session, most recently active first. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const sessions = await ctx.db.query("sessions").withIndex("by_activity").order("desc").take(200);
    return sessions.map(({ factory, session, acked, summary }) => ({
      factory, session, acked, summary: readSummary(summary),
    }));
  },
});

/** One session's page: its summary, its phases in order and every stored event. */
export const get = query({
  args: { factory: v.string(), session: v.string() },
  handler: async (ctx, { factory, session }) => {
    const record = await ctx.db
      .query("sessions")
      .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
      .unique();
    if (record === null) return null;
    const events = await ctx.db
      .query("events")
      .withIndex("by_session_seq", (q) => q.eq("factory", factory).eq("session", session))
      .collect();
    const page = view(events, record.acked);
    return { factory, session, acked: record.acked, ...page };
  },
});
