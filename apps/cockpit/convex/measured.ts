/**
 * What measuring cost, as rows (model/measured.ts), kept as events arrive.
 *
 *   measured  what ingest calls with each batch it folds in: a row for each
 *             judgement those events say was paid for, and — of a benchmark's
 *             session — for each agent call. A batch's events become
 *             contiguous once, so each is written once. A judge's score an
 *             older cockpit stored is not counted: none was paid for before
 *             a cockpit could count it (`chapter_scored` v2, #192).
 */
import type { MutationCtx } from "./_generated/server";
import { measuredIn } from "./model/measured";
import type { StoredEvent } from "./model/wire";
import type { Where } from "./phases";

export async function measured(ctx: MutationCtx, { factory, session }: Where, events: StoredEvent[], at: number,
                               benchmark: boolean): Promise<void> {
  for (const row of measuredIn(events, at, benchmark)) await ctx.db.insert("measured", { factory, session, ...row });
}
