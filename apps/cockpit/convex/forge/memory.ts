/**
 * Where an action finds what it needs to ask the forge, and keeps what it
 * learned: the registered App, and `Memory` (github.ts) between one action
 * and the next.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { localHost, localToken, mode } from "../model/mode";
import type { App } from "./app";

const answerValidator = v.object({ key: v.string(), etag: v.string(), value: v.string() });
const limitValidator = v.object({ limit: v.number(), remaining: v.number(), resetAt: v.number() });
const mintedValidator = v.object({ installation: v.number(), token: v.string(), expiresAt: v.number() });

/** The App this team registered, key and secrets included, or null before it has. */
export async function registeredApp(ctx: QueryCtx): Promise<App | null> {
  const stored = await ctx.db.query("forgeApps").first();
  if (stored === null) return null;
  // The document is the App (schema.ts) plus the two fields Convex adds to every document.
  const app: Partial<typeof stored> = { ...stored };
  delete app._id;
  delete app._creationTime;
  return app as App;
}

/** Whether this cockpit holds a credential to ask the forge with: the person's token, or a registered App. */
export async function credentialed(ctx: QueryCtx): Promise<boolean> {
  if (mode() === "local") return localToken() !== "";
  return (await ctx.db.query("forgeApps").first()) !== null;
}

/** The web origin of the forge this cockpit reads — what a page's links go to — or "" before it has one. */
export async function forgeWeb(ctx: QueryCtx): Promise<string> {
  const host = mode() === "local" ? localHost() : (await ctx.db.query("forgeApps").first())?.host;
  return host ? `https://${host}` : "";
}

export const app = internalQuery({
  args: {},
  handler: (ctx) => registeredApp(ctx),
});

export const load = internalQuery({
  args: {},
  handler: async (ctx) => {
    const answers = await ctx.db.query("forgeAnswers").collect();
    const limits = await ctx.db.query("forgeLimits").collect();
    const tokens = await ctx.db.query("forgeTokens").collect();
    return {
      app: await registeredApp(ctx),
      answers: answers.map(({ key, etag, value }) => ({ key, etag, value })),
      limits: limits.map(({ scope, limit, remaining, resetAt }) => ({ scope, limit, remaining, resetAt })),
      tokens: tokens.map(({ installation, token, expiresAt }) => ({ installation, token, expiresAt })),
    };
  },
});

export const save = internalMutation({
  args: {
    answers: v.array(answerValidator),
    limits: v.array(v.object({ scope: v.string(), limit: v.union(v.null(), limitValidator) })),
    tokens: v.array(mintedValidator),
  },
  returns: v.null(),
  handler: async (ctx, { answers, limits, tokens }) => {
    for (const answer of answers) {
      const known = await ctx.db.query("forgeAnswers").withIndex("by_key", (q) => q.eq("key", answer.key)).unique();
      if (known === null) await ctx.db.insert("forgeAnswers", answer);
      else await ctx.db.patch(known._id, answer);
    }
    for (const { scope, limit } of limits) {
      const known = await ctx.db.query("forgeLimits").withIndex("by_scope", (q) => q.eq("scope", scope)).unique();
      if (limit === null) {
        if (known !== null) await ctx.db.delete(known._id);
      } else if (known === null) await ctx.db.insert("forgeLimits", { scope, ...limit });
      else await ctx.db.patch(known._id, limit);
    }
    for (const minted of tokens) {
      const known = await ctx.db
        .query("forgeTokens")
        .withIndex("by_installation", (q) => q.eq("installation", minted.installation))
        .unique();
      if (known === null) await ctx.db.insert("forgeTokens", minted);
      else await ctx.db.patch(known._id, minted);
    }
    return null;
  },
});
