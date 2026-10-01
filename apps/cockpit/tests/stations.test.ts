import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { ATTENDED_FOR, KILL_FOR, liveness, REDELIVER_AFTER } from "../convex/model/command";
import { fakeForge, type FakeForge, localMode, type Role } from "./forge";
import { catchUp, cockpit, type Cockpit, factory, fixture, ingest, signIn, team, type WireEvent } from "./helpers";

// Stations a person can steer (spec #40, #54): a station registers by a device
// flow a person approves while signed in, polls for its commands with the
// token that hands it, and is refused once that token is revoked. A kill is
// queued for the station holding the session, delivered to the run's own
// shipper while it is attended and to the station loop otherwise, and settled
// only by the station's `command_result`. The factory's end of this wire is
// tests/test_asf_commands.py, against tests/fake_cockpit.py.

const STATION = { id: "st_7f3a9c", name: "alex@mbp:widgets", kind: "local" };
const SESSION = "5c0075aa";

async function post(t: Cockpit, path: string, token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return await t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

/** `asf station register`'s first request: the code and the device secret. */
async function register(t: Cockpit, ingestToken: string, station = STATION) {
  const response = await post(t, "/station/register", ingestToken, { station });
  expect(response.status).toBe(200);
  return await json(response) as { device: string; code: string; url: string; interval: number; expires_in: number };
}

async function handed(t: Cockpit, device: string) {
  return await post(t, "/station/register/poll", null, { device });
}

/** A station `owner` approved: its command token. */
async function approved(t: Cockpit, ingestToken: string, holding?: string): Promise<string> {
  const { device, code } = await register(t, ingestToken);
  expect(await t.mutation(api.stations.approve, { code, signIn: holding })).toEqual({ ok: true });
  const answer = await json(await handed(t, device));
  expect(answer.status).toBe("approved");
  return answer.token as string;
}

const REPORT = { verbs: ["kill"], head: "89abcdef", config_hash: "c0ffee", watchers: ["issues", "answers"] };

async function poll(t: Cockpit, token: string, body: Record<string, unknown> = {}) {
  return await post(t, "/commands", token, { station: STATION.id, report: REPORT, ...body });
}

/** A session that started on STATION and is running. */
function running(session = SESSION): WireEvent[] {
  const started = fixture("session_started", 1);
  Object.assign(started.payload, { adw_id: session });
  return [started];
}

/** A team on acme/widgets, the people in `roles` holding those roles there. */
async function teamOf(forge: FakeForge, roles: Record<string, Role>): Promise<Cockpit> {
  for (const login of Object.keys(roles)) forge.person(login);
  forge.repo("acme/widgets", { factory: true, roles });
  const t = cockpit();
  await team(t, forge);
  forge.install("acme");
  await catchUp(t);
  return t;
}

/** A local cockpit holding alex's token, its factory, and its viewer known. */
async function localOf(forge: FakeForge): Promise<{ t: Cockpit; ingestToken: string }> {
  localMode(forge, forge.person("alex"));
  forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
  const t = cockpit();
  await catchUp(t);
  return { t, ingestToken: await factory(t, "acme/widgets") };
}

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
    expect(answer).toMatchObject({ status: "approved", owner: "alex", station: STATION.id });
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

  it("runs out when nobody approves it in time", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    const { device, code } = await register(t, await factory(t, "acme/widgets"));

    vi.advanceTimersByTime(11 * 60_000);

    expect((await handed(t, device)).status).toBe(410);
    expect(await t.mutation(api.stations.approve, { code, signIn: await signIn(t, forge, "alex") }))
      .toMatchObject({ ok: false });
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
async function killable(forge: FakeForge, roles: Record<string, Role> = { alex: "write" }, report = REPORT) {
  const t = await teamOf(forge, roles);
  const ingestToken = await factory(t, "acme/widgets");
  const alex = await signIn(t, forge, "alex");
  await ingest(t, ingestToken, { session: SESSION, events: running() });
  const token = await approved(t, ingestToken, alex);
  await poll(t, token, { report });
  return { t, ingestToken, alex, token };
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

    vi.advanceTimersByTime(KILL_FOR);
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
