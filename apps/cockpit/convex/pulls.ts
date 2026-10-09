/**
 * A session's pull request as a row (model/pulls.ts), kept as its events arrive.
 *
 *   pull   what ingest calls with each batch it folds in: the session's row,
 *          moved on by those events and written over what was there.
 */
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { pulledIn, type PullRow } from "./model/pulls";
import type { StoredEvent } from "./model/wire";
import type { Where } from "./phases";

/**
 * Fold `events` into the session's row. A session with no row yet — new, or
 * stored before the cockpit kept these rows — and a row an older cockpit
 * wrote, before it kept what a pull request took, are folded from the
 * session's every event (`all`) instead: what came before is not nothing.
 */
export async function pull(ctx: MutationCtx, { factory, session }: Where, events: StoredEvent[],
                           all: () => Promise<StoredEvent[]>): Promise<void> {
  const stored = await ctx.db.query("pulls")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session)).unique();
  const whole = stored === null || stored.spent === undefined;
  const row = whole ? pulledIn(null, await all()) : pulledIn(rowOf(stored), events);
  if (row === null) return;
  if (stored === null) await ctx.db.insert("pulls", { factory, session, ...row });
  else await ctx.db.replace(stored._id, { factory, session, ...row });
}

/** A stored row as the fold takes it: without the document's own fields, or whose session it is. */
function rowOf(stored: Doc<"pulls">): PullRow {
  const row: Partial<Doc<"pulls">> = { ...stored };
  for (const key of ["_id", "_creationTime", "factory", "session"] as const) delete row[key];
  return row as PullRow;
}
