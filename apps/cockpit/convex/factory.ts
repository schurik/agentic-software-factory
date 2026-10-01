/**
 * One factory, as its Factory page shows it (spec #40): which repository, its
 * default branch, what its own `asf check --json` last said there, and where
 * each of its stations stands.
 *
 * The page is a query (`page`) and a look at the forge (`look`). The query is
 * everything the cockpit was told — the CI station's self-description, each
 * station's report — and keeps itself live. The look is what only the forge
 * knows: the commit the default branch is at now, the config files there,
 * and how many commits each station's checkout is behind it. The page puts
 * the two together (`model/drift.ts`).
 */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalQuery, query, type QueryCtx } from "./_generated/server";
import { repoKey, type Distance } from "./forge/forge";
import { ForgeError, RateLimited } from "./forge/github";
import { open } from "./forge/open";
import { readDescription } from "./model/description";
import { roleOf } from "./commands";
import { editing } from "./config";
import { canRead, viewing } from "./viewer";

/** The repository row of `factory`, when the forge shows one. */
async function repoOf(ctx: QueryCtx, factory: string): Promise<Doc<"repos"> | null> {
  return await ctx.db.query("repos").withIndex("by_key", (q) => q.eq("key", repoKey(factory))).unique();
}

/**
 * The check the page goes by: the default branch's. A factory the forge does
 * not show (a local cockpit's checkout with no remote) has no default branch
 * to ask about, and goes by whichever check came last.
 */
async function defaultCheck(ctx: QueryCtx, factory: string, defaultBranch: string | null): Promise<Doc<"checks"> | null> {
  if (defaultBranch !== null) {
    return await ctx.db.query("checks").withIndex("by_ref", (q) => q.eq("factory", factory).eq("ref", defaultBranch)).unique();
  }
  return await ctx.db.query("checks").withIndex("by_factory_at", (q) => q.eq("factory", factory)).order("desc").first();
}

/** Every station of `factory` that has reported where it stands — never a CI job, which leaves a check instead. */
async function reporting(ctx: QueryCtx, factory: string): Promise<Doc<"stations">[]> {
  const rows = await ctx.db.query("stations").withIndex("by_station", (q) => q.eq("factory", factory)).collect();
  return rows.filter((row) => row.kind !== "ci");
}

export const page = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, signIn }) => {
    const who = await viewing(ctx, signIn);
    if (!(await canRead(ctx, who, factory))) return null;
    const repo = await repoOf(ctx, factory);
    const defaultBranch = repo?.defaultBranch || null;
    const check = await defaultCheck(ctx, factory, defaultBranch);
    return {
      repo: repo?.name ?? factory,
      onForge: repo !== null && repo.factory,
      private: repo?.private ?? null,
      defaultBranch,
      role: await roleOf(ctx, who, factory),
      // Why the Config tab's editor is disabled for this viewer, or null when it is not.
      edit: await editing(ctx, who, factory),
      // null: no CI workflow has pushed one — the factory is unchecked, not broken.
      check: check && {
        ref: check.ref, head: check.head, configHash: check.configHash, ok: check.ok, at: check.at,
        station: check.stationName, description: readDescription(check.description),
      },
      stations: (await reporting(ctx, factory)).map((row) => ({
        station: row.station, name: row.name, kind: row.kind, owner: row.ownerLogin, seenAt: row.seenAt,
        head: row.report?.head ?? "", configHash: row.report?.configHash ?? "",
      })),
    };
  },
});

export type Look =
  | { ok: true; tip: string | null; files: string[] | null; distances: Record<string, Distance | null> }
  | { ok: false; because: string };

/** What the look needs from the database: whether the viewer may, which branch, and the commits stations stand on. */
export const looking = internalQuery({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, signIn }): Promise<{ branch: string | null; heads: string[] } | null> => {
    if (!(await canRead(ctx, await viewing(ctx, signIn), factory))) return null;
    const repo = await repoOf(ctx, factory);
    const heads = new Set((await reporting(ctx, factory)).map((row) => row.report?.head ?? "").filter(Boolean));
    return { branch: repo?.factory ? repo.defaultBranch || null : null, heads: [...heads].sort() };
  },
});

/**
 * Ask the forge what the page cannot be told: the default branch's commit,
 * the files under `asf/` there, and each reporting station's distance from
 * it. Read on the cockpit's own credential, for a viewer the mirror lets read
 * the repository; nothing read here is stored.
 */
export const look = action({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Look> => {
    const asked = await ctx.runQuery(internal.factory.looking, args);
    if (asked === null) return { ok: false, because: "no such factory among the ones you can read" };
    if (asked.branch === null) return { ok: false, because: "the forge does not show this factory, so there is no default branch to measure by" };
    const opened = await open(ctx);
    if (opened === null) return { ok: false, because: "this cockpit has no forge credential to ask with" };
    try {
      const tip = await opened.forge.tip(args.factory, asked.branch);
      if (tip === null) return { ok: true, tip, files: null, distances: {} };
      const distances: Record<string, Distance | null> = {};
      for (const head of asked.heads) {
        if (head !== tip) distances[head] = await opened.forge.distance(args.factory, tip, head);
      }
      return { ok: true, tip, files: await opened.forge.paths(args.factory, tip, "asf"), distances };
    } catch (error) {
      if (!(error instanceof ForgeError || error instanceof RateLimited)) throw error;
      return { ok: false, because: error.message };
    } finally {
      await opened.close();
    }
  },
});
