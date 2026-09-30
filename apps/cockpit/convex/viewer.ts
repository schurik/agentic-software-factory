/**
 * Who is looking, and where the forge lets them go.
 *
 * Identity is the forge login and nothing else (spec #40). In a team cockpit
 * a viewer is whoever signed in with the team's GitHub App (auth.ts); in a
 * local one it is the person whose token the cockpit holds — nobody signs in,
 * and nothing on the machine is hidden from them.
 *
 * What a viewer may do is never decided here. `reach` is the forge's own
 * answer, kept for a few minutes: the permission mirror, which the pages read
 * to show what the forge would allow and to hide what it would not.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, type ActionCtx, internalMutation, query, type QueryCtx } from "./_generated/server";
import { type App, exchange, type Expiring, installUrl } from "./forge/app";
import { personValidator, type Reach, reachValidator, repoKey, type Role } from "./forge/forge";
import { ForgeError, GitHub, RateLimited } from "./forge/github";
import { open } from "./forge/open";
import { LAPSED_PER_WRITE } from "./handshakes";
import { digest } from "./model/digest";
import { localHost, localToken, mode, type Mode } from "./model/mode";
import { ranges } from "./model/ranges";
import { expiringValidator } from "./schema";

/** How old the forge's word on a viewer's reach may get before it is asked again. */
const REACH_FOR = 5 * 60_000;
/**
 * How old it may get before it stops counting at all. The mirror is kept true
 * by the viewer's own page asking again (`refresh`); someone whose page
 * stopped asking — or who calls these functions without one — is shown
 * nothing on a word this old. It fails closed: a forge that cannot be reached
 * confirms nothing either.
 */
const REACH_LAPSES = 15 * 60_000;
/** How long one refresh has before another may start beside it. */
const REFRESH_TAKES = 60_000;
/** An access token with less than this left is renewed first. */
const ACCESS_TOKEN_MARGIN = 60_000;

const tokensValidator = v.object({ access: expiringValidator, refresh: v.union(v.null(), expiringValidator) });

// ── who is looking ───────────────────────────────────────────────────────────

export interface Viewing {
  mode: Mode;
  viewer: Doc<"viewers"> | null;
}

/**
 * Who is looking. `signIn` is the token a browser got from `auth.finish`; a
 * local cockpit takes none, and its viewer is whoever its token belongs to.
 */
export async function viewing(ctx: QueryCtx, signIn?: string): Promise<Viewing> {
  if (mode() === "local") {
    const viewer = await ctx.db.query("viewers").withIndex("by_local", (q) => q.eq("local", true)).first();
    return { mode: "local", viewer };
  }
  if (!signIn) return { mode: "team", viewer: null };
  const admitted = live(await signInBy(ctx, await digest(signIn)));
  return { mode: "team", viewer: admitted && (await ctx.db.get(admitted.viewer)) };
}

/** The sign-in of the browser that holds the token with this digest, lapsed or not. */
export async function signInBy(ctx: QueryCtx, held: string): Promise<Doc<"signIns"> | null> {
  return await ctx.db.query("signIns").withIndex("by_digest", (q) => q.eq("digest", held)).unique();
}

function live(admitted: Doc<"signIns"> | null): Doc<"signIns"> | null {
  return admitted !== null && Date.now() < admitted.expiresAt ? admitted : null;
}

/**
 * Whether what is stored of `viewer`'s reach still counts. A local viewer's
 * always does: their token is the cockpit's own, and the machine is theirs.
 */
export function reachKnown(viewer: Doc<"viewers">): boolean {
  return viewer.local || Date.now() - viewer.reachAt < REACH_LAPSES;
}

/** What `viewer` may do on `repo`, as the forge last said — null when it said nothing, or too long ago. */
export async function roleOn(ctx: QueryCtx, viewer: Doc<"viewers">, repo: string): Promise<Role | null> {
  if (!reachKnown(viewer)) return null;
  const row = await ctx.db
    .query("reach")
    .withIndex("by_viewer_repo", (q) => q.eq("viewer", viewer._id).eq("repo", repoKey(repo)))
    .unique();
  return row?.role ?? null;
}

/**
 * Whether the viewer may see `factory`'s sessions. In a team cockpit that is
 * whether the forge lets them read its repository; a local cockpit is one
 * person's own machine, and shows them all of it.
 */
export async function canRead(ctx: QueryCtx, { mode, viewer }: Viewing, factory: string): Promise<boolean> {
  if (mode === "local") return true;
  return viewer !== null && (await roleOn(ctx, viewer, factory)) !== null;
}

/**
 * What the layout needs before it shows anything: which cockpit this is,
 * whether it has a forge to ask, and who is looking.
 */
export const me = query({
  args: { signIn: v.optional(v.string()) },
  handler: async (ctx, { signIn }) => {
    const { mode, viewer } = await viewing(ctx, signIn);
    const app = mode === "team" ? await ctx.db.query("forgeApps").first() : null;
    const forge = mode === "local"
      ? { host: localHost(), ready: localToken() !== "", app: null }
      : { host: app?.host ?? "", ready: app !== null, app: app && { slug: app.slug, installUrl: installUrl(app) } };
    return {
      mode,
      forge,
      viewer: viewer && {
        login: viewer.login, name: viewer.name, avatarUrl: viewer.avatarUrl,
        // False until the forge has been asked again: a page waits on `refresh` rather than show nothing.
        reachKnown: reachKnown(viewer),
      },
    };
  },
});

// ── becoming a viewer ────────────────────────────────────────────────────────

/** The person a local cockpit's token belongs to, as its one viewer. */
export const local = internalMutation({
  args: { person: personValidator },
  returns: v.id("viewers"),
  handler: async (ctx, { person }) => {
    const facts = { forgeId: person.id, login: person.login, name: person.name, avatarUrl: person.avatarUrl, local: true };
    const known = await ctx.db.query("viewers").withIndex("by_forge_id", (q) => q.eq("forgeId", person.id)).first();
    // Another token, another person: the machine has one viewer at a time.
    for (const row of await ctx.db.query("viewers").withIndex("by_local", (q) => q.eq("local", true)).collect()) {
      if (row._id !== known?._id) await ctx.db.patch(row._id, { local: false });
    }
    if (known === null) return await ctx.db.insert("viewers", { ...facts, reachAt: 0 });
    // Asked every minute by the poll, and written only when the forge says something new.
    if (!known.local || known.login !== facts.login || known.name !== facts.name || known.avatarUrl !== facts.avatarUrl) {
      await ctx.db.patch(known._id, facts);
    }
    return known._id;
  },
});

/** The person who just signed in with the team's App, with the tokens it acts as them with. */
export const signedIn = internalMutation({
  args: { person: personValidator, tokens: tokensValidator },
  returns: v.id("viewers"),
  handler: async (ctx, { person, tokens }) => {
    const facts = {
      forgeId: person.id, login: person.login, name: person.name, avatarUrl: person.avatarUrl,
      local: false, access: tokens.access, refresh: tokens.refresh ?? undefined,
    };
    const known = await ctx.db.query("viewers").withIndex("by_forge_id", (q) => q.eq("forgeId", person.id)).first();
    if (known === null) return await ctx.db.insert("viewers", { ...facts, reachAt: 0 });
    await ctx.db.patch(known._id, facts);
    return known._id;
  },
});

/** Let the browser holding the token with this digest in, as `viewer`. */
export const admit = internalMutation({
  args: { digest: v.string(), viewer: v.id("viewers"), expiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, admitted) => {
    // A sign-in that lapsed is already refused (`viewing`); here it is forgotten.
    const lapsed = await ctx.db
      .query("signIns")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
      .take(LAPSED_PER_WRITE);
    for (const gone of lapsed) await ctx.db.delete(gone._id);
    await ctx.db.insert("signIns", admitted);
    return null;
  },
});

/** The forge no longer knows this person's tokens: every browser of theirs is signed out. */
export const signedOut = internalMutation({
  args: { viewer: v.id("viewers") },
  returns: v.null(),
  handler: async (ctx, { viewer }) => {
    for (const admitted of await ctx.db.query("signIns").withIndex("by_viewer", (q) => q.eq("viewer", viewer)).collect()) {
      await ctx.db.delete(admitted._id);
    }
    await ctx.db.patch(viewer, { access: undefined, refresh: undefined });
    return null;
  },
});

// ── the permission mirror ────────────────────────────────────────────────────

/**
 * Ask the forge again where the viewer can go, when what is stored is older
 * than `REACH_FOR`. The page calls it as it opens and every few minutes; the
 * cockpit keeps no permissions of its own, so this is all that keeps the
 * mirror true. It renews the person's access token first when that has run
 * out, and a forge that will not renew it, or no longer takes it, has signed
 * them out.
 */
export const refresh = action({
  args: { signIn: v.string() },
  returns: v.null(),
  handler: async (ctx, { signIn }): Promise<null> => {
    if (mode() === "local") return null;       // the poll keeps a local viewer's reach (discovery.ts)
    const due: Refreshing | null = await ctx.runMutation(internal.viewer.beginRefresh, { digest: await digest(signIn) });
    if (due === null) return null;
    try {
      const opened = await open(ctx, { user: await userToken(ctx, due) });
      if (opened === null) return null;
      try {
        await rememberReach(ctx, due.viewer, await opened.forge.reach());
      } finally {
        await opened.close();
      }
    } catch (error) {
      if (error instanceof ForgeError && error.status === 401) {
        await ctx.runMutation(internal.viewer.signedOut, { viewer: due.viewer });
      } else if (!(error instanceof ForgeError || error instanceof RateLimited)) {
        throw error;
      }
      // Anything else the forge did is its trouble of the moment. Nothing is
      // taken away here and nothing is confirmed: the word that was stored
      // goes on counting only until it lapses (`REACH_LAPSES`).
    }
    return null;
  },
});

/** A refresh that is under way: whose, and the tokens it starts from. */
interface Refreshing {
  viewer: Id<"viewers">;
  access: Expiring | null;
  refresh: Expiring | null;
}

/**
 * Start the refresh of the viewer holding this sign-in, if one is due and no
 * other is under way: a refresh token works once, so two tabs asking at the
 * same moment must not both spend it.
 */
export const beginRefresh = internalMutation({
  args: { digest: v.string() },
  handler: async (ctx, { digest: held }): Promise<Refreshing | null> => {
    const admitted = live(await signInBy(ctx, held));
    const viewer = admitted && (await ctx.db.get(admitted.viewer));
    const now = Date.now();
    if (viewer === null || now - viewer.reachAt < REACH_FOR) return null;
    if (viewer.refreshingAt !== undefined && now - viewer.refreshingAt < REFRESH_TAKES) return null;
    await ctx.db.patch(viewer._id, { refreshingAt: now });
    return { viewer: viewer._id, access: viewer.access ?? null, refresh: viewer.refresh ?? null };
  },
});

/** The viewer's access token, renewed with their refresh token when it has run out. */
async function userToken(ctx: ActionCtx, { viewer, access, refresh }: Refreshing): Promise<string> {
  const now = Date.now();
  if (access && (access.expiresAt === null || access.expiresAt - now > ACCESS_TOKEN_MARGIN)) return access.token;
  const app: App | null = await ctx.runQuery(internal.forge.memory.app, {});
  if (app === null || refresh === null || (refresh.expiresAt !== null && refresh.expiresAt <= now)) {
    throw new ForgeError(401, "the viewer's sign-in has run out");
  }
  const tokens = await exchange(new GitHub(app.host), app, { refreshToken: refresh.token });
  await ctx.runMutation(internal.viewer.renewed, { viewer, tokens });
  return tokens.access.token;
}

export const renewed = internalMutation({
  args: { viewer: v.id("viewers"), tokens: tokensValidator },
  returns: v.null(),
  handler: async (ctx, { viewer, tokens }) => {
    await ctx.db.patch(viewer, { access: tokens.access, refresh: tokens.refresh ?? undefined });
    return null;
  },
});

/** Replace what is stored of `viewer`'s reach with what the forge just said. */
export async function rememberReach(ctx: ActionCtx, viewer: Id<"viewers">, reach: Reach[]): Promise<void> {
  const at = Date.now();
  for (const range of ranges(reach, ({ repo }) => repoKey(repo))) {
    await ctx.runMutation(internal.viewer.reached, {
      viewer, after: range.after, upTo: range.upTo, reach: range.items, at,
    });
  }
}

/**
 * Make `viewer`'s stored reach over the keys in (`after`, `upTo`] the one
 * given. A key range at a time, like the repositories (discovery.reconcile).
 */
export const reached = internalMutation({
  args: {
    viewer: v.id("viewers"),
    after: v.string(),
    upTo: v.union(v.string(), v.null()),
    reach: v.array(reachValidator),
    at: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { viewer, after, upTo, reach, at }) => {
    const known = await ctx.db
      .query("reach")
      .withIndex("by_viewer_repo", (q) => {
        const from = q.eq("viewer", viewer).gt("repo", after);
        return upTo === null ? from : from.lte("repo", upTo);
      })
      .collect();
    const rows = new Map(known.map((row) => [row.repo, row]));
    for (const { repo, role } of reach) {
      const key = repoKey(repo);
      const row = rows.get(key);
      rows.delete(key);
      if (row === undefined) await ctx.db.insert("reach", { viewer, repo: key, role });
      else if (row.role !== role) await ctx.db.patch(row._id, { role });
    }
    for (const gone of rows.values()) await ctx.db.delete(gone._id);
    // The last range closes the refresh: only then is the whole reach as of `at`.
    if (upTo === null) await ctx.db.patch(viewer, { reachAt: at });
    return null;
  },
});
