/**
 * A benchmark's sessions as rows (model/benchmarks.ts), kept as their events arrive.
 *
 *   benchmarked  what ingest calls with each batch it folds in of a benchmark's
 *                session: its row, with those events folded onto it — a
 *                scorer's score, which comes once the session has ended,
 *                included. A session with no row yet is folded from its first
 *                event, so one a cockpit stored before it kept these rows gets
 *                its whole row with its next batch.
 */
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { type BenchmarkedRow, benchmarkedIn } from "./model/benchmarks";
import type { Summary } from "./model/session";
import type { StoredEvent } from "./model/wire";
import type { Where } from "./phases";

export async function benchmarked(ctx: MutationCtx, { factory, session }: Where, fresh: StoredEvent[],
                                  all: () => Promise<StoredEvent[]>, summary: Summary): Promise<void> {
  const stored = await ctx.db.query("benchmarked")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session)).unique();
  const row = stored === null ? benchmarkedIn(null, await all(), summary) : benchmarkedIn(rowOf(stored), fresh, summary);
  if (row === null) return;
  if (stored === null) await ctx.db.insert("benchmarked", { factory, session, ...row });
  else await ctx.db.replace(stored._id, { factory, session, ...row });
}

function rowOf({ benchmark, variant, ref, commit, task, repetition, startedAt, endedAt, status, refusal, cost, rejected, rounds, scores }:
  Doc<"benchmarked">): BenchmarkedRow {
  return { benchmark, variant, ref, commit, task, repetition, startedAt, endedAt, status, refusal, cost, rejected, rounds, scores };
}
