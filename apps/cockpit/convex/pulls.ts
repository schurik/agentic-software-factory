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
 * Fold `events` into the session's row. A session the cockpit stored before it
 * kept these rows has none when its pull request closes, so its commits are
 * read off its events once then — `all` — rather than taken as never made.
 */
export async function pull(ctx: MutationCtx, { factory, session }: Where, events: StoredEvent[],
                           all: () => Promise<StoredEvent[]>): Promise<void> {
  const stored = await ctx.db.query("pulls")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session)).unique();
  const closes = events.some((event) => event.kind === "pull_request_closed");
  const row = stored === null && closes ? pulledIn(null, await all()) : pulledIn(stored && rowOf(stored), events);
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
