import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { settleClaims } from "./claims";
import { settle } from "./commands";
import { retained } from "./model/retention";
import { advance, readSummary } from "./model/session";
import { spentIn } from "./model/spend";
import { storedEventFields } from "./model/wire";
import { tokenBy } from "./tokens";

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
    const token = await tokenBy(ctx, digest);
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
    const folded = readSummary(record?.summary);
    const summary = advance(folded, fresh);
    // A station's `command_result` is what settles a command, never its sending.
    await settle(ctx, factory, fresh);
    // ...and its finish, or an abort, what frees the claim it was started under.
    await settleClaims(ctx, factory, session, fresh);
    const activity = Date.now();
    for (const spent of spentIn(fresh, folded, activity)) {
      const buckets = await ctx.db
        .query("spend")
        .withIndex("by_session_at", (q) => q.eq("factory", factory).eq("session", session).eq("at", spent.at))
        .collect();
      const bucket = buckets.find((row) => row.workflow === spent.workflow && row.station === spent.station &&
                                           row.stationName === spent.stationName && row.person === spent.person) ?? null;
      if (bucket === null) await ctx.db.insert("spend", { factory, session, ...spent });
      else await ctx.db.patch(bucket._id, { cost: bucket.cost + spent.cost, tokens: bucket.tokens + spent.tokens });
    }
    const waiting = summary.waitingFor !== null;
    // Whether it holds a transcript, and from when that ages out (retention.ts).
    const transcript = retained(record === null ? false : record.transcripts, fresh, summary);
    if (record === null) await ctx.db.insert("sessions", { factory, session, acked, summary, activity, waiting, ...transcript });
    else await ctx.db.patch(record._id, { acked, summary, activity, waiting, ...transcript });
    return { acked };
  },
});
