/**
 * Setting up a team cockpit: registering its GitHub App through the manifest
 * flow, and keeping the key and secrets GitHub hands back.
 *
 *   1. the deployment's admin prints a setup code:
 *        docker compose exec app ./convex.sh run setup:code
 *   2. the setup page sends it to `begin`, with the GitHub host and the
 *      organization, and posts the manifest it gets to the URL it gets;
 *   3. the admin names the App on GitHub and confirms; GitHub sends the
 *      browser back to `/setup/callback` with a code, which `complete` trades
 *      for the App.
 *
 * Or, for an App the account registered before — for another cockpit, or for
 * this one on another machine — `adopt` takes that App on: GitHub keeps an
 * App's name unique on a host, so registering it again is refused, and a new
 * one would have to be installed again on every repository.
 *
 * The setup code is what makes the person at the setup page an admin: before
 * an App exists nobody can sign in, so the one thing that can be checked is
 * that they can run a function on the deployment. Presenting a fresh code
 * registers again, which replaces the App — the way out of a registration
 * under the wrong account.
 */
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, query } from "./_generated/server";
import {
  type App, appJwt, appValidator, convert, deliverable, installUrl, manifest, pointWebhook, readApp, registrationUrl, webhookUrl,
} from "./forge/app";
import { ForgeError, GitHub } from "./forge/github";
import { digest, secret } from "./model/digest";

const HOUR = 3600_000;
const NOT_A_SETUP_CODE = "that is not a setup code this deployment printed in the last hour: run `setup:code` again on the deployment these pages use, as this page shows, for a fresh one";

/**
 * Where GitHub would deliver the App's webhook, and whether it could. The
 * setup page says so before the admin leaves for GitHub: a cockpit GitHub
 * cannot reach is registered without a webhook, and learns by the poll.
 */
export const webhook = query({
  args: {},
  returns: v.object({ url: v.string(), deliverable: v.boolean() }),
  handler: async () => {
    const url = webhookUrl(process.env.CONVEX_SITE_URL ?? "");
    return { url, deliverable: deliverable(url) };
  },
});

/** A Convex Cloud deployment, by name, and its functions in the Convex dashboard: where `setup:code` is run. */
export interface CloudDeployment {
  name: string;
  functions: string;
}

/**
 * The Convex Cloud deployment whose site is `siteUrl` — `https://<name>.convex.site`,
 * or with a region, `https://<name>.<region>.convex.site` — or null for any other
 * site: a self-hosted backend, the compose file's.
 */
export function convexCloud(siteUrl: string): CloudDeployment | null {
  const name = /^https:\/\/([a-z0-9-]+)(?:\.[a-z0-9-]+)?\.convex\.site\/*$/.exec(siteUrl.trim())?.[1];
  return name ? { name, functions: `https://dashboard.convex.dev/d/${name}/functions` } : null;
}

/**
 * Where this deployment runs, as the setup page and the Stations tab say it:
 * its site origin — what a station's ASF_COCKPIT_URL is — and, on Convex
 * Cloud, the deployment, whose dashboard runs `setup:code` (there is no
 * container to `docker compose exec` into).
 */
export const deployment = query({
  args: {},
  returns: v.object({ site: v.string(), cloud: v.union(v.null(), v.object({ name: v.string(), functions: v.string() })) }),
  handler: async () => {
    const site = (process.env.CONVEX_SITE_URL ?? "").trim().replace(/\/+$/, "");
    return { site, cloud: convexCloud(site) };
  },
});

/**
 * A setup code, printed once and good for one `begin` within the hour. Run
 * with the deployment's admin key, which is what proves the person runs it:
 *
 *   docker compose exec app ./convex.sh run setup:code     # the compose file's
 *   npx convex run setup:code                              # Convex Cloud, or its dashboard's Functions page
 */
export const code = internalAction({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const made = secret("asf_setup_");
    await ctx.runMutation(internal.handshakes.offer, {
      digest: await digest(made), purpose: "setup code", expiresAt: Date.now() + HOUR,
    });
    return made;
  },
});

export const begin = action({
  args: { code: v.string(), host: v.string(), organization: v.string(), appUrl: v.string() },
  returns: v.object({ url: v.string(), manifest: v.string(), state: v.string() }),
  handler: async (ctx, asked) => {
    const host = hostOf(asked.host);
    const organization = asked.organization.trim();
    if (!/^[A-Za-z0-9-]*$/.test(organization)) throw new ConvexError(`"${organization}" is not an organization's login`);
    const appUrl = origin(asked.appUrl);
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) throw new ConvexError("the backend does not know its own site URL (CONVEX_SITE_ORIGIN), so GitHub would have nowhere to deliver webhooks");

    const taken = await ctx.runMutation(internal.handshakes.take, { digest: await digest(asked.code.trim()), purpose: "setup code" });
    if (taken === null) throw new ConvexError(NOT_A_SETUP_CODE);
    const state = secret("");
    await ctx.runMutation(internal.handshakes.offer, {
      digest: await digest(state), purpose: "setup", expiresAt: Date.now() + HOUR, host,
    });
    return {
      url: registrationUrl(host, organization, state),
      manifest: JSON.stringify(manifest({ appUrl, siteUrl, organization })),
      state,
    };
  },
});

export const complete = action({
  args: { code: v.string(), state: v.string() },
  returns: v.object({ slug: v.string(), installUrl: v.string(), settingsUrl: v.string() }),
  handler: async (ctx, { code: converting, state }) => {
    const begun = await ctx.runMutation(internal.handshakes.take, { digest: await digest(state), purpose: "setup" });
    if (begun === null || !begun.host) {
      throw new ConvexError("this registration was not begun here in the last hour: start the setup again");
    }
    try {
      const { app, settingsUrl } = await convert(new GitHub(begun.host), converting);
      await ctx.runMutation(internal.setup.registered, { app });
      return { slug: app.slug, installUrl: installUrl(app), settingsUrl };
    } catch (error) {
      if (error instanceof ForgeError) throw new ConvexError(error.message);
      throw error;
    }
  },
});

/**
 * Take on an App the account registered before, from what its settings page
 * hands over: its ID, a client secret and a private key, each generated there
 * beside the ones another cockpit holds, which keep working. It stays
 * installed where it is. GitHub is asked as the App whether the ID and the key
 * are one App's, and for the rest; a sign-in comes back to `callbackUrl`,
 * which the admin adds to the App's callback URLs (no API can). Where GitHub
 * could deliver here, its webhook is pointed here, with a secret of its own.
 *
 * The setup code is checked first and spent last: a mistyped ID or a key from
 * the wrong App costs the admin nothing but typing it again.
 */
export const adopt = action({
  args: {
    code: v.string(), host: v.string(), appId: v.string(), clientSecret: v.string(), privateKey: v.string(), appUrl: v.string(),
  },
  returns: v.object({
    slug: v.string(), installUrl: v.string(), settingsUrl: v.string(), callbackUrl: v.string(),
    /** Whether its webhook now delivers here; false where it was left as it was, and this cockpit learns by the poll. */
    webhook: v.boolean(),
  }),
  handler: async (ctx, asked) => {
    const host = hostOf(asked.host);
    const callbackUrl = `${origin(asked.appUrl)}/auth/callback`;
    const appId = asked.appId.trim();
    if (!/^\d+$/.test(appId)) throw new ConvexError(`"${asked.appId}" is not an App ID: it is the number at the top of the App's settings page`);
    const clientSecret = asked.clientSecret.trim();
    if (clientSecret === "") throw new ConvexError("a client secret is needed: generate one on the App's settings page — the ones in use keep working");
    const setupCode = await digest(asked.code.trim());
    if (!(await ctx.runQuery(internal.handshakes.held, { digest: setupCode, purpose: "setup code" }))) {
      throw new ConvexError(NOT_A_SETUP_CODE);
    }

    const key = { appId: Number(appId), privateKey: `${asked.privateKey.trim()}\n` };
    let jwt: string;
    try {
      jwt = await appJwt(key);
    } catch {
      throw new ConvexError("that is not a private key GitHub generated: give the whole .pem file, from -----BEGIN to -----END");
    }
    const github = new GitHub(host);
    try {
      const itself = await readApp(github, key.appId, jwt);
      if ((await ctx.runMutation(internal.handshakes.take, { digest: setupCode, purpose: "setup code" })) === null) {
        throw new ConvexError(NOT_A_SETUP_CODE);
      }
      // An App registered without a webhook subscribes to no events: pointed here, it would still send nothing.
      const hook = webhookUrl(process.env.CONVEX_SITE_URL ?? "");
      const webhookSecret = deliverable(hook) && itself.events.length > 0 ? secret("") : null;
      const webhook = webhookSecret !== null && await pointWebhook(github, jwt, hook, webhookSecret);
      const app: App = {
        host, ...key, slug: itself.slug, htmlUrl: itself.htmlUrl, clientId: itself.clientId, clientSecret,
        webhookSecret: webhook ? webhookSecret : null, callbackUrl,
      };
      await ctx.runMutation(internal.setup.registered, { app });
      return { slug: app.slug, installUrl: installUrl(app), settingsUrl: itself.settingsUrl, callbackUrl, webhook };
    } catch (error) {
      if (error instanceof ForgeError) throw new ConvexError(error.message);
      throw error;
    }
  },
});

export const registered = internalMutation({
  args: { app: appValidator },
  returns: v.null(),
  handler: async (ctx, { app }) => {
    // Everything that was the old App's goes with it: the people it signed
    // in (their tokens were that App's), and what it remembered of the forge.
    for (const old of await ctx.db.query("forgeApps").collect()) await ctx.db.delete(old._id);
    for (const admitted of await ctx.db.query("signIns").collect()) await ctx.db.delete(admitted._id);
    for (const viewer of await ctx.db.query("viewers").collect()) {
      await ctx.db.patch(viewer._id, { access: undefined, refresh: undefined });
    }
    for (const table of ["forgeAnswers", "forgeLimits", "forgeTokens", "discovery"] as const) {
      for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
    }
    await ctx.db.insert("forgeApps", app);
    return null;
  },
});

/** The GitHub host the admin named — github.com when they named none — or why it is not one. */
function hostOf(asked: string): string {
  const host = asked.trim().toLowerCase() || "github.com";
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/.test(host)) throw new ConvexError(`"${asked}" is not a host name`);
  return host;
}

function origin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.origin;
  } catch {
    // Said below, with what was given.
  }
  throw new ConvexError(`"${url}" is not where this cockpit is served`);
}
