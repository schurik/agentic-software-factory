/**
 * The inbox: every gate the viewer is permitted to answer, across every
 * factory they can see, answerable in place (spec #40).
 *
 * A wait on no work item — a prompt run's, at its terminal — is answered by a
 * COMMAND to the station that holds it instead (commands.answer), when the
 * viewer may command it: write on the repository, and a registered station
 * that opted in to `answer` (approve, reject, answer) or `abort`. The station
 * holds the answer to the gate, round and subject it names before it acts.
 *
 * On a work item, an answer is a comment on it, posted AS THE VIEWER —
 * through the team's App on their own user access token, or with the token a
 * local cockpit holds — in the form the factory's answers watcher reads
 * (`model/answer.ts`). So it passes the factory's `trusted_authors` with no
 * factory change, it is on the forge's public record, and the factory decides
 * whether it listens: nothing here records a decision. The wait closes when the
 * session's own events say it did.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import { shown as readable } from "./artifacts";
import { ForgeError, RateLimited } from "./forge/github";
import { credentialed, forgeWeb } from "./forge/memory";
import { open } from "./forge/open";
import { anonymous, answerFor, attendedAt, holderOf, roleOf } from "./commands";
import { pending } from "./model/command";
import { refusal, render, spoken, type Asked as Answering } from "./model/answer";
import { subjectDigest } from "./model/digest";
import {
  asked, blocked, byCommand, type Commanding, type Judged, permitted, ranked, row, type Row, type Sent, type Subject,
} from "./model/inbox";
import { readSummary, view, type Summary } from "./model/session";
import { storedSession } from "./sessions";
import { actAs, canRead, viewing, type Viewing } from "./viewer";

/** How many waits the inbox lists. */
const SHOWN = 200;

/** Whom the inbox is for: their login, or null where a local cockpit has no token to say whose machine it is. */
function loginOf({ viewer }: Viewing): string | null {
  return viewer?.login ?? null;
}

/** The latest answer this cockpit posted for the wait `summary` is in, if it is still that wait. */
async function sentFor(ctx: QueryCtx, factory: string, session: string, summary: Summary): Promise<Sent | null> {
  const waiting = summary.waitingFor!;
  const sent = await ctx.db
    .query("gateAnswers")
    .withIndex("by_wait", (q) =>
      q.eq("factory", factory).eq("session", session).eq("gate", waiting.gate).eq("round", waiting.round))
    .order("desc")
    .first();
  if (sent === null || sent.digest !== waiting.subjectDigest) return null;
  return { by: sent.by, verdict: sent.verdict, url: sent.url, at: sent.at };
}

/** One session's wait, as the viewer may answer it: its events, its stored record and its row — or null. */
async function waitOf(ctx: QueryCtx, who: Viewing, factory: string, session: string, signIn: string | undefined,
                      ready: boolean) {
  const stored = await storedSession(ctx, factory, session, signIn);
  const record = stored && await ctx.db
    .query("sessions")
    .withIndex("by_session", (q) => q.eq("factory", stored.factory).eq("session", session))
    .unique();
  const shown = stored && record && (await rowOf(ctx, who, record, ready));
  if (!stored || !record || !shown) return null;
  const summary = readSummary(record.summary);
  return { stored, row: shown, waiting: summary.waitingFor!, stationId: summary.stationId };
}

/** The station's side of a wait answered by command: who may ask it, and what was asked already. */
async function judgedByCommand(ctx: QueryCtx, who: Viewing, record: Doc<"sessions">, summary: Summary,
                               ready: boolean): Promise<Judged> {
  const { factory, session } = record;
  const waiting = summary.waitingFor!;
  const holder = await holderOf(ctx, factory, summary);
  const last = await answerFor(ctx, factory, session, { gate: waiting.gate, round: waiting.round, digest: waiting.subjectDigest });
  const commanding: Commanding = {
    anonymous: anonymous(who, "answer"),
    role: await roleOf(ctx, who, factory),
    station: holder.facts,
    last: last && {
      by: last.by, verdict: last.verdict ?? last.verb, state: last.state, detail: last.detail, pending: pending(last, Date.now()),
    },
  };
  return {
    blocked: blocked(summary, null, ready, commanding), commanding,
    stationSeenAt: holder.row?.seenAt ?? 0, attendedAt: await attendedAt(ctx, factory, session),
  };
}

/** The row for one waiting session, or null when the viewer is not permitted to answer it. */
async function rowOf(ctx: QueryCtx, who: Viewing, record: Doc<"sessions">, ready: boolean): Promise<Row | null> {
  const summary = readSummary(record.summary);
  if (summary.waitingFor === null) return null;
  const login = loginOf(who);
  // A local cockpit that does not know whose it is cannot check a trust list,
  // and cannot post either: it shows every wait, each saying why not.
  if (!(who.mode === "local" && login === null) && !permitted(summary.waitingFor.trusted, login)) return null;
  const judged = byCommand(summary.waitingFor) ? await judgedByCommand(ctx, who, record, summary, ready) : {
    blocked: blocked(summary, await sentFor(ctx, record.factory, record.session, summary), ready),
    commanding: null, stationSeenAt: 0, attendedAt: null,
  };
  return row(record, summary, login, judged);
}

export const list = query({
  args: { signIn: v.optional(v.string()) },
  handler: async (ctx, { signIn }): Promise<{ rows: Row[] }> => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return { rows: [] };
    const ready = await credentialed(ctx);
    const readable = new Map<string, boolean>();
    const rows: Row[] = [];
    for await (const record of ctx.db.query("sessions").withIndex("by_waiting", (q) => q.eq("waiting", true))) {
      if (!readable.has(record.factory)) readable.set(record.factory, await canRead(ctx, who, record.factory));
      if (!readable.get(record.factory)) continue;
      const shown = await rowOf(ctx, who, record, ready);
      if (shown !== null) rows.push(shown);
      if (rows.length === SHOWN) break;
    }
    return { rows: ranked(rows) };
  },
});

/**
 * One wait, opened in the answer view: what it asks, the subject's
 * whereabouts on the forge, earlier rounds, the journal as the next agent
 * reads it, and where the answer will land. Null for a session the viewer may
 * not see, or may not answer, or that is no longer waiting.
 */
export const gate = query({
  args: { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, signIn }) => {
    const who = await viewing(ctx, signIn);
    const wait = await waitOf(ctx, who, factory, session, signIn, await credentialed(ctx));
    if (wait === null) return null;
    const { stored, row: shown, waiting } = wait;
    const page = view(stored.events, stored.acked);
    return {
      row: shown,
      subjectDigest: waiting.subjectDigest,
      ...asked(stored.events, stored.acked, waiting),
      journal: page.story.journal,
      forge: await forgeWeb(ctx),
      as: loginOf(who),
      cost: page.summary.totalCost,
      tokens: page.summary.totalTokens,
    };
  },
});

/** How many sessions one turn of `backfill` marks. */
const MARKED_PER_TURN = 200;

/**
 * Mark every session an older cockpit stored without `waiting`, from its
 * summary, so the inbox's index finds the ones that wait. `docker/start.sh`
 * runs it once after each deploy; a turn that marked a full batch schedules
 * the next, and a deployment with nothing unmarked does nothing.
 */
export const backfill = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const unmarked = await ctx.db
      .query("sessions")
      .withIndex("by_waiting", (q) => q.eq("waiting", undefined))
      .take(MARKED_PER_TURN);
    for (const record of unmarked) {
      await ctx.db.patch(record._id, { waiting: readSummary(record.summary).waitingFor !== null });
    }
    if (unmarked.length === MARKED_PER_TURN) await ctx.scheduler.runAfter(0, internal.inbox.backfill, {});
    return null;
  },
});

// ── the subject, from the forge ──────────────────────────────────────────────

export type Read =
  | { ok: true; headSha: string;
      files: { path: string; content: string; truncated: boolean; binary: boolean }[];
      diff: string | null;
      // Whether the files at `headSha` are the ones the factory hashed when it
      // asked; null when the subject is a file only the station holds.
      current: boolean | null }
  | { ok: false; because: string };

/** Where the subject of the wait the viewer may answer is on the forge. */
export const locate = internalQuery({
  args: { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, signIn }): Promise<{ subject: Subject; digest: string } | { because: string }> => {
    const wait = await waitOf(ctx, await viewing(ctx, signIn), factory, session, signIn, true);
    if (wait === null) return { because: "no such wait among the ones you may answer" };
    const { stored, row: shown, waiting } = wait;
    const { subject } = asked(stored.events, stored.acked, waiting);
    if (!subject.headSha) return { because: "the factory named no commit for this wait" };
    if (waiting.published === false) return { because: shown.blocked ?? "subject not on the forge" };
    return { subject, digest: waiting.subjectDigest };
  },
});

/**
 * The gate's subject as the forge holds it at exactly the commit the question
 * was asked about (`head_sha`): the files, or — for a subject that is a file
 * of the session's own, like the integrate gate's diff — the forge's
 * comparison of `base_commit` with `head_sha`. Never the branch tip, and
 * nothing of it is kept. Read on the cockpit's own credential, like a repo
 * artifact (artifacts.ts): whether the viewer may see it is the mirror's word.
 */
export const subject = action({
  args: { factory: v.string(), session: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Read> => {
    const located: { subject: Subject; digest: string } | { because: string } =
      await ctx.runQuery(internal.inbox.locate, args);
    if ("because" in located) return { ok: false, because: located.because };
    const { subject: { headSha, baseCommit, files, outside }, digest } = located;
    const opened = await open(ctx);
    if (opened === null) return { ok: false, because: "this cockpit has no forge credential to read it with" };
    try {
      const read = [];
      for (const file of files) {
        const bytes = await opened.forge.file(args.factory, file.path, headSha);
        if (bytes === null) {
          return { ok: false, because: `the forge does not show ${file.path} at ${headSha.slice(0, 7)} to this cockpit: ` +
                                       "the branch may not be pushed, or was deleted" };
        }
        read.push({ ...file, bytes });
      }
      const diff = outside.length && baseCommit ? await opened.forge.compare(args.factory, baseCommit, headSha) : null;
      if (outside.length && diff === null) {
        return { ok: false, because: `the forge shows no diff of ${baseCommit.slice(0, 7)} and ${headSha.slice(0, 7)} ` +
                                     "to this cockpit: the branch may not be pushed, or was deleted" };
      }
      return {
        ok: true, headSha, diff,
        files: await Promise.all(read.map(async ({ path, bytes }) => ({ path, ...(await readable(bytes)) }))),
        current: outside.length ? null : (await subjectDigest(read)) === digest,
      };
    } catch (error) {
      if (!(error instanceof ForgeError || error instanceof RateLimited)) throw error;
      return { ok: false, because: error.message };
    } finally {
      await opened.close();
    }
  },
});

// ── answering ────────────────────────────────────────────────────────────────

const answerArgs = {
  factory: v.string(),
  session: v.string(),
  // The wait the person was shown, which must still be the one the session is in.
  gate: v.string(),
  round: v.number(),
  digest: v.string(),
  verdict: v.union(v.literal("approve"), v.literal("reject"), v.literal("abort"), v.literal("answer")),
  notes: v.string(),
  answers: v.array(v.string()),
  signIn: v.optional(v.string()),
};

/** What an answer needs, once the cockpit has checked it may be given. */
interface Ready {
  asked: Answering;
  issueNumber: number;
  /** Whom the team's App acts as; null in a local cockpit, whose token is the person's own. */
  actor: Id<"viewers"> | null;
  by: string;
  /** A comment on the work item, or a command to `station`. */
  via: Row["via"];
  station: string;
}

/**
 * Whether the viewer may answer this wait as they saw it: it is one the inbox
 * offers them, it is still that gate, round and subject, and nothing blocks it.
 */
export const ready = internalQuery({
  args: answerArgs,
  handler: async (ctx, { factory, session, gate, round, digest, verdict, signIn }): Promise<Ready | { because: string }> => {
    const who = await viewing(ctx, signIn);
    if (who.mode === "team" && who.viewer === null) return { because: "sign in to answer" };
    const wait = await waitOf(ctx, who, factory, session, signIn, await credentialed(ctx));
    if (wait === null) return { because: "no such wait among the ones you may answer" };
    const { stored, row: shown, waiting, stationId } = wait;
    if (shown.gate !== gate || shown.round !== round) {
      return { because: `the session is no longer waiting at ${gate} round ${round}` };
    }
    if (waiting.subjectDigest !== digest) {
      return { because: `the ${gate} changed since you opened it: read it again before you answer` };
    }
    if (shown.blocked !== null) return { because: shown.blocked };
    const refused = shown.refused && (verdict === "abort" ? shown.refused.abort : shown.refused.answer);
    if (refused) return { because: refused };
    return {
      asked: {
        session, gate, round, kind: shown.kind, subject_digest: waiting.subjectDigest,
        questions: asked(stored.events, stored.acked, waiting).questions,
      },
      issueNumber: shown.issueNumber,
      actor: who.mode === "team" ? who.viewer!._id : null,
      by: loginOf(who) ?? "",
      via: shown.via,
      station: stationId,
    };
  },
});

/**
 * Answer a wait: post the comment the factory's answers watcher reads, on the
 * work item, as the viewer — or, for a wait on no work item, queue the answer
 * for its station (`url` is then ""). What the factory would refuse is refused
 * here first, and nothing is sent then. Done means the comment is on the
 * forge, or the command queued, never that the run has moved: that is for the
 * session's own events to say.
 */
export const answer = action({
  args: answerArgs,
  handler: async (ctx, args): Promise<{ ok: true; url: string } | { ok: false; because: string }> => {
    const checked: Ready | { because: string } = await ctx.runQuery(internal.inbox.ready, args);
    if ("because" in checked) return { ok: false, because: checked.because };
    const given = { verdict: args.verdict, notes: args.notes, answers: args.answers };
    const refused = refusal(checked.asked, given);
    if (refused !== null) return { ok: false, because: refused };
    if (checked.via === "command") {
      await ctx.runMutation(internal.commands.answer, {
        factory: args.factory, session: args.session, station: checked.station, gate: args.gate, round: args.round,
        digest: args.digest, verdict: args.verdict, notes: spoken(checked.asked, given), by: checked.by,
      });
      return { ok: true, url: "" };
    }
    let user: string | undefined;
    try {
      if (checked.actor !== null) user = await actAs(ctx, checked.actor);
    } catch (error) {
      if (error instanceof ForgeError && error.status === 401) {
        return { ok: false, because: "your sign-in has run out: sign in again to answer" };
      }
      throw error;
    }
    const opened = await open(ctx, { user });
    if (opened === null) return { ok: false, because: "this cockpit has no forge credential to post an answer with" };
    let url: string;
    try {
      ({ url } = await opened.forge.comment(args.factory, checked.issueNumber, render(checked.asked, given)));
    } catch (error) {
      if (!(error instanceof ForgeError || error instanceof RateLimited)) throw error;
      return { ok: false, because: error.message };
    } finally {
      await opened.close();
    }
    await ctx.runMutation(internal.inbox.answered, {
      factory: args.factory, session: args.session, gate: args.gate, round: args.round,
      digest: args.digest, verdict: args.verdict, by: checked.by, url,
    });
    return { ok: true, url };
  },
});

export const answered = internalMutation({
  args: {
    factory: v.string(), session: v.string(), gate: v.string(), round: v.number(),
    digest: v.string(), verdict: v.string(), by: v.string(), url: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, sent) => {
    await ctx.db.insert("gateAnswers", { ...sent, at: Date.now() });
    return null;
  },
});
