import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { fakeForge, type FakeForge, localMode } from "./forge";
import { catchUp, cockpit, type Cockpit, factory, fixture, ingest, signIn, team } from "./helpers";
import { post } from "./station";

// An issue's and a pull request's state on the forge (#151): open, closed —
// and for a pull request draft and merged. No event says it: a pull request
// is merged long after the session that opened it ended. So the catch-up
// poll asks the forge, one listing of what changed a factory, and keeps the
// answer; a page draws what it kept, and a reference it has no state for as
// it always has.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const REPO = "acme/widgets";

let forge: FakeForge;
let t: Cockpit;
let station: string;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  forge = fakeForge();
  const token = forge.person("alex");
  forge.repo(REPO, { factory: true, roles: { alex: "admin" } });
  localMode(forge, token);
  t = cockpit();
  station = await factory(t, REPO);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * A session of the factory that answers issue `issue` and, given one, opened
 * pull request `pr` — running, or waiting at a gate on that issue.
 */
async function ship(session: string, issue: number, pr = 0, waiting = false): Promise<void> {
  const started = fixture("session_started", 1, 2);
  Object.assign(started.payload, {
    adw_id: session, workflow: "issue", request: `#${issue} broken`,
    issue_url: `https://github.com/${REPO}/issues/${issue}`,
    pr_url: pr ? `https://github.com/${REPO}/pull/${pr}` : "",
  });
  const suspended = fixture("suspended", 2, 2);
  Object.assign(suspended.payload.waiting_for as object, { issue_number: issue });
  Object.assign(suspended.payload, { trusted: [] });
  const events = waiting ? [started, suspended] : [started];
  expect((await ingest(t, station, { session, events })).status).toBe(200);
}

async function statesListed(): Promise<Record<string, unknown>> {
  const list = (await t.query(api.sessions.list, {}))!;
  return Object.fromEntries(list.sessions.map(({ session, states }) => [session, states]));
}

describe("the state of a session's issue and pull request", () => {
  it("is what the forge says, read by the poll and kept", async () => {
    forge.issue(REPO, 42, { title: "broken" });
    const pr = forge.pull(REPO, { head: "asf/s1", title: "fix it", author: "alex" });
    await ship("s1", 42, pr);

    await catchUp(t);
    expect(await statesListed()).toEqual({ s1: { issue: "open", pr: "open" } });

    forge.merge(REPO, pr);
    forge.close(REPO, 42);
    await catchUp(t);
    expect(await statesListed()).toEqual({ s1: { issue: "closed", pr: "merged" } });
  });

  it("is asked once a round, and a round in which nothing changed costs a 304", async () => {
    forge.issue(REPO, 42, { title: "broken" });
    await ship("s1", 42);
    await catchUp(t);

    const mark = forge.requests.length;
    await catchUp(t);
    expect(forge.since(mark).filter((line) => line.includes("/issues?"))).toEqual([
      "GET /repos/acme/widgets/issues?state=all&sort=updated&direction=desc&per_page=100 → 304",
    ]);
    expect(await statesListed()).toEqual({ s1: { issue: "open", pr: null } });
  });

  it("tells a draft from an open pull request, and one closed unmerged from a merged one", async () => {
    forge.issue(REPO, 42, { title: "broken" });
    const draft = forge.pull(REPO, { head: "asf/s1", title: "try", author: "alex" });
    const closed = forge.pull(REPO, { head: "asf/s2", title: "try again", author: "alex" });
    forge.ready(REPO, draft, false);
    forge.close(REPO, closed);
    await ship("s1", 42, draft);
    await ship("s2", 42, closed);

    await catchUp(t);

    expect(await statesListed()).toEqual({ s1: { issue: "open", pr: "draft" }, s2: { issue: "open", pr: "closed" } });
  });

  it("is not known for an item the forge has not listed, and that is drawn as before", async () => {
    await ship("s1", 42, 43);

    await catchUp(t);

    expect(await statesListed()).toEqual({ s1: { issue: null, pr: null } });
  });

  it("pages back past a first page when more changed since the last look than a page holds", async () => {
    forge.pageSize = 2;
    for (const number of [1, 2, 3, 4, 5]) forge.issue(REPO, number, { title: `issue ${number}` });
    await ship("s1", 1);
    await catchUp(t);
    expect(await statesListed()).toEqual({ s1: { issue: "open", pr: null } });

    vi.setSystemTime(NOW + 3600_000);
    forge.close(REPO, 1);
    for (const number of [2, 3, 4]) forge.close(REPO, number);
    await catchUp(t);

    expect(await statesListed()).toEqual({ s1: { issue: "closed", pr: null } });
  });

  it("is not asked of a factory none of whose sessions reached the cockpit", async () => {
    forge.issue(REPO, 42, { title: "broken" });
    const mark = forge.requests.length;

    await catchUp(t);

    expect(forge.since(mark).filter((line) => line.includes("/issues?"))).toEqual([]);
  });

  it("is on every page that names the item: the session's, Now's rows, and a claim on it", async () => {
    forge.issue(REPO, 42, { title: "broken" });
    forge.issue(REPO, 7, { title: "slow" });
    const pr = forge.pull(REPO, { head: "asf/s1", title: "fix it", author: "alex" });
    forge.merge(REPO, pr);
    forge.close(REPO, 7);
    await ship("s1", 42, pr);
    await ship("s2", 7, 0, true);
    const holder = { id: "st_7f3a9c", name: "alex@mbp:widgets", kind: "local" };
    const asked = { op: "take", repo: REPO, kind: "pr", number: pr, session: "s1", since: 0, station: holder,
                    requeue: { add: [], remove: [] } };
    expect((await post(t, "/claims", station, asked)).status).toBe(200);

    await catchUp(t);

    const page = (await t.query(api.sessions.get, { factory: REPO, session: "s1" }))!;
    expect(page.states).toEqual({ issue: "open", pr: "merged" });
    const now = (await t.query(api.now.page, {}))!;
    expect(now.running.map(({ session, states }) => ({ session, states })))
      .toEqual([{ session: "s1", states: { issue: "open", pr: "merged" } }]);
    expect(now.inbox.map(({ session, issueState }) => ({ session, issueState })))
      .toEqual([{ session: "s2", issueState: "closed" }]);
    const claims = await t.query(api.claims.ofSession, { factory: REPO, session: "s1" });
    expect(claims.map(({ number, state }) => ({ number, state }))).toEqual([{ number: pr, state: "merged" }]);
  });
});

describe("in a team's cockpit", () => {
  it("is read on the App's installation, as the rest of the poll is", async () => {
    vi.unstubAllEnvs();
    forge = fakeForge();
    forge.person("alex");
    forge.repo(REPO, { factory: true, roles: { alex: "write" } });
    forge.issue(REPO, 42, { title: "broken" });
    const pr = forge.pull(REPO, { head: "asf/s1", title: "fix it", author: "alex" });
    forge.merge(REPO, pr);
    t = cockpit();
    await team(t, forge);
    forge.install("acme");
    station = await factory(t, REPO);
    await ship("s1", 42, pr);

    await catchUp(t);

    const list = (await t.query(api.sessions.list, { signIn: await signIn(t, forge, "alex") }))!;
    expect(list.sessions.map(({ states }) => states)).toEqual([{ issue: "open", pr: "merged" }]);
  });
});
