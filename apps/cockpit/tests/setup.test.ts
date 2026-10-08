import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { catchUp, cockpit, signIn, team } from "./helpers";
import { APP_URL, fakeForge, SITE_URL, teamMode } from "./forge";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const ASKED = { host: "github.com", organization: "acme", appUrl: APP_URL };

describe("setting up a team cockpit", () => {
  it("has no forge until an admin registers a GitHub App", async () => {
    fakeForge();
    teamMode();
    const t = cockpit();

    expect(await t.query(api.viewer.me, {})).toEqual({
      mode: "team", forge: { host: "", ready: false, app: null }, viewer: null,
    });
  });

  it("walks the manifest flow, and keeps the key and secrets GitHub hands back", async () => {
    const forge = fakeForge();
    teamMode();
    const t = cockpit();

    const begun = await t.action(api.setup.begin, { code: await t.action(internal.setup.code, {}), ...ASKED });

    // Where the admin's browser posts the manifest, and what GitHub will call back.
    expect(begun.url).toBe(`https://github.com/organizations/acme/settings/apps/new?state=${begun.state}`);
    expect(JSON.parse(begun.manifest)).toMatchObject({
      name: "asf-cockpit-acme",
      url: APP_URL,
      public: false,
      redirect_url: `${APP_URL}/setup/callback`,
      callback_urls: [`${APP_URL}/auth/callback`],
      hook_attributes: { url: `${SITE_URL}/forge/webhook`, active: true },
    });

    const registered = await t.action(api.setup.complete, { code: await forge.register(begun), state: begun.state });

    const app = { slug: "asf-cockpit-acme", installUrl: "https://github.com/apps/asf-cockpit-acme/installations/new" };
    expect(registered).toEqual(app);
    const me = await t.query(api.viewer.me, {});
    expect(me.forge).toEqual({ host: "github.com", ready: true, app });
    // Kept, and never handed to a browser.
    const shown = JSON.stringify([registered, me]);
    for (const secret of [forge.app!.clientSecret, forge.app!.webhookSecret, "PRIVATE KEY"]) {
      expect(shown).not.toContain(secret);
    }
  });

  it("begins only for a setup code this deployment printed, and only once", async () => {
    fakeForge();
    teamMode();
    const t = cockpit();
    await expect(t.action(api.setup.begin, { code: "asf_setup_guess", ...ASKED })).rejects.toThrow(/not a setup code/);

    const code = await t.action(internal.setup.code, {});
    await t.action(api.setup.begin, { code, ...ASKED });
    await expect(t.action(api.setup.begin, { code, ...ASKED })).rejects.toThrow(/not a setup code/);
  });

  it("lets a setup code run out after an hour", async () => {
    fakeForge();
    teamMode();
    const t = cockpit();
    const code = await t.action(internal.setup.code, {});

    vi.advanceTimersByTime(3600_000 + 1);

    await expect(t.action(api.setup.begin, { code, ...ASKED })).rejects.toThrow(/not a setup code/);
  });

  it("completes only a registration it began", async () => {
    const forge = fakeForge();
    teamMode();
    const t = cockpit();
    const begun = await t.action(api.setup.begin, { code: await t.action(internal.setup.code, {}), ...ASKED });
    const code = await forge.register(begun);

    await expect(t.action(api.setup.complete, { code, state: "not-the-state" })).rejects.toThrow(/not begun here/);
    expect((await t.query(api.viewer.me, {})).forge.ready).toBe(false);
  });

  it("says so when GitHub does not know the code it is asked to convert", async () => {
    fakeForge();
    teamMode();
    const t = cockpit();
    const begun = await t.action(api.setup.begin, { code: await t.action(internal.setup.code, {}), ...ASKED });

    await expect(t.action(api.setup.complete, { code: "stale", state: begun.state }))
      .rejects.toThrow(/did not convert the manifest code \(404\)/);
  });

  it("registers without a webhook where GitHub could not deliver one, and finds changes by asking", async () => {
    const forge = fakeForge();
    forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    teamMode();
    // A cockpit on someone's machine, or behind a firewall: GitHub refuses a manifest with such a webhook.
    vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
    const t = cockpit();
    expect(await t.query(api.setup.webhook, {})).toEqual({ url: "http://127.0.0.1:3211/forge/webhook", deliverable: false });

    const begun = await t.action(api.setup.begin, {
      code: await t.action(internal.setup.code, {}), host: "github.com", organization: "acme", appUrl: "http://localhost:3000",
    });
    const manifest = JSON.parse(begun.manifest);
    expect(manifest).not.toHaveProperty("hook_attributes");
    expect(manifest).not.toHaveProperty("default_events");
    expect(manifest.callback_urls).toEqual(["http://localhost:3000/auth/callback"]);
    await t.action(api.setup.complete, { code: await forge.register(begun), state: begun.state });

    // No secret, so no delivery is ever taken for the App's — not one signed with the text of a missing one.
    for (const secret of ["null", "undefined"]) {
      const delivery = await forge.delivery("push", forge.pushed("acme/widgets"), secret);
      const response = await t.fetch("/forge/webhook", { method: "POST", headers: delivery.headers, body: delivery.body });
      expect(response.status).toBe(401);
    }
    // The poll is what it learns by.
    forge.install("acme");
    await catchUp(t);
    const list = await t.query(api.factories.list, { signIn: await signIn(t, forge, "alex") });
    expect(list?.factories.map((factory) => factory.repo)).toEqual(["acme/widgets"]);
  });

  it("says its webhook can be delivered to when the backend's site is on the public internet", async () => {
    fakeForge();
    teamMode();
    const t = cockpit();

    expect(await t.query(api.setup.webhook, {})).toEqual({ url: `${SITE_URL}/forge/webhook`, deliverable: true });
  });

  it("says where its setup code is printed: a Convex Cloud deployment's dashboard, else the compose file's container", async () => {
    fakeForge();
    teamMode();
    const t = cockpit();
    expect(await t.query(api.setup.deployment, {})).toEqual({ site: SITE_URL, cloud: null });

    vi.stubEnv("CONVEX_SITE_URL", "https://happy-otter-123.convex.site/");
    expect(await t.query(api.setup.deployment, {})).toEqual({
      site: "https://happy-otter-123.convex.site",
      cloud: { name: "happy-otter-123", functions: "https://dashboard.convex.dev/d/happy-otter-123/functions" },
    });
    vi.stubEnv("CONVEX_SITE_URL", "https://quiet-fox-9.eu-west-1.convex.site");
    expect((await t.query(api.setup.deployment, {})).cloud?.name).toBe("quiet-fox-9");
    vi.stubEnv("CONVEX_SITE_URL", "https://cockpit.convex.site.example.com");
    expect((await t.query(api.setup.deployment, {})).cloud).toBeNull();
  });

  it("registers on an Enterprise Server under the admin's own account, naming no other host", async () => {
    const forge = fakeForge("ghe.acme.test");
    teamMode();
    const t = cockpit();

    const begun = await t.action(api.setup.begin, {
      code: await t.action(internal.setup.code, {}), host: "ghe.acme.test", organization: "", appUrl: APP_URL,
    });
    expect(begun.url).toBe(`https://ghe.acme.test/settings/apps/new?state=${begun.state}`);
    await t.action(api.setup.complete, { code: await forge.register(begun), state: begun.state });

    expect(forge.since(0)).toEqual([expect.stringMatching(/^POST \/api\/v3\/app-manifests\/.+\/conversions → 201$/)]);
    expect((await t.query(api.viewer.me, {})).forge).toEqual({
      host: "ghe.acme.test", ready: true,
      app: { slug: "asf-cockpit", installUrl: "https://ghe.acme.test/apps/asf-cockpit/installations/new" },
    });
  });

  it("refuses a host, an organization or an address that is not one", async () => {
    fakeForge();
    teamMode();
    const t = cockpit();
    const code = await t.action(internal.setup.code, {});

    await expect(t.action(api.setup.begin, { code, ...ASKED, host: "github.com/evil" })).rejects.toThrow(/not a host name/);
    await expect(t.action(api.setup.begin, { code, ...ASKED, organization: "acme/../x" })).rejects.toThrow(/not an organization/);
    await expect(t.action(api.setup.begin, { code, ...ASKED, appUrl: "javascript:alert(1)" })).rejects.toThrow(/not where this cockpit is served/);
    // None of those spent the code.
    await t.action(api.setup.begin, { code, ...ASKED });
  });

  it("registers again for a fresh setup code, replacing the App and signing everyone out", async () => {
    const forge = fakeForge();
    forge.person("alex");
    forge.repo("acme-labs/widgets", { factory: true, roles: { alex: "write" } });
    const t = cockpit();
    await team(t, forge, "acme");
    const before = await signIn(t, forge, "alex");

    await team(t, forge, "acme-labs");

    expect((await t.query(api.viewer.me, { signIn: before })).viewer).toBeNull();
    expect((await t.query(api.viewer.me, {})).forge.app?.slug).toBe("asf-cockpit-acme-labs");
    // The new App is the one the cockpit now asks as.
    forge.install("acme-labs");
    await catchUp(t);
    const list = await t.query(api.factories.list, { signIn: await signIn(t, forge, "alex") });
    expect(list?.factories.map((factory) => factory.repo)).toEqual(["acme-labs/widgets"]);
  });
});
