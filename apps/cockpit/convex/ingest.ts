import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { advance, readSummary } from "./model/session";
import { storedEventFields } from "./model/wire";

/**
 * Store a batch for the factory whose token digests to `digest`, and return the
 * session's acknowledged seq — or null when no factory holds that token.
 *
 * Idempotent by (factory, session, seq): a seq already stored is skipped, never
 * overwritten, because a seq means one line forever (engine/events.py). So a
 * station that lost the answer just sends the same batch again.
 */
export const append = internalMutation({
  args: { digest: v.string(), session: v.string(), events: v.array(v.object(storedEventFields)) },
  returns: v.union(v.null(), v.object({ acked: v.number() })),
  handler: async (ctx, { digest, session, events }) => {
    const token = await ctx.db
      .query("ingestTokens")
      .withIndex("by_digest", (q) => q.eq("digest", digest))
      .unique();
    if (token === null) return null;
    const { factory } = token;

    const stored = (seq: number) =>
      ctx.db
        .query("events")
        .withIndex("by_session_seq", (q) =>
          q.eq("factory", factory).eq("session", session).eq("seq", seq))
        .unique();

    for (const event of events) {
      if ((await stored(event.seq)) === null) {
        await ctx.db.insert("events", { factory, session, ...event });
      }
    }

    const record = await ctx.db
      .query("sessions")
      .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
      .unique();
    const before = record?.acked ?? 0;
    let acked = before;
    while ((await stored(acked + 1)) !== null) acked += 1;
    if (record !== null && acked === before) return { acked };

    // Fold in only what just became contiguous, so the list never shows a
    // session past a gap a replay is about to fill.
    const fresh = await ctx.db
      .query("events")
      .withIndex("by_session_seq", (q) =>
        q.eq("factory", factory).eq("session", session).gt("seq", before).lte("seq", acked))
      .collect();
    const summary = advance(readSummary(record?.summary), fresh);
    const activity = Date.now();
    if (record === null) await ctx.db.insert("sessions", { factory, session, acked, summary, activity });
    else await ctx.db.patch(record._id, { acked, summary, activity });
    return { acked };
  },
});
