import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { KNOWN_FORMAT, readDescription } from "../convex/model/description";
import { drift } from "../convex/model/drift";
import { fakeForge } from "./forge";
import { factory, signIn } from "./helpers";
import { json, localOf, poll, post, REPORT, STATION, teamOf } from "./station";

// The factory describes itself (spec #40, #57): `asf check --json` prints its
// SELF-DESCRIPTION, the optional CI workflow ships it here as a CI station
// with the ingest token, and the Factory page renders its workflows from it —
// the cockpit never reads a workflow file. The description from the default
// branch is also what each station's config drift is measured against. The
// factory's end is tests/test_asf_describe.py.

/**
 * Every self-description format the factory ever wrote, as its golden corpus
 * holds it (`tests/golden/self-description/v<N>.json`), never edited.
 */
const corpus: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob("../../../tests/golden/self-description/v*.json",
                                  { eager: true, query: "?raw", import: "default" }) as Record<string, string>)
    .map(([path, text]) => [path.split("/").at(-1)!, text]),
);

const CURRENT = JSON.parse(corpus[`v${KNOWN_FORMAT}.json`]) as Record<string, unknown>;
const TIP = "a".repeat(40);
const CI = { id: "st_ci0001", name: "runner@fv-az123:widgets", kind: "ci" };

/** The current fixture, as checked at `head` on `ref`. */
function described(fields: { head?: string; ref?: string; configHash?: string; ok?: boolean } = {}): Record<string, unknown> {
  const description = structuredClone(CURRENT);
  description.checked = { head: fields.head ?? TIP, ref: fields.ref ?? "main", config_hash: fields.configHash ?? "c0ffee" };
  if (fields.ok !== undefined) {
    description.ok = fields.ok;
    if (fields.ok) description.problems = [];
  }
  return description;
}

async function ship(t: Parameters<typeof post>[0], token: string | null, description: unknown, station = CI) {
  return await post(t, "/describe", token, { station, description });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── the corpus ───────────────────────────────────────────────────────────────

describe("the golden self-descriptions", () => {
  it("holds one for the format this cockpit reads, and every one ever written reads", () => {
    expect(Object.keys(corpus)).toContain(`v${KNOWN_FORMAT}.json`);
    for (const [name, text] of Object.entries(corpus)) {
      const read = readDescription(text);
      expect(read.format, name).toBe(Number(name.slice(1, -5)));
      expect(read.newer, name).toBe(false);
      expect(read.workflows.length, name).toBeGreaterThan(0);
      expect(read.checked.head, name).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("reads a workflow's purpose, trigger, chain, agents and gates, and the per-session budget", () => {
    const read = readDescription(corpus["v1.json"]);
    const issue = read.workflows.find((workflow) => workflow.name === "issue")!;

    expect(issue.description).toMatch(/^a tracked work item/);
    expect(issue.input).toBe("issue");
    expect(issue.trigger).toEqual({ labels: ["asf:ship"], watched: true });
    expect(issue.stages.map((step) => step.stage)).toEqual(
      ["scout", "plan", "commit", "implement", "verify", "review", "commit", "document", "commit", "integrate"]);
    expect(issue.stages[1]).toEqual({ stage: "plan", kind: "agent", agents: ["planner"], gate: "plan" });
    expect(issue.gates).toContainEqual({ name: "plan", stage: "plan", kind: "gate", on: true });
    const planner = issue.agents.find((agent) => agent.name === "planner")!;
    expect(planner.writes).toEqual(["docs/asf/spec/"]);
    expect(issue.agents.find((agent) => agent.name === "builder")!.writes).toBeNull();
    expect(read.budget).toEqual({ maxCostUsd: 2.5, maxTokens: 2000000 });
    expect(read.ok).toBe(false);
    expect(read.problems).toEqual([{ workflow: "nightly", error: expect.stringContaining("nobody") }]);
  });

  it("reads a newer format loosely, and says the cockpit is the older one", () => {
    const later = { ...described(), format: KNOWN_FORMAT + 1, something_new: { at: 1 } };

    const read = readDescription(JSON.stringify(later));

    expect(read.newer).toBe(true);
    expect(read.workflows.map((workflow) => workflow.name)).toContain("sdlc");
  });

  it("reads nothing out of what is not a description, and never throws", () => {
    expect(readDescription("not json").workflows).toEqual([]);
    expect(readDescription(JSON.stringify({ format: 1, workflows: [{ name: 3 }, "x"] })).workflows)
      .toEqual([expect.objectContaining({ name: "", stages: [], agents: [], gates: [] })]);
  });
});

// ── a CI station ships it ────────────────────────────────────────────────────

describe("a self-description pushed by a CI station", () => {
  it("is taken only with an ingest token the cockpit issued, and only as a description", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "read" });
    const ingestToken = await factory(t, "acme/widgets");

    expect((await ship(t, null, described())).status).toBe(401);
    expect((await ship(t, "asf_ingest_nope", described())).status).toBe(401);
    expect((await post(t, "/describe", ingestToken, { station: CI })).status).toBe(400);
    expect((await ship(t, ingestToken, { format: "one" })).status).toBe(400);
    expect((await ship(t, ingestToken, described(), { id: "", name: "x", kind: "ci" })).status).toBe(400);
    // A checkout's own config is what drift measures, never what it is measured against.
    const local = await ship(t, ingestToken, described(), { id: "st_mine", name: "alex@mbp:widgets", kind: "local" });
    expect(local.status).toBe(403);
    expect((await json(local)).error).toMatch(/CI station/);
    const taken = await ship(t, ingestToken, described());
    expect(taken.status).toBe(200);
    expect(await json(taken)).toEqual({});
  });

  it("renders the Factory page's workflows, from the default branch's description", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "read" });
    const alex = await signIn(t, forge, "alex");
    await t.action(api.viewer.refresh, { signIn: alex });
    const ingestToken = await factory(t, "acme/widgets");

    await ship(t, ingestToken, described({ ref: "main", ok: true }));
    await ship(t, ingestToken, described({ ref: "feature/x", head: "b".repeat(40), ok: false }));
    const page = await t.query(api.factory.page, { factory: "acme/widgets", signIn: alex });

    expect(page).not.toBeNull();
    expect(page!.defaultBranch).toBe("main");
    expect(page!.check).toMatchObject({ ref: "main", head: TIP, ok: true, station: CI.name });
    expect(page!.check!.description.workflows.map((workflow) => workflow.name)).toContain("issue");
    expect(page!.check!.description.budget.maxCostUsd).toBe(2.5);

    await ship(t, ingestToken, described({ ref: "main", head: "c".repeat(40), ok: false }));
    const again = await t.query(api.factory.page, { factory: "acme/widgets", signIn: alex });
    expect(again!.check).toMatchObject({ head: "c".repeat(40), ok: false });     // the latest push, kept once
  });

  it("leaves a factory without one unchecked, not broken", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "read" });
    const alex = await signIn(t, forge, "alex");
    await t.action(api.viewer.refresh, { signIn: alex });

    const page = await t.query(api.factory.page, { factory: "acme/widgets", signIn: alex });

    expect(page).toMatchObject({ repo: "acme/widgets", onForge: true, defaultBranch: "main", check: null });
    expect(await t.query(api.factory.page, { factory: "acme/widgets" })).toBeNull();     // nobody signed in
    expect(await t.query(api.factory.page, { factory: "acme/secret", signIn: alex })).toBeNull();
  });
});

// ── drift ────────────────────────────────────────────────────────────────────

describe("a station's drift from the default branch", () => {
  const reference = { head: TIP, configHash: "c0ffee" };

  it("is current at the default branch's commit with its config", () => {
    expect(drift({ head: TIP, configHash: "c0ffee" }, reference, undefined)).toEqual({ badges: [], drifted: false });
  });

  it("is local edits at that commit with another config", () => {
    expect(drift({ head: TIP, configHash: "beef" }, reference, undefined)).toEqual({ badges: ["local edits"], drifted: true });
  });

  it("is so many commits behind, and drifted only when its config is not the default branch's", () => {
    expect(drift({ head: "b".repeat(40), configHash: "beef" }, reference, { ahead: 0, behind: 3 }))
      .toEqual({ badges: ["3 commits behind"], drifted: true });
    expect(drift({ head: "b".repeat(40), configHash: "c0ffee" }, reference, { ahead: 0, behind: 1 }))
      .toEqual({ badges: ["1 commit behind"], drifted: false });
    expect(drift({ head: "b".repeat(40), configHash: "" }, { head: TIP, configHash: null }, { ahead: 2, behind: 5 }))
      .toEqual({ badges: ["5 commits behind", "2 commits ahead"], drifted: true });
  });

  it("says what it cannot know rather than guess", () => {
    expect(drift({ head: "", configHash: "" }, reference, undefined)).toEqual({ badges: ["no report yet"], drifted: false });
    expect(drift({ head: TIP, configHash: "beef" }, { head: null, configHash: null }, undefined))
      .toEqual({ badges: ["default branch unknown"], drifted: false });
    // At the default branch's commit, but no check measured its config there: never "current".
    expect(drift({ head: TIP, configHash: "beef" }, { head: TIP, configHash: null }, undefined))
      .toEqual({ badges: ["config not measured"], drifted: false });
    expect(drift({ head: "b".repeat(40), configHash: "beef" }, reference, null))
      .toEqual({ badges: ["on a commit the forge does not show"], drifted: true });
  });

  it("is measured against the forge, per station, from each station's report", async () => {
    const forge = fakeForge();
    const { t, ingestToken } = await localOf(forge);
    forge.commit("acme/widgets", "1".repeat(40), { "asf/factory.yaml": "defaults: {}\n" });
    forge.commit("acme/widgets", "2".repeat(40), { "asf/workflows/sdlc/workflow.yaml": "name: sdlc\n" });
    forge.commit("acme/widgets", TIP, { "README.md": "# widgets\n" });
    await ship(t, ingestToken, described({ head: TIP, configHash: "c0ffee", ok: true }));
    const behind = { id: "st_behind", name: "alex@old:widgets", kind: "local" };
    for (const [station, head, hash] of [[STATION, TIP, "beef"], [behind, "1".repeat(40), "0ld"]] as const) {
      const { token } = await t.action(internal.stations.local, { factory: "acme/widgets", station });
      expect((await poll(t, token, { report: { ...REPORT, head, config_hash: hash } }, station)).status).toBe(200);
    }

    const page = await t.query(api.factory.page, { factory: "acme/widgets" });
    const looked = await t.action(api.factory.look, { factory: "acme/widgets" });

    expect(looked).toEqual({
      ok: true, tip: TIP, files: ["asf/factory.yaml", "asf/workflows/sdlc/workflow.yaml"],
      distances: { ["1".repeat(40)]: { ahead: 0, behind: 2 } },
    });
    const byName = Object.fromEntries(page!.stations.map((row) => [row.name, row]));
    expect(byName[STATION.name]).toMatchObject({ head: TIP, configHash: "beef", kind: "local" });
    const reference = { head: looked.ok ? looked.tip : null, configHash: page!.check!.configHash };
    expect(drift(byName[STATION.name], reference, undefined).badges).toEqual(["local edits"]);
    expect(drift(byName[behind.name], reference, looked.ok ? looked.distances["1".repeat(40)] : undefined).badges)
      .toEqual(["2 commits behind"]);
  });
});
