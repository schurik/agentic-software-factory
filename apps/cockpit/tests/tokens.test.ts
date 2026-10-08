import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { fakeForge } from "./forge";
import { factory, ingest, signIn } from "./helpers";
import { localOf, running, SESSION, teamOf } from "./station";

// Ingest tokens issued from the factory page (#175): a CI job takes part in
// no device flow, so a repository's admin issues it a token to copy into a
// repository secret. Shown once, kept as a digest, listed beside the tokens
// stations were handed, and revocable — a revoked token's ingest is refused.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("issuing an ingest token from the factory page", () => {
  it("is an admin's: the token is shown once, and its ingest stored", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { ada: "admin" });
    const ada = await signIn(t, forge, "ada");

    const issued = await t.action(api.tokens.issueFor, { factory: "acme/widgets", label: "GitHub Actions", signIn: ada });
    if (!issued.ok) throw new Error(issued.because);
    expect(issued.token).toMatch(/^asf_ingest_/);
    expect((await ingest(t, issued.token, { session: SESSION, events: running() })).status).toBe(200);

    const listed = await t.query(api.tokens.listed, { factory: "acme/widgets", signIn: ada });
    expect(listed).toEqual({
      mayIssue: true,
      tokens: [expect.objectContaining({ via: "cockpit", label: "GitHub Actions", by: "ada", issuedAt: Date.now(), revocable: true })],
    });
    // Only ever its digest is kept: no list says the token again.
    expect(JSON.stringify(listed)).not.toContain(issued.token);
  });

  it("is refused to a writer, and its list hidden from someone who cannot read the factory", async () => {
    const forge = fakeForge();
    forge.person("dana");
    const t = await teamOf(forge, { alex: "write" });
    const alex = await signIn(t, forge, "alex");

    expect(await t.action(api.tokens.issueFor, { factory: "acme/widgets", label: "CI", signIn: alex })).toEqual({
      ok: false, because: "issuing an ingest token needs admin on acme/widgets; the forge says you have write",
    });
    expect(await t.action(api.tokens.issueFor, { factory: "acme/widgets", label: "CI" })).toMatchObject({ ok: false });
    expect(await t.query(api.tokens.listed, { factory: "acme/widgets", signIn: alex })).toEqual({ mayIssue: false, tokens: [] });
    expect(await t.query(api.tokens.listed, { factory: "acme/widgets", signIn: await signIn(t, forge, "dana") })).toBeNull();
  });

  it("is revocable by an admin, and a revoked token's ingest is refused", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { ada: "admin", alex: "write" });
    const ada = await signIn(t, forge, "ada");
    const alex = await signIn(t, forge, "alex");
    const issued = await t.action(api.tokens.issueFor, { factory: "acme/widgets", label: "CI", signIn: ada });
    if (!issued.ok) throw new Error(issued.because);
    const deployment = await factory(t, "acme/widgets");
    const listed = await t.query(api.tokens.listed, { factory: "acme/widgets", signIn: ada });
    const ci = listed!.tokens.find((token) => token.via === "cockpit")!;

    // The operator's route stays, and its tokens are listed as the deployment's.
    expect(listed!.tokens.map((token) => token.via).sort()).toEqual(["cockpit", "deployment"]);
    expect((await t.query(api.tokens.listed, { factory: "acme/widgets", signIn: alex }))!.tokens.every((token) => !token.revocable)).toBe(true);
    expect(await t.mutation(api.tokens.revoke, { factory: "acme/widgets", id: ci.id, signIn: alex })).toMatchObject({ ok: false });

    expect(await t.mutation(api.tokens.revoke, { factory: "acme/widgets", id: ci.id, signIn: ada })).toEqual({ ok: true });
    expect((await ingest(t, issued.token, { session: SESSION, events: running() })).status).toBe(401);
    expect((await ingest(t, deployment, { session: SESSION, events: running() })).status).toBe(200);
    expect((await t.query(api.tokens.listed, { factory: "acme/widgets", signIn: ada }))!.tokens.map((token) => token.via)).toEqual(["deployment"]);
  });

  it("is anyone's on a local cockpit, which is one person's machine", async () => {
    const forge = fakeForge();
    const { t } = await localOf(forge);

    const issued = await t.action(api.tokens.issueFor, { factory: "acme/widgets", label: "CI" });
    expect(issued.ok).toBe(true);
    expect((await t.query(api.tokens.listed, { factory: "acme/widgets" }))?.mayIssue).toBe(true);
  });
});
