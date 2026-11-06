/**
 * Nudges (ADR 0008): a webhook delivery about a work item, passed on to the
 * stations whose watcher would act on it, so the watcher looks at the forge
 * now instead of at its next interval.
 *
 * A nudge is a hint and never the record. It names an item and a watcher —
 * no session, no verb, no person — so it is not a command: it needs no
 * `cockpit.commands` opt-in and authorizes nothing. The watcher it wakes
 * reads the forge as any pass does, holds the item to its route label and
 * `trusted_authors`, and asks for a claim before touching it, so a station
 * nudged about an item it may not start does nothing, and of two stations
 * nudged about the same item only the one granted the claim starts it.
 *
 * Each hop collapses repeats. The cockpit keeps one row per item and only
 * moves its time forward; a station's loop takes every row newer than its own
 * cursor with each command poll, so the poll is the debounce and nothing here
 * is kept per station; and the watcher keeps a flag, not a queue. A row
 * nobody collected expires with the cron (`expire`), and nothing is lost: the
 * queue is the forge's state, which every watcher's own poll still reads.
 */
import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { repoKey } from "./forge/forge";
import { registeredApp } from "./forge/memory";
import { LIVE_FOR, NUDGE_FOR, type Watched, watchedValidator } from "./model/webhook";

/** How stale the recorded delivery time may get before a delivery writes it again: every poll reads that row. */
const NOTED_EVERY = 60_000;
/** How many expired rows one turn of `expire` deletes; the next minute's turn takes the rest. */
const EXPIRED_PER_TURN = 500;

/**
 * A signed delivery arrived: note when — whatever it was about, it says
 * GitHub reaches this cockpit — and keep the nudge it carries, if any, for a
 * repository the cockpit knows as a factory.
 */
export const heard = internalMutation({
  args: { nudge: v.optional(v.object({ repo: v.string(), number: v.number(), kinds: v.array(watchedValidator) })) },
  returns: v.null(),
  handler: async (ctx, { nudge }) => {
    const now = Date.now();
    const noted = await ctx.db.query("deliveries").first();
    if (noted === null) await ctx.db.insert("deliveries", { at: now });
    else if (now - noted.at >= NOTED_EVERY) await ctx.db.patch(noted._id, { at: now });
    if (nudge === undefined) return null;
    const repo = repoKey(nudge.repo);
    const known = await ctx.db.query("repos").withIndex("by_key", (q) => q.eq("key", repo)).unique();
    if (known === null || !known.factory) return null;
    for (const kind of nudge.kinds) {
      const row = await ctx.db
        .query("nudges")
        .withIndex("by_item", (q) => q.eq("repo", repo).eq("kind", kind).eq("number", nudge.number))
        .unique();
      if (row === null) await ctx.db.insert("nudges", { repo, kind, number: nudge.number, at: now });
      else if (now > row.at) await ctx.db.patch(row._id, { at: now });
    }
    return null;
  },
});

/** Delete the nudges older than `NUDGE_FOR`, collected or not. Run every minute (crons.ts). */
export const expire = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const lapsed = await ctx.db
      .query("nudges")
      .withIndex("by_at", (q) => q.lt("at", Date.now() - NUDGE_FOR))
      .take(EXPIRED_PER_TURN);
    for (const row of lapsed) await ctx.db.delete(row._id);
    return null;
  },
});

/** What one station loop's poll is told: whether nudges are live, its next cursor, and the items since its last. */
export interface Nudged {
  live: boolean;
  after: number;
  items: { kind: Watched; number: number }[];
}

/**
 * The nudges for `factory` newer than the station's cursor `after`, for the
 * watchers it reports running, and the cursor to ask with next. A station
 * that runs none of a nudge's watchers is not told about it.
 */
export async function nudgesFor(ctx: QueryCtx, factory: string, watchers: string[], after: number): Promise<Nudged> {
  const now = Date.now();
  const rows = await ctx.db
    .query("nudges")
    .withIndex("by_repo_at", (q) => q.eq("repo", repoKey(factory)).gt("at", after))
    .collect();
  const running = new Set(watchers);
  return {
    live: await live(ctx, now),
    after: rows.reduce((newest, row) => Math.max(newest, row.at), after),
    items: rows.filter((row) => now - row.at < NUDGE_FOR && running.has(row.kind))
      .map(({ kind, number }) => ({ kind, number })),
  };
}

/** Whether GitHub reaches this cockpit: its App has a webhook secret, and something was delivered lately. */
async function live(ctx: QueryCtx, now: number): Promise<boolean> {
  if ((await registeredApp(ctx))?.webhookSecret == null) return false;
  const noted = await ctx.db.query("deliveries").first();
  return noted !== null && now - noted.at < LIVE_FOR;
}
