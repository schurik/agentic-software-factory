import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { signed } from "./forge/app";
import { parseClaim } from "./model/claim";
import { isRefusal as isCommandRefusal, parsePoll, parseRegistration, REGISTRATION_FOR, REGISTRATION_POLL, approvalCode } from "./model/command";
import { isRefusal as isDescribingRefusal, parseDescribing } from "./model/description";
import { digest, secret } from "./model/digest";
import { asks } from "./model/webhook";
import { isRefusal, parseBatch } from "./model/wire";

const http = httpRouter();

// Stations ship domain events here (the wire is in model/wire.ts). The answer
// names nothing but the acknowledged seq: an ingest token can append, and read
// nothing back.
http.route({
  path: "/ingest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return reply(401, { error: "an ingest token is required" });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return reply(400, { error: "the body is not JSON" });
    }
    const batch = parseBatch(body);
    if (isRefusal(batch)) return reply(batch.status, { error: batch.error });

    const result = await ctx.runMutation(internal.ingest.append, {
      digest: await digest(token),
      session: batch.session,
      events: batch.events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) })),
    });
    if (result === null) return reply(401, { error: "this ingest token is not one the cockpit issued" });
    return reply(200, result);
  }),
});

// A station asks to take commands (`asf station register`, stations.ts): with
// the factory's ingest token, which says whose station it is, or with none,
// naming its factory itself — and then it is handed an ingest token too, and
// what may wait is limited (OPEN_PER_SOURCE). The answer is a code for a
// person to approve and a secret to poll with — and where to approve it,
// when this deployment was told where its pages are.
http.route({
  path: "/station/register",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    const asking = parseRegistration(await body(request));
    if (isCommandRefusal(asking)) return reply(asking.status, { error: asking.error });
    if (!token && !asking.factory) {
      return reply(400, { error: "registering names the factory, as owner/name, or carries its ingest token" });
    }
    const device = secret("asf_device_");
    const code = approvalCode(crypto.getRandomValues(new Uint8Array(8)));
    const asked = await ctx.runMutation(internal.stations.request, {
      ...(token ? { ingest: await digest(token) } : { factory: asking.factory, source: source(request) }),
      host: asking.host, device: await digest(device), code, station: asking.station,
    });
    if (!asked.ok) return reply(asked.status, { error: asked.because });
    const app = (process.env.COCKPIT_APP_URL ?? "").trim().replace(/\/+$/, "");
    return reply(200, {
      device, code, interval: REGISTRATION_POLL, expires_in: REGISTRATION_FOR / 1000,
      url: app ? `${app}/stations/approve?code=${code}` : "",
    });
  }),
});

// The registering station asks whether a person approved it yet. Approved,
// it is handed its command token — the only time the token is ever seen.
http.route({
  path: "/station/register/poll",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const asked = await body(request);
    const device = typeof (asked as { device?: unknown })?.device === "string" ? (asked as { device: string }).device : "";
    if (!device) return reply(400, { error: "a poll names its device secret" });
    const held = await digest(device);
    const state = await ctx.runQuery(internal.stations.registration, { device: held });
    if (state === "expired") return reply(410, { status: "expired", error: "this code expired, or was never asked for" });
    if (state === "pending") return reply(200, { status: "pending" });
    const token = secret("asf_station_");
    const ingest = secret("asf_ingest_");
    const handed = await ctx.runMutation(internal.stations.handOver, {
      device: held, token: await digest(token), ingest: await digest(ingest),
    });
    if (handed.state !== "approved") return reply(handed.state === "pending" ? 200 : 410, { status: handed.state });
    return reply(200, {
      status: "approved", token, owner: handed.owner, station: handed.station, ...(handed.open ? { ingest } : {}),
    });
  }),
});

// A station polls for its commands with its command token (commands.ts), and
// says with every poll what it would obey and where its checkout stands.
http.route({
  path: "/commands",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return reply(401, { error: "a command token is required" });
    const polled = parsePoll(await body(request));
    if (isCommandRefusal(polled)) return reply(polled.status, { error: polled.error });
    const answer = await ctx.runMutation(internal.commands.poll, { token: await digest(token), ...polled });
    if (answer === null) {
      return reply(401, { error: "this command token is not one the cockpit issued, or it was revoked" });
    }
    return reply(200, answer);
  }),
});

// A station asks for a claim on a work item before it touches a label, or
// gives back one no session used (claims.ts, ADR 0003): with the factory's
// ingest token, which says which factory asks. Granted is 200; held by
// another session, or asked for a session a writer abandoned, is 409, naming
// which.
http.route({
  path: "/claims",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return reply(401, { error: "a claim is asked with the factory's ingest token" });
    const factory = await ctx.runQuery(internal.tokens.factoryOf, { digest: await digest(token) });
    if (factory === null) return reply(401, { error: "this ingest token is not one the cockpit issued" });
    const parsed = parseClaim(await body(request), factory);
    if (isCommandRefusal(parsed)) return reply(parsed.status, { error: parsed.error });
    if (parsed.op === "drop") return reply(200, await ctx.runMutation(internal.claims.drop, { factory, asked: parsed.asked }));
    const answer = await ctx.runMutation(internal.claims.take, { factory, asked: parsed.asked });
    return reply(answer.granted ? 200 : 409, answer);
  }),
});

// A CI station pushes the factory's self-description here (`asf check --json
// --ship`, describe.ts): with the factory's ingest token, which can add to its
// own factory and receive nothing — so the answer names nothing either.
http.route({
  path: "/describe",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return reply(401, { error: "a description is pushed with the factory's ingest token" });
    const pushed = parseDescribing(await body(request));
    if (isDescribingRefusal(pushed)) return reply(pushed.status, { error: pushed.error });
    const { checked, format, ok } = pushed.description;
    const kept = await ctx.runMutation(internal.describe.keep, {
      digest: await digest(token), station: pushed.station, text: pushed.text,
      ref: checked.ref, head: checked.head, configHash: checked.configHash, format, ok,
    });
    if (!kept) return reply(401, { error: "this ingest token is not one the cockpit issued" });
    return reply(200, {});
  }),
});

// GitHub delivers the team's App's webhooks here: one URL for every
// repository the App is installed on. GitHub waits ten seconds for the answer
// and never retries, so the delivery is checked, handed to a mutation that
// schedules whatever it calls for, and answered — the forge is asked nothing
// until after. What a delivery means is in model/webhook.ts.
http.route({
  path: "/forge/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.text();
    const app = await ctx.runQuery(internal.forge.memory.app, {});
    const secret = app?.webhookSecret ?? null;
    if (secret === null || !(await signed(secret, body, request.headers.get("X-Hub-Signature-256")))) {
      return reply(401, { error: "this delivery is not signed by the App this cockpit registered" });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return reply(400, { error: "the body is not JSON" });
    }
    const asked = asks(request.headers.get("X-GitHub-Event") ?? "", payload);
    if (asked !== null) {
      await ctx.runMutation(internal.discovery.delivered, asked === "list" ? {} : { look: asked.look });
    }
    return reply(202, {});
  }),
});

/**
 * Where a request came from, as the proxy in front of the deployment says —
 * or "unknown" where none does, which every such request shares. The last
 * `X-Forwarded-For` entry, because that is the one the nearest proxy
 * appended: every entry before it is the client's to write. Only what the
 * open registration limits count by, and what the approval page shows beside
 * the host a station says it is — never what anything is granted on.
 */
function source(request: Request): string {
  const forwarded = request.headers.get("X-Forwarded-For")?.split(",").at(-1)?.trim();
  return forwarded || request.headers.get("X-Real-IP")?.trim() || "unknown";
}

function bearer(request: Request): string | null {
  return /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1] ?? null;
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function reply(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default http;
