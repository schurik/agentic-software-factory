/**
 * A session's chapters as rows (model/chapters.ts), kept as its events arrive.
 *
 *   chapter   what ingest calls with each batch it folds in: a row for each
 *             chapter those events started that has none yet.
 *   backfill  run by `docker/start.sh` and a Vercel production build:
 *             writes the rows of every session an older cockpit stored,
 *             from its first event. A session whose next batch comes first
 *             is written from its first event then.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { chaptersIn } from "./model/chapters";
import type { StoredEvent } from "./model/wire";
import type { Where } from "./phases";

/** How many sessions one turn of the backfill reads the events of. */
const WRITTEN_PER_TURN = 10;

/** Write a row for each chapter `events` started that the session has none for. */
export async function chapter(ctx: MutationCtx, { factory, session }: Where, events: StoredEvent[]): Promise<void> {
  for (const row of chaptersIn(events, Date.now())) {
    const there = await ctx.db.query("chapters")
      .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session).eq("chapter", row.chapter)).unique();
    if (there === null) await ctx.db.insert("chapters", { factory, session, ...row });
  }
}

/**
 * Write the rows of the sessions an older cockpit stored, from their first
 * event. `docker/start.sh` and a Vercel production build run it once after
 * each deploy; a turn that wrote a full batch schedules the next, and a
 * deployment with none left does nothing.
 */
export const backfill = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const unwritten = await ctx.db.query("sessions")
      .withIndex("by_chaptered", (q) => q.eq("chaptered", undefined))
      .take(WRITTEN_PER_TURN);
    for (const record of unwritten) {
      const events = await ctx.db.query("events")
        .withIndex("by_session_seq", (q) => q.eq("factory", record.factory).eq("session", record.session).lte("seq", record.acked))
        .collect();
      await chapter(ctx, record, events);
      await ctx.db.patch(record._id, { chaptered: true });
    }
    if (unwritten.length === WRITTEN_PER_TURN) await ctx.scheduler.runAfter(0, internal.chapters.backfill, {});
    return null;
  },
});
