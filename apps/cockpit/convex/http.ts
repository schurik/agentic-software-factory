import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { digest } from "./model/digest";
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

function reply(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default http;
