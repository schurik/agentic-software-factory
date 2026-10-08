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
 * The setup code is what makes the person at the setup page an admin: before
 * an App exists nobody can sign in, so the one thing that can be checked is
 * that they can run a function on the deployment. Presenting a fresh code
 * registers again, which replaces the App — the way out of a registration
 * under the wrong account.
 */
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, query } from "./_generated/server";
import { appValidator, convert, deliverable, installUrl, manifest, registrationUrl, webhookUrl } from "./forge/app";
import { ForgeError, GitHub } from "./forge/github";
import { digest, secret } from "./model/digest";

const HOUR = 3600_000;

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
    const host = asked.host.trim().toLowerCase() || "github.com";
    const organization = asked.organization.trim();
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/.test(host)) throw new ConvexError(`"${asked.host}" is not a host name`);
    if (!/^[A-Za-z0-9-]*$/.test(organization)) throw new ConvexError(`"${organization}" is not an organization's login`);
    const appUrl = origin(asked.appUrl);
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) throw new ConvexError("the backend does not know its own site URL (CONVEX_SITE_ORIGIN), so GitHub would have nowhere to deliver webhooks");

    const taken = await ctx.runMutation(internal.handshakes.take, { digest: await digest(asked.code.trim()), purpose: "setup code" });
    if (taken === null) {
      throw new ConvexError("that is not a setup code this deployment printed in the last hour: run `setup:code` again on the deployment these pages use, as this page shows, for a fresh one");
    }
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
  returns: v.object({ slug: v.string(), installUrl: v.string() }),
  handler: async (ctx, { code: converting, state }) => {
    const begun = await ctx.runMutation(internal.handshakes.take, { digest: await digest(state), purpose: "setup" });
    if (begun === null || !begun.host) {
      throw new ConvexError("this registration was not begun here in the last hour: start the setup again");
    }
    try {
      const app = await convert(new GitHub(begun.host), converting);
      await ctx.runMutation(internal.setup.registered, { app });
      return { slug: app.slug, installUrl: installUrl(app) };
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

function origin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.origin;
  } catch {
    // Said below, with what was given.
  }
  throw new ConvexError(`"${url}" is not where this cockpit is served`);
}
