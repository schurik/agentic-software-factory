/**
 * The move (#275): an older cockpit stored a session's transcript events with
 * the rest of its events, which made every query of the session page read
 * every transcript body. This cockpit stores them in `transcripts` (schema.ts),
 * and this moves the ones an older cockpit left in `events` there.
 *
 * It goes session by session through the ones an older cockpit stored — those
 * whose record has no `transcribed` yet, which ingest never leaves unset on a
 * session it stores now — a page of one session's events per transaction,
 * each scheduled by the one before, and marks each as it finishes it. So once
 * every session is moved, a run is one index read.
 *
 * `docker/start.sh` runs it after each deploy. When it has nothing left to
 * move it runs the retention backfill (retention.ts), which finds a session's
 * transcript in `transcripts` and so must come after it.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { phaseOf, isTranscript } from "./model/retention";
import { MAX_READ_BYTES } from "./model/wire";

/** How many events one turn reads, at most: a body is read whole, so the bytes are capped too. */
const MOVED_PER_TURN = 500;

const movingValidator = v.object({ factory: v.string(), session: v.string(), cursor: v.union(v.null(), v.string()) });

export const move = internalMutation({
  args: { moving: v.optional(movingValidator) },
  returns: v.null(),
  handler: async (ctx, { moving }) => {
    if (moving === undefined) {
      const next = await ctx.db
        .query("sessions")
        .withIndex("by_transcribed", (q) => q.eq("transcribed", undefined))
        .first();
      if (next === null) await ctx.scheduler.runAfter(0, internal.retention.backfill, {});
      else await ctx.scheduler.runAfter(0, internal.transcripts.move,
                                        { moving: { factory: next.factory, session: next.session, cursor: null } });
      return null;
    }
    const { factory, session, cursor } = moving;
    const page = await ctx.db
      .query("events")
      .withIndex("by_session_seq", (q) => q.eq("factory", factory).eq("session", session))
      .paginate({ numItems: MOVED_PER_TURN, cursor, maximumBytesRead: MAX_READ_BYTES });
    for (const { _id, _creationTime, ...event } of page.page) {
      void _creationTime;
      if (!isTranscript(event.kind)) continue;
      await ctx.db.insert("transcripts", { ...event, phase: phaseOf(event.payload) });
      await ctx.db.delete(_id);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.transcripts.move, { moving: { ...moving, cursor: page.continueCursor } });
      return null;
    }
    const record = await ctx.db
      .query("sessions")
      .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
      .unique();
    const one = await ctx.db
      .query("transcripts")
      .withIndex("by_session_seq", (q) => q.eq("factory", factory).eq("session", session))
      .first();
    if (record !== null) await ctx.db.patch(record._id, { transcribed: one !== null });
    await ctx.scheduler.runAfter(0, internal.transcripts.move, {});
    return null;
  },
});
