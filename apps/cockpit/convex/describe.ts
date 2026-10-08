/**
 * Self-descriptions a CI station pushed (spec #40): what `asf check --json`
 * printed on a pull request or a default-branch push, kept per branch.
 *
 * The CI job is a station like any other, except that it is born and gone
 * with the job, holds only the ingest token and takes no commands — so it is
 * not registered among `stations`: the check it pushed is what it leaves
 * behind, and every push for a branch replaces the last one's.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { stationFieldsValidator } from "./model/command";
import { liveToken } from "./tokens";

/** Keep a description for the factory whose ingest token digests to `digest`; false when none holds it. */
export const keep = internalMutation({
  args: {
    digest: v.string(), station: stationFieldsValidator, text: v.string(),
    ref: v.string(), head: v.string(), configHash: v.string(), format: v.number(), ok: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, { digest, station, text, ref, head, configHash, format, ok }) => {
    const token = await liveToken(ctx, digest);
    if (token === null) return false;
    const { factory } = token;
    const row = {
      factory, ref, head, configHash, format, ok, description: text,
      station: station.id, stationName: station.name, stationKind: station.kind, at: Date.now(),
    };
    const known = await ctx.db.query("checks").withIndex("by_ref", (q) => q.eq("factory", factory).eq("ref", ref)).unique();
    if (known === null) await ctx.db.insert("checks", row);
    else await ctx.db.replace(known._id, row);
    return true;
  },
});
