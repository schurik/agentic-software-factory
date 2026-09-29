import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { storedEventFields } from "./model/wire";

export default defineSchema({
  // A factory-scoped, append-only credential: it can add events to its own
  // factory's sessions and nothing else — no read, no command. Only a digest is
  // kept, so the table leaking is not every station's secret leaking.
  ingestTokens: defineTable({
    factory: v.string(),
    digest: v.string(),
  }).index("by_digest", ["digest"]),

  // One document per domain event, exactly as the station sent it. The payload
  // is kept as the JSON text it arrived as (model/wire.ts) and never validated
  // against a kind: a kind or version this cockpit cannot read is kept all the
  // same, and read once the cockpit can.
  events: defineTable({
    factory: v.string(),
    session: v.string(),
    ...storedEventFields,
  }).index("by_session_seq", ["factory", "session", "seq"]),

  sessions: defineTable({
    factory: v.string(),
    session: v.string(),
    // The highest seq with every seq below it stored — what a station resumes after.
    acked: v.number(),
    // What the sessions list shows: the events up to `acked`, folded (a
    // `Summary`, model/session.ts). Kept here so the list reads one document
    // per session instead of every event. Deliberately untyped in the schema:
    // it is a cache of a fold, and a cockpit upgrade that adds a field to it
    // must not make every stored session fail schema validation on deploy.
    // Readers fill what an older fold never wrote (`readSummary`).
    summary: v.any(),
    // When the cockpit last folded anything in, for ordering the list.
    activity: v.number(),
  })
    .index("by_session", ["factory", "session"])
    .index("by_activity", ["activity"]),
});
