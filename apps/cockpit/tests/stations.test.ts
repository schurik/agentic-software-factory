import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { ATTENDED_FOR, liveness, REDELIVER_AFTER, TOKENLESS_PER_FACTORY, TOKENLESS_PER_SOURCE, TTL } from "../convex/model/command";
import { fakeForge, type FakeForge, type Role } from "./forge";
import { factory, fixture, ingest, signIn } from "./helpers";
import {
  approved, asking, handed, json, localOf, poll, post, register, registerNamed, REPORT, running, SESSION, STATION, steerable, teamOf,
} from "./station";

// Stations a person can steer (spec #40, #54): a station registers by a device
// flow a person approves while signed in, polls for its commands with the
// token that hands it, and is refused once that token is revoked. A kill is
// queued for the station holding the session, delivered to the run's own
// shipper while it is attended and to the station loop otherwise, and settled
// only by the station's `command_result`. The factory's end of this wire is
// tests/test_asf_commands.py, against tests/fake_cockpit.py.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── registering ──────────────────────────────────────────────────────────────

describe("registering a station", () => {
  it("is asked with the factory's ingest token, and answered with a code and where to approve it", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    vi.stubEnv("COCKPIT_APP_URL", "https://cockpit.acme.test/");
    const ingestToken = await factory(t, "acme/widgets");

    expect((await post(t, "/station/register", null, { station: STATION })).status).toBe(401);
    expect((await post(t, "/station/register", "asf_ingest_nope", { station: STATION })).status).toBe(401);
    expect((await post(t, "/station/register", ingestToken, { station: { ...STATION, kind: "ci" } })).status).toBe(400);
    expect((await post(t, "/station/register", ingestToken, {})).status).toBe(400);

    const asked = await register(t, ingestToken);
    expect(asked.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(asked.url).toBe(`https://cockpit.acme.test/stations/approve?code=${asked.code}`);
    expect(asked.device).toMatch(/^asf_device_/);
    expect(await json(await handed(t, asked.device))).toEqual({ status: "pending" });
  });

  it("hands the station its owner's token once a writer approved it, and only once", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    const ingestToken = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    const { device, code } = await register(t, ingestToken);

    const shown = await t.query(api.stations.pending, { code: code.toLowerCase().replace("-", ""), signIn: alex });
    expect(shown).toMatchObject({ factory: "acme/widgets", name: STATION.name, approved: false, because: null });
    expect(await t.mutation(api.stations.approve, { code, signIn: alex })).toEqual({ ok: true });

    const answer = await json(await handed(t, device));
    expect(answer).toMatchObject({ status: "approved", owner: "alex", station: STATION.id, described: false });
    expect(answer.token).toMatch(/^asf_station_/);
    expect((await handed(t, device)).status).toBe(410);           // spent
    expect(await t.query(api.stations.mine, { signIn: alex })).toEqual([
      expect.objectContaining({ factory: "acme/widgets", station: STATION.id, owner: "alex", registered: true }),
    ]);
  });

  it("is refused to someone the forge does not let write, and hidden from someone it does not let read", async () => {
    const forge = fakeForge();
    forge.person("dana");
    const t = await teamOf(forge, { sam: "triage" });
    const { code } = await register(t, await factory(t, "acme/widgets"));
    const sam = await signIn(t, forge, "sam");

    expect(await t.mutation(api.stations.approve, { code, signIn: sam })).toEqual({
      ok: false, because: "a station takes commands for its owner, which needs write on acme/widgets; the forge says you have triage",
    });
    expect((await t.query(api.stations.pending, { code, signIn: sam }))?.because).toMatch(/needs write/);
    expect(await t.query(api.stations.pending, { code, signIn: await signIn(t, forge, "dana") })).toBeNull();
    expect(await t.mutation(api.stations.approve, { code })).toMatchObject({ ok: false });   // nobody signed in
  });

  it("is its owner's to renew: nobody else takes over a station that holds a live token", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write", sam: "write" });
    const ingestToken = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    const sam = await signIn(t, forge, "sam");
    const held = await approved(t, ingestToken, alex);

    // A station's id is in every session it ships: anyone with the ingest token can ask under it.
    const { code } = await register(t, ingestToken);
    expect(await t.mutation(api.stations.approve, { code, signIn: sam })).toEqual({
      ok: false, because: "alex@mbp:widgets is alex's station: they register it again, or revoke it first",
    });
    expect((await poll(t, held)).status).toBe(200);                 // alex's token still works

    await t.mutation(api.stations.revoke, { factory: "acme/widgets", station: STATION.id, signIn: alex });
    expect(await t.mutation(api.stations.approve, { code, signIn: sam })).toEqual({ ok: true });
  });

  it("runs out when nobody approves it in time", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    const { device, code } = await register(t, await factory(t, "acme/widgets"));

    vi.advanceTimersByTime(11 * 60_000);

    expect((await handed(t, device)).status).toBe(410);
    expect(await t.mutation(api.stations.approve, { code, signIn: await signIn(t, forge, "alex") }))
      .toMatchObject({ ok: false });
  });

  it("waits on its factory's Stations tab — its code left for the approver to type from the terminal — until handed over or run out", async () => {
    const forge = fakeForge();
    forge.person("dana");
    const t = await teamOf(forge, { alex: "write", sam: "read" });
    const ingestToken = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    const sam = await signIn(t, forge, "sam");
    const asked = await register(t, ingestToken);
    await register(t, ingestToken, { id: "st_late", name: "late@box:widgets", kind: "local" });
    const listed = (holding?: string) => t.query(api.stations.registrations, { factory: "acme/widgets", signIn: holding });

    expect(await listed(alex)).toEqual([
      { station: STATION.id, name: STATION.name, host: "", tokenless: false, expiresAt: Date.now() + 10 * 60_000, approved: false, because: null },
      expect.objectContaining({ station: "st_late", name: "late@box:widgets" }),
    ]);
    // Typing the code is what proves the approver saw the station's terminal: the list never says it.
    expect(JSON.stringify(await listed(alex))).not.toContain(asked.code);
    // A reader sees who asks, and why they may not approve it.
    expect((await listed(sam))?.[0].because).toMatch(/needs write/);
    expect(await listed(await signIn(t, forge, "dana"))).toBeNull();
    expect(await listed()).toBeNull();

    expect(await t.mutation(api.stations.approve, { code: asked.code, signIn: alex })).toEqual({ ok: true });
    expect((await listed(alex))?.[0]).toMatchObject({ station: STATION.id, approved: true });
    await handed(t, asked.device);
    expect((await listed(alex))?.map((each) => each.station)).toEqual(["st_late"]);

    vi.advanceTimersByTime(11 * 60_000);
    expect(await listed(alex)).toEqual([]);
  });

  it("is nothing a local cockpit's station needs: the token is issued to its one person", async () => {
    const forge = fakeForge();
    const { t } = await localOf(forge);

    const issued = await t.action(internal.stations.local, { factory: "acme/widgets", station: STATION });

    expect(issued.owner).toBe("alex");
    expect((await poll(t, issued.token)).status).toBe(200);
    expect(await t.query(api.stations.mine, {})).toEqual([expect.objectContaining({ owner: "alex", registered: true })]);
  });
});

// ── registering without an ingest token (#175) ──────────────────────────────

describe("registering a station that holds no ingest token", () => {
  it("names its factory itself, and is handed an ingest token of its own with its command token once a writer approved it", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    const alex = await signIn(t, forge, "alex");

    expect((await post(t, "/station/register", null, { station: STATION })).status).toBe(401);
    expect((await post(t, "/station/register", null, { station: STATION, factory: "not a repository" })).status).toBe(400);
    const { device, code } = await registerNamed(t, "acme/widgets");

    // The page names what asked, and that approving gives it a way to write sessions into the factory.
    expect(await t.query(api.stations.pending, { code, signIn: alex })).toMatchObject({
      factory: "acme/widgets", name: STATION.name, kind: "local", host: "mbp", tokenless: true, because: null,
    });
    expect(await t.mutation(api.stations.approve, { code, signIn: alex })).toEqual({ ok: true });

    const answer = await json(await handed(t, device));
    expect(answer).toMatchObject({ status: "approved", owner: "alex", station: STATION.id, described: false });
    expect(answer.token).toMatch(/^asf_station_/);
    expect(answer.ingest_token).toMatch(/^asf_ingest_/);
    expect((await poll(t, answer.token as string)).status).toBe(200);
    expect((await ingest(t, answer.ingest_token as string, { session: SESSION, events: running() })).status).toBe(200);

    // It is the approver's, and the factory page says so.
    const listed = await t.query(api.tokens.listed, { factory: "acme/widgets", signIn: alex });
    expect(listed?.tokens).toEqual([
      expect.objectContaining({ via: "station", label: STATION.name, station: STATION.id, by: "alex", issuedAt: Date.now() }),
    ]);
  });

  it("lists a station once when it asks again, and only its newest code can be approved", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    const alex = await signIn(t, forge, "alex");
    const first = await registerNamed(t, "acme/widgets");
    const second = await registerNamed(t, "acme/widgets");

    const listed = await t.query(api.stations.registrations, { factory: "acme/widgets", signIn: alex });
    expect(listed).toHaveLength(1);
    expect(await t.mutation(api.stations.approve, { code: first.code, signIn: alex })).toMatchObject({ ok: false });
    expect(await json(await handed(t, first.device))).toMatchObject({ status: "expired" });
    expect(await t.mutation(api.stations.approve, { code: second.code, signIn: alex })).toEqual({ ok: true });
    expect((await json(await handed(t, second.device))).status).toBe("approved");
  });

  it("hands no ingest token to a station that asked with one", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    const ingestToken = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    const { device, code } = await register(t, ingestToken);

    expect((await t.query(api.stations.pending, { code, signIn: alex }))?.tokenless).toBe(false);
    await t.mutation(api.stations.approve, { code, signIn: alex });
    // Its CI workflow described the factory already, so the station has nothing to describe.
    await t.run(async (ctx) => {
      await ctx.db.insert("checks", {
        factory: "acme/widgets", ref: "main", head: "a".repeat(40), configHash: "c0ffee", format: 2, ok: true,
        description: "{}", station: "st_ci0001", stationName: "runner", stationKind: "ci", at: Date.now(),
      });
    });
    const answer = await json(await handed(t, device));
    expect(answer).toMatchObject({ status: "approved", described: true });
    expect(answer).not.toHaveProperty("ingest_token");
  });

  it("is refused outright to a viewer without write on the repository it names", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { sam: "read" });
    const { code } = await registerNamed(t, "acme/widgets");
    const sam = await signIn(t, forge, "sam");

    expect((await t.query(api.stations.pending, { code, signIn: sam }))?.because).toMatch(/needs write on acme\/widgets/);
    expect(await t.mutation(api.stations.approve, { code, signIn: sam })).toMatchObject({ ok: false });
  });

  it("is stored under the factory's own spelling, whatever case the station named it in", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    const alex = await signIn(t, forge, "alex");
    const { device, code } = await registerNamed(t, "ACME/Widgets");

    expect((await t.query(api.stations.pending, { code, signIn: alex }))?.factory).toBe("acme/widgets");
    await t.mutation(api.stations.approve, { code, signIn: alex });
    const { ingest_token: issued } = await json(await handed(t, device));
    await ingest(t, issued as string, { session: SESSION, events: running() });
    expect((await t.query(api.sessions.list, { factory: "acme/widgets", signIn: alex }))?.sessions).toHaveLength(1);
  });

  it("rotates the ingest token when its owner registers it again, and loses it with the station's revoke", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    const alex = await signIn(t, forge, "alex");
    const handOver = async () => {
      const { device, code } = await registerNamed(t, "acme/widgets");
      await t.mutation(api.stations.approve, { code, signIn: alex });
      return await json(await handed(t, device));
    };
    const first = await handOver();
    const second = await handOver();

    expect((await ingest(t, first.ingest_token as string, { session: SESSION, events: running() })).status).toBe(401);
    expect((await ingest(t, second.ingest_token as string, { session: SESSION, events: running() })).status).toBe(200);
    expect((await t.query(api.tokens.listed, { factory: "acme/widgets", signIn: alex }))?.tokens).toHaveLength(1);

    await t.mutation(api.stations.revoke, { factory: "acme/widgets", station: STATION.id, signIn: alex });
    expect((await ingest(t, second.ingest_token as string, { session: SESSION, events: running() })).status).toBe(401);
    expect((await t.query(api.tokens.listed, { factory: "acme/widgets", signIn: alex }))?.tokens).toEqual([]);
  });

  it("is rate-limited per factory and per source, so nobody floods the table, and room comes back as requests run out", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    const station = (n: number) => ({ ...STATION, id: `st_${n}` });

    for (let n = 0; n < TOKENLESS_PER_SOURCE; n++) await registerNamed(t, `acme/repo${n}`, station(n), "203.0.113.7");
    const crowded = await asking(t, "acme/another", station(99), "203.0.113.7");
    expect(crowded.status).toBe(429);
    expect((await json(crowded)).error).toMatch(/too many/);

    for (let n = 0; n < TOKENLESS_PER_FACTORY; n++) await registerNamed(t, "acme/widgets", station(100 + n), `198.51.100.${n}`);
    expect((await asking(t, "acme/widgets", station(200), "192.0.2.1")).status).toBe(429);
    // Holding the factory's ingest token is no anonymous request, and is never counted against it.
    expect((await post(t, "/station/register", await factory(t, "acme/widgets"), { station: station(201) })).status).toBe(200);

    vi.advanceTimersByTime(11 * 60_000);
    expect((await asking(t, "acme/widgets", station(200), "192.0.2.1")).status).toBe(200);
    expect((await asking(t, "acme/another", station(99), "203.0.113.7")).status).toBe(200);
  });

  it("runs out when nobody approves it in time, as one asked with a token does", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    const { device, code } = await registerNamed(t, "acme/widgets");

    vi.advanceTimersByTime(11 * 60_000);

    expect((await handed(t, device)).status).toBe(410);
    expect(await t.mutation(api.stations.approve, { code, signIn: await signIn(t, forge, "alex") })).toMatchObject({ ok: false });
  });

  it("waits on the Stations tab with its host, saying it holds no ingest token", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    await registerNamed(t, "acme/widgets");

    expect(await t.query(api.stations.registrations, { factory: "acme/widgets", signIn: await signIn(t, forge, "alex") }))
      .toEqual([expect.objectContaining({ station: STATION.id, host: "mbp", tokenless: true })]);
  });
});

// ── the poll ─────────────────────────────────────────────────────────────────

describe("a station's command poll", () => {
  it("is refused without the token a registration handed over, and once that token is revoked", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    const alex = await signIn(t, forge, "alex");
    const token = await approved(t, await factory(t, "acme/widgets"), alex);

    expect((await poll(t, "asf_station_nope")).status).toBe(401);
    expect((await post(t, "/commands", token, { station: "st_someone_else", report: REPORT })).status).toBe(401);
    expect((await poll(t, token)).status).toBe(200);

    expect(await t.mutation(api.stations.revoke, { factory: "acme/widgets", station: STATION.id, signIn: alex }))
      .toEqual({ ok: true });
    expect((await poll(t, token)).status).toBe(401);
    expect(await t.query(api.stations.mine, { signIn: alex })).toEqual([expect.objectContaining({ registered: false })]);
  });

  it("is whose owner alone may revoke it", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write", sam: "write" });
    await approved(t, await factory(t, "acme/widgets"), await signIn(t, forge, "alex"));

    expect(await t.mutation(api.stations.revoke, { factory: "acme/widgets", station: STATION.id, signIn: await signIn(t, forge, "sam") }))
      .toMatchObject({ ok: false });
  });

  it("is how the cockpit knows the station is online and the session attended, and what the station would obey", async () => {
    const forge = fakeForge();
    const { t, ingestToken } = await localOf(forge);
    await ingest(t, ingestToken, { session: SESSION, events: running() });
    const { token } = await t.action(internal.stations.local, { factory: "acme/widgets", station: STATION });
    const before = await t.query(api.commands.steering, { factory: "acme/widgets", session: SESSION });
    expect(before).toMatchObject({ attendedAt: null, station: { seenAt: 0, verbs: null } });

    await poll(t, token);
    vi.advanceTimersByTime(1000);
    await poll(t, token, { session: SESSION, report: { ...REPORT, watchers: undefined } });

    const after = await t.query(api.commands.steering, { factory: "acme/widgets", session: SESSION });
    const now = Date.now();
    expect(after?.station).toMatchObject({ name: STATION.name, owner: "alex", verbs: ["kill"] });
    expect(liveness(after!.station!.seenAt, after!.attendedAt, now)).toEqual({ attended: true, online: true, lastSeen: now });
    expect(liveness(after!.station!.seenAt, after!.attendedAt, now + ATTENDED_FOR + 2000))
      .toMatchObject({ attended: false, online: false, lastSeen: now });
    // A run cannot say what watchers its checkout runs; the loop's word stands.
    expect((await t.query(api.stations.mine, {}))[0].report?.watchers).toEqual(["issues", "answers"]);
  });
});

// ── kill ─────────────────────────────────────────────────────────────────────

/** A team where alex may command, with acme/widgets' session running on alex's approved station. */
async function killable(forge: FakeForge, roles: Record<string, Role> = { alex: "write" },
                        report: Record<string, unknown> = REPORT) {
  return await steerable(forge, running(), roles, report);
}

const asked = (holding?: string) => ({ factory: "acme/widgets", session: SESSION, signIn: holding });

describe("killing a session from the cockpit", () => {
  it("goes to the run's own shipper while it is attended, and to the station loop when it is not", async () => {
    const forge = fakeForge();
    const { t, alex, token } = await killable(forge);
    await poll(t, token, { session: SESSION });                     // the run polls: attended

    expect(await t.mutation(api.commands.kill, asked(alex))).toEqual({ ok: true });
    expect(await t.mutation(api.commands.kill, asked(alex))).toEqual({ ok: true });   // one is on its way already

    const toLoop = await json(await poll(t, token));
    expect(toLoop.commands).toEqual([]);                             // the run takes it itself
    const toRun = await json(await poll(t, token, { session: SESSION }));
    expect(toRun.commands).toEqual([expect.objectContaining({ verb: "kill", session: SESSION, by: "alex" })]);
    expect((await t.query(api.commands.steering, asked(alex)))?.kill).toMatchObject({ state: "delivered", by: "alex" });

    // No run polling for it: the loop gets the next one.
    const { t: t2, alex: alex2, token: token2 } = await killable(fakeForge());
    await t2.mutation(api.commands.kill, asked(alex2));
    expect((await json(await poll(t2, token2))).commands).toHaveLength(1);
  });

  it("is done only when the station says so, and says what it said", async () => {
    const forge = fakeForge();
    const { t, ingestToken, alex, token } = await killable(forge);
    await t.mutation(api.commands.kill, asked(alex));
    const [delivered] = (await json(await poll(t, token))).commands as { id: string }[];
    expect((await t.query(api.commands.steering, asked(alex)))?.kill?.state).toBe("delivered");

    const result = fixture("command_result", 2);
    Object.assign(result.payload, { command_id: delivered.id, adw_id: SESSION, by: "alex", ok: true, detail: "stopping itself" });
    await ingest(t, ingestToken, { session: SESSION, events: [result] });

    expect((await t.query(api.commands.steering, asked(alex)))?.kill).toMatchObject({ state: "done", detail: "stopping itself" });
  });

  it("reports a station's refusal back, as the station put it", async () => {
    const forge = fakeForge();
    const { t, ingestToken, alex, token } = await killable(forge);
    await t.mutation(api.commands.kill, asked(alex));
    const [delivered] = (await json(await poll(t, token))).commands as { id: string }[];
    const result = fixture("command_result", 2);
    Object.assign(result.payload, {
      command_id: delivered.id, ok: false, detail: "alex is not in issues.trusted_authors, which this station holds every command's author to",
    });
    await ingest(t, ingestToken, { session: SESSION, events: [result] });

    expect((await t.query(api.commands.steering, asked(alex)))?.kill)
      .toMatchObject({ state: "refused", detail: expect.stringContaining("trusted_authors") });
  });

  it("is greyed out when the station's report says it does not take kill", async () => {
    const forge = fakeForge();
    const { t, alex } = await killable(forge, { alex: "write" }, { ...REPORT, verbs: [] });

    const because = "alex@mbp:widgets does not take kill: its asf/factory.yaml's cockpit.commands does not list it";
    expect((await t.query(api.commands.steering, asked(alex)))?.killRefused).toBe(because);
    expect(await t.mutation(api.commands.kill, asked(alex))).toEqual({ ok: false, because });
  });

  it("is a writer's to queue, never a reader's or a triager's", async () => {
    const forge = fakeForge();
    const { t } = await killable(forge, { alex: "write", sam: "triage" });
    const sam = await signIn(t, forge, "sam");

    const refused = await t.mutation(api.commands.kill, asked(sam));
    expect(refused).toEqual({ ok: false, because: "commands need write or higher on this repository, and the forge says you have triage" });
    expect((await t.query(api.commands.steering, asked(sam)))?.killRefused).toBe(refused.ok ? null : refused.because);
  });

  it("is refused for a station nobody registered, saying how to register it", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    await ingest(t, await factory(t, "acme/widgets"), { session: SESSION, events: running() });

    expect(await t.mutation(api.commands.kill, asked(await signIn(t, forge, "alex")))).toEqual({
      ok: false, because: "alex@mbp:widgets takes no commands: run `asf station register` on it",
    });
  });

  it("stops reaching a station whose token was revoked", async () => {
    const forge = fakeForge();
    const { t, alex, token } = await killable(forge);
    await t.mutation(api.stations.revoke, { factory: "acme/widgets", station: STATION.id, signIn: alex });

    expect(await t.mutation(api.commands.kill, asked(alex))).toMatchObject({ ok: false, because: expect.stringContaining("asf station register") });
    expect((await poll(t, token)).status).toBe(401);
  });

  it("waits for an offline station, is sent again if never answered, and expires rather than wait for tomorrow", async () => {
    const forge = fakeForge();
    const { t, alex, token } = await killable(forge);
    await t.mutation(api.commands.kill, asked(alex));

    expect((await json(await poll(t, token))).commands).toHaveLength(1);
    expect((await json(await poll(t, token))).commands).toHaveLength(0);       // delivered: not again at once
    vi.advanceTimersByTime(REDELIVER_AFTER + 1000);
    expect((await json(await poll(t, token))).commands).toHaveLength(1);       // never answered: again

    vi.advanceTimersByTime(TTL.kill);
    expect((await json(await poll(t, token))).commands).toHaveLength(0);
    expect((await t.query(api.commands.steering, asked(alex)))?.kill?.state).toBe("expired");
    expect(await t.mutation(api.commands.kill, asked(alex))).toEqual({ ok: true });      // a fresh one may go
  });

  it("is only for a running session", async () => {
    const forge = fakeForge();
    const { t, ingestToken, alex } = await killable(forge);
    await ingest(t, ingestToken, { session: SESSION, events: [fixture("session_finished", 2)] });

    expect(await t.mutation(api.commands.kill, asked(alex))).toEqual({ ok: false, because: "only a running session can be killed" });
  });
});
