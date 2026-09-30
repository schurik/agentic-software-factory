import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { catchUp, cockpit, type Cockpit, signIn, team } from "./helpers";
import { type Delivery, FACTORY_FILE, type FakeForge, fakeForge } from "./forge";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A team cockpit whose App is installed on acme, with alex signed in. */
async function installed(forge: FakeForge) {
  forge.person("alex");
  forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
  forge.repo("acme/docs", { roles: { alex: "write" } });
  const t = cockpit();
  await team(t, forge);
  const installation = forge.install("acme");
  await catchUp(t);
  return { t, installation, alex: await signIn(t, forge, "alex") };
}

function deliver(t: Cockpit, delivery: Delivery): Promise<Response> {
  return t.fetch("/forge/webhook", { method: "POST", headers: delivery.headers, body: delivery.body });
}

async function shown(t: Cockpit, holding: string): Promise<string[]> {
  return (await t.query(api.factories.list, { signIn: holding }))!.factories.map((factory) => factory.repo);
}

describe("a webhook delivery from the team's App", () => {
  it("shows a factory as soon as it is pushed, having answered GitHub before asking it anything", async () => {
    const forge = fakeForge();
    const { t, alex } = await installed(forge);
    forge.push("acme/docs", { add: [FACTORY_FILE] });
    const mark = forge.requests.length;

    const response = await deliver(t, await forge.delivery("push", forge.pushed("acme/docs")));

    // GitHub gives a receiver ten seconds and does not retry: the answer waits on nothing.
    expect(response.status).toBe(202);
    expect(forge.since(mark)).toEqual([]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await shown(t, alex)).toEqual(["acme/docs", "acme/widgets"]);
    // One look at the one repository, not a listing of them all.
    expect(forge.since(mark)).toEqual([
      expect.stringMatching(/^GET \/app\/installations/),
      "HEAD /repos/acme/docs/contents/asf/factory.yaml → 200",
    ]);
  });

  it("is refused when it is not signed with the App's webhook secret", async () => {
    const forge = fakeForge();
    const { t, alex } = await installed(forge);
    forge.push("acme/docs", { add: [FACTORY_FILE] });

    const forged = await deliver(t, await forge.delivery("push", forge.pushed("acme/docs"), "not-the-secret"));
    const unsigned = await t.fetch("/forge/webhook", {
      method: "POST", headers: { "X-GitHub-Event": "push" }, body: JSON.stringify(forge.pushed("acme/docs")),
    });

    expect(forged.status).toBe(401);
    expect(unsigned.status).toBe(401);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await shown(t, alex)).toEqual(["acme/widgets"]);
  });

  it("is refused by a cockpit with no App to have sent it", async () => {
    const forge = fakeForge();
    const t = cockpit();

    const response = await deliver(t, await forge.delivery("ping", { zen: "Keep it logically awesome." }, "anything"));

    expect(response.status).toBe(401);
  });

  it("asks the forge nothing for a push to another branch, or an event it does not read", async () => {
    const forge = fakeForge();
    const { t } = await installed(forge);
    const mark = forge.requests.length;

    const branch = await deliver(t, await forge.delivery("push", forge.pushed("acme/docs", "feature/x")));
    const other = await deliver(t, await forge.delivery("issue_comment", { action: "created" }));
    const ping = await deliver(t, await forge.delivery("ping", { zen: "Keep it logically awesome." }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect([branch.status, other.status, ping.status]).toEqual([202, 202, 202]);
    expect(forge.since(mark)).toEqual([]);
  });

  it("lists the repositories again when the installation changes", async () => {
    const forge = fakeForge();
    const { t, alex, installation } = await installed(forge);
    forge.repo("acme/gadgets", { factory: true, roles: { alex: "write" } });

    await deliver(t, await forge.delivery("installation_repositories", { action: "added", installation: { id: installation } }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Known to the cockpit at once; shown to alex once the forge says they reach it (viewer.refresh).
    vi.advanceTimersByTime(10 * 60_000);
    await t.action(api.viewer.refresh, { signIn: alex });
    expect(await shown(t, alex)).toEqual(["acme/gadgets", "acme/widgets"]);
  });

  it("that never arrived is caught up by the poll", async () => {
    const forge = fakeForge();
    const { t, alex } = await installed(forge);

    forge.push("acme/docs", { add: [FACTORY_FILE] });
    forge.push("acme/widgets", { remove: [FACTORY_FILE] });
    await catchUp(t);

    expect(await shown(t, alex)).toEqual(["acme/docs"]);
  });

  it("drops everything on an account the App was uninstalled from", async () => {
    const forge = fakeForge();
    const { t, alex, installation } = await installed(forge);

    forge.uninstall(installation);
    await deliver(t, await forge.delivery("installation", { action: "deleted", installation: { id: installation } }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await shown(t, alex)).toEqual([]);
  });
});
