import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { fakeForge } from "./forge";
import { factory, ingest, signIn } from "./helpers";
import { approved, handed, post, register, registerOpenly, REPORT, running, SESSION, STATION, teamOf } from "./station";

// Ingest tokens on the factory page (#142): an admin of the repository issues
// one for CI, sees it once, and revokes it — as they may the one a station's
// registration handed it, and the operator's. A revoked token ships, claims
// and describes nothing.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("an ingest token for CI", () => {
  it("is an admin's to issue on the factory page, shown once, listed by who issued it and when", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "admin" });
    vi.stubEnv("CONVEX_SITE_URL", "https://happy-otter-123.convex.site/");
    const alex = await signIn(t, forge, "alex");

    const issued = await t.action(api.tokens.issueForCi, { factory: "acme/widgets", label: "GitHub Actions", signIn: alex });
    if (!issued.ok) throw new Error(issued.because);
    expect(issued.token).toMatch(/^asf_ingest_/);
    expect((await ingest(t, issued.token, { session: SESSION, events: running() })).status).toBe(200);

    const listed = await t.query(api.tokens.list, { factory: "acme/widgets", signIn: alex });
    expect(listed).toMatchObject({ mayIssue: true, site: "https://happy-otter-123.convex.site" });
    expect(listed?.tokens).toEqual([
      expect.objectContaining({ kind: "ci", label: "GitHub Actions", issuedBy: "alex", issuedAt: Date.now(), revocable: true }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(issued.token);
  });

  it("is refused to a writer, and its list to someone who cannot read the factory", async () => {
    const forge = fakeForge();
    forge.person("dana");
    const t = await teamOf(forge, { sam: "write" });
    const sam = await signIn(t, forge, "sam");

    expect(await t.action(api.tokens.issueForCi, { factory: "acme/widgets", label: "CI", signIn: sam }))
      .toEqual({ ok: false, because: "a token for CI is an admin's to issue, and the forge does not say you administer acme/widgets" });
    expect(await t.query(api.tokens.list, { factory: "acme/widgets", signIn: sam })).toMatchObject({ tokens: [], mayIssue: false });
    expect(await t.query(api.tokens.list, { factory: "acme/widgets", signIn: await signIn(t, forge, "dana") })).toBeNull();
    expect(await t.action(api.tokens.issueForCi, { factory: "acme/widgets", label: "CI" })).toMatchObject({ ok: false });
  });
});

describe("revoking an ingest token", () => {
  it("refuses what it ships, claims and describes from then on, and leaves the factory's other tokens be", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "admin" });
    const alex = await signIn(t, forge, "alex");
    const operators = await factory(t, "acme/widgets");
    const issued = await t.action(api.tokens.issueForCi, { factory: "acme/widgets", label: "CI", signIn: alex });
    if (!issued.ok) throw new Error(issued.because);
    const listed = async () => (await t.query(api.tokens.list, { factory: "acme/widgets", signIn: alex }))!.tokens;
    expect((await listed()).map((token) => token.kind)).toEqual(["operator", "ci"]);

    const ci = (await listed()).find((token) => token.kind === "ci")!;
    expect(await t.mutation(api.tokens.revoke, { token: ci.id, signIn: alex })).toEqual({ ok: true });

    expect((await ingest(t, issued.token, { session: SESSION, events: running() })).status).toBe(401);
    expect((await post(t, "/claims", issued.token, { op: "take", kind: "issue", number: 1, session: SESSION, station: STATION })).status).toBe(401);
    expect((await post(t, "/describe", issued.token, {})).status).not.toBe(200);
    expect((await register(t, operators)).code).toBeTruthy();       // the operator's still works
    expect((await post(t, "/station/register", issued.token, { station: STATION })).status).toBe(401);
    expect((await listed()).map((token) => token.kind)).toEqual(["operator"]);
    expect(await t.mutation(api.tokens.revoke, { token: ci.id, signIn: alex })).toMatchObject({ ok: false });
  });

  it("is its issuer's to do, and an admin's — never another writer's", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "write", sam: "write", root: "admin" });
    const alex = await signIn(t, forge, "alex");
    const sam = await signIn(t, forge, "sam");
    const { device, code } = await registerOpenly(t);
    await t.mutation(api.stations.approve, { code, signIn: alex });
    await handed(t, device);
    const [held] = (await t.query(api.tokens.list, { factory: "acme/widgets", signIn: sam }))!.tokens;

    expect(held).toMatchObject({ kind: "station", issuedBy: "alex", revocable: false });
    expect(await t.mutation(api.tokens.revoke, { token: held.id, signIn: sam })).toMatchObject({ ok: false });
    expect((await t.query(api.tokens.list, { factory: "acme/widgets", signIn: alex }))!.tokens[0].revocable).toBe(true);
    expect(await t.mutation(api.tokens.revoke, { token: held.id, signIn: await signIn(t, forge, "root") })).toEqual({ ok: true });
  });

  it("of a station leaves its command token be: each is its own", async () => {
    const forge = fakeForge();
    const t = await teamOf(forge, { alex: "admin" });
    const alex = await signIn(t, forge, "alex");
    const operators = await factory(t, "acme/widgets");
    const token = await approved(t, operators, alex);
    const [row] = (await t.query(api.tokens.list, { factory: "acme/widgets", signIn: alex }))!.tokens;

    await t.mutation(api.tokens.revoke, { token: row.id, signIn: alex });
    expect((await post(t, "/commands", token, { station: STATION.id, report: REPORT })).status).toBe(200);
  });
});
