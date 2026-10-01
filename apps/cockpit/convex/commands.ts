/**
 * The command channel (spec #40): what a person queues, what a station polls
 * for, and what settles a command — the station's own `command_result`.
 *
 * A station polls `/commands` with its command token every few seconds:
 * a run's own shipper for the commands naming its session, the station's
 * long-lived loop for the rest. Those polls are all the liveness there is:
 * a session is attended while its shipper polls, a station online while its
 * loop does (model/command.ts). A kill for a session whose run is attended
 * waits for that run to take it — it stops itself, gracefully — and anything
 * else goes to the loop.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, internalMutation, type MutationCtx, query, type QueryCtx } from "./_generated/server";
import {
  ATTENDED_FOR, commandRefusal, KILL_FOR, REDELIVER_AFTER, reportValidator, type StationFacts, type SteeringView,
} from "./model/command";
import { Payload } from "./model/payload";
import { readSummary } from "./model/session";
import type { StoredEvent } from "./model/wire";
import { stationOf } from "./stations";
import { canRead, roleOn, viewing } from "./viewer";

type Queued = { ok: true } | { ok: false; because: string };

const OPEN = ["queued", "delivered"] as const;

async function sessionRecord(ctx: QueryCtx, factory: string, session: string) {
  return await ctx.db
    .query("sessions")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
    .unique();
}

async function attendedAt(ctx: QueryCtx, factory: string, session: string): Promise<number | null> {
  const row = await ctx.db
    .query("attendance")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
    .unique();
  return row?.at ?? null;
}

/** The newest command of `verb` for a session, whatever became of it. */
async function latest(ctx: QueryCtx, factory: string, session: string, verb: string): Promise<Doc<"commands"> | null> {
  const all = await ctx.db
    .query("commands")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
    .order("desc")
    .collect();
  return all.find((command) => command.verb === verb) ?? null;
}

function facts(name: string, row: Doc<"stations"> | null): StationFacts {
  return {
    name: row?.name || name || "its station",
    kind: row?.kind ?? "local",
    registered: row !== null && row.token !== null,
    verbs: row?.report?.verbs ?? null,
  };
}

// ── the poll ─────────────────────────────────────────────────────────────────

/**
 * One poll from the station holding the token with digest `token`: note who
 * polled and what it reported, and hand it the commands that are its to take.
 * Null when no station holds that token — never issued, or revoked.
 */
export const poll = internalMutation({
  args: {
    token: v.string(),
    station: v.string(),
    session: v.string(),
    report: reportValidator,
    watchersKnown: v.boolean(),
  },
  handler: async (ctx, { token, station, session, report, watchersKnown }) => {
    const row = await ctx.db.query("stations").withIndex("by_token", (q) => q.eq("token", token)).unique();
    if (row === null || row.station !== station) return null;
    const now = Date.now();
    const { factory } = row;
    // A run cannot know what else runs on its checkout: the loop's word stands.
    const reported = { ...report, watchers: watchersKnown ? report.watchers : row.report?.watchers ?? [] };
    if (session) {
      const seen = await ctx.db
        .query("attendance")
        .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
        .unique();
      if (seen === null) await ctx.db.insert("attendance", { factory, session, station, at: now });
      else await ctx.db.patch(seen._id, { at: now, station });
      // Written only when it says something new: every page showing the station reads this row.
      if (JSON.stringify(row.report) !== JSON.stringify(reported)) await ctx.db.patch(row._id, { report: reported });
    } else {
      await ctx.db.patch(row._id, { seenAt: now, report: reported });
    }

    const handed = [];
    for (const state of OPEN) {
      const waiting = await ctx.db
        .query("commands")
        .withIndex("by_station_state", (q) => q.eq("factory", factory).eq("station", station).eq("state", state))
        .collect();
      for (const command of waiting) {
        if (now > command.expiresAt) {
          await ctx.db.patch(command._id, { state: "expired" });
          continue;
        }
        if (state === "delivered" && command.deliveredAt !== null && now - command.deliveredAt < REDELIVER_AFTER) continue;
        if (session ? command.session !== session : await attended(ctx, factory, command.session, now)) continue;
        await ctx.db.patch(command._id, { state: "delivered", deliveredAt: now });
        handed.push({
          id: command._id, verb: command.verb, session: command.session, notes: command.notes,
          by: command.by, issued_at: command.issuedAt, expires_at: command.expiresAt,
        });
      }
    }
    return { commands: handed };
  },
});

/** Whether a session's own run is polling for it: then its commands are the run's to take. */
async function attended(ctx: QueryCtx, factory: string, session: string, now: number): Promise<boolean> {
  const at = await attendedAt(ctx, factory, session);
  return at !== null && now - at < ATTENDED_FOR;
}

// ── a person queues one ──────────────────────────────────────────────────────

/**
 * Queue a kill of a running session for the station that holds it, as the
 * viewer. Done only when the station says so; until then the session page
 * shows it queued — "station offline" while nothing of the station polls —
 * and a kill nobody took within `KILL_FOR` expires rather than wait for a
 * laptop that wakes up tomorrow.
 */
export const kill = mutation({
  args: { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, signIn }): Promise<Queued> => {
    const who = await viewing(ctx, signIn);
    const record = await sessionRecord(ctx, factory, session);
    if (record === null || !(await canRead(ctx, who, factory))) {
      return { ok: false, because: "no such session among the ones you can read" };
    }
    if (who.viewer === null) {
      return { ok: false, because: who.mode === "team" ? "sign in to kill a session"
        : "this cockpit holds no forge token, so it cannot tell the station who asked: `gh auth login`, then `asf up` again" };
    }
    const summary = readSummary(record.summary);
    if (summary.status !== "running") return { ok: false, because: "only a running session can be killed" };
    const row = summary.stationId ? await stationOf(ctx, factory, summary.stationId) : null;
    const role = who.mode === "local" ? "admin" : await roleOn(ctx, who.viewer, factory);
    const because = commandRefusal("kill", role, row === null && !summary.stationId ? null : facts(summary.stationName, row));
    if (because !== null) return { ok: false, because };

    const now = Date.now();
    const open = await latest(ctx, factory, session, "kill");
    if (open !== null && (open.state === "queued" || open.state === "delivered") && now <= open.expiresAt) {
      return { ok: true };             // one is on its way already
    }
    await ctx.db.insert("commands", {
      factory, station: row!.station, session, verb: "kill", notes: "", by: who.viewer.login,
      issuedAt: now, expiresAt: now + KILL_FOR, state: "queued", deliveredAt: null, detail: "",
    });
    return { ok: true };
  },
});

// ── what the session page shows ──────────────────────────────────────────────

/**
 * The station holding a session, how recently it and the run polled, the
 * newest kill and what became of it, and whether the viewer may queue one.
 * Timestamps, not verdicts: the page reads them against its own clock.
 */
export const steering = query({
  args: { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, signIn }): Promise<SteeringView | null> => {
    const who = await viewing(ctx, signIn);
    const record = await sessionRecord(ctx, factory, session);
    if (record === null || !(await canRead(ctx, who, factory))) return null;
    const summary = readSummary(record.summary);
    const row = summary.stationId ? await stationOf(ctx, factory, summary.stationId) : null;
    const role = who.viewer === null ? null : who.mode === "local" ? "admin" : await roleOn(ctx, who.viewer, factory);
    const because = who.viewer === null
      ? (who.mode === "team" ? "sign in to kill a session" : "this cockpit holds no forge token, so it cannot tell the station who asked")
      : commandRefusal("kill", role, row === null && !summary.stationId ? null : facts(summary.stationName, row));
    const kill = await latest(ctx, factory, session, "kill");
    return {
      station: row && {
        name: row.name, kind: row.kind, owner: row.ownerLogin, registered: row.token !== null,
        seenAt: row.seenAt, verbs: row.report?.verbs ?? null,
      },
      attendedAt: await attendedAt(ctx, factory, session),
      kill: kill && { state: kill.state, by: kill.by, issuedAt: kill.issuedAt, expiresAt: kill.expiresAt, detail: kill.detail },
      killRefused: because,
    };
  },
});

// ── what settles one ─────────────────────────────────────────────────────────

/**
 * Settle the commands `events` report on: a `command_result` from the
 * station, ingested, is the only thing that makes a command done or refused.
 * Called by ingest with what just became contiguous, so each is read once.
 */
export async function settle(ctx: MutationCtx, factory: string, events: StoredEvent[]): Promise<void> {
  for (const event of events) {
    if (event.kind !== "command_result") continue;
    const p = Payload.parse(event.payload);
    const id = ctx.db.normalizeId("commands", p.str("command_id"));
    const command = id === null ? null : await ctx.db.get(id as Id<"commands">);
    if (command === null || command.factory !== factory || command.state === "done" || command.state === "refused") continue;
    await ctx.db.patch(command._id, { state: p.bool("ok") ? "done" : "refused", detail: p.str("detail") });
  }
}
