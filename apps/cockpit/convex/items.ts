/**
 * Where a work item a page names stands on the forge, as the poll last read
 * it (discovery.ts `items`): what its icon is drawn in. Null is not known —
 * not read yet, or of a repository the poll does not follow — and is drawn
 * as it always was, in no state at all.
 */
import type { QueryCtx } from "./_generated/server";
import { type ItemState, repoKey } from "./forge/forge";
import { issueNumber, prNumber } from "./model/session";

/** A session's issue and pull request, each where it stands; null for one it has none of, or not known. */
export interface ItemStates {
  issue: ItemState | null;
  pr: ItemState | null;
}

/** Where issue (or, `pull`, pull request) `number` of `repo` stands, or null when that is not known. */
export async function stateOf(ctx: QueryCtx, repo: string, pull: boolean, number: number): Promise<ItemState | null> {
  if (!number) return null;
  const known = await ctx.db.query("forgeItems")
    .withIndex("by_item", (q) => q.eq("repo", repoKey(repo)).eq("number", number)).unique();
  // A number the forge says is the other kind is not the item the page means.
  return known !== null && known.pull === pull ? known.state : null;
}

/** Where the issue and the pull request a session of `factory` names stand. */
export async function statesOf(ctx: QueryCtx, factory: string, named: { issueUrl: string; prUrl: string }): Promise<ItemStates> {
  return {
    issue: await stateOf(ctx, factory, false, Number(issueNumber(named.issueUrl))),
    pr: await stateOf(ctx, factory, true, Number(prNumber(named.prUrl))),
  };
}
