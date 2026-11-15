/**
 * The move (#275): an older cockpit stored a session's transcript events with
 * the rest of its events, which made every query of the session page read
 * every transcript body. This cockpit stores them in `transcripts` (schema.ts),
 * and this moves the ones an older cockpit left in `events` there, marking
 * each session it moves one of as `transcribed`.
 *
 * `docker/start.sh` runs it after each deploy. Once moved, there is nothing
 * left to move, and a run is one page read. It then runs the retention
 * backfill (retention.ts), which finds a session's transcript in `transcripts`
 * and so must come after it.
 *
 * `events` has no index by kind, so this reads the whole table once, a page
 * per transaction, each scheduled by the one before.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { Payload } from "./model/payload";
import { isTranscript } from "./model/retention";

/** How many events one turn reads, and at most how many bytes: under the 16 MiB a transaction may read. */
const MOVED_PER_TURN = 500;
const MOVED_BYTES_PER_TURN = 8_000_000;

export const move = internalMutation({
  args: { cursor: v.optional(v.union(v.null(), v.string())) },
  returns: v.null(),
  handler: async (ctx, { cursor = null }) => {
    const page = await ctx.db.query("events")
      .paginate({ numItems: MOVED_PER_TURN, cursor, maximumBytesRead: MOVED_BYTES_PER_TURN });
    const marked = new Set<string>();
    for (const event of page.page) {
      if (!isTranscript(event.kind)) continue;
      const { _id, _creationTime, ...stored } = event;
      void _creationTime;
      await ctx.db.insert("transcripts", { ...stored, phase: Payload.parse(stored.payload).str("phase_id") });
      await ctx.db.delete(_id);
      const key = JSON.stringify([stored.factory, stored.session]);
      if (marked.has(key)) continue;
      marked.add(key);
      const record = await ctx.db
        .query("sessions")
        .withIndex("by_session", (q) => q.eq("factory", stored.factory).eq("session", stored.session))
        .unique();
      if (record !== null && record.transcribed !== true) await ctx.db.patch(record._id, { transcribed: true });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.transcripts.move, { cursor: page.continueCursor });
    else await ctx.scheduler.runAfter(0, internal.retention.backfill, {});
    return null;
  },
});
