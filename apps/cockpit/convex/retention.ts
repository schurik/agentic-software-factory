/**
 * Retention (#63): transcripts age out, bodies can be purged, and every view
 * but the Transcript tab rebuilds from what is left (model/retention.ts says
 * what each weight of event is, and what pruning one does).
 *
 *   ageOut       the cron: every session whose transcript is due, pruned.
 *   backfill     run by `docker/start.sh`: finds the transcripts of sessions an
 *                older cockpit stored, and re-dates every one still held by
 *                the deployment's retention as it is now.
 *   purgeSession every body of one session — handoff and transcript alike —
 *                purged, by an admin of its repository (the forge's word,
 *                mirrored); its core events stay, so cost history holds.
 *   purgeFactory every body of every session of a factory, by an owner of the
 *                account its repository belongs to, asked of the forge as the
 *                person — or from the deployment's CLI, with no forge at all:
 *
 *       docker compose exec app ./convex.sh run retention:purgeFactoryFromDeployment \
 *         '{"factory": "acme/widgets", "reason": "the repository was deleted"}'
 *
 * Every purge writes an audit line (`purges`): who, what, when and why. And
 * nothing is purged on its own — not when a repository goes, not when the App
 * is uninstalled: a purge is always somebody's decision.
 *
 * Pruning happens in `sweep`, a page of events at a time, each page its own
 * transaction scheduled by the one before: a factory's whole history does not
 * fit in one.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, type MutationCtx, query } from "./_generated/server";
import { roleOf } from "./commands";
import { ForgeError } from "./forge/github";
import { forgeSaid, open, UNREADABLE } from "./forge/open";
import { agesOutAt, prune, retained, weightOf, type Pruned } from "./model/retention";
import { readSummary } from "./model/session";
import { spellingsOf, storedAs } from "./spelling";
import { actAs, readable, viewing, type Viewing } from "./viewer";

/** How many events one turn of a sweep reads: a body is at most 900 KB, and a turn reads them whole. */
const SWEPT_PER_TURN = 64;
/** How many due sessions one run of the cron starts sweeping. */
const DUE_PER_RUN = 50;
/** How many sessions one turn of the backfill looks through the events of. */
const FOUND_PER_TURN = 10;
/** How many held transcripts one turn of the backfill re-dates. */
const DATED_PER_TURN = 200;

const prunedValidator = v.object({
  on: v.string(),
  reason: v.union(v.literal("aged_out"), v.literal("purged")),
  by: v.string(),
});

/**
 * Every session whose transcript is due, swept. The due time was dated when
 * the session finished, under the retention as it was then; it is dated again
 * here, so a deployment that raised its maximum since keeps what it now allows.
 */
export const ageOut = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("sessions")
      // From 0: an unset due date sorts below every number, and a session
      // that holds no transcript, or still runs, must not fill the take.
      .withIndex("by_transcripts_due", (q) => q.gte("transcriptsDue", 0).lte("transcriptsDue", now))
      .take(DUE_PER_RUN);
    for (const record of due) {
      const dated = agesOutAt(readSummary(record.summary));
      if (dated === null || dated > now) {
        await ctx.db.patch(record._id, { transcriptsDue: dated ?? undefined });
        continue;
      }
      const pruned: Pruned = { on: new Date(now).toISOString(), reason: "aged_out", by: "" };
      await ctx.scheduler.runAfter(0, internal.retention.sweep,
                                  { factory: record.factory, session: record.session, pruned, cursor: null });
    }
    return null;
  },
});

/**
 * Prune one page of events — of one session, or of a whole factory when no
 * session is named — and schedule the next. An age-out prunes transcript
 * bodies only, and stops if the session stopped being due meanwhile (a resume
 * re-opened it); a purge prunes every body. Pruning is idempotent: an event
 * pruned before is left as it is.
 */
export const sweep = internalMutation({
  args: { factory: v.string(), session: v.optional(v.string()), pruned: prunedValidator,
          cursor: v.union(v.null(), v.string()) },
  returns: v.null(),
  handler: async (ctx, { factory, session, pruned, cursor }) => {
    const ageing = pruned.reason === "aged_out";
    const record = session === undefined ? null : await sessionRecord(ctx, factory, session);
    if (ageing && (record === null || record.transcriptsDue === undefined || record.transcriptsDue > Date.now())) return null;
    const events = session === undefined
      ? ctx.db.query("events").withIndex("by_session_seq", (q) => q.eq("factory", factory))
      : ctx.db.query("events").withIndex("by_session_seq", (q) => q.eq("factory", factory).eq("session", session));
    const page = await events.paginate({ numItems: SWEPT_PER_TURN, cursor });
    for (const event of page.page) {
      if (ageing && weightOf(event.kind) !== "transcript") continue;
      const payload = prune(event.kind, event.payload, pruned);
      if (payload !== null) await ctx.db.patch(event._id, { payload });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.retention.sweep, { factory, session, pruned, cursor: page.continueCursor });
    } else if (record !== null) {
      // Its transcript is gone, so there is nothing left to age out.
      await ctx.db.patch(record._id, { transcripts: false, transcriptsDue: undefined });
    }
    return null;
  },
});

/**
 * Find the transcripts of the sessions an older cockpit stored, then re-date
 * every transcript still held. `docker/start.sh` runs it after each deploy —
 * which is also when a changed `COCKPIT_TRANSCRIPT_DAYS` takes effect.
 */
export const backfill = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const unknown = await ctx.db
      .query("sessions")
      .withIndex("by_transcripts", (q) => q.eq("transcripts", undefined))
      .take(FOUND_PER_TURN);
    for (const record of unknown) {
      const events = await ctx.db
        .query("events")
        .withIndex("by_session_seq", (q) => q.eq("factory", record.factory).eq("session", record.session))
        .collect();
      await ctx.db.patch(record._id, retained(false, events, readSummary(record.summary)));
    }
    if (unknown.length === FOUND_PER_TURN) await ctx.scheduler.runAfter(0, internal.retention.backfill, {});
    else await ctx.scheduler.runAfter(0, internal.retention.redate, { cursor: null });
    return null;
  },
});

/** Date every held transcript again, under the retention as it is now. */
export const redate = internalMutation({
  args: { cursor: v.union(v.null(), v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("sessions")
      .withIndex("by_transcripts", (q) => q.eq("transcripts", true))
      .paginate({ numItems: DATED_PER_TURN, cursor });
    for (const record of page.page) {
      const due = agesOutAt(readSummary(record.summary)) ?? undefined;
      if (due !== record.transcriptsDue) await ctx.db.patch(record._id, { transcriptsDue: due });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.retention.redate, { cursor: page.continueCursor });
    return null;
  },
});

async function sessionRecord(ctx: MutationCtx, factory: string, session: string) {
  return await ctx.db
    .query("sessions")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
    .unique();
}

// ── purges ───────────────────────────────────────────────────────────────────

export type Purged = { ok: true } | { ok: false; because: string };

const UNSEEN = "no such session among the ones you can see";

/** Why `reason` will not do, or null when it says why. */
function unexplained(reason: string): string | null {
  return reason.trim() ? null : "say why: the reason is kept with the purge";
}

/** Why `who` cannot purge anything — nobody to name in the audit line — or null when they can. */
function nameless(who: Viewing): string | null {
  if (who.viewer !== null) return null;
  return who.mode === "team" ? "sign in to purge"
    : "this cockpit holds no forge token to say who purged: `gh auth login`, then `asf up` again";
}

/** A purge as its audit line records it, before it is dated. */
type Purge = Omit<Doc<"purges">, "_id" | "_creationTime" | "at">;

/**
 * Write the audit line, then sweep: one session's events, or — with no
 * session named — every event of the factory, under every spelling it was
 * ever stored by.
 */
async function purge(ctx: MutationCtx, { factory, session, by, via, reason }: Purge): Promise<void> {
  const at = Date.now();
  await ctx.db.insert("purges", { factory, session, by, via, reason: reason.trim(), at });
  const pruned: Pruned = { on: new Date(at).toISOString(), reason: "purged", by };
  if (session) {
    await ctx.scheduler.runAfter(0, internal.retention.sweep, { factory, session, pruned, cursor: null });
    return;
  }
  for (const spelling of await spellingsOf(ctx, factory)) {
    await ctx.scheduler.runAfter(0, internal.retention.sweep, { factory: spelling, pruned, cursor: null });
  }
}

/**
 * Purge every body of one session — say, a secret that leaked into an
 * artifact — as an admin of its repository. A local cockpit's one person
 * holds all of it already, and may.
 */
export const purgeSession = mutation({
  args: { factory: v.string(), session: v.string(), reason: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, session, reason, signIn }): Promise<Purged> => {
    const who = await viewing(ctx, signIn);
    const anonymous = nameless(who);
    if (anonymous !== null) return { ok: false, because: anonymous };
    const factory = await readable(ctx, who, named);
    if (factory === null || (await sessionRecord(ctx, factory, session)) === null) return { ok: false, because: UNSEEN };
    const role = await roleOf(ctx, who, factory);
    if (role !== "admin") {
      return { ok: false, because: `purging a session's bodies takes admin on ${factory}; you have ${role ?? "no role"}` };
    }
    const because = unexplained(reason);
    if (because !== null) return { ok: false, because };
    await purge(ctx, { factory, session, by: who.viewer!.login, via: "cockpit", reason });
    return { ok: true };
  },
});

/** Who is asking to purge `factory`, and whether anything but the forge stands in their way. */
export const askingToPurge = internalQuery({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }): Promise<
    { because: string } | { because: null; factory: string; login: string; actor: Id<"viewers"> | null }> => {
    const who = await viewing(ctx, signIn);
    const anonymous = nameless(who);
    if (anonymous !== null) return { because: anonymous };
    const factory = await readable(ctx, who, named);
    if (factory === null) return { because: UNREADABLE };
    return { because: null, factory, login: who.viewer!.login, actor: who.mode === "team" ? who.viewer!._id : null };
  },
});

/**
 * Purge every body of every session of a factory — a repository deleted, or
 * moved off this cockpit — as an owner of the account it belongs to, which
 * the forge is asked as the person. A local cockpit's one person holds all of
 * it already, and may.
 */
export const purgeFactory = action({
  args: { factory: v.string(), reason: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, reason, signIn }): Promise<Purged> => {
    const asked = await ctx.runQuery(internal.retention.askingToPurge, { factory: named, signIn });
    if (asked.because !== null) return { ok: false, because: asked.because };
    const because = unexplained(reason);
    if (because !== null) return { ok: false, because };
    if (asked.actor !== null) {
      const account = asked.factory.split("/")[0];
      let owns: boolean;
      try {
        const opened = await open(ctx, { user: await actAs(ctx, asked.actor) });
        if (opened === null) return { ok: false, because: "this cockpit has no forge credential to ask who owns it with" };
        try {
          owns = await opened.forge.owns(account);
        } finally {
          await opened.close();
        }
      } catch (error) {
        if (error instanceof ForgeError && error.status === 401) {
          return { ok: false, because: "your sign-in has run out: sign in again to purge" };
        }
        return forgeSaid(error);
      }
      if (!owns) {
        return { ok: false, because: `purging a factory takes an owner of ${account}, and the forge does not say you are one` };
      }
    }
    await ctx.runMutation(internal.retention.purged, { factory: asked.factory, by: asked.login, reason });
    return { ok: true };
  },
});

/** A factory purge the forge allowed, written down and started. */
export const purged = internalMutation({
  args: { factory: v.string(), by: v.string(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, { factory, by, reason }) => {
    await purge(ctx, { factory, session: "", by, via: "cockpit", reason });
    return null;
  },
});

/**
 * A factory purge from the deployment itself, for when nobody with a forge
 * permission is left to ask: whoever holds the deployment's admin key runs it
 * (`./convex.sh run`, above), and the audit line says it came from there.
 */
export const purgeFactoryFromDeployment = internalMutation({
  args: { factory: v.string(), reason: v.string() },
  returns: v.string(),
  handler: async (ctx, { factory: named, reason }) => {
    const because = unexplained(reason);
    if (because !== null) return because;
    const factory = await storedAs(ctx, named);
    await purge(ctx, { factory, session: "", by: "", via: "deployment", reason });
    return `purging every body of every session of ${factory}; its events, cost and this purge's audit line are kept`;
  },
});

/** Every purge of `factory`, newest first: what its audit says. Null for a factory the viewer cannot read. */
export const purges = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }) => {
    const factory = await readable(ctx, await viewing(ctx, signIn), named);
    if (factory === null) return null;
    const rows = await ctx.db
      .query("purges")
      .withIndex("by_factory_at", (q) => q.eq("factory", factory))
      .order("desc")
      .take(100);
    return rows.map(({ session, by, via, reason, at }) => ({ session, by, via, reason, at }));
  },
});
