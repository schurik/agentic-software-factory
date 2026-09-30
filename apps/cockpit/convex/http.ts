import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { signed } from "./forge/app";
import { digest } from "./model/digest";
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
    const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
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

function reply(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default http;
