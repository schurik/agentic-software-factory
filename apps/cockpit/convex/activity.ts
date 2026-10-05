/**
 * A factory's Activity (spec #40): what needs attention, what is running now,
 * and what finished last — and its Stations: who runs what, where. Whatever
 * depends on a station is shown under it: the watchers it runs, the sessions
 * it holds and the claims it holds. CI jobs, which come and go, are one entry.
 *
 * `attentionOf` is the one place what needs attention is read: by the
 * Factory page's `attention` query, and by `factories.list`, whose rows are
 * ranked by it. It returns the facts — what the cockpit was told, with
 * their timestamps — and `model/attention.ts` says which of them are worth
 * a person's attention against the page's own clock.
 */
import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { heldOn } from "./claims";
import type { ClaimView } from "./model/claim";
import type { CommandState, Report, Verb } from "./model/command";
import { defaultCheck, repoOf, reporting } from "./factory";
import { periodValidator } from "./model/period";
import { spellingsOf } from "./spelling";
import { mayRevoke } from "./stations";
import type { Drifted, Facts, Failed } from "./model/attention";
import { drift } from "./model/drift";
import { permitted } from "./model/inbox";
import { endedAt, readSummary, type Summary } from "./model/session";
import { readable, viewing, type Viewing } from "./viewer";

/** How many of a factory's sessions a page looks back over, most recently active first. */
const SCANNED = 500;
/** How many failures the facts carry: more than a day's worth is not news to anyone. */
const FAILURES = 20;
/** How many finished sessions Recent lists, and how many CI jobs and check pushes the CI entry does. */
const RECENT = 10;

/** A session's record with its summary read: what every list here is made of. */
export interface Recorded {
  session: string;
  activity: number;
  summary: Summary;
}

/** `factory`'s most recently active sessions, newest first. */
export async function recentOf(ctx: QueryCtx, factory: string): Promise<Recorded[]> {
  const records: Doc<"sessions">[] = await ctx.db
    .query("sessions")
    .withIndex("by_factory_activity", (q) => q.eq("factory", factory))
    .order("desc")
    .take(SCANNED);
  return records.map((record) => ({ session: record.session, activity: record.activity, summary: readSummary(record.summary) }));
}

/** The workflow a session is in now, or ended in: its last chapter's. */
function workflowOf(summary: Summary): string {
  return summary.workflows.at(-1) ?? "";
}

/** A session as Activity and the Stations tab list it. */
export interface SessionRow {
  session: string;
  workflow: string;
  /** running | waiting | success | fail */
  status: string;
  /** The station holding it — its name — and its kind; "" for a factory that did not say. */
  station: string;
  stationKind: string;
  /** The gate it waits at, as "plan round 1"; "" when it waits at none. */
  gate: string;
  triggeredBy: string;
  cost: number;
  /** When it finished, or last moved, epoch ms. */
  endedAt: number;
}

function rowOf(known: Recorded): SessionRow {
  const { summary } = known;
  const waiting = summary.waitingFor;
  return {
    session: known.session, workflow: workflowOf(summary), status: summary.status,
    station: summary.stationName, stationKind: summary.stationKind,
    gate: summary.status === "waiting" && waiting ? `${waiting.gate} round ${waiting.round}` : "",
    triggeredBy: summary.triggeredBy, cost: summary.totalCost, endedAt: endedAt(known),
  };
}

/** Whether a session is live or suspended: what Running now shows. */
function open({ summary }: Recorded): boolean {
  return summary.status === "running" || summary.status === "waiting";
}

/** How many of `known` are live: running now, not suspended at a gate. */
export function liveIn(known: Recorded[]): number {
  return known.filter(({ summary }) => summary.status === "running").length;
}

function finished({ summary }: Recorded): boolean {
  return summary.status === "success" || summary.status === "fail";
}

/** Whether a station still holds a session: live, suspended, or failed — which only it can resume. */
function held(known: Recorded): boolean {
  return open(known) || known.summary.status === "fail";
}

function failures(known: Recorded[]): Failed[] {
  return known
    .filter((each) => each.summary.status === "fail")
    .map((each) => ({ session: each.session, title: each.summary.request, workflow: workflowOf(each.summary), station: each.summary.stationName, endedAt: endedAt(each) }))
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, FAILURES);
}

/** The gates waiting at `factory`'s sessions: those `who` may answer — the ones their inbox shows — and all. */
async function gatesOf(ctx: QueryCtx, who: Viewing, factory: string): Promise<Facts["gates"]> {
  const login = who.viewer?.login ?? null;
  let mine = 0;
  let total = 0;
  for await (const record of ctx.db.query("sessions").withIndex("by_factory_waiting", (q) => q.eq("factory", factory).eq("waiting", true))) {
    const waiting = readSummary(record.summary).waitingFor;
    if (waiting === null) continue;
    total += 1;
    // As the inbox has it: a local cockpit that does not know whose it is shows every wait.
    if ((who.mode === "local" && login === null) || permitted(waiting.trusted, login)) mine += 1;
  }
  return { mine, total };
}

/**
 * The default branch's check, and the reporting stations whose config is not
 * the one it measured. Read without the forge — a query cannot ask it — so
 * against the commit the check ran on, not wherever the branch is now: a
 * station is drifted when its `asf/` hashes otherwise, or, with no hash to
 * compare, when it stands on another commit. The Factory page's header
 * measures the same stations against the forge's tip (`factory.look`).
 */
async function checkOf(ctx: QueryCtx, factory: string, repo: Doc<"repos"> | null, stations: Doc<"stations">[]):
    Promise<Pick<Facts, "check" | "drifted">> {
  const check = await defaultCheck(ctx, factory, repo?.defaultBranch || null);
  const reference = { head: check?.head ?? null, configHash: check?.configHash ?? null };
  const drifted: Drifted[] = [];
  for (const row of stations) {
    const measured = drift({ head: row.report?.head ?? "", configHash: row.report?.configHash ?? "" }, reference, undefined);
    if (measured.drifted) drifted.push({ station: row.station, name: row.name, badges: measured.badges });
  }
  return { check: check === null ? "unchecked" : check.ok ? "passing" : "failing", drifted };
}

/**
 * What needs attention on `factory`, as facts — for a viewer who may read it.
 * `known` is its recent sessions, when the caller read them already.
 */
export async function attentionOf(ctx: QueryCtx, who: Viewing, factory: string, known?: Recorded[]): Promise<Facts> {
  known ??= await recentOf(ctx, factory);
  const repo = await repoOf(ctx, factory);
  const stations = await reporting(ctx, factory);
  const watchers = stations
    .filter((row) => row.report?.watchers.includes("issues"))
    .map((row) => ({ station: row.station, name: row.name, seenAt: row.seenAt }));
  return { gates: await gatesOf(ctx, who, factory), failed: failures(known), claims: await heldOn(ctx, who, factory),
           ...(await checkOf(ctx, factory, repo, stations)), queued: repo?.queued ?? null, watchers };
}

export const attention = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }): Promise<Facts | null> => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    if (factory === null) return null;
    return await attentionOf(ctx, who, factory);
  },
});

/**
 * Running now — the live and suspended sessions, grouped by the workflow each
 * is in, most recently active first — and Recent: the last finished ones,
 * however they ended.
 */
export const page = query({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory: named, signIn }) => {
    const factory = await readable(ctx, await viewing(ctx, signIn), named);
    if (factory === null) return null;
    const known = await recentOf(ctx, factory);
    const groups = new Map<string, SessionRow[]>();
    for (const each of known.filter(open)) {
      const row = rowOf(each);
      groups.set(row.workflow, [...(groups.get(row.workflow) ?? []), row]);
    }
    return {
      running: [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([workflow, sessions]) => ({ workflow, sessions })),
      recent: known.filter(finished).map(rowOf).sort((a, b) => b.endedAt - a.endedAt).slice(0, RECENT),
    };
  },
});

/** A command waiting for a station: queued, or delivered and not yet answered. The page's clock says whether it expired. */
export interface Waiting {
  verb: Verb;
  /** The session it is for; "" for a run, which starts one. */
  session: string;
  /** A run's workflow; "" for any other verb. */
  workflow: string;
  by: string;
  state: CommandState;
  issuedAt: number;
  expiresAt: number;
}

/** A station's record over the period the page asked for: the sessions it ran, how many failed, and what its key paid. */
export interface StationRecord {
  sessions: number;
  failed: number;
  cost: number;
}

/** A station as the Stations tab shows it, with everything that depends on it. */
export interface StationDetail {
  station: string;
  name: string;
  kind: string;
  /** Whose it is: "" for a station nobody approved, which takes no commands. */
  owner: string;
  /** Holds a command token that was not revoked. */
  registered: boolean;
  /** When its long-lived loop last polled: 0 for never. */
  seenAt: number;
  /** What its last poll said: the verbs it obeys, its checkout, the watchers it runs. Null before it ever polled. */
  report: Report | null;
  sessions: SessionRow[];
  claims: ClaimView[];
  /** The release it runs, as the latest session it started said; "" before it started any. */
  release: string;
  period: StationRecord;
  commands: Waiting[];
  /** Whether the viewer may revoke its token: its owner, or an admin of the repository. */
  revocable: boolean;
}

/** Most `spend` rows a station's record sums: past it, the period's spend is what was summed so far. */
const SPEND_SUMMED = 10_000;

/**
 * Every station of the factory that is registered, holds a session or holds
 * a claim — a station that never registered still runs sessions and asks for
 * claims — and one CI entry for every CI job: the sessions that ran in CI and
 * the self-descriptions CI pushed. Each station says the release it runs, the
 * commands waiting for it, and its record over `period` — the page's last 30
 * days, by its own midnights, so the query changes only when the day does.
 */
export const stations = query({
  args: { factory: v.string(), signIn: v.optional(v.string()), period: periodValidator },
  handler: async (ctx, { factory: named, signIn, period }) => {
    const who = await viewing(ctx, signIn);
    const factory = await readable(ctx, who, named);
    if (factory === null) return null;
    const known = await recentOf(ctx, factory);
    const claims = await heldOn(ctx, who, factory);
    const shown = new Map<string, StationDetail>();
    const detail = (station: string, facts: Partial<StationDetail> = {}): StationDetail => {
      const found = shown.get(station) ?? {
        station, name: station, kind: "local", owner: "", registered: false, seenAt: 0, report: null, sessions: [], claims: [],
        release: "", period: { sessions: 0, failed: 0, cost: 0 }, commands: [], revocable: false,
      };
      shown.set(station, Object.assign(found, facts));
      return found;
    };
    for (const row of await reporting(ctx, factory)) {
      detail(row.station, {
        name: row.name, kind: row.kind, owner: row.ownerLogin, registered: row.token !== null, seenAt: row.seenAt, report: row.report,
        revocable: await mayRevoke(ctx, who, row), commands: await waitingFor(ctx, factory, row.station),
      });
    }
    for (const each of known.filter(held)) {
      const { stationId, stationName, stationKind } = each.summary;
      if (!stationId || stationKind === "ci") continue;
      const found = shown.get(stationId) ?? detail(stationId, { name: stationName || stationId, kind: stationKind || "local" });
      found.sessions.push(rowOf(each));
    }
    for (const claim of claims) {
      (shown.get(claim.station) ?? detail(claim.station, { name: claim.stationName })).claims.push(claim);
    }
    // Newest first, so the first session a station started is its latest: the release it runs now.
    for (const each of known) {
      const found = shown.get(each.summary.stationId);
      if (found === undefined) continue;
      if (!found.release) found.release = each.summary.skillVersion;
      const ended = endedAt(each);
      if (ended >= period.from && ended < period.to) {
        found.period.sessions += 1;
        if (each.summary.status === "fail") found.period.failed += 1;
      }
    }
    const stationOf = new Map(known.map((each) => [each.session, each.summary.stationId]));
    let summed = 0;
    for (const spelling of await spellingsOf(ctx, factory)) {
      const rows = ctx.db.query("spend").withIndex("by_factory_at", (q) => q.eq("factory", spelling).gte("at", period.from).lt("at", period.to));
      for await (const row of rows) {
        if ((summed += 1) > SPEND_SUMMED) break;
        const found = shown.get(row.station ?? stationOf.get(row.session) ?? "");
        if (found !== undefined) found.period.cost += row.cost;
      }
    }
    const checks = await ctx.db.query("checks").withIndex("by_factory_at", (q) => q.eq("factory", factory)).order("desc").take(RECENT);
    return {
      stations: [...shown.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
      ci: {
        jobs: known.filter((each) => each.summary.stationKind === "ci").map(rowOf).slice(0, RECENT),
        checks: checks.map((check) => ({ ref: check.ref, head: check.head, ok: check.ok, station: check.stationName, at: check.at })),
      },
    };
  },
});

/** The commands queued for `station` of `factory`, or delivered and not yet answered, oldest first. */
async function waitingFor(ctx: QueryCtx, factory: string, station: string): Promise<Waiting[]> {
  const rows: Doc<"commands">[] = [];
  for (const state of ["queued", "delivered"] as const) {
    rows.push(...await ctx.db.query("commands")
      .withIndex("by_station_state", (q) => q.eq("factory", factory).eq("station", station).eq("state", state))
      .collect());
  }
  return rows
    .map((row) => ({
      verb: row.verb, session: row.session, workflow: row.workflow ?? "", by: row.by, state: row.state,
      issuedAt: row.issuedAt, expiresAt: row.expiresAt,
    }))
    .sort((a, b) => a.issuedAt - b.issuedAt);
}
