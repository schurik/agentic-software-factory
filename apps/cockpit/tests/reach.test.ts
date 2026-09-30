import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { catchUp, cockpit, type Cockpit, factory, fixture, ingest, signIn, team } from "./helpers";
import { type FakeForge, fakeForge, USER_TOKEN_HOURS } from "./forge";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A team cockpit with two factories on acme, and alex signed in. */
async function signedIn(forge: FakeForge) {
  forge.person("alex");
  forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
  forge.repo("acme/gadgets", { factory: true });
  const t = cockpit();
  await team(t, forge);
  forge.install("acme");
  await catchUp(t);
  return { t, alex: await signIn(t, forge, "alex") };
}

async function roles(t: Cockpit, holding: string) {
  const list = await t.query(api.factories.list, { signIn: holding });
  return list && Object.fromEntries(list.factories.map(({ repo, role }) => [repo, role]));
}

describe("the permission mirror", () => {
  it("is the forge's answer from a few minutes ago, asked again once it is older than that", async () => {
    const forge = fakeForge();
    const { t, alex } = await signedIn(forge);
    expect(await roles(t, alex)).toEqual({ "acme/widgets": "admin" });

    forge.grant("acme/widgets", "alex", "read");
    forge.grant("acme/gadgets", "alex", "triage");
    const mark = forge.requests.length;
    await t.action(api.viewer.refresh, { signIn: alex });

    expect(forge.since(mark)).toEqual([]);
    expect(await roles(t, alex)).toEqual({ "acme/widgets": "admin" });

    vi.advanceTimersByTime(5 * MINUTE);
    await t.action(api.viewer.refresh, { signIn: alex });

    expect(await roles(t, alex)).toEqual({ "acme/gadgets": "triage", "acme/widgets": "read" });
  });

  it("hides a factory once the forge no longer lets the viewer read its repository", async () => {
    const forge = fakeForge();
    const { t, alex } = await signedIn(forge);

    forge.grant("acme/widgets", "alex", null);
    vi.advanceTimersByTime(5 * MINUTE);
    await t.action(api.viewer.refresh, { signIn: alex });

    expect(await roles(t, alex)).toEqual({});
  });

  it("renews the viewer's access token after its eight hours, with the refresh token", async () => {
    const forge = fakeForge();
    const { t, alex } = await signedIn(forge);
    forge.grant("acme/gadgets", "alex", "write");

    vi.advanceTimersByTime(USER_TOKEN_HOURS * HOUR + 1);
    const mark = forge.requests.length;
    await t.action(api.viewer.refresh, { signIn: alex });

    expect(forge.since(mark)[0]).toBe("POST /login/oauth/access_token → 200");
    expect(await roles(t, alex)).toEqual({ "acme/gadgets": "write", "acme/widgets": "admin" });

    // And again, eight hours on: each renewal brings the next refresh token.
    forge.grant("acme/gadgets", "alex", null);
    vi.advanceTimersByTime(USER_TOKEN_HOURS * HOUR + 1);
    await t.action(api.viewer.refresh, { signIn: alex });
    expect(await roles(t, alex)).toEqual({ "acme/widgets": "admin" });
  });

  it("signs the viewer out when the forge will not renew their tokens", async () => {
    const forge = fakeForge();
    const { t, alex } = await signedIn(forge);

    forge.revoke("alex");
    vi.advanceTimersByTime(USER_TOKEN_HOURS * HOUR + 1);
    await t.action(api.viewer.refresh, { signIn: alex });

    expect((await t.query(api.viewer.me, { signIn: alex })).viewer).toBeNull();
    expect(await roles(t, alex)).toBeNull();
  });

  it("signs the viewer out when the forge no longer takes their token", async () => {
    const forge = fakeForge();
    const { t, alex } = await signedIn(forge);

    forge.revoke("alex");
    vi.advanceTimersByTime(5 * MINUTE);
    await t.action(api.viewer.refresh, { signIn: alex });

    expect((await t.query(api.viewer.me, { signIn: alex })).viewer).toBeNull();
  });

  it("shows nothing on a word older than fifteen minutes, until the forge is asked again", async () => {
    const forge = fakeForge();
    const { t, alex } = await signedIn(forge);
    const sessions = async () => (await t.query(api.sessions.list, { signIn: alex })).length;
    await ingest(t, await factory(t, "acme/widgets"), { session: "5c0075aa", events: [fixture("session_started", 1)] });
    expect(await sessions()).toBe(1);

    // Nobody asked: a browser that stopped refreshing, or someone calling the functions directly.
    forge.grant("acme/widgets", "alex", null);
    vi.advanceTimersByTime(15 * MINUTE);

    expect(await roles(t, alex)).toEqual({});
    expect(await sessions()).toBe(0);
    expect((await t.query(api.viewer.me, { signIn: alex })).viewer).toMatchObject({ login: "alex", reachKnown: false });

    forge.grant("acme/widgets", "alex", "read");
    await t.action(api.viewer.refresh, { signIn: alex });
    expect(await roles(t, alex)).toEqual({ "acme/widgets": "read" });
    expect(await sessions()).toBe(1);
    expect((await t.query(api.viewer.me, { signIn: alex })).viewer?.reachKnown).toBe(true);
  });

  it("shows nothing it cannot confirm while the forge cannot be reached, and signs nobody out over it", async () => {
    const forge = fakeForge();
    const { t, alex } = await signedIn(forge);

    forge.down = true;
    vi.advanceTimersByTime(USER_TOKEN_HOURS * HOUR + 1);
    await t.action(api.viewer.refresh, { signIn: alex });

    expect(await roles(t, alex)).toEqual({});
    expect((await t.query(api.viewer.me, { signIn: alex })).viewer?.login).toBe("alex");

    forge.down = false;
    vi.advanceTimersByTime(MINUTE);
    await t.action(api.viewer.refresh, { signIn: alex });
    expect(await roles(t, alex)).toEqual({ "acme/widgets": "admin" });
  });

  it("is asked once when two of the viewer's tabs ask at the same moment", async () => {
    const forge = fakeForge();
    const { t, alex } = await signedIn(forge);

    vi.advanceTimersByTime(USER_TOKEN_HOURS * HOUR + 1);
    const mark = forge.requests.length;
    await Promise.all([
      t.action(api.viewer.refresh, { signIn: alex }),
      t.action(api.viewer.refresh, { signIn: alex }),
    ]);

    // A refresh token works once: a second renewal with it would sign the viewer out.
    expect(forge.since(mark).filter((line) => line.startsWith("POST /login/oauth/access_token"))).toHaveLength(1);
    expect((await t.query(api.viewer.me, { signIn: alex })).viewer?.login).toBe("alex");
  });
});
