/**
 * The command channel (spec #40): what a person queues, what a station polls
 * for, and what settles a command — the station's own `command_result`.
 *
 * A station polls `/commands` with its command token every few seconds:
 * a run's own shipper for the commands naming its session, the station's
 * long-lived loop for the rest. Those polls are all the liveness there is:
 * a session is attended while its shipper polls, a station online while its
 * loop does (model/command.ts). A command for a session whose run is attended
 * waits for that run to take it — a kill stops it gracefully, an answer
 * reaches it while it asks in place — and anything else goes to the loop.
 *
 * The verbs: `kill` a running session and `resume` a failed one, each on the
 * station that holds it; `answer` or `abort` a gate that waits on no work item
 * (queued from the inbox, inbox.ts); and `run` a prompt workflow, which goes
 * only to one of the asking person's own stations. Each waits for its station
 * as long as its verb's TTL and then expires (`expire`, every minute), so an
 * offline station's command shows as queued until the station is back or the
 * TTL runs out.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, query, type QueryCtx } from "./_generated/server";
import type { Role } from "./forge/forge";
import {
  ATTENDED_FOR, commandRefusal, type CommandView, pending, REDELIVER_AFTER, reportValidator, type Result,
  resultValidator, type StationFacts, type SteeringView, TTL, type Verb, writes,
} from "./model/command";
import { Payload } from "./model/payload";
import { readSummary, type Summary } from "./model/session";
import type { StoredEvent } from "./model/wire";
import { stationOf } from "./stations";
import { readable, roleOn, viewing, type Viewing } from "./viewer";

type Queued = { ok: true } | { ok: false; because: string };

const OPEN = ["queued", "delivered"] as const;
/** How many lapsed commands one turn of `expire` marks; the next minute's turn takes the rest. */
const EXPIRED_PER_TURN = 200;
/** How many of a person's runs the run form lists. */
const RUNS_SHOWN = 10;

async function sessionRecord(ctx: QueryCtx, factory: string, session: string) {
  return await ctx.db
    .query("sessions")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
    .unique();
}

async function attendanceOf(ctx: QueryCtx, factory: string, session: string) {
  return await ctx.db
    .query("attendance")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
    .unique();
}

export async function attendedAt(ctx: QueryCtx, factory: string, session: string): Promise<number | null> {
  return (await attendanceOf(ctx, factory, session))?.at ?? null;
}

async function queuedFor(ctx: QueryCtx, factory: string, session: string): Promise<Doc<"commands">[]> {
  return await ctx.db
    .query("commands")
    .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", session))
    .order("desc")
    .collect();
}

/** The newest command of `verb` for a session, whatever became of it. */
async function latest(ctx: QueryCtx, factory: string, session: string, verb: Verb): Promise<Doc<"commands"> | null> {
  return (await queuedFor(ctx, factory, session)).find((command) => command.verb === verb) ?? null;
}

/** The newest answer or abort queued for one wait — its gate, round and subject — whatever became of it. */
export async function answerFor(ctx: QueryCtx, factory: string, session: string,
                                wait: { gate: string; round: number; digest: string }): Promise<Doc<"commands"> | null> {
  return (await queuedFor(ctx, factory, session)).find((command) =>
    (command.verb === "answer" || command.verb === "abort") && command.gate === wait.gate &&
    command.round === wait.round && command.digest === wait.digest) ?? null;
}

function shown(command: Doc<"commands"> | null): CommandView | null {
  return command && {
    state: command.state, by: command.by, issuedAt: command.issuedAt, expiresAt: command.expiresAt, detail: command.detail,
  };
}

function facts(name: string, row: Doc<"stations"> | null, kind = ""): StationFacts {
  return {
    name: row?.name || name || "its station",
    kind: row?.kind ?? (kind || "local"),
    registered: row !== null && row.token !== null,
    verbs: row?.report?.verbs ?? null,
  };
}

/**
 * The station holding `summary`'s session, as registered, and its facts for
 * `commandRefusal` — null facts when no station ever said it holds it. A
 * session that ran in CI has no registered station, and says so itself
 * (`session_started` v2's `station_kind`).
 */
export async function holderOf(ctx: QueryCtx, factory: string, summary: Summary) {
  const row = summary.stationId ? await stationOf(ctx, factory, summary.stationId) : null;
  return { row, facts: row === null && !summary.stationId ? null : facts(summary.stationName, row, summary.stationKind) };
}

/** What the viewer may do on `factory`: a local cockpit is its one person's, who may do what their token may. */
export async function roleOf(ctx: QueryCtx, who: Viewing, factory: string): Promise<Role | null> {
  if (who.viewer === null) return null;
  return who.mode === "local" ? "admin" : await roleOn(ctx, who.viewer, factory);
}

/** Why `who` cannot ask a station for anything — nobody to name as `by` — or null when they can. */
export function anonymous(who: Viewing, doing: string): string | null {
  if (who.viewer !== null) return null;
  return who.mode === "team" ? `sign in to ${doing}`
    : "this cockpit holds no forge token, so it cannot tell the station who asked: `gh auth login`, then `asf up` again";
}

type Asking = Pick<Doc<"commands">, "factory" | "station" | "session" | "verb" | "by"> &
  Partial<Pick<Doc<"commands">, "notes" | "verdict" | "gate" | "round" | "digest" | "workflow" | "prompt">>;

/** Queue one command, to wait for its station as long as its verb's TTL. */
async function enqueue(ctx: MutationCtx, asking: Asking): Promise<Id<"commands">> {
  const now = Date.now();
  return await ctx.db.insert("commands", {
    notes: "", ...asking, issuedAt: now, expiresAt: now + TTL[asking.verb], state: "queued", deliveredAt: null, detail: "",
  });
}

// ── the poll ─────────────────────────────────────────────────────────────────

/**
 * One poll from the station holding the token with digest `token`: note who
 * polled and what it reported, settle the results it carried, and hand it
 * the commands that are its to take. Null when no station holds that token —
 * never issued, or revoked.
 */
export const poll = internalMutation({
  args: {
    token: v.string(),
    station: v.string(),
    session: v.string(),
    report: reportValidator,
    watchersKnown: v.boolean(),
    results: v.array(resultValidator),
  },
  handler: async (ctx, { token, station, session, report, watchersKnown, results }) => {
    const row = await ctx.db.query("stations").withIndex("by_token", (q) => q.eq("token", token)).unique();
    if (row === null || row.station !== station) return null;
    const now = Date.now();
    const { factory } = row;
    // A run cannot know what else runs on its checkout: the loop's word stands.
    const reported = { ...report, watchers: watchersKnown ? report.watchers : row.report?.watchers ?? [] };
    if (session) {
      const seen = await attendanceOf(ctx, factory, session);
      if (seen === null) await ctx.db.insert("attendance", { factory, session, station, at: now });
      else await ctx.db.patch(seen._id, { at: now, station });
      // Written only when it says something new: every page showing the station reads this row.
      if (JSON.stringify(row.report) !== JSON.stringify(reported)) await ctx.db.patch(row._id, { report: reported });
    } else {
      await ctx.db.patch(row._id, { seenAt: now, report: reported });
    }
    // A station speaks for its own commands, and only for those.
    for (const result of results) await settleOne(ctx, factory, result, station);

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
          verdict: command.verdict ?? "", gate: command.gate ?? "", round: command.round ?? 0,
          digest: command.digest ?? "", workflow: command.workflow ?? "", prompt: command.prompt ?? "",
        });
      }
    }
    return { commands: handed };
  },
});

/** Whether a session's own run is polling for it: then its commands are the run's to take. */
async function attended(ctx: QueryCtx, factory: string, session: string, now: number): Promise<boolean> {
  if (!session) return false;
  const at = await attendedAt(ctx, factory, session);
  return at !== null && now - at < ATTENDED_FOR;
}

// ── kill and resume: a session's own station ─────────────────────────────────

const sessionArgs = { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) };

const DOING: Record<"kill" | "resume", { doing: string; status: string; refused: string }> = {
  kill: { doing: "kill a session", status: "running", refused: "only a running session can be killed" },
  resume: { doing: "resume a session", status: "fail", refused: "only a failed session can be resumed" },
};

/** Who asks, as what, about which session on which station: what a session's command is weighed by. */
interface Asker {
  who: Viewing;
  role: Role | null;
  summary: Summary;
  station: StationFacts | null;
}

/** Why the viewer may not queue `verb` for the session they ask about, or null when they may. */
function sessionRefusal(verb: "kill" | "resume", { who, role, summary, station }: Asker): string | null {
  const { doing, status, refused } = DOING[verb];
  return anonymous(who, doing) ?? (summary.status !== status ? refused : commandRefusal(verb, role, station));
}

/** Queue `verb` for a session's own station, as the viewer — or say why not. One already on its way is enough. */
async function queueForSession(ctx: MutationCtx, verb: "kill" | "resume",
                               { factory: named, session, signIn }: { factory: string; session: string; signIn?: string }): Promise<Queued> {
  const who = await viewing(ctx, signIn);
  const factory = await readable(ctx, who, named);
  const record = factory === null ? null : await sessionRecord(ctx, factory, session);
  if (factory === null || record === null) {
    return { ok: false, because: "no such session among the ones you can read" };
  }
  const summary = readSummary(record.summary);
  const holder = await holderOf(ctx, factory, summary);
  const because = sessionRefusal(verb, { who, role: await roleOf(ctx, who, factory), summary, station: holder.facts });
  if (because !== null) return { ok: false, because };
  const open = await latest(ctx, factory, session, verb);
  if (open !== null && pending(open, Date.now())) return { ok: true };
  await enqueue(ctx, { factory, station: holder.row!.station, session, verb, by: who.viewer!.login });
  return { ok: true };
}

/**
 * Queue a kill of a running session for the station that holds it, as the
 * viewer. Done only when the station says so; until then the session page
 * shows it queued — "station offline" while nothing of the station polls —
 * and a kill nobody took within `TTL.kill` expires rather than wait for a
 * laptop that wakes up tomorrow.
 */
export const kill = mutation({
  args: sessionArgs,
  handler: async (ctx, args): Promise<Queued> => await queueForSession(ctx, "kill", args),
});

/**
 * Queue a resume of a failed session for the station that holds it — only
 * that one: its worktree and its record are there. The station relaunches it
 * with `asf resume`, which replays what it recorded. A session that ran in CI
 * has no station to send it to; it is re-triggered from the forge.
 */
export const resume = mutation({
  args: sessionArgs,
  handler: async (ctx, args): Promise<Queued> => await queueForSession(ctx, "resume", args),
});

// ── answer and abort: a gate on no work item ─────────────────────────────────

/**
 * Queue an answer to a wait the inbox checked the viewer may answer this way
 * (inbox.answer): the verdict and words, and the gate, round and subject they
 * were given about, which the station holds the session to before acting.
 */
export const answer = internalMutation({
  args: {
    factory: v.string(), session: v.string(), station: v.string(), gate: v.string(), round: v.number(),
    digest: v.string(), verdict: v.string(), notes: v.string(), by: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { factory, session, station, gate, round, digest, verdict, notes, by }) => {
    const open = await answerFor(ctx, factory, session, { gate, round, digest });
    if (open !== null && pending(open, Date.now())) return null;          // one is on its way
    await enqueue(ctx, {
      factory, station, session, verb: verdict === "abort" ? "abort" : "answer", by, notes, verdict, gate, round, digest,
    });
    return null;
  },
});

// ── run: a prompt workflow, on one of your own stations ──────────────────────

/**
 * The viewer's own stations of `factory` — on a local cockpit every one, the
 * machine being its one person's — registered first, then the most recently
 * seen: the first is their default for a run.
 */
async function ownStations(ctx: QueryCtx, who: Viewing, factory: string): Promise<Doc<"stations">[]> {
  if (who.viewer === null) return [];
  const rows = who.mode === "local"
    ? await ctx.db.query("stations").withIndex("by_station", (q) => q.eq("factory", factory)).collect()
    : (await ctx.db.query("stations").withIndex("by_owner", (q) => q.eq("owner", who.viewer!._id)).collect())
      .filter((row) => row.factory === factory);
  return rows.filter((row) => row.kind !== "ci")
    .sort((a, b) => Number(b.token !== null) - Number(a.token !== null) || b.seenAt - a.seenAt);
}

/**
 * Where the viewer may run a prompt on `factory`: their own stations, each
 * with when it was last seen and why it would not take a run, the default
 * first. Never anyone else's station. Null for a factory they cannot read.
 */
export const runTargets = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }) => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    if (factory === null) return null;
    const role = await roleOf(ctx, who, factory);
    return {
      refused: anonymous(who, "run a prompt") ?? (writes(role) ? null : commandRefusal("run", role, null)),
      stations: (await ownStations(ctx, who, factory)).map((row, at) => ({
        station: row.station, name: row.name, seenAt: row.seenAt, default: at === 0,
        refused: commandRefusal("run", role, facts(row.name, row)),
      })),
    };
  },
});

/**
 * Queue a run of a prompt workflow on one of the viewer's own stations — the
 * one named, or their default. It needs write on the repository, a station
 * whose `factory.yaml` opted in to `run` (a stamp does not), and is refused
 * for any station that is not theirs: a teammate never starts an agent with
 * write tools on someone else's machine or budget. The station checks all of
 * that again, and says which session it started.
 */
export const run = mutation({
  args: {
    factory: v.string(), workflow: v.string(), prompt: v.string(), station: v.optional(v.string()),
    signIn: v.optional(v.string()),
  },
  handler: async (ctx, { factory: named, workflow, prompt, station, signIn }):
      Promise<{ ok: true; id: Id<"commands"> } | { ok: false; because: string }> => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    if (factory === null) return { ok: false, because: "no such factory among the ones you can read" };
    const nobody = anonymous(who, "run a prompt");
    if (nobody !== null) return { ok: false, because: nobody };
    const role = await roleOf(ctx, who, factory);
    if (!writes(role)) return { ok: false, because: commandRefusal("run", role, null)! };
    if (!workflow.trim()) return { ok: false, because: "a run names its workflow" };
    if (!prompt.trim()) return { ok: false, because: "a run needs a prompt" };
    const mine = await ownStations(ctx, who, factory);
    const target = station ? mine.find((row) => row.station === station) : mine[0];
    if (target === undefined) {
      return { ok: false, because: station ? `that is not one of your stations on ${factory}: a run goes only to your own`
        : `you have no station on ${factory}: run \`asf station register\` in a checkout of it` };
    }
    const because = commandRefusal("run", role, facts(target.name, target));
    if (because !== null) return { ok: false, because };
    const id = await enqueue(ctx, {
      factory, station: target.station, session: "", verb: "run", by: who.viewer!.login, workflow: workflow.trim(), prompt,
    });
    return { ok: true, id };
  },
});

/** The viewer's latest runs on `factory`: where each went, what became of it, and the session it started. */
export const runs = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }) => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    if (who.viewer === null || factory === null) return [];
    const login = who.viewer.login;
    // Every run of the factory sits under session "": walk them newest first until enough are theirs.
    const theirs: Doc<"commands">[] = [];
    for await (const command of ctx.db
      .query("commands")
      .withIndex("by_session", (q) => q.eq("factory", factory).eq("session", ""))
      .order("desc")) {
      if (command.verb === "run" && command.by === login) theirs.push(command);
      if (theirs.length === RUNS_SHOWN) break;
    }
    return await Promise.all(theirs
      .map(async (command) => {
        const row = await stationOf(ctx, factory, command.station);
        return {
          id: command._id, workflow: command.workflow ?? "", prompt: command.prompt ?? "",
          station: row?.name ?? command.station, seenAt: row?.seenAt ?? 0, ...shown(command)!,
          started: command.started ?? "",
        };
      }));
  },
});

// ── what the session page shows ──────────────────────────────────────────────

/**
 * The station holding a session, how recently it and the run polled, the
 * newest kill and resume and what became of each, and whether the viewer may
 * queue either. Timestamps, not verdicts: the page reads them against its clock.
 */
export const steering = query({
  args: sessionArgs,
  handler: async (ctx, { factory: named, session, signIn }): Promise<SteeringView | null> => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    const record = factory === null ? null : await sessionRecord(ctx, factory, session);
    if (factory === null || record === null) return null;
    const summary = readSummary(record.summary);
    const { row, facts: station } = await holderOf(ctx, factory, summary);
    const asker = { who, role: await roleOf(ctx, who, factory), summary, station };
    return {
      station: row && {
        name: row.name, kind: row.kind, owner: row.ownerLogin, registered: row.token !== null,
        seenAt: row.seenAt, verbs: row.report?.verbs ?? null,
      },
      attendedAt: await attendedAt(ctx, factory, session),
      kill: shown(await latest(ctx, factory, session, "kill")),
      killRefused: sessionRefusal("kill", asker),
      resume: shown(await latest(ctx, factory, session, "resume")),
      resumeRefused: sessionRefusal("resume", asker),
    };
  },
});

// ── what settles one, and what expires one ───────────────────────────────────

/**
 * Settle one command on the station's word. From a session's events any
 * command of the factory may be settled (the ingest token is the factory's);
 * from a poll, only the polling station's own. An expired command the
 * station did carry out after all is settled too: its word is what happened.
 */
async function settleOne(ctx: MutationCtx, factory: string, result: Result, station?: string): Promise<void> {
  const id = ctx.db.normalizeId("commands", result.commandId);
  const command = id === null ? null : await ctx.db.get(id);
  if (command === null || command.factory !== factory || (station !== undefined && command.station !== station)) return;
  if (command.state === "done" || command.state === "refused") return;
  await ctx.db.patch(command._id, {
    state: result.ok ? "done" : "refused", detail: result.detail,
    ...(command.verb === "run" && result.adwId ? { started: result.adwId } : {}),
  });
}

/**
 * Settle the commands `events` report on: a `command_result` from the
 * station, ingested, is what makes a command done or refused. Called by
 * ingest with what just became contiguous, so each is read once.
 */
export async function settle(ctx: MutationCtx, factory: string, events: StoredEvent[]): Promise<void> {
  for (const event of events) {
    if (event.kind !== "command_result") continue;
    const p = Payload.parse(event.payload);
    await settleOne(ctx, factory, {
      commandId: p.str("command_id"), ok: p.bool("ok"), detail: p.str("detail"), adwId: p.str("adw_id"),
    });
  }
}

/**
 * Expire every command whose TTL ran out while it waited — whether or not its
 * station ever polls again, which is when a poll would have noticed. Run
 * every minute (crons.ts); a turn takes a bounded batch.
 */
export const expire = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    for (const state of OPEN) {
      const lapsed = await ctx.db
        .query("commands")
        .withIndex("by_state_expiry", (q) => q.eq("state", state).lt("expiresAt", now))
        .take(EXPIRED_PER_TURN);
      for (const command of lapsed) await ctx.db.patch(command._id, { state: "expired" });
    }
    return null;
  },
});
