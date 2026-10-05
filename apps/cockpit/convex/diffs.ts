/**
 * A session's diffs, read from the forge.
 *
 * No diff travels in an event (CLAUDE.md, invariant 11): what a commit phase
 * changed is the forge's diff of the commit its `committed` names, and what
 * the session changed is the forge's comparison of the commit it started from
 * (`base_commit`) with the latest one it made. Commits, never the branch: what
 * is shown is what was made, not wherever the branch has moved since. What is
 * read is shown and forgotten; the cockpit stores no diff.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, type ActionCtx, internalQuery } from "./_generated/server";
import type { Forge } from "./forge/forge";
import { forgeSaid, open } from "./forge/open";
import { Payload } from "./model/payload";
import { view } from "./model/session";
import { storedSession } from "./sessions";

export type Read = { ok: true; diff: string } | { ok: false; because: string };

/** What to ask the forge for: one commit's diff, or two commits' comparison. */
export type Located = { repo: string; sha: string } | { repo: string; base: string; head: string };

const NO_CREDENTIAL = "this cockpit has no forge credential to read it with";

/** The commit `sha`, if a session the viewer may see made it. */
export const locateCommit = internalQuery({
  args: { factory: v.string(), session: v.string(), sha: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, sha, signIn }): Promise<Located | { because: string }> => {
    const stored = await storedSession(ctx, factory, session, signIn);
    const made = stored?.events.some((event) => event.kind === "committed" && Payload.parse(event.payload).str("sha") === sha);
    if (!stored || !made) return { because: "no such commit in a session you can see" };
    return { repo: stored.factory, sha };
  },
});

/** The commit a session the viewer may see started from, and the latest one it made. */
export const locateChanges = internalQuery({
  args: { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, signIn }): Promise<Located | { because: string }> => {
    const stored = await storedSession(ctx, factory, session, signIn);
    if (!stored) return { because: "no such session among the ones you can see" };
    const { story } = view(stored.events, stored.acked);
    if (!story.headCommit) return { because: "the session has committed nothing yet" };
    if (!story.baseCommit) return { because: "the factory named no commit the session started from" };
    return { repo: stored.factory, base: story.baseCommit, head: story.headCommit };
  },
});

/** What commit `sha` of a session changed, as the forge shows it. */
export const commit = action({
  args: { factory: v.string(), session: v.string(), sha: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Read> =>
    await read(ctx, await ctx.runQuery(internal.diffs.locateCommit, args)),
});

/** What a session changed, from the commit it started from to the latest one it made, as the forge shows it. */
export const changes = action({
  args: { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Read> =>
    await read(ctx, await ctx.runQuery(internal.diffs.locateChanges, args)),
});

/**
 * The diff `located` names, on the cockpit's own credential, like a repo
 * artifact (artifacts.ts): whether the viewer may see it is the mirror's word,
 * asked before the forge is.
 */
export async function read(ctx: ActionCtx, located: Located | { because: string }): Promise<Read> {
  if ("because" in located) return { ok: false, because: located.because };
  const opened = await open(ctx);
  if (opened === null) return { ok: false, because: NO_CREDENTIAL };
  let diff: string | null;
  try {
    diff = await ask(opened.forge, located);
  } catch (error) {
    return forgeSaid(error);
  } finally {
    await opened.close();
  }
  if (diff !== null) return { ok: true, diff };
  const what = "sha" in located ? `commit ${located.sha.slice(0, 7)}`
    : `a diff of ${located.base.slice(0, 7)} and ${located.head.slice(0, 7)}`;
  return { ok: false, because: `the forge does not show ${what} to this cockpit: the branch may not be pushed, or was deleted` };
}

function ask(forge: Forge, located: Located): Promise<string | null> {
  return "sha" in located ? forge.commitDiff(located.repo, located.sha) : forge.compare(located.repo, located.base, located.head);
}
