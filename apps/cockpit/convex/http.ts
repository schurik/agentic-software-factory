import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { digest } from "./model/digest";
import { parseBatch } from "./model/wire";

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
    if (typeof batch === "string") return reply(400, { error: batch });

    const result = await ctx.runMutation(internal.ingest.append, {
      digest: await digest(token),
      ...batch,
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
