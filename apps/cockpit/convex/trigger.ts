/**
 * Trigger a workflow on an issue from the cockpit (spec #40): apply the
 * workflow's route label, and the queued label beside it, AS THE VIEWER —
 * through the team's App on their own user access token, or with the token a
 * local cockpit holds. Nothing is started here: the factory's issues watcher
 * dequeues the issue on its next poll, as it would one a person labelled on
 * the forge, and records whoever the forge's `labeled` event names as the
 * run's trigger. So the forge is the record, and the authority: the cockpit
 * offers this from triage up because that is what the forge asks of a labeller.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, type ActionCtx, internalQuery } from "./_generated/server";
import { ForgeError, RateLimited } from "./forge/github";
import { open } from "./forge/open";
import { refusal, type Route, type Routes, routesOf, unoffered, unready } from "./model/trigger";
import { actAs, canRead, roleOn, viewing } from "./viewer";

type Refused = { ok: false; because: string };

/** What the factory's labels offer: its routes, and the labels that queue an issue and say a run has it. */
export type Offered = { ok: true; routes: Route[]; queued: string; running: string | null } | Refused;

export type Triggered = { ok: true; workflow: string; title: string; url: string } | Refused;

const UNREADABLE = "no such factory among the ones you can read";

/** What the forge said when it would not do something, as a refusal; anything else is thrown on. */
function forgeSaid(error: unknown): Refused {
  if (error instanceof ForgeError || error instanceof RateLimited) return { ok: false, because: error.message };
  throw error;
}

/** Who is asking, and whether the forge lets them read `factory` and label its issues. */
export const asking = internalQuery({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, signIn }): Promise<
    { reads: boolean; because: string | null; actor: Id<"viewers"> | null }> => {
    const who = await viewing(ctx, signIn);
    if (who.viewer === null) {
      const because = who.mode === "team" ? "sign in to trigger a workflow"
        : "this cockpit holds no forge token to label with: run `gh auth login`, then `asf up` again";
      return { reads: who.mode === "local", because, actor: null };
    }
    const reads = await canRead(ctx, who, factory);
    return {
      reads,
      because: reads ? refusal(await roleOn(ctx, who.viewer, factory)) : UNREADABLE,
      actor: who.mode === "team" ? who.viewer._id : null,
    };
  },
});

/**
 * The workflows `factory` can be triggered with: the route labels its
 * repository defines, as `asf labels --create` described them, and its
 * queued label. Read on the cockpit's own credential.
 */
export const routes = action({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Offered> => {
    const asked: { reads: boolean } = await ctx.runQuery(internal.trigger.asking, args);
    if (!asked.reads) return { ok: false, because: UNREADABLE };
    return await offered(ctx, args.factory);
  },
});

async function offered(ctx: ActionCtx, factory: string): Promise<Offered> {
  const opened = await open(ctx);
  if (opened === null) return { ok: false, because: "this cockpit has no forge credential to read labels with" };
  try {
    const labels = await opened.forge.labels(factory);
    if (labels === null) return { ok: false, because: `the forge does not show ${factory}'s labels to this cockpit` };
    const found = routesOf(labels);
    const because = unoffered(found);
    return because === null ? { ok: true, ...found, queued: found.queued! } : { ok: false, because };
  } catch (error) {
    return forgeSaid(error);
  } finally {
    await opened.close();
  }
}

/** The issue as the forge holds it, if it is one the watcher would start on these labels. */
async function ready(ctx: ActionCtx, factory: string, number: number, found: Routes):
  Promise<{ ok: true; title: string; url: string } | Refused> {
  const opened = await open(ctx);
  if (opened === null) return { ok: false, because: "this cockpit has no forge credential to read the issue with" };
  try {
    const issue = await opened.forge.issue(factory, number);
    if (issue === null) return { ok: false, because: `the forge shows no issue #${number} on ${factory}` };
    const because = unready(issue, found);
    return because === null ? { ok: true, title: issue.title, url: issue.url } : { ok: false, because };
  } catch (error) {
    return forgeSaid(error);
  } finally {
    await opened.close();
  }
}

/**
 * Label issue `issue` of `factory` with the route `label` and the queued
 * label, as the viewer. What the forge or the watcher would refuse or get
 * wrong — below triage, a label that routes nothing, an issue that is closed,
 * missing, a pull request, already queued or already a run's — is refused
 * here first, and nothing is labelled then. Done means the labels are on the
 * issue; the run is the watcher's to start.
 */
export const trigger = action({
  args: { factory: v.string(), issue: v.number(), label: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Triggered> => {
    const asked: { because: string | null; actor: Id<"viewers"> | null } =
      await ctx.runQuery(internal.trigger.asking, { factory: args.factory, signIn: args.signIn });
    if (asked.because !== null) return { ok: false, because: asked.because };
    const found = await offered(ctx, args.factory);
    if (!found.ok) return found;
    const route = found.routes.find(({ label }) => label === args.label);
    if (route === undefined) return { ok: false, because: `${args.label} is not a route label on ${args.factory}` };
    const issue = await ready(ctx, args.factory, args.issue, found);
    if (!issue.ok) return issue;

    let user: string | undefined;
    try {
      if (asked.actor !== null) user = await actAs(ctx, asked.actor);
    } catch (error) {
      if (error instanceof ForgeError && error.status === 401) {
        return { ok: false, because: "your sign-in has run out: sign in again to trigger a workflow" };
      }
      throw error;
    }
    const opened = await open(ctx, { user });
    if (opened === null) return { ok: false, because: "this cockpit has no forge credential to label with" };
    try {
      await opened.forge.label(args.factory, args.issue, [route.label, found.queued]);
    } catch (error) {
      return forgeSaid(error);
    } finally {
      await opened.close();
    }
    return { ok: true, workflow: route.workflow, title: issue.title, url: issue.url };
  },
});
