import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { catchUp, cockpit, factory, fixture, ingest } from "./helpers";
import { FACTORY_FILE, fakeForge, localMode } from "./forge";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the Factories list in local mode, with the person's own token", () => {
  it("shows the repositories the token reaches whose default branch holds a factory", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    forge.repo("acme/docs", { roles: { alex: "write" } });
    forge.repo("other/secret", { factory: true });
    localMode(forge, token);
    const t = cockpit();

    await catchUp(t);

    const list = await t.query(api.factories.list, {});
    expect(list?.factories.map((factory) => factory.repo)).toEqual(["acme/widgets"]);
  });

  it("says what the person may do on each, and which no station has reported yet", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    forge.repo("acme/gadgets", { factory: true, private: false, roles: { alex: "triage" } });
    localMode(forge, token);
    const t = cockpit();
    const station = await factory(t, "acme/widgets");
    await ingest(t, station, { session: "5c0075aa", events: [fixture("session_started", 1)] });

    await catchUp(t);

    const list = await t.query(api.factories.list, {});
    expect(list?.factories).toEqual([
      { repo: "acme/gadgets", role: "triage", private: false, onForge: true, reporting: false, lastActivity: null },
      { repo: "acme/widgets", role: "admin", private: true, onForge: true, reporting: true,
        lastActivity: expect.any(Number) },
    ]);
  });

  it("asks again with ETags, so a poll that finds nothing changed is all 304s and no second look", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    forge.repo("acme/docs", { roles: { alex: "write" } });
    localMode(forge, token);
    const t = cockpit();
    await catchUp(t);
    const mark = forge.requests.length;

    await catchUp(t);

    expect(forge.since(mark)).toEqual([
      "GET /user/repos?per_page=100&sort=full_name → 304",
      "GET /user → 304",
    ]);
    const list = await t.query(api.factories.list, {});
    expect(list?.factories.map((factory) => factory.repo)).toEqual(["acme/widgets"]);
  });

  it("sees a factory appear and go at the next poll, looking again only at the repository that moved", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    forge.repo("acme/docs", { roles: { alex: "write" } });
    localMode(forge, token);
    const t = cockpit();
    await catchUp(t);

    forge.push("acme/docs", { add: [FACTORY_FILE] });
    const mark = forge.requests.length;
    await catchUp(t);

    expect(forge.since(mark)).toEqual([
      "GET /user/repos?per_page=100&sort=full_name → 200",
      "GET /user → 304",
      "HEAD /repos/acme/docs/contents/asf/factory.yaml → 200",
    ]);
    expect((await t.query(api.factories.list, {}))?.factories.map((factory) => factory.repo))
      .toEqual(["acme/docs", "acme/widgets"]);

    forge.push("acme/widgets", { remove: [FACTORY_FILE] });
    await catchUp(t);

    expect((await t.query(api.factories.list, {}))?.factories.map((factory) => factory.repo))
      .toEqual(["acme/docs"]);
  });

  it("drops a factory the token no longer reaches", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    forge.repo("acme/gadgets", { factory: true, roles: { alex: "read" } });
    localMode(forge, token);
    const t = cockpit();
    await catchUp(t);

    forge.grant("acme/gadgets", "alex", null);
    await catchUp(t);

    expect((await t.query(api.factories.list, {}))?.factories.map((factory) => factory.repo))
      .toEqual(["acme/widgets"]);
  });

  it("reads a listing longer than one page", async () => {
    const forge = fakeForge();
    forge.pageSize = 2;
    const token = forge.person("alex");
    for (const name of ["a", "b", "c", "d", "e"]) {
      forge.repo(`acme/${name}`, { factory: name !== "c", roles: { alex: "write" } });
    }
    localMode(forge, token);
    const t = cockpit();

    await catchUp(t);

    expect((await t.query(api.factories.list, {}))?.factories.map((factory) => factory.repo))
      .toEqual(["acme/a", "acme/b", "acme/d", "acme/e"]);
  });

  it("takes a repository the listing names twice, on two pages, as the one it is", async () => {
    const forge = fakeForge();
    forge.pageSize = 2;
    forge.stutter = true;
    const token = forge.person("alex");
    for (const name of ["a", "b", "c", "d"]) forge.repo(`acme/${name}`, { factory: true, roles: { alex: "write" } });
    localMode(forge, token);
    const t = cockpit();

    await catchUp(t);
    await catchUp(t);

    expect((await t.query(api.factories.list, {}))?.factories.map((factory) => factory.repo))
      .toEqual(["acme/a", "acme/b", "acme/c", "acme/d"]);
  });

  it("keeps up with more repositories than one transaction, or one look, takes", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    const names = Array.from({ length: 450 }, (_, index) => `acme/r${String(index).padStart(3, "0")}`);
    for (const name of names) forge.repo(name, { factory: true, roles: { alex: "read" } });
    localMode(forge, token);
    const t = cockpit();

    await catchUp(t);
    expect((await t.query(api.factories.list, {}))?.factories.map((factory) => factory.repo)).toEqual(names);

    for (const name of names.slice(100, 350)) forge.grant(name, "alex", null);
    await catchUp(t);
    expect((await t.query(api.factories.list, {}))?.factories.map((factory) => factory.repo))
      .toEqual([...names.slice(0, 100), ...names.slice(350)]);
  });

  it("takes a repository the forge will not show as no factory, and looks at the rest", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    for (const name of ["acme/a", "acme/b", "acme/c"]) forge.repo(name, { factory: true, roles: { alex: "read" } });
    forge.refusing.set("acme/b", { status: 403, message: "Resource protected by organization SAML enforcement." });
    localMode(forge, token);
    const t = cockpit();

    await catchUp(t);

    const list = await t.query(api.factories.list, {});
    expect(list?.factories.map((factory) => factory.repo)).toEqual(["acme/a", "acme/c"]);
    expect(list?.discovery).toMatchObject({ pending: 0, problem: "" });
  });

  it("waits a minute on a secondary rate limit that names no wait, rather than take it for a no", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    for (const name of ["acme/a", "acme/b", "acme/c"]) forge.repo(name, { factory: true, roles: { alex: "read" } });
    forge.refusing.set("acme/b", { status: 403, message: "You have exceeded a secondary rate limit. Please wait." });
    localMode(forge, token);
    const t = cockpit();
    const now = Date.now();

    await catchUp(t);

    const held = await t.query(api.factories.list, {});
    expect(held?.factories.map((factory) => factory.repo)).toEqual(["acme/a"]);
    expect(held?.discovery).toMatchObject({ pending: 2, pausedUntil: now + 60_000 });

    forge.refusing.clear();
    vi.advanceTimersByTime(60_001);
    await catchUp(t);
    expect((await t.query(api.factories.list, {}))?.factories.map((factory) => factory.repo))
      .toEqual(["acme/a", "acme/b", "acme/c"]);
  });

  it("sees a listing grow past a page that was exactly full, whatever the forge's ETag covers", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    const names = Array.from({ length: 100 }, (_, index) => `acme/r${String(index).padStart(3, "0")}`);
    for (const name of names) forge.repo(name, { roles: { alex: "read" } });
    localMode(forge, token);
    const t = cockpit();
    await catchUp(t);

    forge.repo("acme/zz-new", { factory: true, roles: { alex: "read" } });
    await catchUp(t);

    expect((await t.query(api.factories.list, {}))?.factories.map((factory) => factory.repo)).toEqual(["acme/zz-new"]);
  });

  it("knows a factory by its repository whatever case a station ships it under", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    forge.repo("Acme/Widgets", { factory: true, roles: { alex: "admin" } });
    localMode(forge, token);
    const t = cockpit();
    await ingest(t, await factory(t, "acme/widgets"), { session: "5c0075aa", events: [fixture("session_started", 1)] });

    await catchUp(t);

    expect((await t.query(api.factories.list, {}))?.factories).toEqual([
      { repo: "Acme/Widgets", role: "admin", private: true, onForge: true, reporting: true,
        lastActivity: expect.any(Number) },
    ]);
  });

  it("leaves a repository to be asked about again when the forge fails on it", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    for (const name of ["acme/a", "acme/b"]) forge.repo(name, { factory: true, roles: { alex: "read" } });
    forge.refusing.set("acme/b", { status: 502, message: "Server Error" });
    localMode(forge, token);
    const t = cockpit();

    await catchUp(t);
    expect((await t.query(api.factories.list, {}))?.discovery).toMatchObject({
      pending: 1, problem: expect.stringMatching(/502/),
    });

    forge.refusing.clear();
    await catchUp(t);
    const list = await t.query(api.factories.list, {});
    expect(list?.factories.map((factory) => factory.repo)).toEqual(["acme/a", "acme/b"]);
    expect(list?.discovery).toMatchObject({ pending: 0, problem: "" });
  });

  it("keeps a factory its stations ship from in the list when the forge shows none there", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    localMode(forge, token);
    const t = cockpit();
    await ingest(t, await factory(t, "scratch"), { session: "5c0075aa", events: [fixture("session_started", 1)] });

    await catchUp(t);

    expect((await t.query(api.factories.list, {}))?.factories).toEqual([
      { repo: "acme/widgets", role: "admin", private: true, onForge: true, reporting: false, lastActivity: null },
      { repo: "scratch", role: null, private: null, onForge: false, reporting: true,
        lastActivity: expect.any(Number) },
    ]);
  });

  it("asks the forge nothing without a token, and still lists what its stations ship", async () => {
    const forge = fakeForge();
    forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    localMode(forge, null);
    const t = cockpit();
    await ingest(t, await factory(t, "acme/widgets"), { session: "5c0075aa", events: [fixture("session_started", 1)] });

    await catchUp(t);

    expect(forge.requests).toEqual([]);
    expect((await t.query(api.factories.list, {}))?.factories).toEqual([
      { repo: "acme/widgets", role: null, private: null, onForge: false, reporting: true,
        lastActivity: expect.any(Number) },
    ]);
  });
});

describe("the catch-up poll and the forge's rate limit", () => {
  const names = ["a", "b", "c", "d", "e", "f"];

  it("stops short of spending the budget, says until when, and carries on once it resets", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    for (const name of names) forge.repo(`acme/${name}`, { factory: true, roles: { alex: "write" } });
    const reset = Math.floor(Date.now() / 1000) + 3600;
    forge.limit = { limit: 20, remaining: 8, reset };
    localMode(forge, token);
    const t = cockpit();

    await catchUp(t);

    // A quarter of the budget is left alone: it is the person's own, and their factory's.
    expect(forge.limit.remaining).toBe(5);
    const held = await t.query(api.factories.list, {});
    expect(held?.factories.map((factory) => factory.repo)).toEqual(["acme/a"]);
    expect(held?.discovery).toMatchObject({ pending: 5, pausedUntil: reset * 1000 });

    const mark = forge.requests.length;
    await catchUp(t);
    expect(forge.since(mark)).toEqual([]);

    vi.setSystemTime(reset * 1000 + 1000);
    forge.limit = { limit: 20, remaining: 20, reset: reset + 3600 };
    await catchUp(t);

    const after = await t.query(api.factories.list, {});
    expect(after?.factories.map((factory) => factory.repo)).toEqual(names.map((name) => `acme/${name}`));
    expect(after?.discovery).toMatchObject({ pending: 0, pausedUntil: null });
  });

  it("waits out a limit the forge says is spent, even one its headers never warned of", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "write" } });
    const reset = Math.floor(Date.now() / 1000) + 600;
    forge.limit = { limit: 5000, remaining: 0, reset };
    localMode(forge, token);
    const t = cockpit();

    await catchUp(t);

    const list = await t.query(api.factories.list, {});
    expect(list?.factories).toEqual([]);
    expect(list?.discovery).toMatchObject({ listedAt: null, pausedUntil: reset * 1000 });
  });

  it("is never held back by an Enterprise Server that sends no limit at all", async () => {
    const forge = fakeForge("ghe.acme.test");
    const token = forge.person("alex");
    for (const name of names) forge.repo(`acme/${name}`, { factory: true, roles: { alex: "write" } });
    localMode(forge, token);
    const t = cockpit();

    await catchUp(t);

    expect(forge.requests[0].path).toBe("/api/v3/user/repos?per_page=100&sort=full_name");
    const list = await t.query(api.factories.list, {});
    expect(list?.factories).toHaveLength(names.length);
    expect(list?.discovery).toMatchObject({ pending: 0, pausedUntil: null, listedAt: expect.any(Number) });
  });

  it("says what the forge refused, and keeps what it knew", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "write" } });
    localMode(forge, token);
    const t = cockpit();
    await catchUp(t);

    vi.stubEnv("COCKPIT_FORGE_TOKEN", "gho_revoked");
    await catchUp(t);

    const list = await t.query(api.factories.list, {});
    expect(list?.factories.map((factory) => factory.repo)).toEqual(["acme/widgets"]);
    expect(list?.discovery.problem).toMatch(/401.*Bad credentials/);
  });

  it("says when the forge cannot be reached, and keeps what it knew", async () => {
    const forge = fakeForge();
    const token = forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "write" } });
    localMode(forge, token);
    const t = cockpit();
    await catchUp(t);

    forge.down = true;
    await catchUp(t);

    const list = await t.query(api.factories.list, {});
    expect(list?.factories.map((factory) => factory.repo)).toEqual(["acme/widgets"]);
    expect(list?.discovery.problem).toBe("github.com could not be reached: fetch failed");

    forge.down = false;
    await catchUp(t);
    expect((await t.query(api.factories.list, {}))?.discovery.problem).toBe("");
  });

  it("forgets what the forge refused once it holds no token to have been refused", async () => {
    const forge = fakeForge();
    forge.person("alex");
    localMode(forge, "gho_revoked");
    const t = cockpit();
    await catchUp(t);
    expect((await t.query(api.factories.list, {}))?.discovery.problem).toMatch(/401/);

    vi.stubEnv("COCKPIT_FORGE_TOKEN", "");
    await catchUp(t);

    expect((await t.query(api.factories.list, {}))?.discovery.problem).toBe("");
  });
});
