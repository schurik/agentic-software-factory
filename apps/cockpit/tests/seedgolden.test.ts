import { describe, expect, it } from "vitest";
import { batchesOf, targetOf } from "../scripts/seed-golden";
import { MAX_EVENTS } from "../convex/model/wire";
import { recorded } from "./helpers";

// A preview deploy is seeded with the golden sessions over the real wire, as a
// station would send them; any other deploy is left alone.

describe("where the golden sessions go", () => {
  const preview = { VERCEL_ENV: "preview", COCKPIT_DEMO_INGEST_TOKEN: "asf_ingest_x", CONVEX_URL: "https://happy-otter-123.convex.cloud" };

  it("is the deployment's site, on a preview deploy", () => {
    expect(targetOf(preview)).toEqual({ seed: true, ingest: "https://happy-otter-123.convex.site/ingest", token: "asf_ingest_x" });
  });

  it("is a site named outright, for a backend whose site is not beside it", () => {
    expect(targetOf({ ...preview, COCKPIT_DEMO_SITE_URL: "https://cockpit.example:3211/" }))
      .toMatchObject({ ingest: "https://cockpit.example:3211/ingest" });
  });

  it("is nowhere on any deploy but a preview: production holds real sessions only", () => {
    expect(targetOf({ ...preview, VERCEL_ENV: "production" })).toMatchObject({ seed: false });
    expect(targetOf({ COCKPIT_DEMO_INGEST_TOKEN: "asf_ingest_x" })).toMatchObject({ seed: false });
  });

  it("refuses a preview that cannot be seeded, saying what to set", () => {
    expect(() => targetOf({ ...preview, COCKPIT_DEMO_INGEST_TOKEN: "" })).toThrow(/COCKPIT_DEMO_INGEST_TOKEN/);
    expect(() => targetOf({ VERCEL_ENV: "preview", COCKPIT_DEMO_INGEST_TOKEN: "t", CONVEX_URL: "http://127.0.0.1:3210" }))
      .toThrow(/COCKPIT_DEMO_SITE_URL/);
  });
});

describe("what is sent", () => {
  const golden = recorded["issue-then-two-reviews"].events;
  const jsonl = golden.map((event) => JSON.stringify(event)).join("\n") + "\n";

  it("is each session's events, under the id its session_started names", () => {
    const batches = batchesOf(jsonl);
    expect(batches.every((batch) => batch.session === "a9f259f0")).toBe(true);
    expect(batches.flatMap((batch) => batch.events)).toEqual(golden);
  });

  it("is cut into batches the wire takes", () => {
    const long = Array.from({ length: MAX_EVENTS + 1 }, (_, at) => ({ ...golden[at % golden.length], seq: at + 1 }));
    const batches = batchesOf(long.map((event) => JSON.stringify(event)).join("\n"));
    expect(batches.map((batch) => batch.events.length)).toEqual([MAX_EVENTS, 1]);
  });
});
