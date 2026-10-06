/**
 * A session's phases as rows (model/phases.ts), kept as its events arrive.
 *
 *   phase     what ingest calls with each batch it folds in: the rows those
 *             events started or changed, written over what was there.
 *   backfill  run by `docker/start.sh`: writes the rows of every session an
 *             older cockpit stored, from its first event. A session whose
 *             next batch comes first is written from its first event then.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { type PhaseRow, phasedIn } from "./model/phases";
import { EMPTY_SUMMARY, type Summary } from "./model/session";
import type { StoredEvent } from "./model/wire";

/** How many sessions one turn of the backfill reads the events of. */
const WRITTEN_PER_TURN = 10;

/** One session of one factory. */
export interface Where {
  factory: string;
  session: string;
}

/**
 * Fold `events` into the session's rows: onto the ones there, the session
 * folded up to `before` as they start — or, `before` null, as its first
 * events, onto nothing.
 */
export async function phase(ctx: MutationCtx, { factory, session }: Where, events: StoredEvent[], before: Summary | null): Promise<void> {
  const stored = await ctx.db.query("phases")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session)).collect();
  const rows = before === null ? [] : stored.map(rowOf);
  for (const row of phasedIn(rows, events, before ?? EMPTY_SUMMARY, Date.now())) {
    const there = stored.find((each) => each.phase === row.phase);
    if (there === undefined) await ctx.db.insert("phases", { factory, session, ...row });
    else await ctx.db.replace(there._id, { factory, session, ...row });
  }
}

/** A stored row as the fold takes it: without the document's own fields, or whose session it is. */
function rowOf(stored: Doc<"phases">): PhaseRow {
  const row: Partial<Doc<"phases">> = { ...stored };
  for (const key of ["_id", "_creationTime", "factory", "session"] as const) delete row[key];
  return row as PhaseRow;
}

/**
 * Write the rows of the sessions an older cockpit stored, from their first
 * event. `docker/start.sh` runs it once after each deploy; a turn that wrote a
 * full batch schedules the next, and a deployment with none left does nothing.
 */
export const backfill = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const unwritten = await ctx.db.query("sessions")
      .withIndex("by_phased", (q) => q.eq("phased", undefined))
      .take(WRITTEN_PER_TURN);
    for (const record of unwritten) {
      const events = await ctx.db.query("events")
        .withIndex("by_session_seq", (q) => q.eq("factory", record.factory).eq("session", record.session).lte("seq", record.acked))
        .collect();
      await phase(ctx, record, events, null);
      await ctx.db.patch(record._id, { phased: true });
    }
    if (unwritten.length === WRITTEN_PER_TURN) await ctx.scheduler.runAfter(0, internal.phases.backfill, {});
    return null;
  },
});
