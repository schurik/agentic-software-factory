/**
 * A scorer's self-improvement issues as rows (model/improvements.ts), kept as
 * their `improvement_filed` events arrive.
 *
 *   improve   what ingest calls with each batch it folds in: the issues those
 *             events filed, or added evidence to, written over what was there.
 *
 * No backfill: no factory wrote the kind before a cockpit kept these rows.
 */
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { filedIn, foldedVersions, type IssueRow } from "./model/improvements";
import { Payload } from "./model/payload";
import type { StoredEvent } from "./model/wire";
import type { Where } from "./phases";

/** Fold `events` into the factory's issue rows. */
export async function improve(ctx: MutationCtx, { factory }: Where, events: StoredEvent[]): Promise<void> {
  const told = events.filter((event) => foldedVersions(event.kind).includes(event.v));
  if (!told.length) return;
  const stored: Doc<"improvements">[] = [];
  for (const scorer of new Set(told.map((event) => Payload.parse(event.payload).str("scorer")))) {
    stored.push(...await ctx.db.query("improvements").withIndex("by_factory_scorer", (q) => q.eq("factory", factory).eq("scorer", scorer)).collect());
  }
  for (const row of filedIn(stored.map(rowOf), told, Date.now())) {
    const there = stored.find((each) => each.scorer === row.scorer && each.number === row.number);
    if (there === undefined) await ctx.db.insert("improvements", { factory, ...row });
    else await ctx.db.replace(there._id, { factory, ...row });
  }
}

function rowOf({ scorer, number, url, title, cause, surface, notDiagnosed, at }: Doc<"improvements">): IssueRow {
  return { scorer, number, url, title, cause, surface, notDiagnosed, at };
}
