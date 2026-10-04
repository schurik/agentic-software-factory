/**
 * Seed a preview deploy with the golden sessions (tests/golden/sessions at the
 * repository root), so every preview of the cockpit has something to show.
 *
 *   bun run seed:golden          # after `bun run build`, in Vercel's build command
 *
 * It sends them over the real wire — POST /ingest with an ingest token, as a
 * station would — so nothing in the backend knows about seeding, and sending
 * them again is a no-op: ingest stores each event once, by its seq. The
 * sessions land in whichever factory the token was issued for
 * (`npx convex run tokens:issue '{"factory": "owner/repo"}'`); in a team's
 * cockpit pick a repository the people looking can read.
 *
 * Only a preview deploy is seeded (VERCEL_ENV=preview): production holds the
 * sessions real stations shipped and nothing else. A preview that cannot be
 * seeded fails its build, saying what to set, rather than coming up empty.
 *
 *   COCKPIT_DEMO_INGEST_TOKEN  the ingest token, set for Preview only
 *   CONVEX_URL                 the backend; its site is beside it on Convex cloud
 *   COCKPIT_DEMO_SITE_URL      the site, for a backend whose site is elsewhere
 *                              (self-hosted: the SITE_PROXY_PORT, :3211)
 */
import { readdirSync, readFileSync } from "node:fs";
import { MAX_BATCH_BYTES, MAX_EVENTS, type WireEvent } from "../convex/model/wire";

type Env = Record<string, string | undefined>;

export type Target = { seed: false; because: string } | { seed: true; ingest: string; token: string };

/** Where this deploy's golden sessions go, if anywhere; throws for a preview that cannot be seeded. */
export function targetOf(env: Env): Target {
  if (env.VERCEL_ENV !== "preview") {
    return { seed: false, because: `not a preview deploy (VERCEL_ENV=${env.VERCEL_ENV ?? "unset"})` };
  }
  const token = env.COCKPIT_DEMO_INGEST_TOKEN ?? "";
  if (!token) throw new Error("a preview deploy is seeded with the golden sessions: set COCKPIT_DEMO_INGEST_TOKEN for Preview");
  const site = env.COCKPIT_DEMO_SITE_URL || siteOf(env.CONVEX_URL ?? "");
  if (!site) {
    throw new Error("cannot tell where the backend's site is from CONVEX_URL: set COCKPIT_DEMO_SITE_URL for Preview");
  }
  return { seed: true, ingest: `${site.replace(/\/+$/, "")}/ingest`, token };
}

/** Convex cloud serves a deployment's HTTP actions beside its API: `x.convex.cloud` → `x.convex.site`. */
function siteOf(backend: string): string {
  return /^https:\/\/[^/]+\.convex\.cloud\/?$/.test(backend) ? backend.replace(/\.convex\.cloud\/?$/, ".convex.site") : "";
}

export interface Batch {
  session: string;
  events: WireEvent[];
}

/** One session's events.jsonl as the batches a station would send: under MAX_EVENTS and MAX_BATCH_BYTES each. */
export function batchesOf(jsonl: string): Batch[] {
  const events = jsonl.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as WireEvent);
  const started = events.find((event) => event.kind === "session_started");
  const session = String(started?.payload.adw_id ?? "");
  if (!session) throw new Error("a golden session without a session_started naming it");
  const batches: Batch[] = [];
  let current: WireEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = JSON.stringify(event.payload).length;
    if (current.length === MAX_EVENTS || (current.length && bytes + size > MAX_BATCH_BYTES)) {
      batches.push({ session, events: current });
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length) batches.push({ session, events: current });
  return batches;
}

async function main(): Promise<void> {
  const target = targetOf(process.env);
  if (!target.seed) {
    console.log(`seed:golden: nothing to do, ${target.because}`);
    return;
  }
  const root = new URL("../../../tests/golden/sessions/", import.meta.url);
  for (const name of readdirSync(root).sort()) {
    for (const batch of batchesOf(readFileSync(new URL(`${name}/events.jsonl`, root), "utf8"))) {
      const response = await fetch(target.ingest, {
        method: "POST",
        headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
      if (!response.ok) throw new Error(`${target.ingest} refused ${name}: ${response.status} ${await response.text()}`);
    }
    console.log(`seed:golden: ${name} is in`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`seed:golden: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
