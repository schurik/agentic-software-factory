/**
 * Stations a person approved to take commands (spec #40).
 *
 * Registering is a device flow, so no secret is copy-pasted and no forge
 * credential reaches the cockpit from a station:
 *
 *   1. `asf station register` asks `/station/register` — with the factory's
 *      ingest token, which says which factory the station is, or with none,
 *      naming its factory (its origin remote) itself — and gets a code to
 *      show and a device secret to poll with (`request`);
 *   2. a person signed in to the cockpit, with write on that factory, opens
 *      the approval page and approves the code (`approve`): the station
 *      becomes theirs;
 *   3. the station's next poll of `/station/register/poll` is handed a command
 *      token — that person's, for this station alone — of which only the
 *      digest is kept (`handOver`); and, when it asked without an ingest
 *      token, one of those for its factory as well, issued by its approver.
 *
 * Asked without a token, a request is something anyone who can reach the
 * site can make, naming any repository: the approval is then the only gate.
 * So the page names the repository, the station and the host before its
 * button, and what may wait is limited per source and per factory
 * (OPEN_PER_SOURCE), as well as running out.
 *
 * Revoking that token (`revoke`) is what takes a station offline for
 * commands: its polls are refused, and nothing reaches it. A local cockpit is
 * one person's, so its station is theirs without a flow at all (`local`).
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, type MutationCtx, query, type QueryCtx } from "./_generated/server";
import { LAPSED_PER_WRITE } from "./handshakes";
import { normalCode, OPEN_PER_FACTORY, OPEN_PER_SOURCE, REGISTRATION_FOR, stationFieldsValidator, writes } from "./model/command";
import { digest, secret } from "./model/digest";
import { spellingFor } from "./spelling";
import { keepToken, replaceStationToken, tokenBy } from "./tokens";
import { canRead, readable, roleOn, viewing, type Viewing } from "./viewer";

type Result = { ok: true } | { ok: false; because: string };

/** The station `station` of `factory`, as registered — or null. */
export async function stationOf(ctx: QueryCtx, factory: string, station: string): Promise<Doc<"stations"> | null> {
  return await ctx.db
    .query("stations")
    .withIndex("by_station", (q) => q.eq("factory", factory).eq("station", station))
    .unique();
}

/** A station as it asks to be registered: which factory's, its id, and what it calls itself. */
type Asking = Pick<Doc<"registrations">, "factory" | "station" | "name" | "kind">;

/** Make the station `asking` describes the owner's, holding the token with digest `token`. */
async function own(ctx: MutationCtx, asking: Asking, owner: Doc<"viewers"> | null, token: string): Promise<void> {
  const { factory, station, name, kind } = asking;
  const facts = { name, kind, owner: owner?._id ?? null, ownerLogin: owner?.login ?? "", token };
  const known = await stationOf(ctx, factory, station);
  if (known === null) await ctx.db.insert("stations", { factory, station, ...facts, seenAt: 0, report: null });
  else await ctx.db.patch(known._id, facts);       // its owner registering again rotates the token
}

// ── 1. a station asks ────────────────────────────────────────────────────────

/**
 * Keep a station's request: for the factory whose ingest token digests to
 * `ingest`, or — asked without one — for the `factory` it names, when no more
 * open requests wait from its `source` or for that factory than may. Refused
 * with the status the station is answered with.
 */
export const request = internalMutation({
  args: {
    ingest: v.optional(v.string()), factory: v.optional(v.string()), source: v.optional(v.string()),
    host: v.string(), device: v.string(), code: v.string(), station: stationFieldsValidator,
  },
  returns: v.union(
    v.object({ ok: v.literal(true), factory: v.string() }),
    v.object({ ok: v.literal(false), status: v.number(), because: v.string() }),
  ),
  handler: async (ctx, { ingest, factory: named, source, host, device, code, station }) => {
    // Anyone can ask and walk away: each request clears out what has run
    // out, so the table holds what is pending, and the limits count that.
    const now = Date.now();
    const lapsed = await ctx.db
      .query("registrations")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", now))
      .take(LAPSED_PER_WRITE);
    for (const gone of lapsed) await ctx.db.delete(gone._id);

    const asking = { device, code, station: station.id, name: station.name, kind: station.kind, host,
                     expiresAt: now + REGISTRATION_FOR, approvedBy: null };
    if (ingest !== undefined) {
      const token = await tokenBy(ctx, ingest);
      if (token === null) return { ok: false as const, status: 401, because: "this ingest token is not one the cockpit issued, or it was revoked" };
      await ctx.db.insert("registrations", { ...asking, factory: token.factory });
      return { ok: true as const, factory: token.factory };
    }

    const factory = await spellingFor(ctx, named ?? "");
    const from = source || "unknown";
    const fromThere = await ctx.db.query("registrations")
      .withIndex("by_source", (q) => q.eq("source", from).gt("expiresAt", now))
      .take(OPEN_PER_SOURCE);
    if (fromThere.length >= OPEN_PER_SOURCE) {
      return { ok: false as const, status: 429, because: `${OPEN_PER_SOURCE} registrations from where this one came are waiting already: approve one, or let them run out` };
    }
    const forIt = await ctx.db.query("registrations")
      .withIndex("by_factory", (q) => q.eq("factory", factory).gt("expiresAt", now))
      .filter((q) => q.eq(q.field("open"), true))
      .take(OPEN_PER_FACTORY);
    if (forIt.length >= OPEN_PER_FACTORY) {
      return { ok: false as const, status: 429, because: `${OPEN_PER_FACTORY} registrations without an ingest token are waiting for ${factory} already: approve one, or let them run out` };
    }
    await ctx.db.insert("registrations", { ...asking, factory, open: true, source: from });
    return { ok: true as const, factory };
  },
});

// ── 2. a person approves ─────────────────────────────────────────────────────

async function pendingBy(ctx: QueryCtx, code: string): Promise<Doc<"registrations"> | null> {
  const asked = await ctx.db.query("registrations").withIndex("by_code", (q) => q.eq("code", normalCode(code))).first();
  return asked !== null && Date.now() < asked.expiresAt ? asked : null;
}

/**
 * Why the viewer may not approve `asking`, or null when they may. A station
 * that holds a live token is its owner's: a station's id is no secret (every
 * session names it), so anyone else approving it would take it over, and
 * with it the commands its owner sends. Its owner revokes it first.
 */
async function approvalRefusal(ctx: QueryCtx, signIn: string | undefined, asking: Asking):
    Promise<{ because: string } | { viewer: Doc<"viewers"> }> {
  const who = await viewing(ctx, signIn);
  if (who.viewer === null) {
    return { because: who.mode === "team" ? "sign in to approve a station"
      : "this cockpit holds no forge token, so it cannot say whose station this is: `gh auth login`, then `asf up` again" };
  }
  if (who.mode === "local") return { viewer: who.viewer };
  const role = await roleOn(ctx, who.viewer, asking.factory);
  if (!writes(role)) {
    return { because: role === null ? `${asking.factory} is not a repository the forge lets you read`
      : `a station takes commands for its owner, which needs write on ${asking.factory}; the forge says you have ${role}` };
  }
  const known = await stationOf(ctx, asking.factory, asking.station);
  if (known !== null && known.token !== null && known.owner !== who.viewer._id) {
    return { because: `${known.name} is ${known.ownerLogin || "someone else"}'s station: they register it again, or revoke it first` };
  }
  return { viewer: who.viewer };
}

/** What the approval page shows for `code`: the station asking, and whether the viewer may approve it. */
export const pending = query({
  args: { code: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { code, signIn }) => {
    const asked = await pendingBy(ctx, code);
    // A code is not a way to learn which repositories exist.
    if (asked === null || !(await canRead(ctx, await viewing(ctx, signIn), asked.factory))) return null;
    const decided = await approvalRefusal(ctx, signIn, asked);
    return {
      code: asked.code, factory: asked.factory, name: asked.name, kind: asked.kind, station: asked.station,
      host: asked.host ?? "", from: asked.source ?? "", open: asked.open === true,
      expiresAt: asked.expiresAt, approved: asked.approvedBy !== null,
      because: "because" in decided ? decided.because : null,
    };
  },
});

/**
 * Every station asking to become one of `factory`'s, oldest first, as its
 * Stations tab lists them over its cards, with whether — and why not — the
 * viewer may approve each. Never its code: the approver types the one the
 * station's terminal shows, which is what proves they saw that terminal and
 * not a look-alike name in a list. Null for a factory the viewer cannot read.
 * What ran out is left out here as `pendingBy` leaves it; the page's clock
 * leaves out what runs out while it is open.
 */
export const registrations = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }) => {
    const factory = await readable(ctx, await viewing(ctx, signIn), named);
    if (factory === null) return null;
    const asking = await ctx.db.query("registrations")
      .withIndex("by_factory", (q) => q.eq("factory", factory).gt("expiresAt", Date.now()))
      .collect();
    return await Promise.all(asking.map(async (asked) => {
      const decided = await approvalRefusal(ctx, signIn, asked);
      return {
        station: asked.station, name: asked.name, kind: asked.kind, host: asked.host ?? "", open: asked.open === true,
        expiresAt: asked.expiresAt, approved: asked.approvedBy !== null, because: "because" in decided ? decided.because : null,
      };
    }));
  },
});

export const approve = mutation({
  args: { code: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { code, signIn }): Promise<Result> => {
    const asked = await pendingBy(ctx, code);
    if (asked === null) return { ok: false, because: "no station is waiting on that code: it may have expired — run `asf station register` again" };
    const decided = await approvalRefusal(ctx, signIn, asked);
    if ("because" in decided) return { ok: false, because: decided.because };
    if (asked.approvedBy !== null && asked.approvedBy !== decided.viewer._id) {
      return { ok: false, because: "someone else approved this station already" };
    }
    await ctx.db.patch(asked._id, { approvedBy: decided.viewer._id });
    return { ok: true };
  },
});

// ── 3. the station is handed its token ───────────────────────────────────────

/** Where the request with this device digest stands. */
export const registration = internalQuery({
  args: { device: v.string() },
  returns: v.union(v.literal("pending"), v.literal("approved"), v.literal("expired")),
  handler: async (ctx, { device }) => {
    const asked = await ctx.db.query("registrations").withIndex("by_device", (q) => q.eq("device", device)).unique();
    if (asked === null || Date.now() >= asked.expiresAt) return "expired";
    return asked.approvedBy === null ? "pending" : "approved";
  },
});

/**
 * Register the approved station behind `device` as its approver's, holding the
 * command token whose digest is `token`, and spend the request — or say it is
 * still pending, or gone. A request asked without an ingest token keeps
 * `ingest` too, as its factory's ingest token for this station, issued by
 * its approver, and says so (`open: true`), so the station is handed it.
 * Either way the ingest token an earlier registration of the station was
 * handed is revoked: the station keeps one credential file, and the one it
 * wrote now no longer holds that token, so nothing would ever use it again.
 */
export const handOver = internalMutation({
  args: { device: v.string(), token: v.string(), ingest: v.string() },
  returns: v.union(
    v.object({ state: v.literal("approved"), owner: v.string(), station: v.string(), open: v.boolean() }),
    v.object({ state: v.union(v.literal("pending"), v.literal("expired")) }),
  ),
  handler: async (ctx, { device, token, ingest }) => {
    const asked = await ctx.db.query("registrations").withIndex("by_device", (q) => q.eq("device", device)).unique();
    if (asked === null || Date.now() >= asked.expiresAt) return { state: "expired" as const };
    if (asked.approvedBy === null) return { state: "pending" as const };
    const owner = await ctx.db.get(asked.approvedBy);
    await own(ctx, asked, owner, token);
    const open = asked.open === true;
    await replaceStationToken(ctx, asked.factory, asked.station);
    if (open) {
      await keepToken(ctx, asked.factory, ingest, { kind: "station", label: asked.name, station: asked.station, issuedBy: owner });
    }
    await ctx.db.delete(asked._id);
    return { state: "approved" as const, owner: owner?.login ?? "", station: asked.station, open };
  },
});

// ── a local cockpit's own station ────────────────────────────────────────────

/**
 * Issue `factory`'s station `station` a command token, owned by the person
 * whose forge token this local cockpit holds — nobody approves it, because the
 * machine is theirs. Internal, so it runs only with the deployment's admin key,
 * which is what `asf up` calls it with:
 *
 *   ./convex.sh run stations:local '{"factory": "acme/widgets", "station": {…}}'
 */
export const local = internalAction({
  args: { factory: v.string(), station: stationFieldsValidator },
  returns: v.object({ token: v.string(), owner: v.string() }),
  handler: async (ctx, { factory, station }): Promise<{ token: string; owner: string }> => {
    const token = secret("asf_station_");
    const owner: string = await ctx.runMutation(internal.stations.ownLocally, { factory, station, token: await digest(token) });
    return { token, owner };
  },
});

export const ownLocally = internalMutation({
  args: { factory: v.string(), station: stationFieldsValidator, token: v.string() },
  returns: v.string(),
  handler: async (ctx, { factory, station, token }) => {
    const owner = await ctx.db.query("viewers").withIndex("by_local", (q) => q.eq("local", true)).first();
    await own(ctx, { factory, station: station.id, name: station.name, kind: station.kind }, owner, token);
    return owner?.login ?? "";
  },
});

// ── the owner's stations ─────────────────────────────────────────────────────

/** May the viewer revoke `row`'s token: its owner may, and so may an admin of its repository. */
export async function mayRevoke(ctx: QueryCtx, who: Viewing, row: Doc<"stations">): Promise<boolean> {
  if (who.mode === "local") return true;
  if (who.viewer === null) return false;
  return row.owner === who.viewer._id || (await roleOn(ctx, who.viewer, row.factory)) === "admin";
}

/** Every station the viewer owns — on a local cockpit, every station there is. */
export const mine = query({
  args: { signIn: v.optional(v.string()) },
  handler: async (ctx, { signIn }) => {
    const who = await viewing(ctx, signIn);
    let rows: Doc<"stations">[];
    if (who.mode === "local") rows = await ctx.db.query("stations").collect();
    else if (who.viewer === null) rows = [];
    else rows = await ctx.db.query("stations").withIndex("by_owner", (q) => q.eq("owner", who.viewer!._id as Id<"viewers">)).collect();
    return rows.map((row) => ({
      factory: row.factory, station: row.station, name: row.name, kind: row.kind, owner: row.ownerLogin,
      registered: row.token !== null, seenAt: row.seenAt, report: row.report,
    }));
  },
});

/** Revoke a station's command token: its polls are refused from now on, and no command reaches it. */
export const revoke = mutation({
  args: { factory: v.string(), station: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, station, signIn }): Promise<Result> => {
    const row = await stationOf(ctx, factory, station);
    if (row === null || !(await mayRevoke(ctx, await viewing(ctx, signIn), row))) {
      return { ok: false, because: "no such station among the ones you own" };
    }
    await ctx.db.patch(row._id, { token: null });
    return { ok: true };
  },
});
