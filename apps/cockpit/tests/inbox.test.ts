import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { fakeForge, type FakeForge, localMode } from "./forge";
import { catchUp, cockpit, type Cockpit, factory, fixture, ingest, recorded, signIn, team, type WireEvent } from "./helpers";

// The inbox: every gate the viewer is permitted to answer (spec #40) — they
// can read its repository, and the factory's trust list for its channel names
// them or nobody. The forge and the factory decide; the cockpit only mirrors.

const ROOT = "/work/widgets/.asf-worktrees";
const PINNED = "89abcdef0123456789abcdef0123456789abcdef";
const DIGEST = "9f2c1e";

interface Wait {
  session: string;
  gate?: string;
  round?: number;
  kind?: "gate" | "questions";
  channel?: string;
  trusted?: string[];
  published?: boolean;
  since?: string;
  triggeredBy?: string;
  /** Who wrote the issue and whom it is assigned to: a `provenance_recorded` v2 between the two. */
  author?: string;
  assignees?: string[];
  questions?: unknown[];
}

/** A session that started and then suspended at a gate, as its station ships it. */
function suspendedAt(wait: Wait): WireEvent[] {
  const started = fixture("session_started", 1);
  Object.assign(started.payload, {
    adw_id: wait.session, repo_root: `${ROOT}/${wait.session}`, triggered_by: wait.triggeredBy ?? "",
    issue_url: wait.channel === "terminal" ? "" : "https://github.com/acme/widgets/issues/42",
    request: wait.channel === "terminal" ? "add a health check" : "#42 health check broken",
  });
  const suspended = fixture("suspended", 2, 2);
  const gate = wait.gate ?? "plan";
  const kind = wait.kind ?? "gate";
  Object.assign(suspended.payload, {
    head_sha: PINNED, published: wait.published ?? true, trusted: wait.trusted ?? [],
    questions: wait.questions ?? [],
  });
  Object.assign(suspended.payload.waiting_for as Record<string, unknown>, {
    gate, round: wait.round ?? 1, kind, channel: wait.channel ?? "issue",
    issue_number: wait.channel === "terminal" ? 0 : 42, subject_digest: DIGEST, since: wait.since ?? "2026-09-29T11:59:00.000+00:00",
    phase_name: kind === "questions" ? `ask_${gate}` : `approve_${gate}`,
    paths: kind === "questions" ? [] : [`${ROOT}/${wait.session}/docs/asf/spec/plan.md`],
  });
  if (wait.author === undefined && wait.assignees === undefined) return [started, suspended];
  const learned = fixture("provenance_recorded", 2, 2);
  Object.assign(learned.payload, { issue_author: wait.author ?? "", issue_assignees: wait.assignees ?? [] });
  return [started, learned, { ...suspended, seq: 3 }];
}

async function ship(t: Cockpit, token: string, session: string, events: WireEvent[]): Promise<void> {
  const response = await ingest(t, token, { session, events });
  expect(response.status).toBe(200);
}

async function inboxOf(t: Cockpit, holding?: string) {
  const inbox = await t.query(api.inbox.list, { signIn: holding });
  return inbox.rows.map(({ factory, session, blocked }) => ({ factory, session, blocked }));
}

/** A team on `forge`: acme/widgets and acme/gadgets hold factories, and the App is installed on both. */
async function teamOf(forge: FakeForge, roles: Record<string, Record<string, "read" | "write">>): Promise<Cockpit> {
  for (const login of new Set(Object.values(roles).flatMap((byLogin) => Object.keys(byLogin)))) forge.person(login);
  for (const [repo, byLogin] of Object.entries(roles)) forge.repo(repo, { factory: true, roles: byLogin });
  const t = cockpit();
  await team(t, forge);
  forge.install("acme");
  await catchUp(t);
  return t;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the gates a viewer is permitted to answer", () => {
  it("are the ones whose repository they can read and whose trust list names them, or nobody", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, {
      "acme/widgets": { alex: "write", sam: "read", dana: "write" },
      "acme/gadgets": { alex: "write" },
    });
    const widgets = await factory(t, "acme/widgets");
    await ship(t, widgets, "a1a1a1a1", suspendedAt({ session: "a1a1a1a1", trusted: ["alex", "Sam"] }));
    await ship(t, await factory(t, "acme/gadgets"), "b2b2b2b2", suspendedAt({ session: "b2b2b2b2", since: "2026-09-29T12:30:00.000+00:00" }));

    // The longest wait first.
    expect(await inboxOf(t, await signIn(t, forge, "alex"))).toEqual([
      { factory: "acme/widgets", session: "a1a1a1a1", blocked: null },
      { factory: "acme/gadgets", session: "b2b2b2b2", blocked: null },
    ]);
    // The factory's answers watcher compares logins exactly, so the mirror does
    // too: "Sam" in the trust list does not hear sam, and the inbox does not offer it.
    expect(await inboxOf(t, await signIn(t, forge, "sam"))).toEqual([]);
    // Dana can read widgets, but the factory hears only alex and sam there.
    expect(await inboxOf(t, await signIn(t, forge, "dana"))).toEqual([]);
    // Nobody signed in sees nothing.
    expect(await inboxOf(t)).toEqual([]);
  });
});

describe("a wait the inbox cannot answer", () => {
  it("stays in the list, saying why", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    const widgets = await factory(t, "acme/widgets");
    const opened = fixture("gate_opened", 2);
    (opened.payload.waiting_for as Record<string, unknown>).since = "2026-09-29T11:00:05.000+00:00";
    await ship(t, widgets, "c1c1c1c1", [suspendedAt({ session: "c1c1c1c1" })[0], opened]);
    await ship(t, widgets, "c2c2c2c2", suspendedAt({ session: "c2c2c2c2", channel: "terminal", since: "2026-09-29T11:00:10.000+00:00" }));
    await ship(t, widgets, "c3c3c3c3", suspendedAt({ session: "c3c3c3c3", channel: "pr", since: "2026-09-29T11:00:20.000+00:00" }));
    await ship(t, widgets, "c4c4c4c4", suspendedAt({ session: "c4c4c4c4", published: false, since: "2026-09-29T11:00:30.000+00:00" }));
    const answered = fixture("decision_recorded", 3);
    Object.assign(answered.payload, { consumed: false });
    Object.assign(answered.payload.decision as Record<string, unknown>, { round: 1, verdict: "approve", by: "sam", consumed_at: "" });
    await ship(t, widgets, "c5c5c5c5", [...suspendedAt({ session: "c5c5c5c5", since: "2026-09-29T11:00:40.000+00:00" }), answered]);

    expect(await inboxOf(t, await signIn(t, forge, "alex"))).toEqual([
      { factory: "acme/widgets", session: "c1c1c1c1",
        blocked: "being asked at the station's terminal right now: the factory reads the forge once the run has suspended" },
      { factory: "acme/widgets", session: "c2c2c2c2",
        blocked: "started from a prompt, with no work item to answer on: it is answered at the station's terminal" },
      { factory: "acme/widgets", session: "c3c3c3c3",
        blocked: "the factory reads no answers on a pull request yet: it is answered at the station's terminal" },
      { factory: "acme/widgets", session: "c4c4c4c4",
        blocked: "subject not on the forge: the station keeps this session's branch to itself (worktree.publish: on_integrate)" },
      { factory: "acme/widgets", session: "c5c5c5c5",
        blocked: "answered by sam (approve): the run goes on when the factory next looks" },
    ]);
  });
});

describe("a session stored before the inbox existed", () => {
  it("is found once the deployment's start has marked it waiting", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    await ship(t, await factory(t, "acme/widgets"), "k1k1k1k1", suspendedAt({ session: "k1k1k1k1" }));
    // As an older cockpit left it: no `waiting` beside the summary.
    await t.run(async (ctx) => {
      for (const record of await ctx.db.query("sessions").collect()) await ctx.db.patch(record._id, { waiting: undefined });
    });
    const alex = await signIn(t, forge, "alex");
    expect(await inboxOf(t, alex)).toEqual([]);

    await t.mutation(internal.inbox.backfill, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await inboxOf(t, alex)).toEqual([{ factory: "acme/widgets", session: "k1k1k1k1", blocked: null }]);
  });
});

describe("the list, live", () => {
  it("gains a row when a gate opens, and loses it when the decision is acted on", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    const widgets = await factory(t, "acme/widgets");
    const alex = await signIn(t, forge, "alex");
    const [started, suspended] = suspendedAt({ session: "d1d1d1d1" });

    await ship(t, widgets, "d1d1d1d1", [started]);
    expect(await inboxOf(t, alex)).toEqual([]);

    await ship(t, widgets, "d1d1d1d1", [suspended]);
    expect(await inboxOf(t, alex)).toEqual([{ factory: "acme/widgets", session: "d1d1d1d1", blocked: null }]);

    const consumed = fixture("decision_recorded", 3);
    Object.assign(consumed.payload.decision as Record<string, unknown>, { round: 1, verdict: "approve", by: "alex" });
    await ship(t, widgets, "d1d1d1d1", [consumed]);
    expect(await inboxOf(t, alex)).toEqual([]);
  });

  it("marks and sorts first what is for the viewer — triggered, written, assigned — and hides nothing", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    const widgets = await factory(t, "acme/widgets");
    // The longest wait, and nobody's in particular.
    await ship(t, widgets, "e1e1e1e1", suspendedAt({ session: "e1e1e1e1", since: "2026-09-29T10:00:00.000+00:00" }));
    await ship(t, widgets, "e2e2e2e2", suspendedAt({ session: "e2e2e2e2", triggeredBy: "Alex" }));
    await ship(t, widgets, "e3e3e3e3", suspendedAt({ session: "e3e3e3e3", author: "alex", triggeredBy: "bob",
                                                     since: "2026-09-29T11:00:00.000+00:00" }));
    await ship(t, widgets, "e4e4e4e4", suspendedAt({ session: "e4e4e4e4", assignees: ["carol", "alex"],
                                                     since: "2026-09-29T11:30:00.000+00:00" }));
    await ship(t, widgets, "e5e5e5e5", suspendedAt({ session: "e5e5e5e5", author: "bob", assignees: ["carol"],
                                                     triggeredBy: "bob", since: "2026-09-29T09:00:00.000+00:00" }));

    const { rows } = await t.query(api.inbox.list, { signIn: await signIn(t, forge, "alex") });
    expect(rows.map(({ session, forYou }) => ({ session, forYou }))).toEqual([
      { session: "e3e3e3e3", forYou: ["wrote"] },
      { session: "e4e4e4e4", forYou: ["assigned"] },
      { session: "e2e2e2e2", forYou: ["triggered"] },
      { session: "e5e5e5e5", forYou: [] },
      { session: "e1e1e1e1", forYou: [] },
    ]);
  });

  it("names every reason a row is for the viewer", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    await ship(t, await factory(t, "acme/widgets"), "e6e6e6e6",
               suspendedAt({ session: "e6e6e6e6", triggeredBy: "alex", author: "Alex", assignees: ["ALEX"] }));

    const { rows } = await t.query(api.inbox.list, { signIn: await signIn(t, forge, "alex") });
    expect(rows.map(({ forYou }) => forYou)).toEqual([["triggered", "wrote", "assigned"]]);
  });
});

const MARK = (session: string) =>
  `<!-- asf:answer adw=${session} gate=plan round=1 digest=${DIGEST} -->\n<sub>Answered in the asf cockpit.</sub>\n`;

function answering(session: string, given: Partial<{ verdict: "approve" | "reject" | "abort" | "answer"; notes: string;
                                                   answers: string[]; digest: string; round: number }> = {}) {
  return { factory: "acme/widgets", session, gate: "plan", round: given.round ?? 1, digest: given.digest ?? DIGEST,
           verdict: given.verdict ?? "approve", notes: given.notes ?? "", answers: given.answers ?? [] };
}

describe("answering from the inbox", () => {
  it("posts the answer on the work item as the viewer, and the row says so until the factory acts", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    await ship(t, await factory(t, "acme/widgets"), "f1f1f1f1", suspendedAt({ session: "f1f1f1f1", trusted: ["alex"] }));
    const alex = await signIn(t, forge, "alex");

    const posted = await t.action(api.inbox.answer, { ...answering("f1f1f1f1", { notes: "ship it" }), signIn: alex });

    expect(posted).toEqual({ ok: true, url: expect.stringMatching(/\/acme\/widgets\/issues\/42#issuecomment-\d+$/) });
    // On the person's own user access token: GitHub shows it as theirs, made through the App.
    expect(forge.comments("acme/widgets", 42)).toEqual([
      { author: "alex", via: "user", body: `/approve\n\nship it\n\n${MARK("f1f1f1f1")}` },
    ]);
    expect(await inboxOf(t, alex)).toEqual([{
      factory: "acme/widgets", session: "f1f1f1f1",
      blocked: "answered by alex in the cockpit (approve): waiting for the factory's answers watcher",
    }]);
  });

  it("refuses what the factory would refuse, and posts nothing", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { "acme/widgets": { alex: "write", dana: "write" } });
    const widgets = await factory(t, "acme/widgets");
    await ship(t, widgets, "f2f2f2f2", suspendedAt({ session: "f2f2f2f2", trusted: ["alex"] }));
    await ship(t, widgets, "f3f3f3f3", suspendedAt({ session: "f3f3f3f3", channel: "terminal" }));
    const alex = await signIn(t, forge, "alex");
    const refused = (because: string) => ({ ok: false, because });

    expect(await t.action(api.inbox.answer, { ...answering("f2f2f2f2", { verdict: "reject" }), signIn: alex }))
      .toEqual(refused("a reject needs notes: they are what the agent revises from"));
    expect(await t.action(api.inbox.answer, { ...answering("f2f2f2f2", { digest: "0ld" }), signIn: alex }))
      .toEqual(refused("the plan changed since you opened it: read it again before you answer"));
    expect(await t.action(api.inbox.answer, { ...answering("f2f2f2f2", { round: 2 }), signIn: alex }))
      .toEqual(refused("the session is no longer waiting at plan round 2"));
    expect(await t.action(api.inbox.answer, { ...answering("f2f2f2f2"), signIn: await signIn(t, forge, "dana") }))
      .toEqual(refused("no such wait among the ones you may answer"));
    expect(await t.action(api.inbox.answer, { ...answering("f3f3f3f3"), signIn: alex }))
      .toEqual(refused("started from a prompt, with no work item to answer on: it is answered at the station's terminal"));
    expect(forge.comments("acme/widgets", 42)).toEqual([]);
  });

  it("in a local cockpit, posts with the token of the person whose machine it is", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    const t = cockpit();
    await catchUp(t);
    await ship(t, await factory(t, "acme/widgets"), "f4f4f4f4", suspendedAt({ session: "f4f4f4f4", trusted: ["alex"] }));

    const posted = await t.action(api.inbox.answer, answering("f4f4f4f4", { verdict: "abort", notes: "duplicate of #40" }));

    expect(posted).toMatchObject({ ok: true });
    expect(forge.comments("acme/widgets", 42)).toEqual([
      { author: "alex", via: "person", body: `/abort\n\nduplicate of #40\n\n${MARK("f4f4f4f4")}` },
    ]);
  });
});

describe("the subject of a gate", () => {
  const PLAN = "# Plan\n\n1. Register /health in app.py.\n";
  const WORKTREE = `${ROOT}/g1g1g1g1`;
  // What the factory's own `hitl.digest` makes of these files at these paths.
  const OF_THE_PLAN = "faef1218ffb1721c0bdbc8afdf3d6db87d4e2a440b50881e2c8a3a31eb73d350";
  const OF_THREE = "5ae88d88411dbcf90cf35f2e1de42d2487bfb9d231aa8edce9317aeadde8bf91";
  const BASE = "0".repeat(40);
  const TIP = "7".repeat(40);

  /** acme/widgets with `commits` on it (sha → files), and a session waiting on `paths` hashed as `digest`. */
  async function gated(commits: Record<string, Record<string, string>>, paths: string[], digest: string) {
    const forge = fakeForge();
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    for (const [sha, files] of Object.entries(commits)) forge.commit("acme/widgets", sha, files);
    const events = suspendedAt({ session: "g1g1g1g1" });
    Object.assign(events[1].payload, { base_commit: BASE });
    Object.assign(events[1].payload.waiting_for as Record<string, unknown>, { paths, subject_digest: digest });
    await ship(t, await factory(t, "acme/widgets"), "g1g1g1g1", events);
    const alex = await signIn(t, forge, "alex");
    const read = () => t.action(api.inbox.subject, { factory: "acme/widgets", session: "g1g1g1g1", signIn: alex });
    return { forge, read };
  }

  it("is read at the commit the question was asked about, never the branch tip, and checked against its digest", async () => {
    const { forge, read } = await gated({
      [PINNED]: { "docs/asf/spec/plan.md": PLAN },
      [TIP]: { "docs/asf/spec/plan.md": "# Plan\n\nRewritten since.\n" },
    }, [`${WORKTREE}/docs/asf/spec/plan.md`], OF_THE_PLAN);

    expect(await read()).toEqual({
      ok: true, headSha: PINNED, current: true, diff: null,
      files: [{ path: "docs/asf/spec/plan.md", content: PLAN, truncated: false, binary: false }],
    });
    expect(forge.requests.filter(({ path }) => path.includes("/contents/docs/")).map(({ path }) => path))
      .toEqual([`/repos/acme/widgets/contents/docs/asf/spec/plan.md?ref=${PINNED}`]);
  });

  it("hashes several files in the factory's order", async () => {
    const files = { "docs/asf/spec/plan.md": PLAN, "docs/asf/spec/z-notes.md": "two\n", "docs/asf-spec.md": "three\n" };
    const { read } = await gated({ [PINNED]: files }, Object.keys(files).map((path) => `${WORKTREE}/${path}`), OF_THREE);

    expect(await read()).toMatchObject({ ok: true, current: true });
  });

  it("says when what the commit holds is not what the factory asked about", async () => {
    const { read } = await gated({ [PINNED]: { "docs/asf/spec/plan.md": "# Plan\n\nNot what was asked.\n" } },
                                 [`${WORKTREE}/docs/asf/spec/plan.md`], OF_THE_PLAN);

    expect(await read()).toMatchObject({ ok: true, current: false });
  });

  it("is the forge's diff of base and head when the subject is a file of the session's own", async () => {
    const { read } = await gated({ [BASE]: { "app.py": "ok = 0\n" }, [PINNED]: { "app.py": "ok = 1\n" } },
                                 ["/work/widgets/asf/data/sessions/g1g1g1g1/changes.diff"], "d1ff");

    // What was hashed is a file only the station has: the factory checks the digest when it hears the answer.
    expect(await read()).toEqual({
      ok: true, headSha: PINNED, current: null, files: [],
      diff: "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n-ok = 0\n+ok = 1\n",
    });
  });

  it("says so when the forge does not hold the commit", async () => {
    const { read } = await gated({}, [`${WORKTREE}/docs/asf/spec/plan.md`], OF_THE_PLAN);

    expect(await read()).toEqual({
      ok: false,
      because: `the forge does not show docs/asf/spec/plan.md at ${PINNED.slice(0, 7)} to this cockpit: ` +
        "the branch may not be pushed, or was deleted",
    });
  });
});

describe("the answer view", () => {
  it("shows a recorded run's second plan round with the first one's verdict and the journal the next agent reads", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    // The recorded session, as its station had shipped it when the plan gate asked a second time.
    const events = recorded["issue-then-two-reviews"].events.filter(({ seq }) => seq <= 82);
    await ship(t, await factory(t, "acme/widgets"), "a9f259f0", events);
    const alex = await signIn(t, forge, "alex");

    expect(await inboxOf(t, alex)).toEqual([{ factory: "acme/widgets", session: "a9f259f0", blocked: null }]);
    const gate = await t.query(api.inbox.gate, { factory: "acme/widgets", session: "a9f259f0", signIn: alex });

    expect(gate).toMatchObject({
      row: { gate: "plan", round: 2, kind: "gate", channel: "issue", issueNumber: 42,
             summary: "the plan now names the module", blocked: null },
      subjectDigest: "6151fe4319d06427379e4ef96b3898549880d60e220f8868b7376e5cecfe3a78",
      subject: {
        headSha: "ddfd5cbd17ce9ebc7344da7e65a6c6eb9751ddc3", baseCommit: "ddfd5cbd17ce9ebc7344da7e65a6c6eb9751ddc3",
        files: [{ path: "docs/asf/spec/plan.md", absolute: "/work/widgets/.asf-worktrees/a9f259f0/docs/asf/spec/plan.md" }],
        outside: [],
      },
      earlier: [{ round: 1, verdict: "reject", by: "asf tests", notes: "name the module the date is converted in", channel: "cli" }],
      questions: [],
      as: "alex",
    });
    expect(gate!.journal).toContain(
      "✎ asf tests said, reject at the plan gate (round 1): name the module the date is converted in");
  });

  it("shows a question round's questions, the recommendation first", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { "acme/widgets": { alex: "write" } });
    const question = {
      topic: "scope", question: "Which endpoint?", why: "the fix differs per path", blocking: true,
      options: [{ answer: "every endpoint", because: "", recommended: false },
                { answer: "/health", because: "it is the one that 500s", recommended: true }],
    };
    await ship(t, await factory(t, "acme/widgets"), "h1h1h1h1",
               suspendedAt({ session: "h1h1h1h1", gate: "requirements", kind: "questions", questions: [question] }));

    const gate = await t.query(api.inbox.gate, { factory: "acme/widgets", session: "h1h1h1h1",
                                                 signIn: await signIn(t, forge, "alex") });

    expect(gate!.row).toMatchObject({ kind: "questions", questions: 1 });
    expect(gate!.questions).toEqual([{ ...question, options: [question.options[1], question.options[0]] }]);
  });

  it("is nothing at all for a wait the viewer may not answer", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { "acme/widgets": { alex: "write", dana: "write" } });
    await ship(t, await factory(t, "acme/widgets"), "h2h2h2h2", suspendedAt({ session: "h2h2h2h2", trusted: ["alex"] }));

    expect(await t.query(api.inbox.gate, { factory: "acme/widgets", session: "h2h2h2h2",
                                           signIn: await signIn(t, forge, "dana") })).toBeNull();
  });
});
