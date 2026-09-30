/**
 * Signing in to a team cockpit, with the team's GitHub App.
 *
 *   1. `start` hands the browser a URL on the forge and a `state`;
 *   2. the person approves there, and the forge sends the browser back to
 *      `/auth/callback` with a code and that state;
 *   3. `finish` trades the code for the person's tokens, asks the forge who
 *      they are and where they can go, and hands the browser a sign-in token.
 *
 * The sign-in token is the cockpit's own: an opaque secret the browser sends
 * with every call, of which only the digest is kept. The person's forge
 * tokens never leave the backend.
 *
 * A local cockpit has none of this: whoever ran `asf up` is the viewer.
 */
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, mutation } from "./_generated/server";
import { type App, authorizeUrl, exchange } from "./forge/app";
import { ForgeError, GitHub, RateLimited } from "./forge/github";
import { open } from "./forge/open";
import { digest, secret } from "./model/digest";
import { mode } from "./model/mode";
import { rememberReach, signInBy } from "./viewer";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** How long the person has on the forge's page before the sign-in must be started again. */
const STARTED_FOR = 10 * MINUTE;
/** How long a browser stays signed in. */
const SIGNED_IN_FOR = 30 * DAY;
const NO_APP = "no GitHub App is registered for this cockpit yet: an admin sets one up at /setup";

export const start = action({
  args: {},
  returns: v.object({ url: v.string(), state: v.string() }),
  handler: async (ctx): Promise<{ url: string; state: string }> => {
    if (mode() === "local") throw new ConvexError("a local cockpit has no sign-in: it is yours");
    const app: App | null = await ctx.runQuery(internal.forge.memory.app, {});
    if (app === null) throw new ConvexError(NO_APP);
    const state = secret("");
    await ctx.runMutation(internal.handshakes.offer, {
      digest: await digest(state), purpose: "sign-in", expiresAt: Date.now() + STARTED_FOR,
    });
    return { url: authorizeUrl(app, state), state };
  },
});

export const finish = action({
  args: { code: v.string(), state: v.string() },
  returns: v.string(),
  handler: async (ctx, { code, state }) => {
    const started = await ctx.runMutation(internal.handshakes.take, { digest: await digest(state), purpose: "sign-in" });
    if (started === null) throw new ConvexError("this sign-in was not started here, or took too long: start it again");
    const app: App | null = await ctx.runQuery(internal.forge.memory.app, {});
    if (app === null) throw new ConvexError(NO_APP);
    try {
      const tokens = await exchange(new GitHub(app.host), app, { code });
      const opened = await open(ctx, { user: tokens.access.token });
      if (opened === null) throw new ConvexError(NO_APP);
      try {
        const person = await opened.forge.person();
        const reach = await opened.forge.reach();
        const viewer = await ctx.runMutation(internal.viewer.signedIn, { person, tokens });
        await rememberReach(ctx, viewer, reach);
        const token = secret("asf_signin_");
        await ctx.runMutation(internal.viewer.admit, {
          digest: await digest(token), viewer, expiresAt: Date.now() + SIGNED_IN_FOR,
        });
        return token;
      } finally {
        await opened.close();
      }
    } catch (error) {
      if (error instanceof ForgeError || error instanceof RateLimited) throw new ConvexError(error.message);
      throw error;
    }
  },
});

export const signOut = mutation({
  args: { signIn: v.string() },
  returns: v.null(),
  handler: async (ctx, { signIn }) => {
    const admitted = await signInBy(ctx, await digest(signIn));
    if (admitted !== null) await ctx.db.delete(admitted._id);
    return null;
  },
});
