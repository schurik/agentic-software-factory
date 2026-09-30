import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { fakeForge, type FakeForge, localMode } from "./forge";
import { cockpit, type Cockpit, factory, fixture, ingest, signIn, team, type WireEvent } from "./helpers";

// A repo artifact travels as a path, and the cockpit reads it from the forge
// at the sha of the commit after it — never the branch tip, which a later
// phase, or a person, may have moved on (CLAUDE.md, invariant 11).

const SESSION = "5c0075aa";
const PINNED = "3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f";
const TIP = "9".repeat(40);
const SPEC = "docs/asf/spec/5c0075aa_health-check.md";
const WRITTEN = "# Plan\n\nRegister /health in app.py.\n";

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A plan phase that wrote the spec into the repository, the commit after it, and a later one that changed it. */
async function session(content = WRITTEN): Promise<WireEvent[]> {
  const written = fixture("artifact_written", 3);
  Object.assign(written.payload, {
    phase_id: "5c0075aa_03_plan", location: "repo", path: SPEC, content: "",
    size: new TextEncoder().encode(content).length, digest: await sha256(content),
  });
  const later = fixture("committed", 5);
  Object.assign(later.payload, { sha: TIP, phase_id: "5c0075aa_09_commit_fix", files: [SPEC] });
  return [fixture("session_started", 1), fixture("phase_started", 2, 2), written, fixture("committed", 4), later];
}

async function shipped(t: Cockpit, events: WireEvent[], name = "acme/widgets"): Promise<void> {
  const response = await ingest(t, await factory(t, name), { session: SESSION, events });
  expect(response.status).toBe(200);
}

function repository(forge: FakeForge, roles: Record<string, "read" | "write"> = { alex: "write" }): void {
  forge.repo("acme/widgets", { factory: true, roles });
  forge.commit("acme/widgets", PINNED, { [SPEC]: WRITTEN });
  forge.commit("acme/widgets", TIP, { [SPEC]: "# Plan\n\nRewritten since.\n" });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a repo artifact, read from the forge", () => {
  it("is read at the sha of the commit after it was written, never the branch tip", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    repository(forge);
    const t = cockpit();
    await shipped(t, await session());
    const mark = forge.requests.length;

    const read = await t.action(api.artifacts.read, { factory: "acme/widgets", session: SESSION, seq: 3 });

    expect(read).toEqual({ ok: true, sha: PINNED, content: WRITTEN, truncated: false, binary: false, matches: true });
    expect(forge.since(mark)).toEqual([`GET /repos/acme/widgets/contents/${SPEC}?ref=${PINNED} → 200`]);
  });
});

describe("a repo artifact in a team's cockpit", () => {
  it("is read on the App's installation, for a person the forge lets read the repository", async () => {
    const forge = fakeForge();
    forge.person("alex");
    repository(forge, { alex: "read" });
    const t = cockpit();
    await team(t, forge);
    forge.install("acme");
    const held = await signIn(t, forge, "alex");
    await t.action(api.viewer.refresh, { signIn: held });
    await shipped(t, await session());
    const mark = forge.requests.length;

    const read = await t.action(api.artifacts.read, { factory: "acme/widgets", session: SESSION, seq: 3, signIn: held });

    expect(read).toMatchObject({ ok: true, sha: PINNED, content: WRITTEN });
    const asked = forge.since(mark).filter((line) => line.includes("/contents/"));
    expect(asked).toEqual([`GET /repos/acme/widgets/contents/${SPEC}?ref=${PINNED} → 200`]);
  });

  it("is read for nobody the forge would not show the repository to", async () => {
    const forge = fakeForge();
    forge.person("alex");
    forge.person("mallory");
    repository(forge, { alex: "read" });
    const t = cockpit();
    await team(t, forge);
    forge.install("acme");
    const held = await signIn(t, forge, "mallory");
    await t.action(api.viewer.refresh, { signIn: held });
    await shipped(t, await session());
    const mark = forge.requests.length;

    const read = await t.action(api.artifacts.read, { factory: "acme/widgets", session: SESSION, seq: 3, signIn: held });

    expect(read).toEqual({ ok: false, because: "no such artifact in a session you can see" });
    expect(forge.since(mark)).toEqual([]);
  });
});

describe("what a read says when it cannot show the file as written", () => {
  function local(): FakeForge {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    repository(forge);
    return forge;
  }

  it("says so when the bytes at the commit are not the ones the phase wrote", async () => {
    local();
    const t = cockpit();
    await shipped(t, await session("# Plan\n\nWhat the planner wrote, changed before the commit.\n"));

    const read = await t.action(api.artifacts.read, { factory: "acme/widgets", session: SESSION, seq: 3 });

    expect(read).toMatchObject({ ok: true, content: WRITTEN, matches: false });
  });

  it("asks nothing for a version a later phase rewrote before any commit", async () => {
    const forge = local();
    const t = cockpit();
    const [started, first, written, commit] = await session();
    const again = { ...written, seq: 4, payload: { ...written.payload as object, phase_id: "5c0075aa_05_plan_revise_1", digest: "0".repeat(64) } };
    await shipped(t, [started, first, written, again, { ...commit, seq: 5 }]);
    const mark = forge.requests.length;

    const read = await t.action(api.artifacts.read, { factory: "acme/widgets", session: SESSION, seq: 3 });

    expect(read).toEqual({ ok: false, because: "a later phase wrote it again before anything committed it, so this version never reached the forge" });
    expect(forge.since(mark)).toEqual([]);
  });

  it("says the forge does not show it when the branch was never pushed", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    forge.repo("acme/widgets", { factory: true, roles: { alex: "write" } });
    const t = cockpit();
    await shipped(t, await session());

    const read = await t.action(api.artifacts.read, { factory: "acme/widgets", session: SESSION, seq: 3 });

    expect(read).toEqual({ ok: false, because: `the forge does not show ${SPEC} at 3e1f0a9 to this cockpit: ` +
                                               "the branch may not be pushed, or was deleted" });
  });

  it("cuts a file past the cap, and says it did", async () => {
    const forge = local();
    const big = "x".repeat(300 * 1024);
    forge.commit("acme/widgets", PINNED, { [SPEC]: big });
    const t = cockpit();
    await shipped(t, await session(big));

    const read = await t.action(api.artifacts.read, { factory: "acme/widgets", session: SESSION, seq: 3 });

    expect(read).toMatchObject({ ok: true, truncated: true, matches: true });
    expect(read.ok && read.content.length).toBe(256 * 1024);
  });

  it("names a handoff file as nothing to read from the forge", async () => {
    local();
    const t = cockpit();
    await shipped(t, [fixture("session_started", 1), fixture("phase_started", 2, 2),
                      { ...fixture("artifact_written", 3), payload: { ...fixture("artifact_written", 3).payload as object, phase_id: "5c0075aa_03_plan" } }]);

    const read = await t.action(api.artifacts.read, { factory: "acme/widgets", session: SESSION, seq: 3 });

    expect(read).toEqual({ ok: false, because: "not a repository file: it travelled with the session" });
  });
});
