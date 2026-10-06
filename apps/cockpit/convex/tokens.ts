/**
 * Ingest tokens: what a station ships its sessions with, scoped to one
 * factory. Three ways one is issued, each its own row so each is revoked
 * alone:
 *
 *   - to a station, when a person with write approves its registration
 *     (stations.ts) — the station asked without one, naming its factory;
 *   - on the factory page, by an admin of its repository, for CI: a job
 *     cannot take part in a device flow, so it holds a token copied into a
 *     repository secret (`issueForCi`);
 *   - by the operator, with the deployment's admin key (`issue`).
 *
 * Only a digest is ever kept. A revoked token is kept too, marked, because the
 * earliest token's factory is how the factory's name is spelled (spelling.ts).
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, internalQuery, mutation, type MutationCtx, query, type QueryCtx } from "./_generated/server";
import { digest, secret } from "./model/digest";
import { spellingFor } from "./spelling";
import { readable, roleOn, viewing, type Viewing } from "./viewer";

type Result = { ok: true } | { ok: false; because: string };

/** The live token whose digest is `held`, or null when none is — never issued, or revoked. */
export async function tokenBy(ctx: QueryCtx, held: string): Promise<Doc<"ingestTokens"> | null> {
  const token = await ctx.db.query("ingestTokens").withIndex("by_digest", (q) => q.eq("digest", held)).unique();
  return token === null || token.revokedAt !== undefined ? null : token;
}

/** Who issued a token, as its row keeps it: a person, at a moment, for a station or for CI. */
export interface Issued {
  kind: "station" | "ci";
  label: string;
  station?: string;
  issuedBy: Doc<"viewers"> | null;
}

/** Keep the digest of a token just made, for `factory` as it is already spelled here. */
export async function keepToken(ctx: MutationCtx, factory: string, held: string, issued?: Issued): Promise<void> {
  await ctx.db.insert("ingestTokens", {
    factory: await spellingFor(ctx, factory), digest: held,
    ...(issued ? {
      kind: issued.kind, label: issued.label, ...(issued.station ? { station: issued.station } : {}),
      ...(issued.issuedBy ? { issuedBy: issued.issuedBy._id, issuedByLogin: issued.issuedBy.login } : {}),
      issuedAt: Date.now(),
    } : {}),
  });
}

/**
 * Revoke the live token a registration handed station `station` of `factory`
 * before: registering again replaces it, so a station holds one at a time.
 */
export async function replaceStationToken(ctx: MutationCtx, factory: string, station: string): Promise<void> {
  const rows = await ctx.db.query("ingestTokens").withIndex("by_factory", (q) => q.eq("factory", factory)).collect();
  for (const row of rows) {
    if (row.kind === "station" && row.station === station && row.revokedAt === undefined) {
      await ctx.db.patch(row._id, { revokedAt: Date.now() });
    }
  }
}

// ── the operator's: the admin key ────────────────────────────────────────────

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
  handler: async (ctx, { factory, digest }) => {
    await keepToken(ctx, factory, digest);
    return null;
  },
});

/** The factory whose live ingest token digests to `digest`, or null when none does. */
export const factoryOf = internalQuery({
  args: { digest: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { digest }) => (await tokenBy(ctx, digest))?.factory ?? null,
});

// ── the factory page's: for CI, by an admin ──────────────────────────────────

/** Whether the viewer is an admin of `factory`'s repository: who issues a token for CI. */
async function administers(ctx: QueryCtx, who: Viewing, factory: string): Promise<boolean> {
  if (who.mode === "local") return true;
  return who.viewer !== null && (await roleOn(ctx, who.viewer, factory)) === "admin";
}

/** May the viewer revoke `row`: an admin of its repository may, and so may whoever it was issued by. */
async function mayRevoke(ctx: QueryCtx, who: Viewing, row: Doc<"ingestTokens">): Promise<boolean> {
  if (who.mode === "local") return true;
  if (who.viewer === null) return false;
  return row.issuedBy === who.viewer._id || (await roleOn(ctx, who.viewer, row.factory)) === "admin";
}

/**
 * Issue an ingest token for CI on `factory`, by an admin of its repository,
 * and return it — the only time it is ever seen: the admin stores it as the
 * repository's `secrets.ASF_COCKPIT_TOKEN`.
 */
export const issueForCi = action({
  args: { factory: v.string(), label: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, label, signIn }): Promise<{ ok: true; token: string } | { ok: false; because: string }> => {
    const token = secret("asf_ingest_");
    const kept: Result = await ctx.runMutation(internal.tokens.keepForCi, { factory, label, signIn, digest: await digest(token) });
    return kept.ok ? { ok: true, token } : kept;
  },
});

export const keepForCi = internalMutation({
  args: { factory: v.string(), label: v.string(), signIn: v.optional(v.string()), digest: v.string() },
  handler: async (ctx, { factory: named, label, signIn, digest }): Promise<Result> => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    if (factory === null) return { ok: false, because: `${named} is not a factory you can read` };
    if (!(await administers(ctx, who, factory))) {
      return { ok: false, because: `a token for CI is an admin's to issue, and the forge does not say you administer ${factory}` };
    }
    await keepToken(ctx, factory, digest, { kind: "ci", label: label.trim() || "CI", issuedBy: who.viewer });
    return { ok: true };
  },
});

/**
 * Every live ingest token of `factory`, oldest first, as its Stations tab
 * lists them — never a token, never a digest — with whether the viewer may
 * revoke each, and whether they may issue one for CI. Null for a factory the
 * viewer cannot read.
 */
export const list = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }) => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    if (factory === null) return null;
    const rows = await ctx.db.query("ingestTokens").withIndex("by_factory", (q) => q.eq("factory", factory)).collect();
    const tokens = await Promise.all(rows.filter((row) => row.revokedAt === undefined).map(async (row) => ({
      id: row._id as Id<"ingestTokens">,
      kind: row.kind ?? ("operator" as const),
      label: row.label ?? "",
      station: row.station ?? "",
      issuedBy: row.issuedByLogin ?? "",
      issuedAt: row.issuedAt ?? row._creationTime,
      revocable: await mayRevoke(ctx, who, row),
    })));
    return { tokens, mayIssue: await administers(ctx, who, factory), site: (process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "") };
  },
});

/** Revoke an ingest token: what it ships, claims or describes is refused from now on. */
export const revoke = mutation({
  args: { token: v.id("ingestTokens"), signIn: v.optional(v.string()) },
  handler: async (ctx, { token, signIn }): Promise<Result> => {
    const row = await ctx.db.get(token);
    const who = await viewing(ctx, signIn);
    if (row === null || row.revokedAt !== undefined || (await readable(ctx, who, row.factory)) === null || !(await mayRevoke(ctx, who, row))) {
      return { ok: false, because: "no such token among the ones you may revoke" };
    }
    await ctx.db.patch(row._id, { revokedAt: Date.now() });
    return { ok: true };
  },
});
