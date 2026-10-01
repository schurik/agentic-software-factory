import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { REDELIVER_AFTER, TTL } from "../convex/model/command";
import { fakeForge } from "./forge";
import { factory, fixture, ingest, signIn, type WireEvent } from "./helpers";
import { approved, json, poll, REPORT, running, SESSION, STATION, steerable, teamOf } from "./station";

// The rest of the closed vocabulary (spec #40, #55): resume, the answers a
// terminal-channel gate waits for, and run. Every one is queued for a station,
// delivered once (and again only if never answered), expired by its verb's
// TTL, and done only when the station says so — in a `command_result` its
// session carries, or, for a run that started a session rather than naming
// one, on its next poll. The factory's end is tests/test_asf_commands.py.

const OBEYS = { ...REPORT, verbs: ["answer", "abort", "kill", "resume"] };
const RUNS = { ...OBEYS, verbs: [...OBEYS.verbs, "run"] };
const DIGEST = "9f2c1e";

const asked = (holding?: string) => ({ factory: "acme/widgets", session: SESSION, signIn: holding });

/** SESSION started on STATION and failed. */
function failed(kind = "local"): WireEvent[] {
  const [started] = running();
  Object.assign(started.payload, { station_kind: kind });
  return [{ ...started, v: 2 }, fixture("session_finished", 2)];
}

/** SESSION, a prompt run on STATION, waiting at its plan gate on the terminal channel. */
function waitingOnTerminal(status: "waiting" | "running" = "waiting"): WireEvent[] {
  const [started] = running();
  Object.assign(started.payload, { request: "add a health check", issue_url: "" });
  const wait = {
    gate: "plan", round: 1, kind: "gate", channel: "terminal", issue_number: 0, subject_digest: DIGEST,
    phase_name: "approve_plan", paths: [],
  };
  if (status === "running") {
    const opened = fixture("gate_opened", 2);
    Object.assign(opened.payload.waiting_for as Record<string, unknown>, wait);
    return [started, opened];
  }
  const suspended = fixture("suspended", 2, 2);
  Object.assign(suspended.payload, { head_sha: "89abcdef", published: true, trusted: [], questions: [] });
  Object.assign(suspended.payload.waiting_for as Record<string, unknown>, wait);
  return [started, suspended];
}

/** What the station says it did with command `id`, in the session it names. */
function result(id: string, seq: number, fields: Record<string, unknown>): WireEvent {
  const said = fixture("command_result", seq);
  Object.assign(said.payload, { command_id: id, adw_id: SESSION, by: "alex", ok: true, detail: "", ...fields });
  return said;
}

type T = Awaited<ReturnType<typeof steerable>>["t"];

/** What a poll from the station holding `token` is handed, reporting `report` as it does. */
async function delivered(t: T, token: string, body = {}, report: Record<string, unknown> = OBEYS) {
  return (await json(await poll(t, token, { report, ...body }))).commands as Record<string, unknown>[];
}

/** Every command's verb and state, read off the table: after an hour, a viewer's forge reach has lapsed. */
async function states(t: T): Promise<string[]> {
  return (await t.run(async (ctx) => await ctx.db.query("commands").collect())).map((c) => `${c.verb}: ${c.state}`);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── resume ───────────────────────────────────────────────────────────────────

describe("resuming a failed session", () => {
  it("is queued for the station that holds it, taken by its loop, and done when the station says so", async () => {
    const { t, ingestToken, alex, token } = await steerable(fakeForge(), failed(), { alex: "write" }, OBEYS);

    expect(await t.mutation(api.commands.resume, asked(alex))).toEqual({ ok: true });
    expect(await t.mutation(api.commands.resume, asked(alex))).toEqual({ ok: true });     // one is on its way

    const [command] = await delivered(t, token);
    expect(command).toMatchObject({ verb: "resume", session: SESSION, by: "alex" });
    expect((await t.query(api.commands.steering, asked(alex)))?.resume).toMatchObject({ state: "delivered", by: "alex" });

    await ingest(t, ingestToken, { session: SESSION, events: [result(command.id as string, 3, { verb: "resume", detail: "relaunched" })] });
    expect((await t.query(api.commands.steering, asked(alex)))?.resume).toMatchObject({ state: "done", detail: "relaunched" });
  });

  it("is only for a failed session", async () => {
    const { t, alex } = await steerable(fakeForge(), running(), { alex: "write" }, OBEYS);

    const because = "only a failed session can be resumed";
    expect(await t.mutation(api.commands.resume, asked(alex))).toEqual({ ok: false, because });
    expect((await t.query(api.commands.steering, asked(alex)))?.resumeRefused).toBe(because);
  });

  it("is disabled for a session that ran in CI, which is re-triggered from the forge instead", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write" });
    await ingest(t, await factory(t, "acme/widgets"), { session: SESSION, events: failed("ci") });
    const alex = await signIn(t, forge, "alex");

    const because = "ran in CI: re-trigger from the forge";
    expect((await t.query(api.commands.steering, asked(alex)))?.resumeRefused).toBe(because);
    expect(await t.mutation(api.commands.resume, asked(alex))).toEqual({ ok: false, because });
  });

  it("is greyed out when the station does not take resume", async () => {
    const { t, alex } = await steerable(fakeForge(), failed(), { alex: "write" }, REPORT);

    expect((await t.query(api.commands.steering, asked(alex)))?.resumeRefused)
      .toBe("alex@mbp:widgets does not take resume: its asf/factory.yaml's cockpit.commands does not list it");
  });

  it("waits for an offline station for an hour, not the minutes a kill does", async () => {
    const { t, alex, token } = await steerable(fakeForge(), failed(), { alex: "write" }, OBEYS);
    await t.mutation(api.commands.resume, asked(alex));

    vi.advanceTimersByTime(TTL.kill + 1000);
    expect(await delivered(t, token)).toHaveLength(1);

    vi.advanceTimersByTime(TTL.resume);
    await t.mutation(internal.commands.expire, {});
    expect(await states(t)).toEqual(["resume: expired"]);
  });
});

// ── expiry ───────────────────────────────────────────────────────────────────

describe("a command nobody took", () => {
  it("expires by its verb's TTL even while its station never polls again, and is never delivered after", async () => {
    const { t, alex, token } = await steerable(fakeForge(), running(), { alex: "write" }, OBEYS);
    await t.mutation(api.commands.kill, asked(alex));

    vi.advanceTimersByTime(TTL.kill + 1000);
    await t.mutation(internal.commands.expire, {});

    expect((await t.query(api.commands.steering, asked(alex)))?.kill?.state).toBe("expired");
    expect(await delivered(t, token)).toEqual([]);
  });
});

// ── answering a terminal-channel gate ────────────────────────────────────────

const answering = (holding: string | undefined, fields: Record<string, unknown> = {}) => ({
  factory: "acme/widgets", session: SESSION, gate: "plan", round: 1, digest: DIGEST,
  verdict: "approve" as const, notes: "", answers: [], signIn: holding, ...fields,
});

describe("a gate that waits on the terminal channel", () => {
  it("is answerable from the inbox once its station takes answers, as a command and never a comment", async () => {
    const forge = fakeForge();
    const { t, alex, token } = await steerable(forge, waitingOnTerminal(), { alex: "write" }, OBEYS);

    const [row] = (await t.query(api.inbox.list, { signIn: alex })).rows;
    expect(row).toMatchObject({ via: "command", blocked: null, refused: { answer: null, abort: null } });

    // Queued for the station, not posted: there is no work item to post on.
    expect(await t.action(api.inbox.answer, answering(alex, { notes: "keep it small" }))).toEqual({ ok: true, url: "" });

    const [command] = await delivered(t, token);
    expect(command).toMatchObject({
      verb: "answer", verdict: "approve", session: SESSION, by: "alex", notes: "keep it small",
      gate: "plan", round: 1, digest: DIGEST,
    });
    const [after] = (await t.query(api.inbox.list, { signIn: alex })).rows;
    expect(after.blocked).toBe("answered by alex in the cockpit (approve)");
    expect(after.queued).toMatchObject({ by: "alex", verdict: "approve" });

  });

  it("sends an abort as its own verb, and a question round's answers as the words the analyst reads", async () => {
    const { t, alex, token } = await steerable(fakeForge(), waitingOnTerminal(), { alex: "write" }, OBEYS);

    expect(await t.action(api.inbox.answer, answering(alex, { verdict: "abort", notes: "not now" }))).toMatchObject({ ok: true });

    expect(await delivered(t, token)).toEqual([expect.objectContaining({ verb: "abort", verdict: "abort", notes: "not now" })]);
  });

  it("keeps a reject without notes and an answer to a changed subject from ever being queued", async () => {
    const { t, alex, token } = await steerable(fakeForge(), waitingOnTerminal(), { alex: "write" }, OBEYS);

    expect(await t.action(api.inbox.answer, answering(alex, { verdict: "reject" })))
      .toEqual({ ok: false, because: "a reject needs notes: they are what the agent revises from" });
    expect(await t.action(api.inbox.answer, answering(alex, { digest: "0ld" })))
      .toEqual({ ok: false, because: "the plan changed since you opened it: read it again before you answer" });
    expect(await delivered(t, token)).toEqual([]);
  });

  it("stays disabled, saying why, when the station takes no answers or nobody registered it", async () => {
    const { t, alex } = await steerable(fakeForge(), waitingOnTerminal(), { alex: "write" }, { ...OBEYS, verbs: ["kill", "abort"] });

    const [row] = (await t.query(api.inbox.list, { signIn: alex })).rows;
    expect(row.blocked).toBeNull();
    expect(row.refused).toEqual({
      answer: "alex@mbp:widgets does not take answer: its asf/factory.yaml's cockpit.commands does not list it",
      abort: null,
    });
    expect(await t.action(api.inbox.answer, answering(alex))).toEqual({ ok: false, because: row.refused!.answer });

    const forge = fakeForge();
    const lone = await teamOf(forge, { alex: "write" });
    await ingest(lone, await factory(lone, "acme/widgets"), { session: SESSION, events: waitingOnTerminal() });
    const [unregistered] = (await lone.query(api.inbox.list, { signIn: await signIn(lone, forge, "alex") })).rows;
    expect(unregistered.blocked).toBe("alex@mbp:widgets takes no commands: run `asf station register` on it");
  });

  it("is a writer's to answer by command, never a reader's", async () => {
    const forge = fakeForge();
    const { t } = await steerable(forge, waitingOnTerminal(), { alex: "write", sam: "read" }, OBEYS);

    const [row] = (await t.query(api.inbox.list, { signIn: await signIn(t, forge, "sam") })).rows;
    expect(row.blocked).toBe("commands need write or higher on this repository, and the forge says you have read");
  });

  it("is answerable while the run asks in place, and the answer goes to the run's own shipper", async () => {
    const { t, alex, token } = await steerable(fakeForge(), waitingOnTerminal("running"), { alex: "write" }, OBEYS);
    await poll(t, token, { session: SESSION, report: OBEYS });      // the run polls: attended

    const [row] = (await t.query(api.inbox.list, { signIn: alex })).rows;
    expect(row).toMatchObject({ via: "command", blocked: null });
    expect(row.attendedAt).not.toBeNull();
    await t.action(api.inbox.answer, answering(alex));

    expect(await delivered(t, token)).toEqual([]);
    expect(await delivered(t, token, { session: SESSION })).toHaveLength(1);
  });

  it("can be answered again once the station refused the last answer, and says what it said", async () => {
    const { t, ingestToken, alex, token } = await steerable(fakeForge(), waitingOnTerminal(), { alex: "write" }, OBEYS);
    await t.action(api.inbox.answer, answering(alex));
    const [command] = await delivered(t, token);
    await ingest(t, ingestToken, { session: SESSION, events: [result(command.id as string, 3, { verb: "answer", ok: false, detail: "alex is not in issues.trusted_authors" })] });

    const [row] = (await t.query(api.inbox.list, { signIn: alex })).rows;
    expect(row.blocked).toBeNull();
    expect(row.note).toBe("alex@mbp:widgets refused the last answer: alex is not in issues.trusted_authors");
  });
});

// ── run ──────────────────────────────────────────────────────────────────────

const SAMS = { id: "st_5a35a3", name: "sam@laptop:widgets", kind: "local" };
const running_ = (holding: string | undefined, fields: Record<string, unknown> = {}) => ({
  factory: "acme/widgets", workflow: "quick", prompt: "add a health check", signIn: holding, ...fields,
});

describe("running a prompt workflow", () => {
  it("goes to the viewer's own most recently seen station by default, and is done when its poll says what it started", async () => {
    const { t, alex, token } = await steerable(fakeForge(), running(), { alex: "write" }, RUNS);

    const targets = await t.query(api.commands.runTargets, { factory: "acme/widgets", signIn: alex });
    expect(targets).toMatchObject({ refused: null, stations: [{ station: STATION.id, name: STATION.name, default: true, refused: null }] });

    const queued = await t.mutation(api.commands.run, running_(alex));
    expect(queued).toMatchObject({ ok: true });
    const [command] = await delivered(t, token);
    expect(command).toMatchObject({ verb: "run", session: "", workflow: "quick", prompt: "add a health check", by: "alex" });
    expect((await t.query(api.commands.runs, { factory: "acme/widgets", signIn: alex }))[0])
      .toMatchObject({ state: "delivered", station: STATION.name, workflow: "quick", started: "" });

    // Its result has no session to travel in: it rides the next poll.
    await poll(t, token, { results: [{ command_id: command.id, verb: "run", adw_id: "a1b2c3d4", by: "alex", ok: true, detail: "started session a1b2c3d4" }] });
    expect((await t.query(api.commands.runs, { factory: "acme/widgets", signIn: alex }))[0])
      .toMatchObject({ state: "done", started: "a1b2c3d4", detail: "started session a1b2c3d4" });
  });

  it("is refused unless the station opted in to run, which a stamp does not", async () => {
    const { t, alex } = await steerable(fakeForge(), running(), { alex: "write" }, OBEYS);

    const because = "alex@mbp:widgets does not take run: its asf/factory.yaml's cockpit.commands does not list it — run is off unless it is listed";
    expect(await t.mutation(api.commands.run, running_(alex))).toEqual({ ok: false, because });
    expect((await t.query(api.commands.runTargets, { factory: "acme/widgets", signIn: alex }))?.stations[0].refused).toBe(because);
  });

  it("can never be sent to another person's station", async () => {
    const forge = fakeForge();
    const { t, ingestToken, token } = await steerable(forge, running(), { alex: "write", sam: "write" }, RUNS);
    const sam = await signIn(t, forge, "sam");
    const samsToken = await approved(t, ingestToken, sam, SAMS);
    await poll(t, samsToken, { report: RUNS }, SAMS);

    expect(await t.mutation(api.commands.run, running_(sam, { station: STATION.id })))
      .toEqual({ ok: false, because: "that is not one of your stations on acme/widgets: a run goes only to your own" });
    const targets = await t.query(api.commands.runTargets, { factory: "acme/widgets", signIn: sam });
    expect(targets?.stations.map((each) => each.station)).toEqual([SAMS.id]);
    expect(await t.mutation(api.commands.run, running_(sam))).toMatchObject({ ok: true });
    expect(await delivered(t, token)).toEqual([]);                    // not to alex's
    const toSam = (await json(await poll(t, samsToken, {}, SAMS))).commands;
    expect(toSam).toEqual([expect.objectContaining({ verb: "run", by: "sam" })]);
  });

  it("lists the viewer's other stations with when each was last seen, and runs on the one they pick", async () => {
    const forge = fakeForge();
    const { t, ingestToken, alex, token } = await steerable(forge, running(), { alex: "write" }, RUNS);
    const desk = { id: "st_de5k00", name: "alex@desk:widgets", kind: "local" };
    const deskToken = await approved(t, ingestToken, alex, desk);
    vi.advanceTimersByTime(60_000);
    await poll(t, deskToken, { report: RUNS }, desk);

    const targets = await t.query(api.commands.runTargets, { factory: "acme/widgets", signIn: alex });
    expect(targets?.stations.map(({ station, default: chosen }) => [station, chosen]))
      .toEqual([[desk.id, true], [STATION.id, false]]);
    expect(targets?.stations[1].seenAt).toBeGreaterThan(0);

    await t.mutation(api.commands.run, running_(alex, { station: STATION.id }));
    expect(await delivered(t, token)).toHaveLength(1);
  });

  it("waits as queued for an offline station until its TTL, then expires", async () => {
    const { t, alex } = await steerable(fakeForge(), running(), { alex: "write" }, RUNS);
    await t.mutation(api.commands.run, running_(alex));
    expect((await t.query(api.commands.runs, { factory: "acme/widgets", signIn: alex }))[0]).toMatchObject({ state: "queued" });

    vi.advanceTimersByTime(TTL.run + 1000);
    await t.mutation(internal.commands.expire, {});
    expect(await states(t)).toEqual(["run: expired"]);
  });

  it("needs a workflow and a prompt, and write on the repository", async () => {
    const forge = fakeForge();
    const { t, alex } = await steerable(forge, running(), { alex: "write", sam: "triage" }, RUNS);

    expect(await t.mutation(api.commands.run, running_(alex, { prompt: " " }))).toEqual({ ok: false, because: "a run needs a prompt" });
    expect(await t.mutation(api.commands.run, running_(alex, { workflow: "" }))).toEqual({ ok: false, because: "a run names its workflow" });
    expect(await t.mutation(api.commands.run, running_(await signIn(t, forge, "sam"))))
      .toEqual({ ok: false, because: "commands need write or higher on this repository, and the forge says you have triage" });
  });
});

// ── results on the poll ──────────────────────────────────────────────────────

describe("a result a poll carries", () => {
  it("settles only a command of the station that polled", async () => {
    const forge = fakeForge();
    const { t, ingestToken, alex, token } = await steerable(forge, running(), { alex: "write", sam: "write" }, RUNS);
    await t.mutation(api.commands.run, running_(alex));
    const [command] = await delivered(t, token);
    const sam = await signIn(t, forge, "sam");
    const samsToken = await approved(t, ingestToken, sam, SAMS);

    await poll(t, samsToken, { results: [{ command_id: command.id, verb: "run", ok: false, detail: "forged" }] }, SAMS);
    expect((await t.query(api.commands.runs, { factory: "acme/widgets", signIn: alex }))[0].state).toBe("delivered");

    vi.advanceTimersByTime(REDELIVER_AFTER + 1000);
    expect(await delivered(t, token)).toHaveLength(1);                // never answered: again
  });
});
