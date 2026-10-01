/**
 * Discovering factories: which repositories the forge credential reaches, and
 * which of them hold `asf/factory.yaml` on their default branch. There is no
 * registry in the cockpit — the forge is asked, and the answer is kept.
 *
 * `catchUp` is the poll. It runs once as the deployment starts and then on a
 * cron (crons.ts), in both modes: in local mode it is the only way anything
 * is learned, because GitHub cannot reach localhost; in team mode it is what
 * catches a webhook delivery that never arrived, because GitHub does not
 * retry one. It lists the repositories and marks as `stale` each one that
 * moved since it was last looked at. `check` then asks the forge about the
 * stale ones, a batch at a time, and `queues` asks each factory which of
 * its issues are queued for a route — what "nobody watching" is read against.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { type ActionCtx, internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { type Forge, repoKey, repositoryValidator } from "./forge/forge";
import { ForgeError, RateLimited } from "./forge/github";
import { credentialed } from "./forge/memory";
import { open } from "./forge/open";
import { mode } from "./model/mode";
import { PENDING_SHOWN, type Progress } from "./model/progress";
import { ranges } from "./model/ranges";
import { queuedFor, routesOf } from "./model/trigger";
import { rememberReach } from "./viewer";

/** How many repositories one `check` asks about before it hands over to the next. */
const BATCH = 100;
/**
 * The share of the forge's rate limit the poll never touches. In local mode
 * the budget is the person's own: their `gh`, and their factory's watchers,
 * spend from it too, and a first look at a few thousand repositories must not
 * leave them with nothing.
 */
const RESERVE = 0.25;
/** How long a stretch may hold its turn: an action that died with it (the backend went down) holds it no longer. */
const STRETCH_TAKES = 3 * 60_000;

export const catchUp = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const listed = await polling(ctx, "listing", async (forge) => {
      const repositories = await forge.repositories();
      for (const range of ranges(repositories, (repository) => repoKey(repository.name))) {
        await ctx.runMutation(internal.discovery.reconcile, {
          after: range.after, upTo: range.upTo, repositories: range.items,
        });
      }
      if (mode() === "local") {
        // The token is the person's own, so the same poll says where they can go.
        const viewer = await ctx.runMutation(internal.viewer.local, { person: await forge.person() });
        await rememberReach(ctx, viewer, await forge.reach());
      }
      return { listedAt: Date.now() };
    });
    if (listed) await ctx.scheduler.runAfter(0, internal.discovery.check, { queues: true });
    return null;
  },
});

/**
 * `queues`: a round of the catch-up, which goes on to every factory's queue
 * once which repositories are factories is settled. A webhook's look at one
 * repository that moved does not.
 */
export const check = internalAction({
  args: { queues: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { queues }) => {
    const stale = await ctx.runQuery(internal.discovery.stale, { limit: BATCH });
    if (stale.length === 0) {
      if (queues) await ctx.scheduler.runAfter(0, internal.discovery.queues, {});
      return null;
    }
    const checked = await polling(ctx, "checking", async (forge) => {
      const answers: { key: string; rev: number; factory: boolean }[] = [];
      try {
        for (const { key, name, rev } of stale) {
          answers.push({ key, rev, factory: await forge.holdsFactory(name) });
        }
      } finally {
        // Whatever stopped it, what was answered before that was answered.
        await ctx.runMutation(internal.discovery.settle, { answers });
      }
      return {};
    });
    // Again: more than one batch, or a repository that moved while this one
    // was being asked about — whose own `check` found this one at work and
    // left. With none left, that turn goes on to the queues.
    if (checked) await ctx.scheduler.runAfter(0, internal.discovery.check, { queues });
    return null;
  },
});

/**
 * Which of each factory's open issues are queued for a route: the ones its
 * issues watcher would start. Asked every round, not only of what moved — a
 * label changes no push — and conditionally, so a round that finds nothing
 * new is 304s. A factory whose labels the forge will not show is recorded as
 * not known, never as having nothing queued.
 */
export const queues = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const factories = await ctx.runQuery(internal.discovery.factories, {});
    if (factories.length === 0) return null;
    await polling(ctx, "queueing", async (forge) => {
      const found: { key: string; queued: number[] | null }[] = [];
      try {
        for (const { key, name } of factories) found.push({ key, queued: await queuedOn(forge, name) });
      } finally {
        await ctx.runMutation(internal.discovery.queued, { found });
      }
      return {};
    });
    return null;
  },
});

async function queuedOn(forge: Forge, repo: string): Promise<number[] | null> {
  const labels = await forge.labels(repo);
  if (labels === null) return null;
  const found = routesOf(labels);
  if (found.queued === null || found.routes.length === 0) return [];
  const issues = await forge.labelled(repo, found.queued);
  return issues === null ? null : queuedFor(issues, found);
}

export const factories = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("repos").withIndex("by_factory", (q) => q.eq("factory", true)).collect();
    return rows.map(({ key, name }) => ({ key, name }));
  },
});

export const queued = internalMutation({
  args: { found: v.array(v.object({ key: v.string(), queued: v.union(v.null(), v.array(v.number())) })) },
  returns: v.null(),
  handler: async (ctx, { found }) => {
    for (const { key, queued } of found) {
      const row = await ctx.db.query("repos").withIndex("by_key", (q) => q.eq("key", key)).unique();
      if (row !== null && JSON.stringify(row.queued) !== JSON.stringify(queued)) await ctx.db.patch(row._id, { queued });
    }
    return null;
  },
});

/** The kinds of work the poll does, each of which one action at a time is at. */
const stretchValidator = v.union(v.literal("listing"), v.literal("checking"), v.literal("queueing"));
type Stretch = "listing" | "checking" | "queueing";

/** What a stretch leaves in the record of how the poll is doing. */
interface Noted {
  listedAt?: number;
  pausedUntil?: number | null;
  problem?: string;
}

/**
 * One stretch of background work against the forge, and whether it ran to
 * its end. It does not start while the rate limit has it waiting, nor while
 * another action is at the same stretch (`begin`), and what stops it is
 * recorded rather than thrown: a spent budget as the time it resets, a
 * refusal as what the forge said. The Factories page shows both. `work`
 * returns what to note of a stretch that did run to its end.
 */
async function polling(ctx: ActionCtx, stretch: Stretch, work: (forge: Forge) => Promise<Noted>): Promise<boolean> {
  if (!(await ctx.runMutation(internal.discovery.begin, { stretch }))) return false;
  let noted: Noted = {};
  const opened = await open(ctx, { reserve: RESERVE });
  try {
    if (opened === null) return false;
    noted = { ...(await work(opened.forge)), pausedUntil: null, problem: "" };
    return true;
  } catch (error) {
    if (error instanceof RateLimited) noted = { pausedUntil: error.until };
    else if (error instanceof ForgeError) noted = { problem: error.message };
    else throw error;
    return false;
  } finally {
    await ctx.runMutation(internal.discovery.note, { ...noted, [stretch]: null });
    await opened?.close();
  }
}

/**
 * Take the turn at `stretch`, or learn that it is not to be started: the
 * rate limit has the poll waiting, another action is at it already, or this
 * cockpit holds no credential to ask with.
 *
 * Polls overlap as a matter of course — the cron's tick beside the one
 * `start.sh` runs, a webhook's look beside the cron's — and two at once ask
 * the forge everything twice, out of a budget that is the person's own.
 */
export const begin = internalMutation({
  args: { stretch: stretchValidator },
  returns: v.boolean(),
  handler: async (ctx, { stretch }) => {
    const now = Date.now();
    const state = await ctx.db.query("discovery").first();
    if (!(await credentialed(ctx))) {
      // Nothing to ask with, so nothing was refused: what an earlier credential ran into is not this cockpit's state.
      if (state !== null && (state.pausedUntil !== null || state.problem !== "")) {
        await ctx.db.patch(state._id, { pausedUntil: null, problem: "" });
      }
      return false;
    }
    if (state === null) {
      await ctx.db.insert("discovery", { listedAt: null, pausedUntil: null, problem: "", [stretch]: now });
      return true;
    }
    if (state.pausedUntil !== null && now < state.pausedUntil) return false;
    const taken = state[stretch] ?? null;
    // A turn is given back when its stretch ends; one older than this was never going to be.
    if (taken !== null && now - taken < STRETCH_TAKES) return false;
    await ctx.db.patch(state._id, { [stretch]: now });
    return true;
  },
});

/** How the poll is doing, for whoever shows it. */
export async function readProgress(ctx: QueryCtx): Promise<Progress> {
  const state = await ctx.db.query("discovery").first();
  const pending = await ctx.db.query("repos").withIndex("by_stale", (q) => q.eq("stale", true)).take(PENDING_SHOWN);
  return {
    listedAt: state?.listedAt ?? null,
    pausedUntil: state?.pausedUntil ?? null,
    problem: state?.problem ?? "",
    pending: pending.length,
  };
}

/** For whoever runs the deployment: `./convex.sh run discovery:progress`. */
export const progress = internalQuery({
  args: {},
  handler: (ctx) => readProgress(ctx),
});

export const note = internalMutation({
  args: {
    listedAt: v.optional(v.number()),
    pausedUntil: v.optional(v.union(v.null(), v.number())),
    problem: v.optional(v.string()),
    listing: v.optional(v.null()),
    checking: v.optional(v.null()),
    queueing: v.optional(v.null()),
  },
  returns: v.null(),
  handler: async (ctx, noted) => {
    const state = await ctx.db.query("discovery").first();
    if (state === null) await ctx.db.insert("discovery", { listedAt: null, pausedUntil: null, problem: "", ...noted });
    else await ctx.db.patch(state._id, noted);
    return null;
  },
});

/**
 * Make the stored repositories with a key in (`after`, `upTo`] the ones given:
 * new ones are added, vanished ones go, and one that moved — a push, or
 * another default branch — is marked stale. A listing is reconciled a key
 * range at a time so a team with thousands of repositories never needs one
 * transaction to hold them all.
 */
export const reconcile = internalMutation({
  args: { after: v.string(), upTo: v.union(v.string(), v.null()), repositories: v.array(repositoryValidator) },
  returns: v.null(),
  handler: async (ctx, { after, upTo, repositories }) => {
    const known = await ctx.db
      .query("repos")
      .withIndex("by_key", (q) => (upTo === null ? q.gt("key", after) : q.gt("key", after).lte("key", upTo)))
      .collect();
    const rows = new Map(known.map((row) => [row.key, row]));
    for (const repository of repositories) {
      const key = repoKey(repository.name);
      const row = rows.get(key);
      rows.delete(key);
      const facts = {
        name: repository.name, forgeId: repository.id, defaultBranch: repository.defaultBranch,
        private: repository.private, pushedAt: repository.pushedAt,
      };
      if (row === undefined) {
        await ctx.db.insert("repos", { key, ...facts, stale: true, rev: 0, factory: false });
      } else if (row.pushedAt !== facts.pushedAt || row.defaultBranch !== facts.defaultBranch) {
        await ctx.db.patch(row._id, { ...facts, stale: true, rev: row.rev + 1 });
      } else if (row.name !== facts.name || row.private !== facts.private || row.forgeId !== facts.forgeId) {
        await ctx.db.patch(row._id, facts);
      }
    }
    for (const gone of rows.values()) await ctx.db.delete(gone._id);
    return null;
  },
});

/**
 * What a webhook delivery called for (model/webhook.ts): a look at the one
 * repository whose default branch moved, or — with none named, or one the
 * cockpit has not listed yet — the whole catch-up.
 */
export const delivered = internalMutation({
  args: { look: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { look }) => {
    const row = look === undefined
      ? null
      : await ctx.db.query("repos").withIndex("by_key", (q) => q.eq("key", repoKey(look))).unique();
    if (row === null) {
      await ctx.scheduler.runAfter(0, internal.discovery.catchUp, {});
      return null;
    }
    await ctx.db.patch(row._id, { stale: true, rev: row.rev + 1 });
    await ctx.scheduler.runAfter(0, internal.discovery.check, {});
    return null;
  },
});

export const stale = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("repos").withIndex("by_stale", (q) => q.eq("stale", true)).take(limit);
    return rows.map(({ key, name, rev }) => ({ key, name, rev }));
  },
});

/** Record what the forge said about each repository — unless it moved again while being asked. */
export const settle = internalMutation({
  args: { answers: v.array(v.object({ key: v.string(), rev: v.number(), factory: v.boolean() })) },
  returns: v.null(),
  handler: async (ctx, { answers }) => {
    for (const { key, rev, factory } of answers) {
      const row = await ctx.db.query("repos").withIndex("by_key", (q) => q.eq("key", key)).unique();
      if (row === null) continue;
      await ctx.db.patch(row._id, row.rev === rev ? { factory, stale: false } : { factory });
    }
    return null;
  },
});
