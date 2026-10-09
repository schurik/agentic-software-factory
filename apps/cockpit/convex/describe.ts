/**
 * Self-descriptions a station pushed (spec #40): what `asf check --json`
 * printed on a pull request or a default-branch push, kept per branch.
 *
 * The CI job is a station like any other, except that it is born and gone
 * with the job, holds only the ingest token and takes no commands — so it is
 * not registered among `stations`: the check it pushed is what it leaves
 * behind, and every push for a branch replaces the last one's.
 *
 * A local station pushes one only to a factory nothing has described yet,
 * when it registers (`stations.handOver` says whether that is so), and only
 * for the default branch: the factory is not "unchecked" from the moment it
 * connects. From then on the description is the CI workflow's to keep — the
 * default branch's is what every station's config drift is measured against,
 * and a checkout's own edits must not become it.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { repoOf } from "./factory";
import { stationFieldsValidator } from "./model/command";
import { liveToken } from "./tokens";

const refusal = v.union(v.null(), v.object({ status: v.number(), error: v.string() }));

/** Keep a description for the factory whose ingest token digests to `digest`; null when kept, else why not. */
export const keep = internalMutation({
  args: {
    digest: v.string(), station: stationFieldsValidator, text: v.string(),
    ref: v.string(), head: v.string(), configHash: v.string(), format: v.number(), ok: v.boolean(),
  },
  returns: refusal,
  handler: async (ctx, { digest, station, text, ref, head, configHash, format, ok }) => {
    const token = await liveToken(ctx, digest);
    if (token === null) return { status: 401, error: "this ingest token is not one the cockpit issued, or it was revoked" };
    const { factory } = token;
    if (station.kind !== "ci") {
      const any = await ctx.db.query("checks").withIndex("by_factory_at", (q) => q.eq("factory", factory)).first();
      if (any !== null) {
        return { status: 403, error: "this factory is described already: its CI workflow keeps the description current, never a local checkout" };
      }
      const branch = (await repoOf(ctx, factory))?.defaultBranch || "";
      if (branch && ref !== branch) {
        return { status: 409, error: `a factory is first described from its default branch, ${branch}, and this checkout is on ${ref || "no branch"}` };
      }
    }
    const row = {
      factory, ref, head, configHash, format, ok, description: text,
      station: station.id, stationName: station.name, stationKind: station.kind, at: Date.now(),
    };
    const known = await ctx.db.query("checks").withIndex("by_ref", (q) => q.eq("factory", factory).eq("ref", ref)).unique();
    if (known === null) await ctx.db.insert("checks", row);
    else await ctx.db.replace(known._id, row);
    return null;
  },
});
