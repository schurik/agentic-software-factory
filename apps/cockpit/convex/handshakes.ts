/**
 * Secrets that are handed out to come back once (the `handshakes` table): a
 * setup code, and the `state` a browser carries to GitHub and back. Only the
 * digest is kept, and taking one is what spends it.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { purposeValidator } from "./schema";

/** How many lapsed rows one write clears away while it is there. */
export const LAPSED_PER_WRITE = 100;

export const offer = internalMutation({
  args: { digest: v.string(), purpose: purposeValidator, expiresAt: v.number(), host: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, offered) => {
    // Anyone can start a sign-in and walk away, so each offer clears out
    // what has run out: the table holds what is pending, never what was.
    const lapsed = await ctx.db
      .query("handshakes")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
      .take(LAPSED_PER_WRITE);
    for (const gone of lapsed) await ctx.db.delete(gone._id);
    await ctx.db.insert("handshakes", offered);
    return null;
  },
});

/** Spend the handshake with this digest, if it was offered for `purpose` and has not run out. */
export const take = internalMutation({
  args: { digest: v.string(), purpose: purposeValidator },
  returns: v.union(v.null(), v.object({ host: v.optional(v.string()) })),
  handler: async (ctx, { digest, purpose }) => {
    const offered = await ctx.db.query("handshakes").withIndex("by_digest", (q) => q.eq("digest", digest)).unique();
    if (offered === null || offered.purpose !== purpose) return null;
    await ctx.db.delete(offered._id);
    return Date.now() < offered.expiresAt ? { host: offered.host } : null;
  },
});
