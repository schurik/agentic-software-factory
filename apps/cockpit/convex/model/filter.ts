/**
 * Finding a session (spec #40): what the Sessions pages — a factory's tab,
 * and the one across factories — narrow their list by. Each filter a person
 * leaves unset lets every session through.
 */
import { forYou } from "./inbox";
import type { Period } from "./period";
import { at, endedAt, type Summary } from "./session";

/** A stored session, as much of it as finding one reads. */
export interface Known {
  /** When the cockpit last folded anything into it, epoch ms. */
  activity: number;
  summary: Summary;
}

/**
 * The station filter's one entry for every CI job, as the Stations tab
 * collapses them: a job's station is minted for the job and gone with it.
 * Never a station's own id, which is minted `st_…` (engine/station.py).
 */
export const CI = "ci";

/** The statuses a session can be found in: `status`'s choices are always all of them. */
export const STATUSES = ["running", "waiting", "success", "fail"] as const;
export type Status = (typeof STATUSES)[number];

export interface SessionFilter {
  /** A workflow the session passed through, in any chapter. */
  workflow?: string;
  /** Who triggered it — the labeller, or whoever ran `asf run` — as the inbox's "for you" reads it. */
  person?: string;
  /** The station holding it, by its id — or `CI`, for any CI job. */
  station?: string;
  status?: Status;
  /** A period it was alive at any moment of: started before its end, and ended — if it has — after its start. */
  period?: Period;
}

export function matches(known: Known, filter: SessionFilter): boolean {
  const { summary } = known;
  if (filter.workflow && !summary.workflows.includes(filter.workflow)) return false;
  if (filter.person && !forYou(summary, filter.person).includes("triggered")) return false;
  if (filter.status && summary.status !== filter.status) return false;
  if (filter.station && stationOf(summary) !== filter.station) return false;
  if (filter.period && !alive(known, filter.period)) return false;
  return true;
}

/** What the station filter knows a session's station by. */
function stationOf(summary: Summary): string {
  return summary.stationKind === "ci" ? CI : summary.stationId;
}

/** Whether a session was alive at any moment of `period`. One live or suspended is alive still. */
function alive(known: Known, { from, to }: Period): boolean {
  const open = known.summary.status === "running" || known.summary.status === "waiting";
  const end = open ? Infinity : endedAt(known);
  const start = at(known.summary.startedAt) ?? Math.min(end, known.activity);
  return start < to && end >= from;
}


/** How far a list looks: the sessions it shows at most, and how many stored ones it reads to find them. */
export interface Limits {
  shown: number;
  read: number;
}

export interface Found<R> {
  /** The sessions the filter kept, in the order they were read. */
  sessions: R[];
  /** The choices each filter offers: from every readable session looked at, kept or not. */
  facets: Facets;
  /** How many readable sessions were looked at. */
  looked: number;
  /** Whether it stopped at a limit with sessions left unread: older ones may match too. */
  cut: boolean;
}

/**
 * The sessions in `records` — most recently active first — that the viewer
 * may read and `filter` keeps, read until `limits` say stop. A filter narrows
 * what is looked at, never how far: a narrow one finds older sessions than a
 * wide one only because it has fewer to show.
 */
export async function find<R extends Known & { factory: string }>(
  records: AsyncIterable<R>, readable: (factory: string) => Promise<boolean>, filter: SessionFilter, limits: Limits,
): Promise<Found<R>> {
  const looked: R[] = [];
  const sessions: R[] = [];
  let read = 0;
  let cut = false;
  for await (const record of records) {
    if (read === limits.read || sessions.length === limits.shown) {
      cut = true;
      break;
    }
    read += 1;
    if (!(await readable(record.factory))) continue;
    looked.push(record);
    if (matches(record, filter)) sessions.push(record);
  }
  return { sessions, facets: facetsOf(looked), looked: looked.length, cut };
}

/** What each filter offers to narrow by: what the sessions looked at hold. */
export interface Facets {
  workflows: string[];
  /** Logins, one per person whatever the case. */
  people: string[];
  /** Each station by the id the filter takes and the name it was last seen under; CI last. */
  stations: { key: string; name: string }[];
}


/** The choices `known`'s sessions offer — read most recently active first, so a station goes by its latest name. */
export function facetsOf(known: Known[]): Facets {
  const workflows = new Set<string>();
  const people = new Map<string, string>();
  const stations = new Map<string, string>();
  for (const { summary } of known) {
    for (const workflow of summary.workflows) workflows.add(workflow);
    const login = summary.triggeredBy;
    if (login && !people.has(login.toLowerCase())) people.set(login.toLowerCase(), login);
    const key = stationOf(summary);
    if (key && !stations.has(key)) stations.set(key, key === CI ? "CI" : summary.stationName || key);
  }
  const listed = [...stations].map(([key, name]) => ({ key, name }));
  return {
    workflows: [...workflows].sort(byName),
    people: [...people.values()].sort(byName),
    stations: [
      ...listed.filter(({ key }) => key !== CI).sort((a, b) => byName(a.name, b.name)),
      ...listed.filter(({ key }) => key === CI),
    ],
  };
}

function byName(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}
