/**
 * Ingest tokens: what a station ships a factory's sessions with (spec #40,
 * #175). Three routes issue one, each a row of its own so each is revoked on
 * its own:
 *
 *   - the deployment's admin key (`issue`), the operator's route;
 *   - a station's registration a person with write approved (`handOver` in
 *     stations.ts), so connecting a checkout needs nobody holding that key;
 *   - a repository's admin on the factory page (`issueFor`), for a CI job,
 *     which takes part in no device flow and copies it into a secret.
 *
 * Only a digest is kept, and a token is shown once, by whatever issued it.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, type MutationCtx, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { repoKey } from "./forge/forge";
import { digest, secret } from "./model/digest";
import { spellingFor } from "./spelling";
import { readable, roleOn, viewing, type Viewing } from "./viewer";

type Result = { ok: true } | { ok: false; because: string };

/** The live token with this digest — null for none, and for one revoked. */
export async function liveToken(ctx: QueryCtx, held: string): Promise<Doc<"ingestTokens"> | null> {
  const token = await ctx.db.query("ingestTokens").withIndex("by_digest", (q) => q.eq("digest", held)).unique();
  return token === null || token.revokedAt !== undefined ? null : token;
}

/** Revoke every live token a registration handed `station` of `factory`: its approval is withdrawn, or replaced. */
export async function revokeStation(ctx: MutationCtx, factory: string, station: string): Promise<void> {
  const held = await ctx.db.query("ingestTokens")
    .withIndex("by_station", (q) => q.eq("factory", factory).eq("station", station))
    .collect();
  for (const token of held) if (token.revokedAt === undefined) await ctx.db.patch(token._id, { revokedAt: Date.now() });
}

/**
 * Issue an ingest token for `factory` (its repository, e.g. `acme/widgets`) and
 * return it — the only time it is ever seen. Internal, so it runs only with the
 * deployment's admin key:
 *
 *   npx convex run tokens:issue '{"factory": "acme/widgets"}'
 *
 * An action rather than a mutation, because that is where a secret can be made
 * (`secret`, model/digest.ts).
 */
export const issue = internalAction({
  args: { factory: v.string() },
  returns: v.string(),
  handler: async (ctx, { factory }) => {
    const token = secret("asf_ingest_");
    await ctx.runMutation(internal.tokens.store, { factory, digest: await digest(token) });
    return token;
  },
});

/**
 * Keep the digest of a token `issue` just made. Never called with a token
 * itself. The token holds the factory as it is already spelled here, if it
 * is — `spelling.ts` — so one factory's sessions are stored under one name.
 */
export const store = internalMutation({
  args: { factory: v.string(), digest: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("ingestTokens", {
      ...args, factory: await spellingFor(ctx, args.factory), via: "deployment", by: "", issuedAt: Date.now(),
    });
    return null;
  },
});

/** The factory whose live ingest token digests to `digest`, or null when none does. */
export const factoryOf = internalQuery({
  args: { digest: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { digest }) => (await liveToken(ctx, digest))?.factory ?? null,
});

// ── from the factory page ────────────────────────────────────────────────────

/** Why the viewer may not issue `factory` an ingest token, or null when they may: an admin of its repository may. */
async function issueRefusal(ctx: QueryCtx, who: Viewing, factory: string): Promise<string | null> {
  if (who.mode === "local") return null;
  if (who.viewer === null) return "sign in to issue an ingest token";
  const role = await roleOn(ctx, who.viewer, factory);
  if (role === "admin") return null;
  return role === null ? `${factory} is not a repository the forge lets you read`
    : `issuing an ingest token needs admin on ${factory}; the forge says you have ${role}`;
}

/** May the viewer revoke `token`: on a local cockpit anyone may, else an admin of its repository, or whoever it was issued by. */
async function mayRevoke(ctx: QueryCtx, who: Viewing, token: Doc<"ingestTokens">): Promise<boolean> {
  if (who.mode === "local") return true;
  if (who.viewer === null) return false;
  return (token.by !== undefined && token.by !== "" && token.by === who.viewer.login)
    || (await roleOn(ctx, who.viewer, token.factory)) === "admin";
}

/**
 * `factory`'s live ingest tokens, newest first, as its Stations tab lists
 * them — how each was issued, to what, by whom and when; never the token —
 * and whether the viewer may issue one. Null for a factory the viewer cannot read.
 */
export const listed = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }) => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    if (factory === null) return null;
    const key = repoKey(factory);
    // A factory may hold tokens issued under a spelling from before it kept to one (spelling.ts).
    const rows = (await ctx.db.query("ingestTokens").collect())
      .filter((token) => repoKey(token.factory) === key && token.revokedAt === undefined)
      .sort((a, b) => (b.issuedAt ?? b._creationTime) - (a.issuedAt ?? a._creationTime));
    return {
      mayIssue: (await issueRefusal(ctx, who, factory)) === null,
      tokens: await Promise.all(rows.map(async (token) => ({
        id: token._id, via: token.via ?? "deployment", label: token.label ?? "", station: token.station ?? "",
        by: token.by ?? "", issuedAt: token.issuedAt ?? token._creationTime, revocable: await mayRevoke(ctx, who, token),
      }))),
    };
  },
});

/**
 * Issue `factory` an ingest token for CI, named `label`, as an admin of its
 * repository: the token is returned this once, and never again. An action,
 * because that is where a secret can be made; whether the viewer may is
 * decided where the digest is kept.
 */
export const issueFor = action({
  args: { factory: v.string(), label: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, label, signIn }): Promise<{ ok: true; token: string } | { ok: false; because: string }> => {
    const token = secret("asf_ingest_");
    const kept: Result = await ctx.runMutation(internal.tokens.keepIssued, { factory, label, signIn, digest: await digest(token) });
    return kept.ok ? { ok: true, token } : kept;
  },
});

export const keepIssued = internalMutation({
  args: { factory: v.string(), label: v.string(), signIn: v.optional(v.string()), digest: v.string() },
  handler: async (ctx, { factory: named, label, signIn, digest }): Promise<Result> => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    if (factory === null) return { ok: false, because: `${named} is not a factory you can read` };
    const refused = await issueRefusal(ctx, who, factory);
    if (refused !== null) return { ok: false, because: refused };
    await ctx.db.insert("ingestTokens", {
      factory: await spellingFor(ctx, factory), digest, via: "cockpit", label: label.trim().slice(0, 100) || "CI",
      by: who.viewer?.login ?? "", issuedAt: Date.now(),
    });
    return { ok: true };
  },
});

/** Revoke one of `factory`'s ingest tokens: what ships with it is refused from now on. */
export const revoke = mutation({
  args: { factory: v.string(), id: v.id("ingestTokens"), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, id, signIn }): Promise<Result> => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    const token = factory === null ? null : await ctx.db.get(id as Id<"ingestTokens">);
    if (token === null || factory === null || repoKey(token.factory) !== repoKey(factory) || token.revokedAt !== undefined
        || !(await mayRevoke(ctx, who, token))) {
      return { ok: false, because: "no such token among the ones you may revoke" };
    }
    await ctx.db.patch(token._id, { revokedAt: Date.now() });
    return { ok: true };
  },
});
