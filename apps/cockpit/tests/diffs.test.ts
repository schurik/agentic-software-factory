import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { fakeForge, type FakeForge, localMode } from "./forge";
import { cockpit, type Cockpit, factory, fixture, ingest, signIn, team, type WireEvent } from "./helpers";

// A diff is read from the forge, never carried in an event (CLAUDE.md,
// invariant 11): a commit phase's at the sha its `committed` names, and the
// session's changes as the forge compares its base commit with the latest
// commit the session made.

const SESSION = "5c0075aa";
const BASE = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";   // session_started v3's base_commit
const PLANNED = "3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f";
const BUILT = "9".repeat(40);
const SPEC = "docs/asf/spec/5c0075aa_health-check.md";

/** A session that committed its plan, then its code. */
function session(): WireEvent[] {
  const code = fixture("committed", 4);
  Object.assign(code.payload, { sha: BUILT, phase_id: "5c0075aa_08_commit_implement", files: ["app.py"], message: "feat: health" });
  return [fixture("session_started", 1, 3), fixture("phase_started", 2, 2), fixture("committed", 3), code];
}

async function shipped(t: Cockpit, events: WireEvent[] = session()): Promise<void> {
  const response = await ingest(t, await factory(t, "acme/widgets"), { session: SESSION, events });
  expect(response.status).toBe(200);
}

function repository(forge: FakeForge, roles: Record<string, "read" | "write"> = { alex: "write" }): void {
  forge.repo("acme/widgets", { factory: true, roles });
  forge.commit("acme/widgets", BASE, { "app.py": "ok = 0\n" });
  forge.commit("acme/widgets", PLANNED, { [SPEC]: "# Plan\n" });
  forge.commit("acme/widgets", BUILT, { "app.py": "ok = 1\n" });
}

const PLAN_DIFF = `diff --git a/${SPEC} b/${SPEC}\nnew file mode 100644\n--- /dev/null\n+++ b/${SPEC}\n@@ -0,0 +1 @@\n+# Plan\n`;
const APP_DIFF = "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-ok = 0\n+ok = 1\n";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a commit phase's diff", () => {
  it("is the forge's diff of the commit its `committed` names, on the person's own token", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    repository(forge);
    const t = cockpit();
    await shipped(t);
    const mark = forge.requests.length;

    const read = await t.action(api.diffs.commit, { factory: "acme/widgets", session: SESSION, sha: PLANNED });

    expect(read).toEqual({ ok: true, diff: PLAN_DIFF });
    expect(forge.since(mark)).toEqual([`GET /repos/acme/widgets/commits/${PLANNED} → 200`]);
  });

  it("is read on the App's installation in a team's cockpit, for a person the forge lets read the repository", async () => {
    const forge = fakeForge();
    forge.person("alex");
    repository(forge, { alex: "read" });
    const t = cockpit();
    await team(t, forge);
    forge.install("acme");
    const held = await signIn(t, forge, "alex");
    await t.action(api.viewer.refresh, { signIn: held });
    await shipped(t);

    const read = await t.action(api.diffs.commit, { factory: "acme/widgets", session: SESSION, sha: BUILT, signIn: held });

    expect(read).toEqual({ ok: true, diff: APP_DIFF });
  });

  it("is read for nobody the forge would not show the repository to", async () => {
    const forge = fakeForge();
    forge.person("alex");
    forge.person("sam");
    repository(forge, { alex: "read" });
    const t = cockpit();
    await team(t, forge);
    forge.install("acme");
    const held = await signIn(t, forge, "sam");
    await t.action(api.viewer.refresh, { signIn: held });
    await shipped(t);
    const mark = forge.requests.length;

    const read = await t.action(api.diffs.commit, { factory: "acme/widgets", session: SESSION, sha: BUILT, signIn: held });

    expect(read).toEqual({ ok: false, because: "no such commit in a session you can see" });
    expect(forge.since(mark)).toEqual([]);
  });

  it("asks the forge about no commit the session did not make", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    repository(forge);
    const t = cockpit();
    await shipped(t);
    const mark = forge.requests.length;

    const read = await t.action(api.diffs.commit, { factory: "acme/widgets", session: SESSION, sha: BASE });

    expect(read).toEqual({ ok: false, because: "no such commit in a session you can see" });
    expect(forge.since(mark)).toEqual([]);
  });

  it("says the forge does not show it when the branch was never pushed", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    forge.repo("acme/widgets", { factory: true, roles: { alex: "write" } });
    const t = cockpit();
    await shipped(t);

    const read = await t.action(api.diffs.commit, { factory: "acme/widgets", session: SESSION, sha: BUILT });

    expect(read).toEqual({
      ok: false, because: "the forge does not show commit 9999999 to this cockpit: the branch may not be pushed, or was deleted",
    });
  });

  it("says it cannot read the diff without a forge credential", async () => {
    const forge = fakeForge();
    localMode(forge, null);
    const t = cockpit();
    await shipped(t);

    const read = await t.action(api.diffs.commit, { factory: "acme/widgets", session: SESSION, sha: BUILT });

    expect(read).toEqual({ ok: false, because: "this cockpit has no forge credential to read it with" });
  });
});

describe("the session's changes", () => {
  it("are the forge's diff of the session's base commit and the latest commit it made", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    repository(forge);
    const t = cockpit();
    await shipped(t);
    const mark = forge.requests.length;

    const read = await t.action(api.diffs.changes, { factory: "acme/widgets", session: SESSION });

    expect(read).toEqual({ ok: true, diff: APP_DIFF + PLAN_DIFF });
    expect(forge.since(mark)).toEqual([`GET /repos/acme/widgets/compare/${BASE}...${BUILT} → 200`]);
  });

  it("are read on the App's installation in a team's cockpit", async () => {
    const forge = fakeForge();
    forge.person("alex");
    repository(forge, { alex: "read" });
    const t = cockpit();
    await team(t, forge);
    forge.install("acme");
    const held = await signIn(t, forge, "alex");
    await t.action(api.viewer.refresh, { signIn: held });
    await shipped(t);

    const read = await t.action(api.diffs.changes, { factory: "acme/widgets", session: SESSION, signIn: held });

    expect(read).toMatchObject({ ok: true });
  });

  it("are nothing to read before the session committed anything", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    repository(forge);
    const t = cockpit();
    await shipped(t, session().slice(0, 2));
    const mark = forge.requests.length;

    const read = await t.action(api.diffs.changes, { factory: "acme/widgets", session: SESSION });

    expect(read).toEqual({ ok: false, because: "the session has committed nothing yet" });
    expect(forge.since(mark)).toEqual([]);
  });

  it("say it cannot read the diff without a forge credential", async () => {
    const forge = fakeForge();
    localMode(forge, null);
    const t = cockpit();
    await shipped(t);

    const read = await t.action(api.diffs.changes, { factory: "acme/widgets", session: SESSION });

    expect(read).toEqual({ ok: false, because: "this cockpit has no forge credential to read it with" });
  });
});
