import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { catchUp, cockpit, type Cockpit, factory, fixture, ingest, signIn, team } from "./helpers";
import { fakeForge } from "./forge";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function factoriesOf(t: Cockpit, holding?: string) {
  const list = await t.query(api.factories.list, { signIn: holding });
  return list && list.factories.map(({ repo, role, reporting }) => ({ repo, role, reporting }));
}

describe("the Factories list in a team cockpit", () => {
  it("shows each viewer exactly the repositories they can read that hold a factory", async () => {
    const forge = fakeForge();
    forge.person("alex");
    forge.person("sam");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin", sam: "read" } });
    forge.repo("acme/gadgets", { factory: true, roles: { alex: "write" } });
    forge.repo("acme/docs", { roles: { alex: "write", sam: "write" } });            // no factory
    forge.repo("acme/unlisted", { factory: true, roles: { alex: "admin" } });       // the App is not installed on it
    forge.repo("other/thing", { factory: true, roles: { alex: "admin" } });         // nor on this account
    const t = cockpit();
    await team(t, forge);
    forge.install("acme", ["acme/widgets", "acme/gadgets", "acme/docs"]);
    await ingest(t, await factory(t, "acme/widgets"), { session: "5c0075aa", events: [fixture("session_started", 1)] });

    await catchUp(t);

    expect(await factoriesOf(t, await signIn(t, forge, "alex"))).toEqual([
      { repo: "acme/gadgets", role: "write", reporting: false },
      { repo: "acme/widgets", role: "admin", reporting: true },
    ]);
    expect(await factoriesOf(t, await signIn(t, forge, "sam"))).toEqual([
      { repo: "acme/widgets", role: "read", reporting: true },
    ]);
  });

  it("reads as the App's installation, with a token it keeps for its hour and ETags that make a quiet poll free", async () => {
    const forge = fakeForge();
    forge.repo("acme/widgets", { factory: true });
    const t = cockpit();
    await team(t, forge);
    const installation = forge.install("acme");
    const mark = forge.requests.length;

    // Where the App is installed is asked as the App itself, with a JWT that is new each time.
    const asTheApp = expect.stringMatching(/^GET \/app\/installations\?per_page=100 → (200|304)$/);

    await catchUp(t);
    expect(forge.since(mark)).toEqual([
      asTheApp,
      `POST /app/installations/${installation}/access_tokens → 201`,
      "GET /installation/repositories?per_page=100 → 200",
      asTheApp,
      "HEAD /repos/acme/widgets/contents/asf/factory.yaml → 200",
      asTheApp,
      "GET /repos/acme/widgets/labels?per_page=100 → 200",
    ]);

    const quiet = forge.requests.length;
    await catchUp(t);
    expect(forge.since(quiet)).toEqual([
      asTheApp, "GET /installation/repositories?per_page=100 → 304",
      asTheApp, "GET /repos/acme/widgets/labels?per_page=100 → 304",
    ]);

    // An hour on the token has lapsed, and a new one is minted.
    vi.advanceTimersByTime(3600_000);
    const later = forge.requests.length;
    await catchUp(t);
    expect(forge.since(later)).toContain(`POST /app/installations/${installation}/access_tokens → 201`);
  });

  it("shows nothing to someone who has not signed in", async () => {
    const forge = fakeForge();
    forge.repo("acme/widgets", { factory: true, private: false });
    const t = cockpit();
    await team(t, forge);
    forge.install("acme");
    await catchUp(t);

    expect(await factoriesOf(t)).toBeNull();
    expect(await factoriesOf(t, "asf_signin_guess")).toBeNull();
  });
});

describe("sessions in a team cockpit", () => {
  async function shipped(forge: ReturnType<typeof fakeForge>) {
    forge.person("alex");
    forge.person("sam");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "write", sam: "read" } });
    forge.repo("acme/gadgets", { factory: true, roles: { alex: "write" } });
    const t = cockpit();
    await team(t, forge);
    forge.install("acme");
    await ingest(t, await factory(t, "acme/widgets"), { session: "5c0075aa", events: [fixture("session_started", 1)] });
    await ingest(t, await factory(t, "acme/gadgets"), { session: "0ddba11", events: [fixture("session_started", 1)] });
    await catchUp(t);
    return t;
  }

  it("are listed for a viewer who can read their factory's repository, and for nobody else", async () => {
    const forge = fakeForge();
    const t = await shipped(forge);
    const listed = async (holding?: string) =>
      (await t.query(api.sessions.list, { signIn: holding })).map(({ factory: from, session }) => `${from} ${session}`);

    expect((await listed(await signIn(t, forge, "alex"))).sort()).toEqual(["acme/gadgets 0ddba11", "acme/widgets 5c0075aa"]);
    expect(await listed(await signIn(t, forge, "sam"))).toEqual(["acme/widgets 5c0075aa"]);
    expect(await listed()).toEqual([]);
  });

  it("open for a viewer who can read their factory's repository, and for nobody else", async () => {
    const forge = fakeForge();
    const t = await shipped(forge);
    const gadgets = { factory: "acme/gadgets", session: "0ddba11" };

    expect((await t.query(api.sessions.get, { ...gadgets, signIn: await signIn(t, forge, "alex") }))?.session).toBe("0ddba11");
    expect(await t.query(api.sessions.get, { ...gadgets, signIn: await signIn(t, forge, "sam") })).toBeNull();
    expect(await t.query(api.sessions.get, gadgets)).toBeNull();
  });
});
