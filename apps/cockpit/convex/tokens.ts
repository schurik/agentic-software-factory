import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { digest, secret } from "./model/digest";

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

/** Keep the digest of a token `issue` just made. Never called with a token itself. */
export const store = internalMutation({
  args: { factory: v.string(), digest: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("ingestTokens", args);
    return null;
  },
});
