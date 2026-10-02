import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { attentionOf, liveIn, recentOf } from "./activity";
import { readProgress } from "./discovery";
import { reporting } from "./factory";
import { repoKey, type Role } from "./forge/forge";
import type { Facts } from "./model/attention";
import { type Period, periodValidator } from "./model/period";
import type { Spend } from "./model/spend";
import { roleOn, viewing, type Viewing } from "./viewer";

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
  /** Its sessions running now — not those suspended at a gate, which `facts.gates` counts. */
  live: number;
  /** When each of its stations' loop last polled, 0 for never: the page says which are online, by its clock. */
  seen: number[];
  /** What its agent calls cost in the period asked for, list-price equivalent; null when none was. */
  spend: Spend | null;
  /** What needs attention is read from, as the Factory page's Activity reads it (`model/attention.ts`). */
  facts: Facts;
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
  args: { signIn: v.optional(v.string()), period: v.optional(periodValidator) },
  handler: async (ctx, { signIn, period }) => {
    const who = await viewing(ctx, signIn);
    const { mode, viewer } = who;
    if (mode === "team" && viewer === null) return null;

    // A station's ingest token names its factory as it was first spelled here
    // (`spelling.ts`), which may not be the forge's case; the forge's names
    // are case-insensitive.
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
      // Its stations' spelling first: what its sessions are stored under (`spelling.ts`).
      const names = [...(shippedAs.get(repo.key) ?? []), repo.name];
      factories.push({ repo: repo.name, role, private: repo.private, onForge: true, ...(await standing(ctx, who, names, period)) });
    }
    if (mode === "local") {
      const shown = new Set(found.map((repo) => repo.key));
      for (const [key, names] of shippedAs) {
        if (shown.has(key)) continue;
        const shipped = await standing(ctx, who, names, period);
        if (shipped.reporting) factories.push({ repo: names[0], role: null, private: null, onForge: false, ...shipped });
      }
    }
    // By name: how the page ranks them is its own, by its clock (`model/factories.ts`).
    factories.sort((a, b) => (repoKey(a.repo) < repoKey(b.repo) ? -1 : 1));
    return { factories, discovery: await readProgress(ctx) };
  },
});

/**
 * What a row says of the factory known as `names`. The first is the one its
 * data is stored under, which sessions, stations and what needs attention
 * are read by; spend and whether it reported are read under every spelling,
 * for a cockpit that stored two before it kept to one.
 */
async function standing(ctx: QueryCtx, who: Viewing, names: string[], period: Period | undefined):
    Promise<Omit<FactoryRow, "repo" | "role" | "private" | "onForge">> {
  const [factory] = names;
  const known = await recentOf(ctx, factory);
  return {
    ...(await reported(ctx, names)),
    live: liveIn(known),
    seen: (await reporting(ctx, factory)).map((row) => row.seenAt),
    spend: period === undefined ? null : await spentOn(ctx, names, period),
    facts: await attentionOf(ctx, who, factory, known),
  };
}

/** What the factory known as `names` spent in `period`. */
async function spentOn(ctx: QueryCtx, names: string[], { from, to }: Period): Promise<Spend> {
  const spend: Spend = { cost: 0, tokens: 0 };
  for (const factory of new Set(names)) {
    const buckets = ctx.db.query("spend").withIndex("by_factory_at", (q) => q.eq("factory", factory).gte("at", from).lt("at", to));
    for await (const bucket of buckets) {
      spend.cost += bucket.cost;
      spend.tokens += bucket.tokens;
    }
  }
  return spend;
}

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
