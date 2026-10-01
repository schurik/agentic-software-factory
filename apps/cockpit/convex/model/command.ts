/**
 * Commands and the stations that take them, as a model (spec #40).
 *
 * A COMMAND is the steering the forge cannot carry — kill, resume, answering a
 * terminal-channel gate, a prompt run — from a closed vocabulary with typed
 * fields only. The cockpit queues one and the station decides: it obeys only
 * verbs its `factory.yaml` opts in, only for a `by` its `trusted_authors`
 * accepts, and says what it did in a `command_result` event — the one source
 * for "done". So the cockpit never claims a command did anything; it says it
 * is queued, delivered, done or refused, as the station reported.
 *
 * LIVENESS is read off the polls stations already make, never a heartbeat of
 * its own: a session is ATTENDED while its run's own shipper keeps polling for
 * it, a station ONLINE while its long-lived loop does. Both are timestamps the
 * page compares with its own clock, so "last seen" keeps counting.
 *
 * The other end of this wire is `engine/commands.py` in the factory.
 */
import { type Infer, v } from "convex/values";
import type { Role } from "../forge/forge";
import { isRecord } from "./wire";

export const verbValidator = v.union(
  v.literal("answer"), v.literal("abort"), v.literal("kill"), v.literal("resume"), v.literal("run"),
);
export type Verb = Infer<typeof verbValidator>;

export const commandStateValidator = v.union(
  v.literal("queued"), v.literal("delivered"), v.literal("done"), v.literal("refused"), v.literal("expired"),
);
export type CommandState = Infer<typeof commandStateValidator>;

/** What every poll says about the station: never its config, only where it stands. */
export const reportValidator = v.object({
  verbs: v.array(v.string()),         // what it would obey: opted in, and known to its release
  head: v.string(),                   // the commit its checkout has out
  configHash: v.string(),             // sha256 over its asf/ files
  watchers: v.array(v.string()),      // what its station loop runs
});
export type Report = Infer<typeof reportValidator>;

export const stationFieldsValidator = v.object({ id: v.string(), name: v.string(), kind: v.string() });
export type StationFields = Infer<typeof stationFieldsValidator>;

/** A run's shipper polled within this: the session is attended. */
export const ATTENDED_FOR = 10_000;
/** A station's loop polled within this: the station is online. */
export const ONLINE_FOR = 10_000;
/** How long a kill waits for a station: minutes, so a laptop waking up tomorrow never acts on it. */
export const KILL_FOR = 5 * 60_000;
/** A command delivered and never answered goes out again after this; the station's record makes it act once. */
export const REDELIVER_AFTER = 30_000;
/** How long a registration's code may wait for a person. */
export const REGISTRATION_FOR = 10 * 60_000;
/** How often a registering station asks whether it was approved, in seconds. */
export const REGISTRATION_POLL = 2;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";     // nothing a person misreads

/** A code a person reads off a terminal and finds again on a page: `ABCD-EF23`. */
export function userCode(random: Uint8Array): string {
  const letters = Array.from(random.slice(0, 8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
}

/** A code as a person might type it: case and the dash are theirs to forget. */
export function normalCode(typed: string): string {
  const letters = typed.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

// ── the wire ─────────────────────────────────────────────────────────────────

export type Refusal = { status: number; error: string };

export function isRefusal(value: unknown): value is Refusal {
  return isRecord(value) && typeof value.error === "string" && typeof value.status === "number";
}

/** A registration request's body: `{station: {id, name, kind}}`. */
export function parseRegistration(body: unknown): StationFields | Refusal {
  const station = isRecord(body) ? body.station : undefined;
  if (!isRecord(station) || !text(station.id) || typeof station.name !== "string") {
    return { status: 400, error: "a registration names its station: {station: {id, name, kind}}" };
  }
  const kind = typeof station.kind === "string" ? station.kind : "local";
  if (kind === "ci") return { status: 400, error: "a CI station takes no commands, so it is never registered" };
  return { id: station.id as string, name: station.name || (station.id as string), kind };
}

export interface PollBody {
  station: string;
  session: string;                    // "" from the station loop
  report: Report;
  /** False when the poll could not know what watchers run: a run's own shipper. */
  watchersKnown: boolean;
}

/** A command poll's body: `{station, session?, report: {verbs, head, config_hash, watchers}}`. */
export function parsePoll(body: unknown): PollBody | Refusal {
  if (!isRecord(body) || !text(body.station)) return { status: 400, error: "a poll names its station" };
  const report = isRecord(body.report) ? body.report : {};
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    station: body.station as string,
    session: typeof body.session === "string" ? body.session : "",
    report: {
      verbs: strings(report.verbs),
      head: typeof report.head === "string" ? report.head : "",
      configHash: typeof report.config_hash === "string" ? report.config_hash : "",
      watchers: strings(report.watchers),
    },
    watchersKnown: Array.isArray(report.watchers),
  };
}

function text(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

// ── liveness, as a page tells it ─────────────────────────────────────────────

export interface Liveness {
  attended: boolean;
  online: boolean;
  /** When anything of the station's last polled, epoch ms; null when nothing ever has. */
  lastSeen: number | null;
}

export function liveness(seenAt: number, attendedAt: number | null, now: number): Liveness {
  const lastSeen = Math.max(seenAt, attendedAt ?? 0);
  return {
    attended: attendedAt !== null && now - attendedAt < ATTENDED_FOR,
    online: seenAt > 0 && now - seenAt < ONLINE_FOR,
    lastSeen: lastSeen > 0 ? lastSeen : null,
  };
}

// ── who may queue a kill ─────────────────────────────────────────────────────

const RANK: Role[] = ["read", "triage", "write", "maintain", "admin"];

/** Whether `role` is write or higher: the bar for any direct command. */
export function writes(role: Role | null): boolean {
  return role !== null && RANK.indexOf(role) >= RANK.indexOf("write");
}

export interface StationFacts {
  name: string;
  kind: string;
  registered: boolean;                // holds a command token that was not revoked
  verbs: string[] | null;             // what its report says it obeys; null before it ever polled
}

/**
 * Why a viewer holding `role` may not queue `verb` for a session on
 * `station` — null when they may. Whether the station is online is not a
 * reason: a command for an offline station waits for it, until it expires.
 */
export function commandRefusal(verb: Verb, role: Role | null, station: StationFacts | null): string | null {
  if (!writes(role)) {
    return role === null ? "the forge has not said what you may do on this repository"
      : `commands need write or higher on this repository, and the forge says you have ${role}`;
  }
  if (station === null) return "no station has said it holds this session";
  if (station.kind === "ci") return "it ran in CI, and a CI station takes no commands";
  if (!station.registered) return `${station.name} takes no commands: run \`asf station register\` on it`;
  if (station.verbs === null) return `${station.name} has never polled for commands`;
  if (!station.verbs.includes(verb)) {
    return `${station.name} does not take ${verb}: its asf/factory.yaml's cockpit.commands does not list it`;
  }
  return null;
}
