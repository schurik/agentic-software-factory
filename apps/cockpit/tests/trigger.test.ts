import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { refusal } from "../convex/model/trigger";
import { fakeForge, type FakeForge, localMode, type Role } from "./forge";
import { catchUp, cockpit, type Cockpit, signIn, team } from "./helpers";

// Triggering a workflow on an issue (spec #40): the cockpit applies the
// workflow's route label, and the queued label beside it, AS THE VIEWER — so
// the forge records who did it, and the factory's watcher starts the run and
// records them as its trigger. Enabled for triage or higher, which is what the
// forge asks of anyone who labels; the forge is what enforces it.
//
// The cockpit knows a route label by the description the factory's own
// `asf labels --create` gave it, which `tests/golden/labels/` holds for both ends.

interface Described { name: string; description: string; workflow?: string }

const golden = (import.meta.glob("../../../tests/golden/labels/descriptions.json", { eager: true, import: "default" }) as
  Record<string, { route: Described; queued: Described; running: Described }>)["../../../tests/golden/labels/descriptions.json"];

/** The labels `asf labels --create` defines on a factory's repository, with two that are not the factory's. */
function defined(forge: FakeForge, repo = "acme/widgets"): void {
  forge.label(repo, golden.route.name, golden.route.description);
  forge.label(repo, "asf:refine", golden.route.description.replace(` ${golden.route.workflow} `, " refine "));
  forge.label(repo, golden.queued.name, golden.queued.description);
  forge.label(repo, golden.running.name, golden.running.description);
  forge.label(repo, "asf:hotfix", "");                      // made by hand: nothing says what it routes to
  forge.label(repo, "bug", "Something isn't working");
}

/** A team cockpit on acme/widgets, alex holding `role` there, with issue #42 open. */
async function teamWith(forge: FakeForge, role: Role): Promise<{ t: Cockpit; alex: string }> {
  forge.person("alex");
  forge.repo("acme/widgets", { factory: true, roles: { alex: role } });
  forge.issue("acme/widgets", 42, { title: "health check broken" });
  defined(forge);
  const t = cockpit();
  await team(t, forge);
  forge.install("acme");
  await catchUp(t);
  return { t, alex: await signIn(t, forge, "alex") };
}

const asking = (given: Partial<{ issue: number; label: string }> = {}) =>
  ({ factory: "acme/widgets", issue: given.issue ?? 42, label: given.label ?? golden.route.name });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("which workflows can be triggered", () => {
  it("are the route labels the factory defined on the forge, recognised by their description", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "triage");

    expect(await t.action(api.trigger.routes, { factory: "acme/widgets", signIn: alex })).toEqual({
      ok: true,
      routes: [{ label: golden.route.name, workflow: golden.route.workflow }, { label: "asf:refine", workflow: "refine" }],
      queued: golden.queued.name,
      running: golden.running.name,
    });
  });

  it("are none, saying why, on a repository whose labels were never created by the factory", async () => {
    const forge = fakeForge();
    forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "write" } });
    forge.label("acme/widgets", "asf:ship", "");
    const t = cockpit();
    await team(t, forge);
    forge.install("acme");
    await catchUp(t);

    const routes = await t.action(api.trigger.routes, { factory: "acme/widgets", signIn: await signIn(t, forge, "alex") });
    expect(routes).toEqual({
      ok: false, because: "the forge defines no route label this factory made: run `asf labels --create` in the repository",
    });
  });
});

describe("triggering", () => {
  it("applies the route and queued labels to the issue as the viewer", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "triage");

    const done = await t.action(api.trigger.trigger, { ...asking(), signIn: alex });

    expect(done).toEqual({
      ok: true, workflow: golden.route.workflow, title: "health check broken",
      url: "https://github.com/acme/widgets/issues/42",
    });
    // On the person's own user access token: the forge's `labeled` event names them,
    // and that is who the factory records as having triggered the run.
    expect(forge.labelled("acme/widgets", 42)).toEqual([
      { by: "alex", via: "user", labels: [golden.route.name, golden.queued.name] },
    ]);
  });

  it("labels with the person's own token in a local cockpit", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    forge.issue("acme/widgets", 42, { title: "health check broken" });
    defined(forge);
    const t = cockpit();
    await catchUp(t);

    expect(await t.action(api.trigger.trigger, asking({ label: "asf:refine" }))).toMatchObject({ ok: true, workflow: "refine" });
    expect(forge.labelled("acme/widgets", 42)).toEqual([
      { by: "alex", via: "person", labels: ["asf:refine", golden.queued.name] },
    ]);
  });

  it("is refused below triage, saying so, and nothing is labelled", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "read");

    const refused = await t.action(api.trigger.trigger, { ...asking(), signIn: alex });

    expect(refused).toEqual({ ok: false, because: refusal("read") });
    expect(forge.labelled("acme/widgets", 42)).toEqual([]);
  });

  it.each([
    ["a label that routes nothing", asking({ label: "asf:hotfix" }), "is not a route label"],
    ["an issue that does not exist", asking({ issue: 7 }), "no issue #7"],
    ["a closed issue", asking({ issue: 43 }), "#43 is closed"],
    ["a pull request", asking({ issue: 44 }), "#44 is a pull request"],
    // Queued already: no `labeled` event would name the viewer, and the watcher starts it anyway.
    ["an issue already queued", asking({ issue: 45 }), "#45 is already queued"],
    // A run parked at a gate leaves its issue on `running`: queueing it again would start a second run beside it.
    ["an issue a run already has", asking({ issue: 46 }), "a run already has #46"],
  ])("refuses %s before anything is labelled", async (_, given, because) => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "write");
    forge.issue("acme/widgets", 43, { title: "done already", state: "closed" });
    forge.issue("acme/widgets", 44, { title: "a change", pull: true });
    forge.issue("acme/widgets", 45, { title: "waiting", labels: [golden.route.name, golden.queued.name] });
    forge.issue("acme/widgets", 46, { title: "at a gate", labels: [golden.route.name, golden.running.name] });

    const refused = await t.action(api.trigger.trigger, { ...given, signIn: alex });

    expect(refused).toEqual({ ok: false, because: expect.stringContaining(because) });
    expect([42, 7, 43, 44, 45, 46].flatMap((number) => forge.labelled("acme/widgets", number))).toEqual([]);
  });

  it("queues again an issue an earlier run finished, naming the viewer as its trigger", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "triage");
    forge.issue("acme/widgets", 47, { title: "try again", labels: [golden.route.name, "asf:failed"] });

    expect(await t.action(api.trigger.trigger, { ...asking({ issue: 47 }), signIn: alex })).toMatchObject({ ok: true });
    expect(forge.labelled("acme/widgets", 47)).toEqual([
      { by: "alex", via: "user", labels: [golden.route.name, golden.queued.name] },
    ]);
  });

  it("is refused to a viewer who is not signed in", async () => {
    const forge = fakeForge();
    const { t } = await teamWith(forge, "admin");
    expect(await t.action(api.trigger.trigger, asking())).toEqual({ ok: false, because: "sign in to trigger a workflow" });
  });
});

describe("why the trigger is disabled", () => {
  it("names the role it needs and the one the viewer has", () => {
    expect(refusal("read")).toBe("triggering needs triage or higher on this repository, and the forge says you have read");
    expect(refusal(null)).toBe("the forge has not said what you may do on this repository");
    for (const role of ["triage", "write", "maintain", "admin"] as const) expect(refusal(role)).toBeNull();
  });
});
