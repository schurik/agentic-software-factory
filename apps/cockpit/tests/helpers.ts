import { convexTest } from "convex-test";
import { vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { APP_URL, type FakeForge, teamMode } from "./forge";
import type { WireEvent } from "../convex/model/wire";

export type { WireEvent };

// Every Convex module, as convex-test wants them: it loads functions by path.
const modules = import.meta.glob("../convex/**/*.*s");

export function cockpit() {
  return convexTest({ schema, modules });
}

export type Cockpit = ReturnType<typeof cockpit>;

/** A factory known to the cockpit, and the ingest token a station of it holds. */
export async function factory(t: Cockpit, name = "acme/widgets"): Promise<string> {
  return await t.action(internal.tokens.issue, { factory: name });
}

export async function ingest(t: Cockpit, token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return await t.fetch("/ingest", { method: "POST", headers, body: JSON.stringify(body) });
}

/**
 * The golden corpus the factory's own suite writes against: one line per event
 * kind and version, exactly as `events.jsonl` holds it. Every fixture ever
 * checked in stays, and the cockpit must read all of them.
 */
export const corpus: Record<string, WireEvent> = Object.fromEntries(
  Object.entries(
    import.meta.glob("../../../tests/golden/events/*/v*.json", { eager: true, import: "default" }) as
      Record<string, WireEvent>,
  ).map(([path, event]) => [path.split("/golden/events/")[1], event]),
);

/** The fixture for `kind` at `version`, renumbered to sit at `seq` in a session. */
export function fixture(kind: string, seq: number, version = 1): WireEvent {
  const event = corpus[`${kind}/v${version}.json`];
  if (!event) throw new Error(`no golden fixture ${kind}/v${version}.json`);
  return structuredClone({ ...event, seq });
}

/**
 * One round of the forge catch-up poll, and everything it schedules after
 * itself. What the cron does every minute, and `start.sh` once at start.
 * Needs `vi.useFakeTimers()`: convex-test runs scheduled functions on timers.
 */
export async function catchUp(t: Cockpit): Promise<void> {
  await t.action(internal.discovery.catchUp, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** A team's cockpit with its GitHub App registered on `forge`: the setup page's whole flow. */
export async function team(t: Cockpit, forge: FakeForge, organization = "acme"): Promise<void> {
  teamMode();
  const begun = await t.action(api.setup.begin, {
    code: await t.action(internal.setup.code, {}), host: forge.host, organization, appUrl: APP_URL,
  });
  await t.action(api.setup.complete, { code: await forge.register(begun), state: begun.state });
}

/** `login` signing in with the team's App; returns what their browser then holds. */
export async function signIn(t: Cockpit, forge: FakeForge, login: string): Promise<string> {
  const { state } = await t.action(api.auth.start, {});
  return await t.action(api.auth.finish, { code: forge.authorize(login), state });
}
