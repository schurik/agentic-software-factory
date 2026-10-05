import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { needsAttention } from "../convex/model/attention";
import { fakeForge, type FakeForge } from "./forge";
import { catchUp, cockpit, type Cockpit, factory, fixture, ingest, recorded, signIn, team, type WireEvent } from "./helpers";
import { post } from "./station";

// Now (#115): one query for the viewer across every factory the permission
// mirror lets them read — the gates waiting on them, what needs attention,
// what is running, and the gates waiting on someone else. Whether a fact is
// worth attention, a session stuck or a wait long is the page's to say, by
// its own clock (nowview.test.tsx); the query only gathers.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 3600_000;

interface Shipped {
  session: string;
  status?: "running" | "waiting" | "fail";
  trusted?: string[];
}

function shipped({ session, status = "running", trusted = [] }: Shipped): WireEvent[] {
  const started = fixture("session_started", 1, 2);
  Object.assign(started.payload, {
    adw_id: session, workflow: "issue", request: `#42 ${session} broken`, issue_url: "https://github.com/acme/widgets/issues/42",
    started_at: new Date(NOW - 2 * HOUR).toISOString(),
  });
  if (status === "running") return [started];
  if (status === "waiting") {
    const suspended = fixture("suspended", 2, 2);
    Object.assign(suspended.payload, { trusted });
    return [started, suspended];
  }
  const finished = fixture("session_finished", 2);
  Object.assign(finished.payload, { status, ended_at: new Date(NOW - HOUR).toISOString() });
  return [started, finished];
}

async function ship(t: Cockpit, token: string, ...sessions: Shipped[]): Promise<void> {
  for (const given of sessions) {
    expect((await ingest(t, token, { session: given.session, events: shipped(given) })).status).toBe(200);
  }
}

/** A team on `forge` whose repositories each hold a factory, the people in each holding those roles. */
async function teamOf(forge: FakeForge, roles: Record<string, Record<string, "read" | "write">>): Promise<Cockpit> {
  for (const login of new Set(Object.values(roles).flatMap((byLogin) => Object.keys(byLogin)))) forge.person(login);
  for (const [repo, byLogin] of Object.entries(roles)) forge.repo(repo, { factory: true, roles: byLogin });
  const t = cockpit();
  await team(t, forge);
  forge.install("acme");
  await catchUp(t);
  return t;
}

const golden = import.meta.glob("../../../tests/golden/self-description/v1.json",
                                { eager: true, import: "default" }) as Record<string, Record<string, unknown>>;

/** The factory's CI pushing its self-description, whose budget is $2.50 a session. */
async function described(t: Cockpit, token: string): Promise<void> {
  const description = { ...structuredClone(Object.values(golden)[0]), ok: true };
  const station = { id: "st_ci0001", name: "runner@fv-az123:widgets", kind: "ci" };
  expect((await post(t, "/describe", token, { station, description })).status).toBe(200);
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

describe("the Now query", () => {
  it("gathers the four sections across every factory the viewer can read, and leaves out the ones they cannot", async () => {
    const t = await teamOf(forge, {
      "acme/widgets": { alex: "write", dana: "write" },
      "acme/gadgets": { alex: "read" },
      "acme/secret": { dana: "write" },
    });
    const widgets = await factory(t, "acme/widgets");
    const gadgets = await factory(t, "acme/gadgets");
    const secret = await factory(t, "acme/secret");
    await ship(t, widgets, { session: "w1mine", status: "waiting", trusted: ["alex"] },
               { session: "w2dana", status: "waiting", trusted: ["dana"] }, { session: "w3run" });
    await ship(t, gadgets, { session: "g1run" }, { session: "g2fail", status: "fail" });
    await described(t, gadgets);
    await ship(t, secret, { session: "s1wait", status: "waiting" }, { session: "s2run" }, { session: "s3fail", status: "fail" });

    const page = (await t.query(api.now.page, { signIn: await signIn(t, forge, "alex") }))!;

    expect(page.inbox.map(({ factory: at, session }) => `${at}/${session}`)).toEqual(["acme/widgets/w1mine"]);
    expect(page.others.map(({ factory: at, session, waitsOn }) => ({ at: `${at}/${session}`, waitsOn })))
      .toEqual([{ at: "acme/widgets/w2dana", waitsOn: ["dana"] }]);
    expect(page.running.map(({ factory: at, session, title, ceiling }) => ({ at: `${at}/${session}`, title, ceiling })))
      .toEqual(expect.arrayContaining([
        { at: "acme/widgets/w3run", title: "#42 w3run broken", ceiling: 0 },
        { at: "acme/gadgets/g1run", title: "#42 g1run broken", ceiling: 2.5 },
      ]));
    expect(page.running).toHaveLength(2);
    // The facts, by factory: the page says which are worth attention by its clock.
    expect(page.attention.map(({ factory: at }) => at).sort()).toEqual(["acme/gadgets", "acme/widgets"]);
    const gadgetsFacts = page.attention.find(({ factory: at }) => at === "acme/gadgets")!.facts;
    expect(needsAttention(gadgetsFacts, NOW)).toEqual([
      { kind: "failed", sessions: [expect.objectContaining({ session: "g2fail", title: "#42 g2fail broken" })] },
    ]);
  });

  it("covers a repository that ships sessions before the forge shows it as a factory, where the viewer can read it", async () => {
    // A factory stamped on a branch ships before asf/factory.yaml reaches the default branch.
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    forge.repo("acme/branchy", { roles: { alex: "read" } });
    forge.repo("acme/hidden", { roles: {} });
    await catchUp(t);
    await ship(t, await factory(t, "acme/branchy"), { session: "b1run" }, { session: "b2fail", status: "fail" });
    await ship(t, await factory(t, "acme/hidden"), { session: "h1run" }, { session: "h2fail", status: "fail" });

    const page = (await t.query(api.now.page, { signIn: await signIn(t, forge, "alex") }))!;
    expect(page.running.map(({ factory: at, session }) => `${at}/${session}`)).toEqual(["acme/branchy/b1run"]);
    expect(page.attention.map(({ factory: at }) => at).sort()).toEqual(["acme/branchy", "acme/widgets"]);
  });

  it("names a session started on an issue by the work item its provenance named", async () => {
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    const staged = recorded["issue-then-two-reviews-in-stages"].events;
    const upTo = staged.findIndex((event) => event.kind === "phase_started" && event.payload.name === "plan");
    const session = String(staged[0].payload.adw_id);
    expect((await ingest(t, await factory(t, "acme/widgets"), { session, events: staged.slice(0, upTo + 1) })).status).toBe(200);

    const page = (await t.query(api.now.page, { signIn: await signIn(t, forge, "alex") }))!;
    expect(page.running.map(({ title }) => title)).toEqual(["#42 Resolve relative due dates via the meeting date"]);
  });

  it("is nothing to someone who has not signed in to a team's cockpit", async () => {
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    await ship(t, await factory(t, "acme/widgets"), { session: "w1mine", status: "waiting" });
    expect(await t.query(api.now.page, {})).toBeNull();
  });
});

describe("the Now badge", () => {
  it("counts the gates waiting on the viewer, and nothing waiting on someone else or where they cannot read", async () => {
    const t = await teamOf(forge, { "acme/widgets": { alex: "write", dana: "write" }, "acme/secret": { dana: "write" } });
    await ship(t, await factory(t, "acme/widgets"), { session: "w1mine", status: "waiting", trusted: ["alex"] },
               { session: "w2any", status: "waiting" }, { session: "w3dana", status: "waiting", trusted: ["dana"] });
    await ship(t, await factory(t, "acme/secret"), { session: "s1wait", status: "waiting" });

    expect(await t.query(api.inbox.count, { signIn: await signIn(t, forge, "alex") })).toBe(2);
    expect(await t.query(api.inbox.count, { signIn: await signIn(t, forge, "dana") })).toBe(3);
    expect(await t.query(api.inbox.count, {})).toBe(0);
  });
});

describe("a running session's progress", () => {
  const STAGED = recorded["issue-then-two-reviews-in-stages"].events;

  it("is the chapter it is in, as a mini graph: the stage it is in, and the phase there, since when", async () => {
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    const token = await factory(t, "acme/widgets");
    // Up to the first agent phase of the plan stage, still running.
    const upTo = STAGED.findIndex((event) => event.kind === "phase_started" && event.payload.name === "plan");
    const session = String(STAGED[0].payload.adw_id);
    expect((await ingest(t, token, { session, events: STAGED.slice(0, upTo + 1) })).status).toBe(200);

    const progress = (await t.query(api.sessions.progress, { factory: "acme/widgets", session, signIn: await signIn(t, forge, "alex") }))!;
    expect(progress.stage).toBe("plan");
    expect(progress.phase).toEqual({ name: "plan", since: STAGED[upTo].ts });
    const current = progress.mini.blocks[progress.mini.current!];
    expect(current).toMatchObject({ stage: "plan", status: "running" });
    expect(progress.mini.blocks.map((block) => block.status)).toEqual(["done", "running", ...Array(8).fill("pending")]);
  });

  it("is nothing to someone who may not read the session", async () => {
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" }, "acme/secret": { dana: "write" } });
    await ship(t, await factory(t, "acme/widgets"), { session: "w3run" });
    expect(await t.query(api.sessions.progress, { factory: "acme/widgets", session: "w3run",
                                                 signIn: await signIn(t, forge, "dana") })).toBeNull();
  });
});
