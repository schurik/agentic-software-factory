import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { catchUp, cockpit, signIn, team } from "./helpers";
import { APP_URL, type FakeForge, fakeForge, SITE_URL, teamMode } from "./forge";

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
    // Its settings page, too: the one place GitHub takes a logo for it.
    expect(registered).toEqual({ ...app, settingsUrl: "https://github.com/organizations/acme/settings/apps/asf-cockpit-acme" });
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
    const registered = await t.action(api.setup.complete, { code: await forge.register(begun), state: begun.state });
    expect(registered.settingsUrl).toBe("https://ghe.acme.test/settings/apps/asf-cockpit");

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

describe("taking on an App the account already registered", () => {
  // Another cockpit's pages and site: where the account sets up a second one, or moves the first.
  const PAGES = "https://cockpit.acme.dev";
  const SITE = "https://site.cockpit.acme.dev";

  /**
   * The App a cockpit before this one registered — with a webhook, or (`webhook: false`)
   * from a machine GitHub could not deliver to — installed on acme's repositories; and
   * what its settings page hands over for another cockpit: a client secret generated
   * beside the one in use, and a private key.
   */
  async function registeredBefore(forge: FakeForge, { webhook = true } = {}) {
    teamMode();
    if (!webhook) vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
    const before = cockpit();
    const begun = await before.action(api.setup.begin, { code: await before.action(internal.setup.code, {}), ...ASKED });
    await before.action(api.setup.complete, { code: await forge.register(begun), state: begun.state });
    forge.install("acme");
    vi.stubEnv("CONVEX_SITE_URL", SITE);
    return {
      host: forge.host, appId: String(forge.app!.id), clientSecret: forge.clientSecret(),
      privateKey: forge.app!.pem, appUrl: PAGES,
    };
  }

  const push = async (t: ReturnType<typeof cockpit>, forge: FakeForge, secret?: string) => {
    const delivery = await forge.delivery("push", forge.pushed("acme/widgets"), secret);
    return (await t.fetch("/forge/webhook", { method: "POST", headers: delivery.headers, body: delivery.body })).status;
  };

  it("takes it on where it is installed, registering no second App, and points its webhook here", async () => {
    const forge = fakeForge();
    forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "write" } });
    const given = await registeredBefore(forge);
    const theirs = forge.app!.webhookSecret!;
    const t = cockpit();
    const mark = forge.requests.length;

    const adopted = await t.action(api.setup.adopt, { code: await t.action(internal.setup.code, {}), ...given });

    expect(adopted).toEqual({
      slug: "asf-cockpit-acme",
      installUrl: "https://github.com/apps/asf-cockpit-acme/installations/new",
      settingsUrl: "https://github.com/organizations/acme/settings/apps/asf-cockpit-acme",
      callbackUrl: `${PAGES}/auth/callback`,
      webhook: true,
    });
    // Asked as the App itself, and nothing converted: the App is the one there was.
    expect(forge.since(mark)).toEqual(["GET /app → 200", "PATCH /app/hook/config → 200"]);
    expect(forge.app!.hook).toBe(`${SITE}/forge/webhook`);
    expect((await t.query(api.viewer.me, {})).forge).toEqual({
      host: "github.com", ready: true,
      app: { slug: "asf-cockpit-acme", installUrl: "https://github.com/apps/asf-cockpit-acme/installations/new" },
    });

    // A sign-in comes back here, not to the App's first callback URL, which is the other cockpit's.
    const started = await t.action(api.auth.start, {});
    expect(new URL(started.url).searchParams.get("redirect_uri")).toBe(`${PAGES}/auth/callback`);
    // And sees what the App was installed on before: nothing is installed again.
    await catchUp(t);
    const list = await t.query(api.factories.list, { signIn: await signIn(t, forge, "alex") });
    expect(list?.factories.map((factory) => factory.repo)).toEqual(["acme/widgets"]);

    // Deliveries are signed with a secret only this cockpit holds; the one before is refused.
    expect(await push(t, forge)).toBe(202);
    expect(await push(t, forge, theirs)).toBe(401);
    expect(JSON.stringify(adopted)).not.toContain(forge.app!.webhookSecret!);
  });

  it("asks GitHub nothing for a setup code this deployment did not print", async () => {
    const forge = fakeForge();
    const given = await registeredBefore(forge);
    const t = cockpit();
    const mark = forge.requests.length;

    await expect(t.action(api.setup.adopt, { code: "asf_setup_guess", ...given })).rejects.toThrow(/not a setup code/);
    expect(forge.since(mark)).toEqual([]);
  });

  it("keeps nothing for an App ID, a key or a secret that is not one, and keeps the setup code", async () => {
    const forge = fakeForge();
    const given = await registeredBefore(forge);
    const t = cockpit();
    const code = await t.action(internal.setup.code, {});

    await expect(t.action(api.setup.adopt, { code, ...given, appId: "acme" })).rejects.toThrow(/"acme" is not an App ID/);
    await expect(t.action(api.setup.adopt, { code, ...given, clientSecret: " " })).rejects.toThrow(/client secret/);
    await expect(t.action(api.setup.adopt, { code, ...given, privateKey: "ssh-rsa AAAAB3Nza" })).rejects.toThrow(/not a private key/);
    await expect(t.action(api.setup.adopt, { code, ...given, appId: "4242" }))
      .rejects.toThrow(/github\.com did not take App 4242's ID and private key \(401\)/);
    expect((await t.query(api.viewer.me, {})).forge.ready).toBe(false);

    // None of those spent the code; taking the App on does, once.
    await t.action(api.setup.adopt, { code, ...given });
    expect((await t.query(api.viewer.me, {})).forge.ready).toBe(true);
    await expect(t.action(api.setup.adopt, { code, ...given })).rejects.toThrow(/not a setup code/);
  });

  it("leaves the webhook where it is when GitHub could not deliver here, and learns by the poll", async () => {
    const forge = fakeForge();
    forge.repo("acme/widgets", { factory: true });
    const given = await registeredBefore(forge);
    const theirs = forge.app!.hook;
    vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
    const t = cockpit();
    const mark = forge.requests.length;

    const adopted = await t.action(api.setup.adopt, {
      code: await t.action(internal.setup.code, {}), ...given, appUrl: "http://localhost:3000",
    });

    expect(adopted.webhook).toBe(false);
    expect(adopted.callbackUrl).toBe("http://localhost:3000/auth/callback");
    expect(forge.since(mark)).toEqual(["GET /app → 200"]);
    expect(forge.app!.hook).toBe(theirs);
    // No secret of its own, so no delivery is taken: not even one signed with the other cockpit's.
    expect(await push(t, forge)).toBe(401);
  });

  it("leaves alone the webhook of an App registered without one, which subscribes to no events", async () => {
    const forge = fakeForge();
    forge.repo("acme/widgets", { factory: true });
    const given = await registeredBefore(forge, { webhook: false });
    const t = cockpit();
    const mark = forge.requests.length;

    const adopted = await t.action(api.setup.adopt, { code: await t.action(internal.setup.code, {}), ...given });

    expect(adopted.webhook).toBe(false);
    expect(forge.since(mark)).toEqual(["GET /app → 200"]);
    expect(forge.app!.hook).toBeNull();
    // No secret anywhere, so nothing signed with the text of a missing one is taken.
    expect(await push(t, forge, "null")).toBe(401);
  });

  it("names the settings page of an App under the admin's own account, on an Enterprise Server", async () => {
    const forge = fakeForge("ghe.acme.test");
    teamMode();
    const before = cockpit();
    const begun = await before.action(api.setup.begin, {
      code: await before.action(internal.setup.code, {}), host: "ghe.acme.test", organization: "", appUrl: APP_URL,
    });
    await before.action(api.setup.complete, { code: await forge.register(begun), state: begun.state });
    const t = cockpit();

    const adopted = await t.action(api.setup.adopt, {
      code: await t.action(internal.setup.code, {}), host: "ghe.acme.test", appId: String(forge.app!.id),
      clientSecret: forge.clientSecret(), privateKey: forge.app!.pem, appUrl: PAGES,
    });

    expect(adopted.settingsUrl).toBe("https://ghe.acme.test/settings/apps/asf-cockpit");
    expect(adopted.installUrl).toBe("https://ghe.acme.test/apps/asf-cockpit/installations/new");
  });
});
