import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { readProgress } from "./discovery";
import { repoKey, type Role } from "./forge/forge";
import { roleOn, viewing } from "./viewer";

export interface FactoryRow {
  /** `owner/name`: a factory is known to a cockpit through its repository. */
  repo: string;
  /** What the viewer may do there, as the forge last said. */
  role: Role | null;
  private: boolean | null;
  /** Whether the forge shows a factory on this repository's default branch. */
  onForge: boolean;
  /** Whether any station has shipped a session of it: false is "no station yet". */
  reporting: boolean;
  lastActivity: number | null;
}

/**
 * The factories the viewer can read: every repository the forge credential
 * reaches whose default branch holds `asf/factory.yaml`, whether or not a
 * station has reported from it yet. Nothing registers a factory here.
 *
 * In a team cockpit that is filtered to the repositories the forge says the
 * viewer reaches, and null — nothing at all — for someone who has not signed
 * in.
 *
 * A local cockpit adds what its stations ship from and the forge does not
 * show as a factory — a checkout with no remote, a machine with no `gh`. It
 * is one person's own machine, and their factory is there whatever the forge
 * can see of it.
 */
export const list = query({
  args: { signIn: v.optional(v.string()) },
  handler: async (ctx, { signIn }) => {
    const { mode, viewer } = await viewing(ctx, signIn);
    if (mode === "team" && viewer === null) return null;

    // A station names its factory when its ingest token is issued, in whatever
    // case it was typed; the forge's names are case-insensitive.
    const shippedAs = new Map<string, string[]>();
    for (const { factory } of await ctx.db.query("ingestTokens").collect()) {
      const names = shippedAs.get(repoKey(factory)) ?? [];
      if (!names.includes(factory)) shippedAs.set(repoKey(factory), [...names, factory]);
    }

    const found = await ctx.db.query("repos").withIndex("by_factory", (q) => q.eq("factory", true)).collect();
    const factories: FactoryRow[] = [];
    for (const repo of found) {
      const role = viewer === null ? null : await roleOn(ctx, viewer, repo.key);
      if (mode === "team" && role === null) continue;
      const shipped = await reported(ctx, [repo.name, ...(shippedAs.get(repo.key) ?? [])]);
      factories.push({ repo: repo.name, role, private: repo.private, onForge: true, ...shipped });
    }
    if (mode === "local") {
      const shown = new Set(found.map((repo) => repo.key));
      for (const [key, names] of shippedAs) {
        if (shown.has(key)) continue;
        const shipped = await reported(ctx, names);
        if (shipped.reporting) factories.push({ repo: names[0], role: null, private: null, onForge: false, ...shipped });
      }
      factories.sort((a, b) => (repoKey(a.repo) < repoKey(b.repo) ? -1 : 1));
    }
    return { factories, discovery: await readProgress(ctx) };
  },
});

/** Whether a station has shipped a session of the factory under any of `names`, and when the last one moved. */
async function reported(ctx: QueryCtx, names: string[]): Promise<Pick<FactoryRow, "reporting" | "lastActivity">> {
  let lastActivity: number | null = null;
  for (const factory of new Set(names)) {
    const latest = await ctx.db
      .query("sessions")
      .withIndex("by_factory_activity", (q) => q.eq("factory", factory))
      .order("desc")
      .first();
    if (latest !== null && (lastActivity === null || latest.activity > lastActivity)) lastActivity = latest.activity;
  }
  return { reporting: lastActivity !== null, lastActivity };
}
