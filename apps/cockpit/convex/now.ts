/**
 * Now (#115): the home page, as one query for the viewer across every factory
 * the permission mirror lets them read — the gates waiting on them (the
 * inbox), what needs attention, what is running, and the gates waiting on
 * someone else.
 *
 * It gathers facts and leaves the judging to the page, by its own clock, as
 * the attention rule always has: whether a failure is still news, a session
 * stuck in a phase, a wait long or a spend close to its ceiling
 * (`model/attention.ts`). A query that read the clock would keep calling old
 * news new until something else re-ran it.
 *
 * Where each running session is in its workflow — its stage graph — is not
 * here: that is the session's events folded, a query of its own per row
 * (`sessions.progress`), so one long session cannot make the whole page heavy.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { attentionOf, recentOf } from "./activity";
import { defaultCheck, repoOf } from "./factory";
import { readableFactories } from "./factories";
import { type Other, waitsFor } from "./inbox";
import type { Facts } from "./model/attention";
import { readDescription } from "./model/description";
import type { Row } from "./model/inbox";
import { viewing } from "./viewer";

/** A session running now, as Now's Running lists it. */
export interface Running {
  factory: string;
  session: string;
  /** What it was asked: `#42 title`, or the prompt. */
  title: string;
  workflow: string;
  issueUrl: string;
  prUrl: string;
  startedAt: string;
  /** What it spent so far, list-price equivalent. */
  cost: number;
  /** Its factory's per-session cost ceiling; 0 for none, or none known. */
  ceiling: number;
}

export interface NowPage {
  inbox: Row[];
  /** What needs attention is read from, by factory: the page judges it at its own clock. */
  attention: { factory: string; facts: Facts }[];
  running: Running[];
  others: Other[];
}

export const page = query({
  args: { signIn: v.optional(v.string()) },
  handler: async (ctx, { signIn }): Promise<NowPage | null> => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return null;
    const attention: NowPage["attention"] = [];
    const running: Running[] = [];
    for (const { names: [factory] } of await readableFactories(ctx, who, true)) {
      const known = await recentOf(ctx, factory);
      attention.push({ factory, facts: await attentionOf(ctx, who, factory, known) });
      const live = known.filter(({ summary }) => summary.status === "running");
      if (!live.length) continue;
      const check = await defaultCheck(ctx, factory, (await repoOf(ctx, factory))?.defaultBranch || null);
      const ceiling = check ? readDescription(check.description).budget.maxCostUsd : 0;
      for (const { session, summary } of live) {
        running.push({
          factory, session, title: summary.request, workflow: summary.workflow || (summary.workflows.at(-1) ?? ""),
          issueUrl: summary.issueUrl, prUrl: summary.prUrl, startedAt: summary.startedAt, cost: summary.totalCost, ceiling,
        });
      }
    }
    const waits = await waitsFor(ctx, who, true);
    return {
      inbox: waits.mine,
      attention,
      // The longest-running first: what has been going longest is likeliest stuck.
      running: running.sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      others: waits.others,
    };
  },
});
