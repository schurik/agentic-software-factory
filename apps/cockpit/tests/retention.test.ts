import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { catchUp, cockpit, factory, fixture, ingest, signIn, team, type Cockpit, type WireEvent } from "./helpers";
import { fakeForge, type FakeForge } from "./forge";

// Retention (#63): what a cockpit keeps of a session, and for how long. Core
// events are kept forever; handoff bodies (an artifact's content, a command's
// output tail) until someone purges them; a transcript's bodies age out once
// the session has been finished for as long as the deployment allows — or as
// factory.yaml says, when that is shorter.

const SESSION = "5c0075aa";
const WHERE = { factory: "acme/widgets", session: SESSION };

async function ship(t: Cockpit, token: string, events: WireEvent[]) {
  const response = await ingest(t, token, { session: SESSION, events });
  expect(response.status).toBe(200);
}

/** `session_started` v3, saying the retention its process ran under. */
function started(seq: number, days: number): WireEvent {
  const event = fixture("session_started", seq, 3);
  event.payload.transcript_retention_days = days;
  return event;
}

/** One planned phase with its transcript and its handoff bodies, finished at noon on 29 Sep. */
function finished(days = 0): WireEvent[] {
  const artifact = fixture("artifact_written", 5);
  artifact.payload.phase_id = "5c0075aa_03_plan";
  const command = fixture("command_finished", 6);
  command.payload.phase_id = "5c0075aa_03_plan";
  return [
    started(1, days),
    fixture("phase_started", 2, 2),
    fixture("prompt_rendered", 3),
    fixture("harness_output", 4),
    artifact,
    command,
    fixture("session_finished", 7),
  ];
}

const ENDED = Date.parse("2026-09-29T12:00:00.000Z");
const DAY = 24 * 3600_000;

/** Every stored payload of the session, by seq, as the Events tab shows it. */
async function payloads(t: Cockpit): Promise<Record<number, Record<string, unknown>>> {
  const view = await t.query(api.sessions.get, WHERE);
  return Object.fromEntries(view!.events.map((row) => [row.seq, JSON.parse(row.raw) as Record<string, unknown>]));
}

/** The transcript retention cron, as it runs once `ms` after the session ended. */
async function ageOutAt(t: Cockpit, ms: number) {
  vi.setSystemTime(ENDED + ms);
  await t.mutation(internal.retention.ageOut, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ENDED);
  vi.stubEnv("COCKPIT_MODE", "local");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the retention a session ran under", () => {
  it("is what its factory set, and a later process can only lower it", async () => {
    const t = cockpit();
    const token = await factory(t);

    await ship(t, token, [started(1, 14)]);
    expect((await t.query(api.sessions.get, WHERE))!.summary.transcriptDays).toBe(14);

    await ship(t, token, [started(2, 0), started(3, 21)]);
    expect((await t.query(api.sessions.get, WHERE))!.summary.transcriptDays).toBe(14);

    await ship(t, token, [started(4, 3)]);
    expect((await t.query(api.sessions.get, WHERE))!.summary.transcriptDays).toBe(3);
  });

  it("is the cockpit's own when the factory set none", async () => {
    const t = cockpit();
    await ship(t, await factory(t), [fixture("session_started", 1, 2)]);

    expect((await t.query(api.sessions.get, WHERE))!.summary.transcriptDays).toBe(0);
  });
});

describe("a transcript", () => {
  it("ages out 30 days after its session finished, its events and every other body staying", async () => {
    const t = cockpit();
    await ship(t, await factory(t), finished());
    const before = await payloads(t);

    await ageOutAt(t, 30 * DAY - 60_000);
    expect(await payloads(t)).toEqual(before);

    await ageOutAt(t, 30 * DAY + 60_000);
    const after = await payloads(t);
    const on = new Date(ENDED + 30 * DAY + 60_000).toISOString();
    expect(after[3]).toEqual({ phase_id: "5c0075aa_03_plan", agent: "planner", send: 1,
                               digest: before[3].digest, truncated: false,
                               pruned: { on, reason: "aged_out" } });
    expect(after[4]).toEqual({ phase_id: "5c0075aa_03_plan", agent: "planner", chunk: 2,
                               pruned: { on, reason: "aged_out" } });
    // Core events and handoff bodies are kept forever.
    for (const seq of [1, 2, 5, 6, 7]) expect(after[seq]).toEqual(before[seq]);
    expect(Object.keys(after).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("is kept as long as the deployment allows, or as factory.yaml says when that is shorter", async () => {
    vi.stubEnv("COCKPIT_TRANSCRIPT_DAYS", "10");
    const shorter = cockpit();
    await ship(shorter, await factory(shorter), finished(3));
    const longer = cockpit();
    await ship(longer, await factory(longer), finished(20));

    await ageOutAt(shorter, 3 * DAY + 60_000);
    await ageOutAt(longer, 3 * DAY + 60_000);
    expect((await payloads(shorter))[3].pruned).toMatchObject({ reason: "aged_out" });
    expect((await payloads(longer))[3].pruned).toBeUndefined();

    await ageOutAt(longer, 10 * DAY + 60_000);
    expect((await payloads(longer))[3].pruned).toMatchObject({ reason: "aged_out" });
  });

  it("never ages out while its session runs, and a resume stops the clock", async () => {
    const t = cockpit();
    const token = await factory(t);
    await ship(t, token, finished().slice(0, 6));

    await ageOutAt(t, 90 * DAY);
    expect((await payloads(t))[3].pruned).toBeUndefined();

    await ship(t, token, [fixture("session_finished", 7), started(8, 0)]);
    await ageOutAt(t, 120 * DAY);
    expect((await payloads(t))[3].pruned).toBeUndefined();
  });

  it("ages out behind any number of sessions with no transcript to age out", async () => {
    const t = cockpit();
    const token = await factory(t);
    // More running sessions, and finished ones that sent no transcript, than one run of the cron takes.
    for (let index = 0; index < 60; index += 1) {
      const events = index % 2 ? [started(1, 0)] : [started(1, 0), fixture("session_finished", 2)];
      expect((await ingest(t, token, { session: `quiet${index}`, events })).status).toBe(200);
    }
    await ship(t, token, finished());

    await ageOutAt(t, 31 * DAY);

    expect((await payloads(t))[3].pruned).toMatchObject({ reason: "aged_out" });
  });

  it("of a session stored before retention existed ages out once the backfill has found it", async () => {
    const t = cockpit();
    await ship(t, await factory(t), finished());
    await t.run(async (ctx) => {
      const record = (await ctx.db.query("sessions").first())!;
      await ctx.db.patch(record._id, { transcripts: undefined, transcriptsDue: undefined });
    });

    await ageOutAt(t, 31 * DAY);
    expect((await payloads(t))[3].pruned).toBeUndefined();

    await t.mutation(internal.retention.backfill, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await ageOutAt(t, 31 * DAY);
    expect((await payloads(t))[3].pruned).toMatchObject({ reason: "aged_out" });
  });
});

describe("the Transcript tab", () => {
  it("says when the transcript aged out, rather than show nothing", async () => {
    const t = cockpit();
    await ship(t, await factory(t), finished());

    await ageOutAt(t, 31 * DAY);

    const detail = await t.query(api.sessions.phase, { ...WHERE, phaseId: "5c0075aa_03_plan" });
    expect(detail!.transcript).toMatchObject({
      on: true, pruned: { on: new Date(ENDED + 31 * DAY).toISOString(), reason: "aged_out", by: "" },
    });
  });

  it("holds the transcript, unpruned, until then", async () => {
    const t = cockpit();
    await ship(t, await factory(t), finished());

    const detail = await t.query(api.sessions.phase, { ...WHERE, phaseId: "5c0075aa_03_plan" });
    expect(detail!.transcript.pruned).toBeNull();
    expect(detail!.transcript.runs[0].sends[0].prompt).toContain("# Plan");
  });
});

// ── purges ───────────────────────────────────────────────────────────────────

const BODIES = { 3: ["system", "prompt"], 4: ["text"], 5: ["content"], 6: ["output_tail"] } as Record<number, string[]>;

/** A team's cockpit on `forge`, holding the finished session and a second one of the same factory. */
async function teamWithSessions(forge: FakeForge) {
  const t = cockpit();
  await team(t, forge);
  forge.install("acme");
  const token = await factory(t);
  await ship(t, token, finished());
  const other = await ingest(t, token, { session: "0ther000", events: finished() });
  expect(other.status).toBe(200);
  await catchUp(t);
  return t;
}

async function payloadsAs(t: Cockpit, held: string, session = SESSION) {
  const view = await t.query(api.sessions.get, { factory: WHERE.factory, session, signIn: held });
  return Object.fromEntries(view!.events.map((row) => [row.seq, JSON.parse(row.raw) as Record<string, unknown>]));
}

function forgeOfAcme() {
  const forge = fakeForge();
  forge.person("alex");
  forge.person("sam");
  forge.person("olive");
  forge.repo("acme/widgets", { factory: true, roles: { alex: "admin", sam: "write", olive: "admin" } });
  forge.owner("acme", "olive");
  return forge;
}

describe("purging a session's bodies", () => {
  it("is for a repo admin: every body goes, the events and their seqs stay, and an audit line says who, what, when and why", async () => {
    const forge = forgeOfAcme();
    const t = await teamWithSessions(forge);
    const alex = await signIn(t, forge, "alex");
    const before = await payloadsAs(t, alex);
    const cost = (await t.query(api.sessions.get, { ...WHERE, signIn: alex }))!.summary.totalCost;

    const purged = await t.mutation(api.retention.purgeSession, { ...WHERE, reason: "a token leaked into an artifact", signIn: alex });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(purged).toEqual({ ok: true });
    const after = await payloadsAs(t, alex);
    const pruned = { on: new Date(ENDED).toISOString(), reason: "purged", by: "alex" };
    for (const [seq, fields] of Object.entries(BODIES)) {
      for (const field of fields) expect(after[Number(seq)]).not.toHaveProperty(field);
      expect(after[Number(seq)].pruned).toEqual(pruned);
    }
    for (const seq of [1, 2, 7]) expect(after[seq]).toEqual(before[seq]);
    expect((await t.query(api.sessions.get, { ...WHERE, signIn: alex }))!.summary.totalCost).toBe(cost);
    // Only the session named.
    expect((await payloadsAs(t, alex, "0ther000"))[5]).toEqual(before[5]);
    expect(await t.query(api.retention.purges, { factory: WHERE.factory, signIn: alex })).toEqual([
      { session: SESSION, by: "alex", via: "cockpit", reason: "a token leaked into an artifact", at: ENDED },
    ]);
  });

  it("is refused to anyone below admin, and without a reason, and purges nothing then", async () => {
    const forge = forgeOfAcme();
    const t = await teamWithSessions(forge);
    const sam = await signIn(t, forge, "sam");
    const alex = await signIn(t, forge, "alex");
    const before = await payloadsAs(t, alex);

    expect(await t.mutation(api.retention.purgeSession, { ...WHERE, reason: "leak", signIn: sam }))
      .toEqual({ ok: false, because: "purging a session's bodies takes admin on acme/widgets; you have write" });
    expect(await t.mutation(api.retention.purgeSession, { ...WHERE, reason: "  ", signIn: alex }))
      .toEqual({ ok: false, because: "say why: the reason is kept with the purge" });
    expect(await t.mutation(api.retention.purgeSession, { ...WHERE, reason: "leak" }))
      .toEqual({ ok: false, because: "sign in to purge" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await payloadsAs(t, alex)).toEqual(before);
    expect(await t.query(api.retention.purges, { factory: WHERE.factory, signIn: alex })).toEqual([]);
  });

  it("says the page's viewer may purge only where they are an admin", async () => {
    const forge = forgeOfAcme();
    const t = await teamWithSessions(forge);

    expect((await t.query(api.sessions.get, { ...WHERE, signIn: await signIn(t, forge, "alex") }))!.mayPurge).toBe(true);
    expect((await t.query(api.sessions.get, { ...WHERE, signIn: await signIn(t, forge, "sam") }))!.mayPurge).toBe(false);
  });
});

describe("purging a factory", () => {
  it("is for an owner of the organization the repository belongs to, and purges every session's bodies", async () => {
    const forge = forgeOfAcme();
    const t = await teamWithSessions(forge);
    const olive = await signIn(t, forge, "olive");

    const purged = await t.action(api.retention.purgeFactory, { factory: WHERE.factory, reason: "the repository is gone", signIn: olive });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(purged).toEqual({ ok: true });
    for (const session of [SESSION, "0ther000"]) {
      const after = await payloadsAs(t, olive, session);
      for (const seq of Object.keys(BODIES)) expect(after[Number(seq)].pruned).toMatchObject({ reason: "purged", by: "olive" });
    }
    expect(await t.query(api.retention.purges, { factory: WHERE.factory, signIn: olive })).toEqual([
      { session: "", by: "olive", via: "cockpit", reason: "the repository is gone", at: ENDED },
    ]);
  });

  it("is refused to a repo admin who does not own the organization", async () => {
    const forge = forgeOfAcme();
    const t = await teamWithSessions(forge);
    const alex = await signIn(t, forge, "alex");

    expect(await t.action(api.retention.purgeFactory, { factory: WHERE.factory, reason: "gone", signIn: alex }))
      .toEqual({ ok: false, because: "purging a factory takes an owner of acme, and the forge does not say you are one" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await payloadsAs(t, alex))[5].pruned).toBeUndefined();
  });

  it("says so when the team's App was registered without leave to read who owns the organization", async () => {
    const forge = forgeOfAcme();
    const t = await teamWithSessions(forge);
    const olive = await signIn(t, forge, "olive");
    const permissions = forge.app!.manifest.default_permissions as Record<string, string>;
    delete permissions.members;

    const refused = await t.action(api.retention.purgeFactory, { factory: WHERE.factory, reason: "gone", signIn: olive });

    expect(refused).toMatchObject({ ok: false, because: expect.stringContaining("Members: read") });
  });

  it("is done from the deployment's CLI with no forge permission at all, and audited", async () => {
    const forge = fakeForge();
    const t = cockpit();
    await team(t, forge);
    await ship(t, await factory(t), finished());

    const said = await t.mutation(internal.retention.purgeFactoryFromDeployment,
                                  { factory: "acme/widgets", reason: "the repository was deleted" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(said).toContain("acme/widgets");
    const stored = await t.run(async (ctx) => ({
      events: await ctx.db.query("events").collect(),
      purges: await ctx.db.query("purges").collect(),
    }));
    for (const event of stored.events.filter((each) => [3, 4, 5, 6].includes(each.seq))) {
      expect(JSON.parse(event.payload).pruned).toEqual({ on: new Date(ENDED).toISOString(), reason: "purged" });
    }
    expect(stored.purges.map(({ factory: name, session, by, via, reason, at }) => ({ factory: name, session, by, via, reason, at })))
      .toEqual([{ factory: "acme/widgets", session: "", by: "", via: "deployment", reason: "the repository was deleted", at: ENDED }]);
  });

  it("never happens on its own, not even when the App is uninstalled", async () => {
    const forge = forgeOfAcme();
    const t = cockpit();
    await team(t, forge);
    const installation = forge.install("acme");
    await ship(t, await factory(t), finished());
    await catchUp(t);

    forge.uninstall(installation);
    await catchUp(t);
    await ageOutAt(t, 365 * DAY);

    const events = await t.run(async (ctx) => await ctx.db.query("events").collect());
    expect(events.filter((event) => JSON.parse(event.payload).pruned?.reason === "purged")).toEqual([]);
    expect(JSON.parse(events.find((event) => event.seq === 5)!.payload).content).toBeTruthy();
  });
});
