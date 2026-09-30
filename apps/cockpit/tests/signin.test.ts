import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { catchUp, cockpit, signIn, team } from "./helpers";
import { fakeForge, localMode } from "./forge";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("signing in to a team cockpit", () => {
  it("sends a person to the team's App, and knows them by their forge login when they come back", async () => {
    const forge = fakeForge();
    forge.person("alex");
    const t = cockpit();
    await team(t, forge);

    const started = await t.action(api.auth.start, {});
    expect(started.url).toBe(
      `https://github.com/login/oauth/authorize?client_id=${forge.app!.clientId}&state=${started.state}`);
    const holding = await t.action(api.auth.finish, { code: forge.authorize("alex"), state: started.state });

    expect((await t.query(api.viewer.me, { signIn: holding })).viewer).toEqual({
      login: "alex", name: "Alex", avatarUrl: "https://github.com/avatars/alex", reachKnown: true,
    });
    expect((await t.query(api.viewer.me, {})).viewer).toBeNull();
    expect((await t.query(api.viewer.me, { signIn: "asf_signin_guess" })).viewer).toBeNull();
  });

  it("finishes only a sign-in it started, and only with a code the forge gave", async () => {
    const forge = fakeForge();
    forge.person("alex");
    const t = cockpit();
    await team(t, forge);

    await expect(t.action(api.auth.finish, { code: forge.authorize("alex"), state: "made-up" }))
      .rejects.toThrow(/not started here/);

    const { state } = await t.action(api.auth.start, {});
    await expect(t.action(api.auth.finish, { code: "guessed", state })).rejects.toThrow(/refused the sign-in/);
    // The state went with the attempt: a second try starts again.
    await expect(t.action(api.auth.finish, { code: forge.authorize("alex"), state })).rejects.toThrow(/not started here/);
  });

  it("gives up on a sign-in left waiting on the forge's page", async () => {
    const forge = fakeForge();
    forge.person("alex");
    const t = cockpit();
    await team(t, forge);
    const { state } = await t.action(api.auth.start, {});

    vi.advanceTimersByTime(10 * 60_000 + 1);

    await expect(t.action(api.auth.finish, { code: forge.authorize("alex"), state })).rejects.toThrow(/took too long/);
  });

  it("signs a browser out, and lets a sign-in lapse after thirty days", async () => {
    const forge = fakeForge();
    forge.person("alex");
    const t = cockpit();
    await team(t, forge);
    const laptop = await signIn(t, forge, "alex");
    const phone = await signIn(t, forge, "alex");

    await t.mutation(api.auth.signOut, { signIn: laptop });

    expect((await t.query(api.viewer.me, { signIn: laptop })).viewer).toBeNull();
    expect((await t.query(api.viewer.me, { signIn: phone })).viewer?.login).toBe("alex");

    vi.advanceTimersByTime(30 * 24 * 3600_000 + 1);
    expect((await t.query(api.viewer.me, { signIn: phone })).viewer).toBeNull();
  });

  it("cannot be started before an App is registered", async () => {
    fakeForge();
    const t = cockpit();
    await expect(t.action(api.auth.start, {})).rejects.toThrow(/no GitHub App is registered/);
  });
});

describe("a local cockpit", () => {
  it("needs no sign-in: the viewer is whoever its token belongs to", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    const t = cockpit();
    expect(await t.query(api.viewer.me, {})).toEqual({
      mode: "local", forge: { host: "github.com", ready: true, app: null }, viewer: null,
    });

    await catchUp(t);

    expect((await t.query(api.viewer.me, {})).viewer).toEqual({
      login: "alex", name: "Alex", avatarUrl: "https://github.com/avatars/alex", reachKnown: true,
    });
    await expect(t.action(api.auth.start, {})).rejects.toThrow(/a local cockpit has no sign-in/);
  });

  it("says when it holds no token to ask the forge with", async () => {
    const forge = fakeForge();
    localMode(forge, null);
    const t = cockpit();

    expect((await t.query(api.viewer.me, {})).forge).toEqual({ host: "github.com", ready: false, app: null });
  });

  it("has one viewer at a time: whoever the token belongs to now", async () => {
    const forge = fakeForge();
    const alex = forge.person("alex");
    const sam = forge.person("sam");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin", sam: "read" } });
    localMode(forge, alex);
    const t = cockpit();
    await catchUp(t);

    vi.stubEnv("COCKPIT_FORGE_TOKEN", sam);
    await catchUp(t);
    expect((await t.query(api.viewer.me, {})).viewer?.login).toBe("sam");
    expect((await t.query(api.factories.list, {}))?.factories[0].role).toBe("read");

    vi.stubEnv("COCKPIT_FORGE_TOKEN", alex);
    await catchUp(t);
    expect((await t.query(api.viewer.me, {})).viewer?.login).toBe("alex");
    expect((await t.query(api.factories.list, {}))?.factories[0].role).toBe("admin");
  });
});
