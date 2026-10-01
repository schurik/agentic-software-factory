import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { fakeForge } from "./forge";
import { factory, fixture, ingest, signIn, type WireEvent } from "./helpers";
import { json, post, SESSION, STATION, teamOf } from "./station";

// Claims (spec #40, ADR 0003): a shared cockpit decides which station starts a
// work item. One transactional mutation keyed on the item grants the first
// session that asks and refuses every other; the claim is held until that
// session's own events say it finished or was aborted — kept on failure, so
// resume works — and freed otherwise only by a writer's Release claim, which
// relabels the item and abandons the session. The factory's end of this wire
// is tests/test_asf_claims.py, against tests/fake_cockpit.py.

const OTHER = { id: "st_9b1d2e", name: "bob@laptop:widgets", kind: "local" };
const REQUEUE = { add: ["asf:queued"], remove: ["asf:running", "asf:failed", "asf:done"] };

function asking(op: "take" | "drop", session: string, station = STATION, more: Record<string, unknown> = {}) {
  return { op, repo: "acme/widgets", kind: "issue", number: 42, session, since: 0, station, requeue: REQUEUE, ...more };
}

async function claim(t: Parameters<typeof post>[0], token: string | null, body: unknown) {
  return await post(t, "/claims", token, body);
}

function finished(seq: number, status: "success" | "fail"): WireEvent {
  const event = fixture("session_finished", seq);
  event.payload.status = status;
  return event;
}

function decided(seq: number, verdict: string): WireEvent {
  const event = fixture("decision_recorded", seq);
  (event.payload.decision as Record<string, unknown>).verdict = verdict;
  return event;
}

function started(seq = 1, session = SESSION): WireEvent {
  const event = fixture("session_started", seq);
  Object.assign(event.payload, { adw_id: session, station_id: STATION.id, station_name: STATION.name });
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a claim", () => {
  it("is granted to the first session that asks, again to it, and refused to any other, naming who holds it", async () => {
    const t = await teamOf(fakeForge(), { alex: "write" });
    const token = await factory(t, "acme/widgets");

    expect(await json(await claim(t, token, asking("take", SESSION)))).toEqual({ granted: true });
    expect(await json(await claim(t, token, asking("take", SESSION)))).toEqual({ granted: true });

    for (const refused of [asking("take", "0therrun", OTHER), asking("take", SESSION, OTHER), asking("take", "0therrun")]) {
      const response = await claim(t, token, refused);
      expect(response.status).toBe(409);
      expect(await json(response)).toEqual({
        granted: false, held: { station: STATION.id, name: STATION.name, session: SESSION },
      });
    }
    // Another number, another kind, another repository: other items.
    expect((await claim(t, token, asking("take", "0therrun", OTHER, { number: 43 }))).status).toBe(200);
    expect((await claim(t, token, asking("take", "0therrun", OTHER, { kind: "pr" }))).status).toBe(200);
    expect((await claim(t, token, asking("take", "0therrun", OTHER, { repo: "ACME/gadgets" }))).status).toBe(200);
    // The forge's names are case-insensitive, and so is the key.
    expect((await claim(t, token, asking("take", "0therrun", OTHER, { repo: "Acme/Widgets" }))).status).toBe(409);
  });

  it("is granted to exactly one of two stations asking at once", async () => {
    const t = await teamOf(fakeForge(), { alex: "write" });
    const token = await factory(t, "acme/widgets");
    const answers = await Promise.all([
      claim(t, token, asking("take", SESSION)), claim(t, token, asking("take", "0therrun", OTHER)),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
  });

  it("is asked with the factory's ingest token, about an issue or a pull request", async () => {
    const t = await teamOf(fakeForge(), { alex: "write" });
    const token = await factory(t, "acme/widgets");
    expect((await claim(t, null, asking("take", SESSION))).status).toBe(401);
    expect((await claim(t, "asf_ingest_nope", asking("take", SESSION))).status).toBe(401);
    expect((await claim(t, token, asking("take", SESSION, STATION, { kind: "epic" }))).status).toBe(400);
    expect((await claim(t, token, asking("take", SESSION, STATION, { number: 0 }))).status).toBe(400);
    expect((await claim(t, token, asking("take", ""))).status).toBe(400);
    expect((await claim(t, token, { ...asking("take", SESSION), station: {} })).status).toBe(400);
  });

  it("is kept when its session fails, so resume works, and released when it finishes", async () => {
    const t = await teamOf(fakeForge(), { alex: "write" });
    const token = await factory(t, "acme/widgets");
    await claim(t, token, asking("take", SESSION));

    await ingest(t, token, { session: SESSION, events: [started(1), finished(2, "fail")] });
    expect((await claim(t, token, asking("take", "0therrun", OTHER))).status).toBe(409);

    await ingest(t, token, { session: SESSION, events: [finished(3, "success")] });
    expect((await claim(t, token, asking("take", "0therrun", OTHER))).status).toBe(200);
  });

  it("is released when its session is aborted", async () => {
    const t = await teamOf(fakeForge(), { alex: "write" });
    const token = await factory(t, "acme/widgets");
    await claim(t, token, asking("take", SESSION));
    await ingest(t, token, { session: SESSION, events: [started(1), decided(2, "abort")] });
    expect((await claim(t, token, asking("take", "0therrun", OTHER))).status).toBe(409);
    await ingest(t, token, { session: SESSION, events: [finished(3, "fail")] });
    expect((await claim(t, token, asking("take", "0therrun", OTHER))).status).toBe(200);
  });

  it("is not released by an earlier chapter's finish, shipped after it was asked", async () => {
    const t = await teamOf(fakeForge(), { alex: "write" });
    const token = await factory(t, "acme/widgets");
    await claim(t, token, asking("take", SESSION, STATION, { kind: "pr", since: 2 }));
    await ingest(t, token, { session: SESSION, events: [started(1), finished(2, "success")] });
    expect((await claim(t, token, asking("take", "0therrun", OTHER, { kind: "pr" }))).status).toBe(409);
    await ingest(t, token, { session: SESSION, events: [finished(3, "success")] });
    expect((await claim(t, token, asking("take", "0therrun", OTHER, { kind: "pr" }))).status).toBe(200);
  });

  it("is given back by its own station, for its own session, and by nobody else", async () => {
    const t = await teamOf(fakeForge(), { alex: "write" });
    const token = await factory(t, "acme/widgets");
    await claim(t, token, asking("take", SESSION));
    expect(await json(await claim(t, token, asking("drop", SESSION, OTHER)))).toEqual({ dropped: false });
    expect(await json(await claim(t, token, asking("drop", "0therrun")))).toEqual({ dropped: false });
    expect(await json(await claim(t, token, asking("drop", SESSION)))).toEqual({ dropped: true });
    expect((await claim(t, token, asking("take", "0therrun", OTHER))).status).toBe(200);
  });
});

describe("releasing a claim", () => {
  async function held() {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write", sam: "triage" });
    forge.issue("acme/widgets", 42, { title: "health check broken", labels: ["asf:ship", "asf:running"] });
    const token = await factory(t, "acme/widgets");
    await claim(t, token, asking("take", SESSION));
    await ingest(t, token, { session: SESSION, events: [started(1), finished(2, "fail")] });
    return { forge, t, token, alex: await signIn(t, forge, "alex"), sam: await signIn(t, forge, "sam") };
  }

  it("spells out what it does, and is offered to writers only", async () => {
    const { t, alex, sam } = await held();
    const shown = await t.query(api.claims.ofSession, { factory: "acme/widgets", session: SESSION, signIn: alex });
    expect(shown).toEqual([expect.objectContaining({
      kind: "issue", number: 42, repo: "acme/widgets", stationName: STATION.name, released: null,
      consequence: `relabels #42 \`asf:queued\` and abandons session ${SESSION}`, refused: null,
    })]);
    const toSam = await t.query(api.claims.ofSession, { factory: "acme/widgets", session: SESSION, signIn: sam });
    expect(toSam[0].refused).toMatch(/needs write .* triage/);
    expect(await t.action(api.claims.release, { claim: toSam[0].id, signIn: sam }))
      .toEqual({ ok: false, because: toSam[0].refused });
    expect(await t.query(api.claims.ofSession, { factory: "acme/widgets", session: SESSION })).toEqual([]);
  });

  it("relabels the item queued, abandons the session, and keeps who did it", async () => {
    const { forge, t, token, alex } = await held();
    const [shown] = await t.query(api.claims.ofSession, { factory: "acme/widgets", session: SESSION, signIn: alex });

    expect(await t.action(api.claims.release, { claim: shown.id, signIn: alex })).toEqual({ ok: true, relabelled: true });

    expect(forge.labelsOn("acme/widgets", 42)).toEqual(["asf:ship", "asf:queued"]);
    expect(forge.labelled("acme/widgets", 42)).toEqual([{ by: "alex", via: "user", labels: ["asf:queued"] }]);
    const [after] = await t.query(api.claims.ofSession, { factory: "acme/widgets", session: SESSION, signIn: alex });
    expect(after.released).toEqual({ at: expect.any(Number), by: "alex", why: "released" });
    expect((await claim(t, token, asking("take", "0therrun", OTHER))).status).toBe(200);
    // The session is abandoned: its station is refused any claim for it from now on — a
    // resume of it asks — so it cannot carry on beside the run that took the item afresh.
    for (const asked of [asking("take", SESSION), asking("take", SESSION, STATION, { kind: "pr", number: 7 })]) {
      const refused = await claim(t, token, asked);
      expect(refused.status).toBe(409);
      expect(await json(refused)).toEqual({ granted: false, abandoned: { session: SESSION, by: "alex" } });
    }
    // Once is enough: a second release has nothing to free.
    expect(await t.action(api.claims.release, { claim: shown.id, signIn: alex }))
      .toEqual({ ok: false, because: "this claim was already let go" });
  });

  it("frees the claim even when the forge will not relabel, and says so", async () => {
    const { t, token, alex } = await held();
    const [shown] = await t.query(api.claims.ofSession, { factory: "acme/widgets", session: SESSION, signIn: alex });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Server Error" }), { status: 500 }));
    const released = await t.action(api.claims.release, { claim: shown.id, signIn: alex });
    vi.unstubAllGlobals();
    expect(released).toMatchObject({ ok: true, relabelled: false });
    expect((released as { because: string }).because).toMatch(/relabel #42 by hand/);
    expect((await claim(t, token, asking("take", "0therrun", OTHER))).status).toBe(200);
  });
});
