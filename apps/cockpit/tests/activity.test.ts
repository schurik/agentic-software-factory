import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { type Attention, needsAttention } from "../convex/model/attention";
import { fakeForge, type FakeForge } from "./forge";
import { catchUp, factory, fixture, ingest, signIn, type WireEvent } from "./helpers";
import { approved, poll, post, REPORT, STATION, teamOf } from "./station";

// A factory's Activity (spec #40): what needs attention — gates waiting, failed
// sessions, claims whose station has been away a day, drift, a failing check,
// and nobody watching — what is running now, and what finished last. The query
// is what the cockpit was told; whether each thing is worth a person's
// attention is read against the page's clock (`needsAttention`), so a failure
// stops being news without anything new arriving.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 3600_000;

interface Shipped {
  session: string;
  workflow?: string;
  station?: { id: string; name: string; kind?: string };
  /** running (the default), waiting at a gate, or finished as success | fail. */
  status?: "running" | "waiting" | "success" | "fail";
  endedAt?: number;
  trusted?: string[];
}

const ALEX = STATION;
const REQUEUE = { add: ["asf:queued"], remove: ["asf:running"] };

const TIP = "a".repeat(40);
const CI = { id: "st_ci0001", name: "runner@fv-az123:widgets", kind: "ci" };
const golden = import.meta.glob("../../../tests/golden/self-description/v1.json",
                                { eager: true, import: "default" }) as Record<string, Record<string, unknown>>;

/** The CI workflow's `asf check --json`, pushed for the default branch at TIP. */
async function checked(t: Awaited<ReturnType<typeof teamOf>>, token: string, ok: boolean, configHash = "c0ffee") {
  const description = { ...structuredClone(Object.values(golden)[0]), ok, checked: { head: TIP, ref: "main", config_hash: configHash } };
  expect((await post(t, "/describe", token, { station: CI, description })).status).toBe(200);
}

const labels = (import.meta.glob("../../../tests/golden/labels/descriptions.json", { eager: true, import: "default" }) as
  Record<string, Record<"route" | "queued" | "running", { name: string; description: string }>>)["../../../tests/golden/labels/descriptions.json"];

/** The labels `asf labels --create` makes, and issues: #42 queued for a route, #43 queued for none, #44 closed, #45 a run's. */
function labelled(forge: FakeForge): void {
  for (const label of Object.values(labels)) forge.label("acme/widgets", label.name, label.description);
  const { route, queued, running } = labels;
  forge.issue("acme/widgets", 42, { title: "health check broken", labels: [queued.name, route.name] });
  forge.issue("acme/widgets", 43, { title: "no route", labels: [queued.name] });
  forge.issue("acme/widgets", 44, { title: "closed", state: "closed", labels: [queued.name, route.name] });
  forge.issue("acme/widgets", 45, { title: "a run has it", labels: [running.name, route.name] });
}

/** `station` asking for issue `number` for `session`, as a watcher does before it touches a label. */
async function claimed(t: Awaited<ReturnType<typeof teamOf>>, token: string, session: string, number: number, station = ALEX) {
  const response = await post(t, "/claims", token, {
    op: "take", repo: "acme/widgets", kind: "issue", number, session, since: 0, station, requeue: REQUEUE,
  });
  expect(response.status).toBe(200);
}

/** A session as its station ships it, ending where `given` says. */
function shipped(given: Shipped): WireEvent[] {
  const station = given.station ?? ALEX;
  const started = fixture("session_started", 1, 2);
  Object.assign(started.payload, {
    adw_id: given.session, workflow: given.workflow ?? "issue", station_id: station.id, station_name: station.name,
    station_kind: station.kind ?? "local", started_at: new Date(NOW - 2 * HOUR).toISOString(),
  });
  const status = given.status ?? "running";
  if (status === "running") return [started];
  if (status === "waiting") {
    const suspended = fixture("suspended", 2, 2);
    Object.assign(suspended.payload, { trusted: given.trusted ?? [] });
    return [started, suspended];
  }
  const finished = fixture("session_finished", 2);
  Object.assign(finished.payload, { status, ended_at: new Date(given.endedAt ?? NOW - HOUR).toISOString() });
  return [started, finished];
}

async function ship(t: Awaited<ReturnType<typeof teamOf>>, token: string, ...sessions: Shipped[]): Promise<void> {
  for (const given of sessions) {
    expect((await ingest(t, token, { session: given.session, events: shipped(given) })).status).toBe(200);
  }
}

/** What needs attention on acme/widgets for `holding`, as the page would read it at `now`. */
async function attention(t: Awaited<ReturnType<typeof teamOf>>, holding: string, now = NOW): Promise<Attention[]> {
  const facts = await t.query(api.activity.attention, { factory: "acme/widgets", signIn: holding });
  expect(facts).not.toBeNull();
  return needsAttention(facts!, now);
}

function kinds(items: Attention[]): string[] {
  return items.map((item) => item.kind);
}

let forge: FakeForge;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  forge = fakeForge();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("needs attention", () => {
  it("is nothing for a factory where nothing waits, failed, drifted or sits unwatched", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    await ship(t, token, { session: "a1" }, { session: "a2", status: "success" });

    expect(await attention(t, await signIn(t, forge, "alex"))).toEqual([]);
  });

  it("names the gates waiting that the viewer may answer, and how many wait in all", async () => {
    const t = await teamOf(forge, { alex: "write", sam: "write" });
    const token = await factory(t, "acme/widgets");
    await ship(t, token,
      { session: "g1", status: "waiting", trusted: ["alex"] },
      { session: "g2", status: "waiting" },
      { session: "g3", status: "waiting", trusted: ["sam"] });

    expect(await attention(t, await signIn(t, forge, "alex"))).toEqual([{ kind: "gates", mine: 2, total: 3 }]);
    expect(await attention(t, await signIn(t, forge, "sam"))).toEqual([{ kind: "gates", mine: 2, total: 3 }]);
  });

  it("leaves out gates waiting only on someone else: there is nothing in the inbox for the viewer to do", async () => {
    const t = await teamOf(forge, { alex: "write", sam: "write" });
    const token = await factory(t, "acme/widgets");
    await ship(t, token, { session: "g3", status: "waiting", trusted: ["sam"] });

    expect(kinds(await attention(t, await signIn(t, forge, "alex")))).toEqual([]);
  });

  it("names the sessions that failed in the last day, newest first, and lets an older failure go", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    await ship(t, token,
      { session: "f1", workflow: "issue", status: "fail", endedAt: NOW - 3 * HOUR },
      { session: "f2", workflow: "pr-review", status: "fail", endedAt: NOW - HOUR },
      { session: "f3", status: "fail", endedAt: NOW - 25 * HOUR },
      { session: "ok", status: "success", endedAt: NOW - HOUR });
    const alex = await signIn(t, forge, "alex");

    expect(await attention(t, alex)).toEqual([{
      kind: "failed",
      sessions: [
        { session: "f2", workflow: "pr-review", station: ALEX.name, endedAt: NOW - HOUR },
        { session: "f1", workflow: "issue", station: ALEX.name, endedAt: NOW - 3 * HOUR },
      ],
    }]);
    // A day on, the same facts are no longer news.
    expect(await attention(t, alex, NOW + 24 * HOUR)).toEqual([]);
  });

  it("forgets a failure once the session is resumed and goes on", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    await ship(t, token, { session: "f1", status: "fail", endedAt: NOW - HOUR });
    const resumed = fixture("session_started", 3, 2);
    Object.assign(resumed.payload, { adw_id: "f1", station_id: ALEX.id, station_name: ALEX.name });
    await ingest(t, token, { session: "f1", events: [resumed] });

    expect(await attention(t, await signIn(t, forge, "alex"))).toEqual([]);
  });

  it("lifts a claim whose station has been away for over a day, saying how long — and leaves a recent one be", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    vi.setSystemTime(NOW - 50 * HOUR);
    await ship(t, token, { session: "c1" });
    await claimed(t, token, "c1", 42);
    await poll(t, await approved(t, token, alex));        // the station's loop, heard from once, 50 hours ago
    vi.setSystemTime(NOW);

    const lifted = await attention(t, alex);
    expect(kinds(lifted)).toEqual(["claim"]);
    expect(lifted[0]).toMatchObject({
      kind: "claim", away: 50 * HOUR,
      claim: { kind: "issue", number: 42, station: ALEX.id, stationName: ALEX.name, session: "c1", refused: null,
               consequence: "relabels #42 `asf:queued` and abandons session c1" },
    });
    expect(kinds(await attention(t, alex, NOW - 30 * HOUR))).toEqual([]);
  });

  it("counts a station away from the last it was heard of: its loop, its run, or its asking for the claim", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    vi.setSystemTime(NOW - 30 * HOUR);
    await ship(t, token, { session: "c1" }, { session: "c2" });
    await claimed(t, token, "c1", 42);                  // a station that never registered: no loop ever polls
    vi.setSystemTime(NOW - 2 * HOUR);
    await claimed(t, token, "c2", 43);
    vi.setSystemTime(NOW);

    const lifted = await attention(t, alex);
    expect(lifted.map((item) => item.kind === "claim" && [item.claim.number, item.away])).toEqual([[42, 30 * HOUR]]);
  });

  it("never lifts a claim that was let go", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    vi.setSystemTime(NOW - 50 * HOUR);
    await ship(t, token, { session: "c1" });
    await claimed(t, token, "c1", 42);
    await ship(t, token, { session: "c1", status: "success", endedAt: NOW - 49 * HOUR });
    vi.setSystemTime(NOW);

    expect(await attention(t, await signIn(t, forge, "alex"))).toEqual([]);
  });

  it("says the default branch's check is failing, and nothing of a passing one or of none", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    expect(await attention(t, alex)).toEqual([]);                   // unchecked: not broken

    await checked(t, token, false);
    expect(await attention(t, alex)).toEqual([{ kind: "check" }]);
    await checked(t, token, true);
    expect(await attention(t, alex)).toEqual([]);
  });

  it("names the stations whose config is not the default branch's", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    const command = await approved(t, token, alex);
    await checked(t, token, true, "c0ffee");

    await poll(t, command, { report: { ...REPORT, config_hash: "c0ffee" } });     // behind, with the same config
    expect(await attention(t, alex)).toEqual([]);
    await poll(t, command, { report: { ...REPORT, config_hash: "beef" } });
    expect(await attention(t, alex)).toEqual([
      { kind: "drift", stations: [{ station: ALEX.id, name: ALEX.name, badges: [`on ${REPORT.head.slice(0, 7)}`] }] },
    ]);
  });

  it("goes by the drift a page measured against the forge's tip, when it has one, over the last check's", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    await poll(t, await approved(t, token, alex), { report: { ...REPORT, config_hash: "beef" } });
    const facts = (await t.query(api.activity.attention, { factory: "acme/widgets", signIn: alex }))!;
    expect(needsAttention(facts, NOW)).toEqual([]);                       // no check: nothing to measure by here

    const measured = [{ station: ALEX.id, name: ALEX.name, badges: ["3 commits behind"] }];
    expect(needsAttention(facts, NOW, measured)).toEqual([{ kind: "drift", stations: measured }]);
    expect(needsAttention(facts, NOW, [])).toEqual([]);
  });

  it("says nobody is watching when issues are queued for a route and no station runs an issues watcher", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    labelled(forge);
    await catchUp(t);

    expect(await attention(t, alex)).toEqual([{ kind: "unwatched", issues: [42] }]);

    const command = await approved(t, token, alex);
    await poll(t, command, { report: { ...REPORT, watchers: ["answers"] } });
    expect(kinds(await attention(t, alex))).toEqual(["unwatched"]);          // a watcher, but not of issues
    await poll(t, command, { report: { ...REPORT, watchers: ["issues", "answers"] } });
    expect(await attention(t, alex)).toEqual([]);
    expect(kinds(await attention(t, alex, NOW + HOUR))).toEqual(["unwatched"]);  // its loop gone quiet
  });

  it("says nothing of nobody watching while no issue is queued, or before the forge was asked", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const alex = await signIn(t, forge, "alex");
    expect(await attention(t, alex)).toEqual([]);                           // the forge's word not in yet

    labelled(forge);
    forge.issue("acme/widgets", 42, { title: "picked up", labels: [labels.running.name, labels.route.name] });
    await catchUp(t);
    expect(await attention(t, alex)).toEqual([]);
  });

  it("is nothing at all to someone the forge does not let read the repository", async () => {
    const t = await teamOf(forge, { alex: "write" });
    forge.person("eve");
    expect(await t.query(api.activity.attention, { factory: "acme/widgets", signIn: await signIn(t, forge, "eve") })).toBeNull();
  });
});

describe("running now and recent", () => {
  const BOB = { id: "st_bob", name: "bob@desk:widgets", kind: "local" };

  it("groups live and suspended sessions by the workflow they are in, each naming its station", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    await ship(t, token,
      { session: "r1", workflow: "issue" },
      { session: "r2", workflow: "pr-review", station: BOB },
      { session: "r3", workflow: "issue", status: "waiting", station: BOB },
      { session: "done", workflow: "issue", status: "success" });

    const page = await t.query(api.activity.page, { factory: "acme/widgets", signIn: await signIn(t, forge, "alex") });

    expect(page!.running.map((group) => ({
      workflow: group.workflow,
      sessions: group.sessions.map(({ session, status, station, gate }) => ({ session, status, station, gate })),
    }))).toEqual([
      { workflow: "issue", sessions: [
        { session: "r3", status: "waiting", station: BOB.name, gate: "requirements round 1" },
        { session: "r1", status: "running", station: ALEX.name, gate: "" },
      ] },
      { workflow: "pr-review", sessions: [{ session: "r2", status: "running", station: BOB.name, gate: "" }] },
    ]);
  });

  it("lists the last finished sessions, newest first, however they ended", async () => {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    await ship(t, token,
      ...Array.from({ length: 12 }, (_, at) => ({
        session: `s${at}`, status: at % 3 ? "success" as const : "fail" as const, endedAt: NOW - (12 - at) * HOUR,
      })),
      { session: "live" });

    const page = await t.query(api.activity.page, { factory: "acme/widgets", signIn: await signIn(t, forge, "alex") });

    expect(page!.recent.map(({ session, status }) => [session, status])).toEqual([
      ["s11", "success"], ["s10", "success"], ["s9", "fail"], ["s8", "success"], ["s7", "success"],
      ["s6", "fail"], ["s5", "success"], ["s4", "success"], ["s3", "fail"], ["s2", "success"],
    ]);
    expect(page!.recent[0]).toMatchObject({ workflow: "issue", station: ALEX.name, endedAt: NOW - HOUR });
  });

  it("is nothing to someone who may not read the factory", async () => {
    const t = await teamOf(forge, { alex: "write" });
    expect(await t.query(api.activity.page, { factory: "acme/widgets" })).toBeNull();
  });
});

describe("the stations of a factory", () => {
  const BOB = { id: "st_bob", name: "bob@desk:widgets", kind: "local" };

  async function seeded() {
    const t = await teamOf(forge, { alex: "write" });
    const token = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    await poll(t, await approved(t, token, alex), { report: { ...REPORT, watchers: ["issues", "answers"] } });
    await ship(t, token,
      { session: "f1", status: "fail", endedAt: NOW - 3 * HOUR },
      { session: "s1", status: "success" },
      { session: "w1", status: "waiting" },
      { session: "r1" },
      { session: "b1", station: BOB },                                   // a station that never registered
      { session: "ci1", workflow: "pr-review", station: CI, status: "success" });
    await claimed(t, token, "b1", 42, BOB);
    await checked(t, token, true);
    return { t, alex };
  }

  it("lists every station that holds anything, each with its watchers, the sessions it holds and its claims", async () => {
    const { t, alex } = await seeded();

    const shown = await t.query(api.activity.stations, { factory: "acme/widgets", signIn: alex });

    expect(shown!.stations.map(({ station, name, owner, kind, registered, report, sessions, claims }) => ({
      station, name, owner, kind, registered, watchers: report?.watchers ?? null,
      sessions: sessions.map((row) => [row.session, row.status]), claims: claims.map((claim) => claim.number),
    }))).toEqual([
      { station: ALEX.id, name: ALEX.name, owner: "alex", kind: "local", registered: true, watchers: ["issues", "answers"],
        sessions: [["r1", "running"], ["w1", "waiting"], ["f1", "fail"]], claims: [] },
      { station: BOB.id, name: BOB.name, owner: "", kind: "local", registered: false, watchers: null,
        sessions: [["b1", "running"]], claims: [42] },
    ]);
    expect(shown!.stations[0].seenAt).toBe(NOW);
    expect(shown!.stations[0].report).toMatchObject({ verbs: REPORT.verbs, head: REPORT.head });
    expect(shown!.stations[1].claims[0]).toMatchObject({ stationName: BOB.name, session: "b1", refused: null });
  });

  it("collapses every CI job into one entry: its recent jobs and its check pushes", async () => {
    const { t, alex } = await seeded();

    const shown = await t.query(api.activity.stations, { factory: "acme/widgets", signIn: alex });

    expect(shown!.stations.map((station) => station.kind)).not.toContain("ci");
    expect(shown!.ci.jobs.map(({ session, workflow, station }) => [session, workflow, station])).toEqual([["ci1", "pr-review", CI.name]]);
    expect(shown!.ci.checks).toEqual([{ ref: "main", head: TIP, ok: true, station: CI.name, at: NOW }]);
  });

  it("is nothing to someone who may not read the factory", async () => {
    const { t } = await seeded();
    expect(await t.query(api.activity.stations, { factory: "acme/widgets" })).toBeNull();
  });
});
