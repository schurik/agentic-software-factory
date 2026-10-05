import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { fakeForge, type FakeForge } from "./forge";
import { catchUp, cockpit, type Cockpit, factory, fixture, ingest, signIn, team, type WireEvent } from "./helpers";
import { approved, poll, STATION } from "./station";

// The forge's names are case-insensitive, and a station names its factory in
// whatever case it was typed when its ingest token was issued. A factory is
// one factory however it is spelled: what its stations shipped under
// `acme/widgets` is on the page the forge links as `Acme/Widgets`.

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

function started(session: string): WireEvent {
  const event = fixture("session_started", 1, 2);
  Object.assign(event.payload, { adw_id: session, station_id: STATION.id, station_name: STATION.name, station_kind: "local" });
  return event;
}

function suspended(seq: number, trusted: string[]): WireEvent {
  const event = fixture("suspended", seq, 2);
  Object.assign(event.payload, { trusted });
  return event;
}

let forge: FakeForge;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  forge = fakeForge();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A team on `Acme/Widgets`, whose first station was handed a token for `acme/widgets` before the forge was asked. */
async function misspelt(): Promise<{ t: Cockpit; token: string; alex: string }> {
  forge.person("alex");
  forge.repo("Acme/Widgets", { factory: true, roles: { alex: "write" } });
  const t = cockpit();
  await team(t, forge);
  const token = await factory(t, "acme/widgets");
  forge.install("acme");
  await catchUp(t);
  const alex = await signIn(t, forge, "alex");
  await ingest(t, token, { session: "r1", events: [started("r1")] });
  await ingest(t, token, { session: "g1", events: [started("g1"), suspended(2, ["alex"])] });
  await poll(t, await approved(t, token, alex), {});
  return { t, token, alex };
}

describe("a factory its stations spell otherwise than the forge", () => {
  it("is one row of the Factories list, with its sessions, gates and stations", async () => {
    const { t, alex } = await misspelt();

    const list = await t.query(api.factories.list, { signIn: alex });

    expect(list?.factories).toMatchObject([
      { repo: "Acme/Widgets", reporting: true, live: 1, seen: [NOW], facts: { gates: { mine: 1, total: 1 } } },
    ]);
  });

  it("is all there on its Factory page, read by the forge's name", async () => {
    const { t, alex } = await misspelt();
    const asked = { factory: "Acme/Widgets", signIn: alex };

    expect((await t.query(api.factory.page, asked))?.stations.map((row) => row.name)).toEqual([STATION.name]);
    expect((await t.query(api.activity.attention, asked))?.gates).toEqual({ mine: 1, total: 1 });
    expect((await t.query(api.activity.page, asked))?.running.flatMap((group) => group.sessions.map((row) => row.session)).sort())
      .toEqual(["g1", "r1"]);
    expect((await t.query(api.activity.stations, { ...asked, period: { from: 0, to: Date.now() + 1 } }))?.stations.map((row) => row.sessions.length)).toEqual([2]);
    expect(await t.query(api.commands.runTargets, asked)).toMatchObject({ stations: [{ name: STATION.name }] });
  });

  it("opens a session the Factory page links to by the forge's name", async () => {
    const { t, alex } = await misspelt();

    expect(await t.query(api.sessions.get, { factory: "Acme/Widgets", session: "r1", signIn: alex }))
      .toMatchObject({ session: "r1" });
    expect(await t.query(api.commands.steering, { factory: "ACME/WIDGETS", session: "r1", signIn: alex }))
      .toMatchObject({ station: { name: STATION.name } });
  });

  it("keeps one spelling once one is known: a station handed a token later ships under it", async () => {
    const { t, alex } = await misspelt();
    const later = await factory(t, "ACME/widgets");
    await ingest(t, later, { session: "r2", events: [started("r2")] });

    const { sessions } = (await t.query(api.sessions.list, { signIn: alex }))!;
    expect(new Set(sessions.map((row) => row.factory))).toEqual(new Set(["acme/widgets"]));
    expect((await t.query(api.factories.list, { signIn: alex }))?.factories[0].live).toBe(2);
  });

  it("is stored under the forge's spelling when the forge named it before any station did", async () => {
    forge.person("alex");
    forge.repo("Acme/Widgets", { factory: true, roles: { alex: "write" } });
    const t = cockpit();
    await team(t, forge);
    forge.install("acme");
    await catchUp(t);
    const token = await factory(t, "acme/widgets");
    await ingest(t, token, { session: "r1", events: [started("r1")] });

    const { sessions } = (await t.query(api.sessions.list, { signIn: await signIn(t, forge, "alex") }))!;
    expect(sessions.map((row) => row.factory)).toEqual(["Acme/Widgets"]);
  });
});
