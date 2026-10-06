import { expect } from "vitest";
import { api } from "../convex/_generated/api";
import { fakeForge, type FakeForge, localMode, type Role } from "./forge";
import { catchUp, cockpit, type Cockpit, factory, fixture, ingest, signIn, team, type WireEvent } from "./helpers";

// A station's side of the wire, as tests/stations.test.ts and
// tests/commands.test.ts both drive it: registering by the device flow, the
// command poll with its report, and the sessions a station ships.

export const STATION = { id: "st_7f3a9c", name: "alex@mbp:widgets", kind: "local" };
export const SESSION = "5c0075aa";
export const REPORT = { verbs: ["kill"], head: "89abcdef", config_hash: "c0ffee", watchers: ["issues", "answers"] };

export async function post(t: Cockpit, path: string, token: string | null, body: unknown,
                           more: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...more };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return await t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
}

export async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

/** `asf station register`'s first request: the code and the device secret. */
export async function register(t: Cockpit, ingestToken: string, station = STATION) {
  const response = await post(t, "/station/register", ingestToken, { station });
  expect(response.status).toBe(200);
  return await json(response) as { device: string; code: string; url: string; interval: number; expires_in: number };
}

/** `asf station register` with no ingest token: the station names its factory, and says its host. */
export async function asksOpenly(t: Cockpit, factory = "acme/widgets", station = STATION, from = "203.0.113.7") {
  return await post(t, "/station/register", null, { station, factory, host: "mbp" }, { "X-Forwarded-For": `${from}, 10.0.0.1` });
}

export async function registerOpenly(t: Cockpit, factory = "acme/widgets", station = STATION) {
  const response = await asksOpenly(t, factory, station);
  expect(response.status).toBe(200);
  return await json(response) as { device: string; code: string; url: string; interval: number; expires_in: number };
}

export async function handed(t: Cockpit, device: string) {
  return await post(t, "/station/register/poll", null, { device });
}

/** A station the person signed in as `holding` approved: its command token. */
export async function approved(t: Cockpit, ingestToken: string, holding?: string, station = STATION): Promise<string> {
  const { device, code } = await register(t, ingestToken, station);
  expect(await t.mutation(api.stations.approve, { code, signIn: holding })).toEqual({ ok: true });
  const answer = await json(await handed(t, device));
  expect(answer.status).toBe("approved");
  return answer.token as string;
}

export async function poll(t: Cockpit, token: string, body: Record<string, unknown> = {}, station = STATION) {
  return await post(t, "/commands", token, { station: station.id, report: REPORT, ...body });
}

/** A session that started on STATION and is running. */
export function running(session = SESSION, station = STATION): WireEvent[] {
  const started = fixture("session_started", 1);
  Object.assign(started.payload, { adw_id: session, station_id: station.id, station_name: station.name });
  return [started];
}

/** A team on acme/widgets, the people in `roles` holding those roles there. */
export async function teamOf(forge: FakeForge, roles: Record<string, Role>): Promise<Cockpit> {
  for (const login of Object.keys(roles)) forge.person(login);
  forge.repo("acme/widgets", { factory: true, roles });
  const t = cockpit();
  await team(t, forge);
  forge.install("acme");
  await catchUp(t);
  return t;
}

/** A local cockpit holding alex's token, its factory, and its viewer known. */
export async function localOf(forge: FakeForge): Promise<{ t: Cockpit; ingestToken: string }> {
  localMode(forge, forge.person("alex"));
  forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
  const t = cockpit();
  await catchUp(t);
  return { t, ingestToken: await factory(t, "acme/widgets") };
}

/**
 * A team where the people in `roles` may act, `events` shipped as SESSION,
 * and alex's approved station having polled with `report`.
 */
export async function steerable(forge: FakeForge, events: WireEvent[], roles: Record<string, Role> = { alex: "write" },
                                report: Record<string, unknown> = REPORT) {
  const t = await teamOf(forge, roles);
  const ingestToken = await factory(t, "acme/widgets");
  const alex = await signIn(t, forge, "alex");
  await ingest(t, ingestToken, { session: SESSION, events });
  const token = await approved(t, ingestToken, alex);
  await poll(t, token, { report });
  return { t, ingestToken, alex, token };
}

export { fakeForge };
