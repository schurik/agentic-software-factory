/**
 * A session's scores as rows (model/scores.ts), kept as its events arrive.
 *
 *   score     what ingest calls with each batch it folds in: the rows those
 *             events scored, written over what was there.
 *   backfill  run by `docker/start.sh` and a Vercel production build:
 *             writes the rows of every session an older cockpit stored,
 *             from its first event. A session whose next batch comes first
 *             is written from its first event then.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { type ScoreRow, scoredIn } from "./model/scores";
import type { StoredEvent } from "./model/wire";
import type { Where } from "./phases";

/** How many sessions one turn of the backfill reads the events of. */
const WRITTEN_PER_TURN = 10;

/**
 * Fold `events` into the session's rows. `at` is where the session stands
 * among its factory's — when the cockpit first stored it, the order the
 * Scorers view's strip lists sessions in — so a row is found in that order.
 */
export async function score(ctx: MutationCtx, { factory, session }: Where, events: StoredEvent[], at: number): Promise<void> {
  const stored = await ctx.db.query("scores")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session)).collect();
  for (const row of scoredIn(stored.map(rowOf), events)) {
    const there = stored.find((each) => each.scorer === row.scorer);
    if (there === undefined) await ctx.db.insert("scores", { factory, session, at, ...row });
    else await ctx.db.replace(there._id, { factory, session, at, ...row });
  }
}

function rowOf({ scorer, failing, chapters }: Doc<"scores">): ScoreRow {
  return { scorer, failing, chapters };
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
      .withIndex("by_scored", (q) => q.eq("scored", undefined))
      .take(WRITTEN_PER_TURN);
    for (const record of unwritten) {
      const events = await ctx.db.query("events")
        .withIndex("by_session_seq", (q) => q.eq("factory", record.factory).eq("session", record.session).lte("seq", record.acked))
        .collect();
      await score(ctx, record, events, record._creationTime);
      await ctx.db.patch(record._id, { scored: true });
    }
    if (unwritten.length === WRITTEN_PER_TURN) await ctx.scheduler.runAfter(0, internal.scores.backfill, {});
    return null;
  },
});
