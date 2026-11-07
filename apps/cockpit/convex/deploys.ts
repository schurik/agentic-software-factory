/**
 * The cockpit's own deploys: which builds started on this deployment, and
 * when — what the footer shows beside the build being served.
 *
 *   record  run by `docker/start.sh` once the functions are pushed, with the
 *           build the image carries: a row for a build the newest row is not.
 *           A local build (no commit) is not recorded: every one would look
 *           the same.
 *   recent  the newest deploys, for anyone who may see the cockpit at all.
 */
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { type Build, buildValidator, isCiBuild, sameBuild } from "./model/build";
import { viewing } from "./viewer";

/** How many deploys the footer lists. */
const SHOWN = 10;

export interface Deploy {
  build: Build;
  at: number;
}

export const record = internalMutation({
  args: { build: buildValidator },
  handler: async (ctx, { build }): Promise<"recorded" | "restarted" | "local"> => {
    if (!isCiBuild(build)) return "local";
    const newest = await ctx.db.query("deploys").withIndex("by_at").order("desc").first();
    if (newest !== null && sameBuild(newest.build, build)) return "restarted";
    await ctx.db.insert("deploys", { build, at: Date.now() });
    return "recorded";
  },
});

export const recent = query({
  args: { signIn: v.optional(v.string()) },
  handler: async (ctx, { signIn }): Promise<Deploy[]> => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return [];
    const rows = await ctx.db.query("deploys").withIndex("by_at").order("desc").take(SHOWN);
    return rows.map(({ build, at }) => ({ build, at }));
  },
});
