/**
 * Claims (spec #40, ADR 0003): a shared cockpit decides which station starts
 * a work item, because the forge label cannot.
 *
 * A station asks `/claims` with its factory's ingest token before it touches
 * a label — the issues and pull-request watchers, and `asf run <workflow> <n>`
 * by hand (`--force` skips the asking) — and `take` grants or refuses it in
 * one transaction, so two stations asking at once cannot both be granted.
 * Ingest frees a claim when its session's events say the run finished or was
 * aborted (`settleClaims`); a failure keeps it, and so does a station being
 * offline. Otherwise only a writer frees one, with Release claim (`release`):
 * the claim is let go, recorded as theirs, and the item is relabelled as the
 * claim says, as them.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, type MutationCtx, query, type QueryCtx } from "./_generated/server";
import { ForgeError, RateLimited } from "./forge/github";
import { open } from "./forge/open";
import { stateOf } from "./items";
import { askedValidator, type Asked, type ClaimView, consequence, type Released, sameHolder, settles } from "./model/claim";
import { writes } from "./model/command";
import type { StoredEvent } from "./model/wire";
import { anonymous, attendedAt, roleOf } from "./commands";
import { stationOf } from "./stations";
import { actAs, canRead, readable, viewing, type Viewing } from "./viewer";

async function heldFor(ctx: QueryCtx, asked: Pick<Asked, "repo" | "kind" | "number">): Promise<Doc<"claims"> | null> {
  return await ctx.db
    .query("claims")
    .withIndex("by_item", (q) => q.eq("repo", asked.repo).eq("kind", asked.kind).eq("number", asked.number).eq("held", true))
    .first();
}

/** Who abandoned `session` of `factory` by releasing a claim it held, or null when nobody has. */
async function abandonedBy(ctx: QueryCtx, factory: string, session: string): Promise<string | null> {
  const rows = await ctx.db.query("claims").withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session)).collect();
  return rows.find((row) => row.released?.why === "released")?.released?.by ?? null;
}

async function letGo(ctx: MutationCtx, claim: Doc<"claims">, why: Released["why"], by = ""): Promise<void> {
  await ctx.db.patch(claim._id, { held: false, released: { at: Date.now(), by, why } });
}

// ── the wire ─────────────────────────────────────────────────────────────────

/**
 * Grant `factory`'s station the claim `asked` describes — or say who holds
 * it, or that a writer abandoned the session it is for. One mutation, so it is
 * one transaction: of two stations asking at once, the second sees the first's
 * row and is refused.
 *
 * An abandoned session gets no claim again, on any item: a writer released
 * one it held so that the item could start afresh elsewhere, and a resume of
 * it — which asks — must not carry it on beside that new run.
 */
export const take = internalMutation({
  args: { factory: v.string(), asked: askedValidator },
  handler: async (ctx, { factory, asked }) => {
    const by = await abandonedBy(ctx, factory, asked.session);
    if (by !== null) return { granted: false as const, abandoned: { session: asked.session, by } };
    const held = await heldFor(ctx, asked);
    if (held !== null && !sameHolder(held, asked)) {
      return { granted: false as const, held: { station: held.station, name: held.stationName, session: held.session } };
    }
    if (held === null) {
      await ctx.db.insert("claims", {
        factory, repo: asked.repo, kind: asked.kind, number: asked.number, station: asked.station.id,
        stationName: asked.station.name, session: asked.session, since: asked.since, requeue: asked.requeue,
        grantedAt: Date.now(), aborted: false, held: true, released: null,
      });
    }
    return { granted: true as const };
  },
});

/**
 * Give back a claim its own station took for a session that never started —
 * its label would not flip, or its run died first. Nobody else's: false
 * unless the held claim is this station's, for exactly this session.
 */
export const drop = internalMutation({
  args: { factory: v.string(), asked: askedValidator },
  handler: async (ctx, { asked }) => {
    const held = await heldFor(ctx, asked);
    if (held === null || !sameHolder(held, asked)) return { dropped: false };
    await letGo(ctx, held, "never started");
    return { dropped: true };
  },
});

/**
 * Free the claims a session holds once `events` — what ingest just made
 * contiguous, in seq order — say its run finished or was aborted. Called by
 * ingest, so each event is read once.
 */
export async function settleClaims(ctx: MutationCtx, factory: string, session: string, events: StoredEvent[]): Promise<void> {
  if (!events.some((event) => event.kind === "session_finished" || event.kind === "decision_recorded")) return;
  const held = await ctx.db
    .query("claims")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session).eq("held", true))
    .collect();
  for (const claim of held) {
    const settled = settles(claim, events);
    if (settled.released !== null) await letGo(ctx, claim, settled.released);
    else if (settled.aborted !== claim.aborted) await ctx.db.patch(claim._id, { aborted: settled.aborted });
  }
}

// ── what the session page shows ──────────────────────────────────────────────

/** Why the viewer may not release a claim on `factory`, or null when they may. */
async function releaseRefusal(ctx: QueryCtx, who: Viewing, factory: string): Promise<string | null> {
  const nobody = anonymous(who, "release a claim");
  if (nobody !== null) return nobody;
  const role = await roleOf(ctx, who, factory);
  if (writes(role)) return null;
  return role === null ? "the forge has not said what you may do on this repository"
    : `releasing a claim needs write on this repository, and the forge says you have ${role}`;
}

/** `rows` of `factory` as the viewer is shown them: what releasing each would do, and whether they may. */
async function viewsOf(ctx: QueryCtx, who: Viewing, factory: string, rows: Doc<"claims">[]): Promise<ClaimView[]> {
  const refused = await releaseRefusal(ctx, who, factory);
  return await Promise.all(rows.map(async (row) => {
    const seenAt = (await stationOf(ctx, factory, row.station))?.seenAt ?? 0;
    return {
      id: row._id, kind: row.kind, number: row.number, repo: row.repo,
      state: await stateOf(ctx, row.repo, row.kind, row.number), session: row.session, station: row.station,
      stationName: row.stationName, seenAt,
      heardAt: Math.max(seenAt, (await attendedAt(ctx, factory, row.session)) ?? 0, row.grantedAt),
      grantedAt: row.grantedAt, released: row.released, consequence: consequence(row), refused: row.held ? refused : null,
    };
  }));
}

/**
 * Every claim a session took, newest first: on which item, by which station
 * and how recently that station was seen, what releasing it would do, and —
 * once let go — when, why and by whom. [] for a session the viewer cannot read.
 */
export const ofSession = query({
  args: { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, session, signIn }): Promise<ClaimView[]> => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    if (factory === null) return [];
    const rows = (await ctx.db.query("claims").withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session)).collect())
      .sort((a, b) => b.grantedAt - a.grantedAt);
    return await viewsOf(ctx, who, factory, rows);
  },
});

/** Every claim `factory`'s stations hold now, oldest first, as `who` is shown them — who must be allowed to read it. */
export async function heldOn(ctx: QueryCtx, who: Viewing, factory: string): Promise<ClaimView[]> {
  const rows = await ctx.db.query("claims").withIndex("by_factory", (q) => q.eq("factory", factory).eq("held", true)).collect();
  return await viewsOf(ctx, who, factory, rows.sort((a, b) => a.grantedAt - b.grantedAt));
}

// ── a writer's Release claim ─────────────────────────────────────────────────

type Freed =
  | { ok: true; actor: Id<"viewers"> | null; repo: string; number: number; add: string[]; remove: string[] }
  | { ok: false; because: string };

/** Let a claim go as the viewer, if they may: what the forge must then be asked to put back. */
export const free = internalMutation({
  args: { claim: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { claim, signIn }): Promise<Freed> => {
    const who = await viewing(ctx, signIn);
    const id = ctx.db.normalizeId("claims", claim);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null || !(await canRead(ctx, who, row.factory))) return { ok: false, because: "no such claim among the ones you can read" };
    const because = await releaseRefusal(ctx, who, row.factory);
    if (because !== null) return { ok: false, because };
    if (!row.held) return { ok: false, because: "this claim was already let go" };
    await letGo(ctx, row, "released", who.viewer!.login);
    return {
      ok: true, actor: who.mode === "team" ? who.viewer!._id : null, repo: row.repo, number: row.number,
      add: row.requeue.add, remove: row.requeue.remove,
    };
  },
});

export type ReleaseResult = { ok: true; relabelled: true } | { ok: true; relabelled: false; because: string } |
  { ok: false; because: string };

/**
 * Release a claim, as a writer: it is let go at once — recorded as theirs,
 * the session it was for abandoned — and the item is put back as the claim
 * says, as them, so a watcher starts it afresh. A forge that will not relabel
 * leaves the claim released all the same, and says what to do by hand.
 */
export const release = action({
  args: { claim: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ReleaseResult> => {
    const freed: Freed = await ctx.runMutation(internal.claims.free, args);
    if (!freed.ok) return freed;
    const byHand = (why: string): ReleaseResult => ({
      ok: true, relabelled: false, because: `the claim is released, but ${why} — relabel #${freed.number} by hand`,
    });
    if (!freed.add.length && !freed.remove.length) return { ok: true, relabelled: true };
    let user: string | undefined;
    try {
      if (freed.actor !== null) user = await actAs(ctx, freed.actor);
    } catch (error) {
      if (error instanceof ForgeError) return byHand("your sign-in has run out, so the forge was not asked");
      throw error;
    }
    const opened = await open(ctx, { user });
    if (opened === null) return byHand("this cockpit has no forge credential to label with");
    try {
      if (freed.add.length) await opened.forge.label(freed.repo, freed.number, freed.add);
      for (const label of freed.remove) await opened.forge.unlabel(freed.repo, freed.number, label);
    } catch (error) {
      if (error instanceof ForgeError || error instanceof RateLimited) return byHand(`the forge said: ${error.message}`);
      throw error;
    } finally {
      await opened.close();
    }
    return { ok: true, relabelled: true };
  },
});
